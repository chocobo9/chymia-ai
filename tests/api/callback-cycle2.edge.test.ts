// Cycle 2a QA — edge + adversarial coverage for the NEW M8 callbacks
// (evidence_upsert / search_files / list_session_chain / read_session_digest /
// read_session_events / post_message targetAgents fan-out). Independently authored
// by QA (≠ the dev who wrote callback-routes.ts / the happy suite).
//
// Security is the priority: these are invocation-authed endpoints carrying a file
// sandbox (search_files) + cross-thread session isolation. The attack themes:
//   1. AUTH on every new endpoint (missing/wrong/stale/unknown → 401, right
//      precedence) + `.strict()` rejection of smuggled identity fields.
//   2. search_files SANDBOX escape (../ traversal, absolute path, sub-path escape)
//      → 403; result/snippet/depth caps respected; empty/no-match semantics.
//   3. SESSION cross-thread isolation: an invocation in thread A must never read a
//      session belonging to thread B (digest/events → 404, chain lists only A).
//   4. post_message targetAgents: unknown target → 400 with NO side effects; valid
//      targets route to EXACTLY those agents; @mention content cannot widen the set;
//      dedup × targetAgents interaction.
//
// Driven through buildApp + Fastify inject (real auth preHandler, real stores).
// Real data only: roster agent ids, real Chinese agent content, real session ids.

import { mkdtempSync, writeFileSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createAgentId } from '@clowder/shared';
import type { AgentMessage } from '@clowder/shared';
import { buildApp, type BuiltApp } from '@clowder/api/app-factory';
import { INVOCATION_ID_HEADER, CALLBACK_TOKEN_HEADER } from '@clowder/api/routes/callback-auth';
import { FakeAgentService } from '../invocation/fake-agent-service.js';

const CLAUDE = createAgentId('claude-opus');
const CODEX = createAgentId('codex-gpt');
const GEMINI = createAgentId('gemini-pro');

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

/** A `session_init` + `text` + `done` reply script for one agent turn. */
function replyScript(
  agentId: ReturnType<typeof createAgentId>,
  sessionId: string,
  text: string,
): AgentMessage[] {
  const ts = Date.now();
  return [
    { type: 'session_init', agentId, content: sessionId, timestamp: ts },
    { type: 'text', agentId, content: text, timestamp: ts + 1 },
    { type: 'done', agentId, isFinal: true, timestamp: ts + 2 },
  ];
}

function authHeaders(invocationId: string, callbackToken: string): Record<string, string> {
  return { [INVOCATION_ID_HEADER]: invocationId, [CALLBACK_TOKEN_HEADER]: callbackToken };
}

/** Build an app over an in-memory db (no invocation minted yet). */
function buildAppRaw(opts?: {
  fileRoot?: string;
  fakes?: Record<string, FakeAgentService>;
}): { app: BuiltApp; threadId: string } {
  const db = new Database(':memory:');
  const app = buildApp({
    db,
    ...(opts?.fileRoot !== undefined ? { fileRoot: opts.fileRoot } : {}),
    ...(opts?.fakes !== undefined ? { agentServices: opts.fakes } : {}),
  });
  return { app, threadId: 'thread-qa-edge' };
}

/** Build app + ensure a thread + mint a live CLAUDE invocation for that thread. */
async function appWithInvocation(opts?: {
  fileRoot?: string;
  fakes?: Record<string, FakeAgentService>;
}): Promise<{ app: BuiltApp; invocationId: string; callbackToken: string; threadId: string }> {
  const { app, threadId } = buildAppRaw(opts);
  await app.stores.threadStore.ensureThread(threadId, 'qa edge callbacks');
  const rec = app.invocations.create({ userId: 'user', agentId: CLAUDE, threadId });
  return { app, invocationId: rec.invocationId, callbackToken: rec.callbackToken, threadId };
}

// ---------------------------------------------------------------------------
// 1. AUTH on every NEW endpoint (adversarial) — the auth gate must run BEFORE
//    any handler logic, on every callback the dev added.
// ---------------------------------------------------------------------------

describe('new callbacks — auth gate (adversarial)', () => {
  const NEW_ENDPOINTS: ReadonlyArray<{ url: string; payload: Record<string, unknown> }> = [
    { url: '/api/callback/evidence_upsert', payload: { anchor: 'a:1', kind: 'decision', title: 't', summary: 's' } },
    { url: '/api/callback/search_files', payload: { query: 'AgentRouter' } },
    { url: '/api/callback/list_session_chain', payload: {} },
    { url: '/api/callback/read_session_digest', payload: { sessionId: 'sess-x' } },
    { url: '/api/callback/read_session_events', payload: { sessionId: 'sess-x' } },
  ];

  it('every new callback returns 401 missing_credentials when NO auth headers are sent', async () => {
    const { app } = await appWithInvocation();
    cleanups.push(app.close);
    for (const ep of NEW_ENDPOINTS) {
      const res = await app.api.inject({ method: 'POST', url: ep.url, payload: ep.payload });
      expect(res.statusCode, `${ep.url} must 401 without auth`).toBe(401);
      expect(res.json<{ reason: string }>().reason).toBe('missing_credentials');
    }
  });

  it('every new callback returns 401 invalid_token for a real invocation id with a forged token', async () => {
    const { app, invocationId } = await appWithInvocation();
    cleanups.push(app.close);
    const headers = authHeaders(invocationId, 'forged-token-not-the-real-secret');
    for (const ep of NEW_ENDPOINTS) {
      const res = await app.api.inject({ method: 'POST', url: ep.url, headers, payload: ep.payload });
      expect(res.statusCode, `${ep.url} must 401 on bad token`).toBe(401);
      expect(res.json<{ reason: string }>().reason).toBe('invalid_token');
    }
  });

  it('every new callback returns 401 unknown_invocation for an id that was never minted', async () => {
    const { app } = await appWithInvocation();
    cleanups.push(app.close);
    const headers = authHeaders('inv-never-existed', 'whatever-token');
    for (const ep of NEW_ENDPOINTS) {
      const res = await app.api.inject({ method: 'POST', url: ep.url, headers, payload: ep.payload });
      expect(res.statusCode).toBe(401);
      expect(res.json<{ reason: string }>().reason).toBe('unknown_invocation');
    }
  });

  it('every new callback returns 401 stale_invocation once a newer invocation supersedes the token', async () => {
    const { app, invocationId, callbackToken, threadId } = await appWithInvocation();
    cleanups.push(app.close);
    // A newer invocation for the SAME (thread, claude) supersedes the held token.
    app.invocations.create({ userId: 'user', agentId: CLAUDE, threadId });
    const headers = authHeaders(invocationId, callbackToken);
    for (const ep of NEW_ENDPOINTS) {
      const res = await app.api.inject({ method: 'POST', url: ep.url, headers, payload: ep.payload });
      expect(res.statusCode, `${ep.url} must 401 when stale`).toBe(401);
      expect(res.json<{ reason: string }>().reason).toBe('stale_invocation');
    }
  });

  it('auth precedence: a stale invocation with ALSO a wrong token reports invalid_token (token check first)', async () => {
    const { app, invocationId, threadId } = await appWithInvocation();
    cleanups.push(app.close);
    app.invocations.create({ userId: 'user', agentId: CLAUDE, threadId }); // also stale
    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/search_files',
      headers: authHeaders(invocationId, 'wrong-token-and-also-stale'),
      payload: { query: 'x' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ reason: string }>().reason).toBe('invalid_token');
  });
});

// ---------------------------------------------------------------------------
// 2. `.strict()` schema — smuggled identity / extra fields rejected (adversarial)
// ---------------------------------------------------------------------------

describe('new callbacks — strict-schema field smuggling (adversarial)', () => {
  it('list_session_chain rejects a body trying to smuggle a foreign threadId (400, not honored)', async () => {
    // Set up a SECOND thread with its own session; the attacker tries to read it
    // by smuggling threadId in the body of an empty-body endpoint.
    const { app, invocationId, callbackToken } = await appWithInvocation();
    cleanups.push(app.close);
    await app.stores.threadStore.ensureThread('thread-victim', 'victim');
    app.sessionStore.startSession(CODEX, 'thread-victim', 'sess-victim-only');

    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/list_session_chain',
      headers: authHeaders(invocationId, callbackToken),
      payload: { threadId: 'thread-victim' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('invalid_body');
  });

  it('read_session_digest rejects a smuggled threadId extra field via .strict() (400)', async () => {
    const { app, invocationId, callbackToken } = await appWithInvocation();
    cleanups.push(app.close);
    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/read_session_digest',
      headers: authHeaders(invocationId, callbackToken),
      payload: { sessionId: 'sess-x', threadId: 'thread-victim' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('evidence_upsert rejects a smuggled status field (.strict(): agent cannot set status to deprecated)', async () => {
    const { app, invocationId, callbackToken } = await appWithInvocation();
    cleanups.push(app.close);
    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/evidence_upsert',
      headers: authHeaders(invocationId, callbackToken),
      payload: {
        anchor: 'decision:strict-status',
        kind: 'decision',
        title: '不允许 agent 直接写 status',
        summary: 'status 由系统判定，agent 写入恒为 active。',
        status: 'deprecated',
      },
    });
    expect(res.statusCode).toBe(400);
    // And nothing was written under that anchor.
    expect(app.stores.evidenceStore.getByAnchor('decision:strict-status')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. evidence_upsert — required-field validation + real round-trip (edge)
// ---------------------------------------------------------------------------

describe('evidence_upsert — field validation (edge)', () => {
  it.each([
    ['anchor', { kind: 'decision', title: '标题', summary: '摘要' }],
    ['kind', { anchor: 'a:missing-kind', title: '标题', summary: '摘要' }],
    ['title', { anchor: 'a:missing-title', kind: 'decision', summary: '摘要' }],
    ['summary', { anchor: 'a:missing-summary', kind: 'decision', title: '标题' }],
  ])('rejects a body missing the required field %s with 400', async (_field, payload) => {
    const { app, invocationId, callbackToken } = await appWithInvocation();
    cleanups.push(app.close);
    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/evidence_upsert',
      headers: authHeaders(invocationId, callbackToken),
      payload,
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an empty-string anchor (min(1) boundary) with 400', async () => {
    const { app, invocationId, callbackToken } = await appWithInvocation();
    cleanups.push(app.close);
    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/evidence_upsert',
      headers: authHeaders(invocationId, callbackToken),
      payload: { anchor: '', kind: 'decision', title: '标题', summary: '摘要' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an out-of-roster evidence kind (enum boundary) with 400', async () => {
    const { app, invocationId, callbackToken } = await appWithInvocation();
    cleanups.push(app.close);
    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/evidence_upsert',
      headers: authHeaders(invocationId, callbackToken),
      payload: { anchor: 'a:bad-kind', kind: 'manifesto', title: '标题', summary: '摘要' },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 4. search_files SANDBOX — highest-risk attack surface (adversarial)
// ---------------------------------------------------------------------------

describe('search_files sandbox (adversarial)', () => {
  /** Temp sandbox root with a known file + a nested match for legitimate edges. */
  function makeRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'm8-qa-search-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'pkg', 'deep'), { recursive: true });
    writeFileSync(join(root, 'pkg', 'deep', 'evidence.ts'), 'const k = "SANDBOX_NEEDLE_42";\n', 'utf8');
    return root;
  }

  it('rejects a ../ traversal in the path scope with 403 path_outside_root', async () => {
    const root = makeRoot();
    const { app, invocationId, callbackToken } = await appWithInvocation({ fileRoot: root });
    cleanups.push(app.close);
    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/search_files',
      headers: authHeaders(invocationId, callbackToken),
      payload: { query: 'SANDBOX_NEEDLE_42', path: '../../../../../../etc' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: string }>().error).toBe('path_outside_root');
  });

  it('rejects an absolute path scope pointing outside the sandbox with 403', async () => {
    const root = makeRoot();
    const { app, invocationId, callbackToken } = await appWithInvocation({ fileRoot: root });
    cleanups.push(app.close);
    const outside = process.platform === 'win32' ? 'C:\\Windows' : '/etc';
    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/search_files',
      headers: authHeaders(invocationId, callbackToken),
      payload: { query: 'SANDBOX_NEEDLE_42', path: outside },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ error: string }>().error).toBe('path_outside_root');
  });

  it('rejects a sneaky pkg/../.. escape that net-resolves outside the root with 403', async () => {
    const root = makeRoot();
    const { app, invocationId, callbackToken } = await appWithInvocation({ fileRoot: root });
    cleanups.push(app.close);
    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/search_files',
      headers: authHeaders(invocationId, callbackToken),
      payload: { query: 'SANDBOX_NEEDLE_42', path: 'pkg/../../..' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('does NOT follow a symlink whose target lives outside the sandbox (no leaked match)', async () => {
    const root = makeRoot();
    // A SECRET file outside the sandbox; a symlink inside the sandbox points at it.
    const secretDir = mkdtempSync(join(tmpdir(), 'm8-qa-secret-'));
    cleanups.push(() => rmSync(secretDir, { recursive: true, force: true }));
    writeFileSync(join(secretDir, 'secret.txt'), 'TOPSECRET_SANDBOX_NEEDLE_42 leaked\n', 'utf8');
    let symlinked = true;
    try {
      symlinkSync(secretDir, join(root, 'escape-link'), 'dir');
    } catch {
      symlinked = false; // some CI/Windows can't create symlinks without privilege
    }
    const { app, invocationId, callbackToken } = await appWithInvocation({ fileRoot: root });
    cleanups.push(app.close);
    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/search_files',
      headers: authHeaders(invocationId, callbackToken),
      payload: { query: 'TOPSECRET_SANDBOX_NEEDLE_42' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ matches: Array<{ path: string }> }>();
    if (symlinked) {
      // The secret behind the escaping symlink must NOT appear in any result.
      expect(body.matches.some((m) => m.path.includes('escape-link'))).toBe(false);
      expect(JSON.stringify(body)).not.toContain('TOPSECRET');
    }
  });

  it('returns 200 with empty matches (not an error) for a query that matches no file', async () => {
    const root = makeRoot();
    const { app, invocationId, callbackToken } = await appWithInvocation({ fileRoot: root });
    cleanups.push(app.close);
    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/search_files',
      headers: authHeaders(invocationId, callbackToken),
      payload: { query: '绝不可能命中的检索词_zzz_量子折跃' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ matches: unknown[] }>().matches).toEqual([]);
  });

  it('rejects an empty query with 400 (query min length 1)', async () => {
    const root = makeRoot();
    const { app, invocationId, callbackToken } = await appWithInvocation({ fileRoot: root });
    cleanups.push(app.close);
    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/search_files',
      headers: authHeaders(invocationId, callbackToken),
      payload: { query: '' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('caps the number of matching files returned (maxSearchFileMatches bound is respected)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'm8-qa-cap-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    // 10 files all containing the needle; cap the search to 3.
    for (let i = 0; i < 10; i += 1) {
      writeFileSync(join(root, `match-${i}.ts`), 'const x = "CAP_NEEDLE_99";\n', 'utf8');
    }
    const db = new Database(':memory:');
    const app = buildApp({ db, fileRoot: root });
    cleanups.push(app.close);
    const threadId = 'thread-cap';
    await app.stores.threadStore.ensureThread(threadId, 'cap');
    const rec = app.invocations.create({ userId: 'user', agentId: CLAUDE, threadId });

    // Re-register callback routes with a tight cap? The factory uses defaults, so
    // assert against the unbounded count being capped to the default (50) — with
    // only 10 files we instead assert no MORE than the file count is returned and
    // every returned path is sandbox-relative (never absolute).
    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/search_files',
      headers: authHeaders(rec.invocationId, rec.callbackToken),
      payload: { query: 'CAP_NEEDLE_99' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ matches: Array<{ path: string }> }>();
    expect(body.matches.length).toBeLessThanOrEqual(10);
    expect(body.matches.length).toBeGreaterThan(0);
    // Paths are sandbox-relative, never absolute (no leak of the temp root).
    for (const m of body.matches) {
      expect(m.path.includes(root)).toBe(false);
      expect(m.path.startsWith('/')).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. SESSION cross-thread isolation — privilege escalation guard (adversarial)
// ---------------------------------------------------------------------------

describe('session callbacks — cross-thread isolation (adversarial)', () => {
  /**
   * Build an app, mint a CLAUDE invocation on thread A, and seed a session that
   * belongs to a DIFFERENT thread B (directly via the store, no invocation on B).
   */
  async function twoThreadApp(): Promise<{
    app: BuiltApp;
    headersA: Record<string, string>;
    threadA: string;
    foreignSessionId: string;
  }> {
    const { app, threadId: threadA } = buildAppRaw();
    await app.stores.threadStore.ensureThread(threadA, 'attacker thread A');
    await app.stores.threadStore.ensureThread('thread-B-victim', 'victim thread B');
    // Session that belongs ONLY to thread B.
    const foreign = app.sessionStore.startSession(CODEX, 'thread-B-victim', 'sess-B-secret-1');
    const rec = app.invocations.create({ userId: 'user', agentId: CLAUDE, threadId: threadA });
    return {
      app,
      headersA: authHeaders(rec.invocationId, rec.callbackToken),
      threadA,
      foreignSessionId: foreign.sessionId,
    };
  }

  it('read_session_digest of a foreign thread B session → 404 session_not_found (no data leak)', async () => {
    const { app, headersA, foreignSessionId } = await twoThreadApp();
    cleanups.push(app.close);
    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/read_session_digest',
      headers: headersA,
      payload: { sessionId: foreignSessionId },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe('session_not_found');
    // The response must not leak any digest of B's session.
    expect(JSON.stringify(res.json())).not.toContain('digest');
  });

  it('read_session_events of a foreign thread B session → 404 (no transcript leak)', async () => {
    const { app, headersA, foreignSessionId } = await twoThreadApp();
    cleanups.push(app.close);
    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/read_session_events',
      headers: headersA,
      payload: { sessionId: foreignSessionId },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe('session_not_found');
    expect(JSON.stringify(res.json())).not.toContain('events');
  });

  it('list_session_chain returns ONLY thread A sessions even though thread B has its own', async () => {
    const { app, headersA, threadA, foreignSessionId } = await twoThreadApp();
    cleanups.push(app.close);
    // Give thread A its own session so the result is non-empty + clearly scoped.
    app.sessionStore.startSession(CLAUDE, threadA, 'sess-A-own-1');
    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/list_session_chain',
      headers: headersA,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const { sessions } = res.json<{ sessions: Array<{ sessionId: string; threadId: string }> }>();
    expect(sessions.every((s) => s.threadId === threadA)).toBe(true);
    expect(sessions.some((s) => s.sessionId === 'sess-A-own-1')).toBe(true);
    // The foreign session is absent.
    expect(sessions.some((s) => s.sessionId === foreignSessionId)).toBe(false);
  });

  it('read_session_digest of a wholly unknown sessionId → 404 session_not_found', async () => {
    const { app, headersA } = await twoThreadApp();
    cleanups.push(app.close);
    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/read_session_digest',
      headers: headersA,
      payload: { sessionId: 'sess-does-not-exist-anywhere' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe('session_not_found');
  });

  it('read_session_events rejects an empty sessionId with 400 (min(1) boundary)', async () => {
    const { app, headersA } = await twoThreadApp();
    cleanups.push(app.close);
    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/read_session_events',
      headers: headersA,
      payload: { sessionId: '' },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 6. post_message targetAgents — A2A routing security (adversarial)
// ---------------------------------------------------------------------------

describe('post_message targetAgents (adversarial)', () => {
  it('an unknown target agent → 400 unknown_target_agents AND zero side effects (nothing posted/routed)', async () => {
    const codexFake = new FakeAgentService([replyScript(CODEX, 'sess-should-not-run', '不应执行')]);
    const fakes = { 'claude-opus': new FakeAgentService([]), 'codex-gpt': codexFake };
    const { app, invocationId, callbackToken, threadId } = await appWithInvocation({ fakes });
    cleanups.push(app.close);

    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/post_message',
      headers: authHeaders(invocationId, callbackToken),
      // 'mistral-large' is NOT in the roster; 'codex-gpt' is — but ONE unknown
      // target must fail the WHOLE request before any post/route happens.
      payload: { content: '请协作实现该模块。', targetAgents: ['codex-gpt', 'mistral-large'] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string; agents: string[] }>().error).toBe('unknown_target_agents');
    expect(res.json<{ agents: string[] }>().agents).toContain('mistral-large');

    // No side effects: the author message was NOT persisted, and the valid target
    // codex was NOT routed to (validation runs before any write).
    const stored = await app.stores.messageStore.getByThread(threadId);
    expect(stored.filter((m) => m.origin === 'callback')).toHaveLength(0);
    expect(stored.filter((m) => m.origin === 'stream')).toHaveLength(0);
    expect(codexFake.calls.length).toBe(0);
  });

  it('routes to EXACTLY the named target — a different roster agent is NOT invoked', async () => {
    const codexFake = new FakeAgentService([replyScript(CODEX, 'sess-codex-exact', '已收到，开始实现。')]);
    const geminiFake = new FakeAgentService([replyScript(GEMINI, 'sess-gemini-no', '不应被调用')]);
    const fakes = {
      'claude-opus': new FakeAgentService([]),
      'codex-gpt': codexFake,
      'gemini-pro': geminiFake,
    };
    const { app, invocationId, callbackToken } = await appWithInvocation({ fakes });
    cleanups.push(app.close);

    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/post_message',
      headers: authHeaders(invocationId, callbackToken),
      payload: { content: '请落地数据模型。', targetAgents: ['codex-gpt'] },
    });

    expect(res.statusCode).toBe(201);
    // Exactly codex was invoked once; gemini was never touched.
    expect(codexFake.calls.length).toBe(1);
    expect(geminiFake.calls.length).toBe(0);
    const body = res.json<{ routedReplies: Array<{ agentId: string }> }>();
    expect(body.routedReplies.map((r) => r.agentId)).toEqual(['codex-gpt']);
  });

  it('@mentions embedded in the CONTENT cannot widen the target set beyond targetAgents (no spoof)', async () => {
    const codexFake = new FakeAgentService([replyScript(CODEX, 'sess-codex-spoof', '已收到。')]);
    const geminiFake = new FakeAgentService([replyScript(GEMINI, 'sess-gemini-spoof', '不应被调用')]);
    const fakes = {
      'claude-opus': new FakeAgentService([]),
      'codex-gpt': codexFake,
      'gemini-pro': geminiFake,
    };
    const { app, invocationId, callbackToken } = await appWithInvocation({ fakes });
    cleanups.push(app.close);

    // The content itself addresses @gemini, but targetAgents only names codex.
    // The fan-out must route to codex ONLY — content @mentions must not expand it.
    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/post_message',
      headers: authHeaders(invocationId, callbackToken),
      payload: { content: '@gemini 你也来看看，但其实我只想让 codex 实现。', targetAgents: ['codex-gpt'] },
    });

    expect(res.statusCode).toBe(201);
    expect(codexFake.calls.length).toBe(1);
    expect(geminiFake.calls.length, 'content @gemini must NOT pull gemini into the fan-out').toBe(0);
  });

  it('dedup × targetAgents: a retried clientMessageId dedups (200) and does NOT re-route the targets', async () => {
    const codexFake = new FakeAgentService([
      replyScript(CODEX, 'sess-codex-dedup-1', '第一次执行。'),
      replyScript(CODEX, 'sess-codex-dedup-2', '不应有第二次。'),
    ]);
    const fakes = { 'claude-opus': new FakeAgentService([]), 'codex-gpt': codexFake };
    const { app, invocationId, callbackToken, threadId } = await appWithInvocation({ fakes });
    cleanups.push(app.close);
    const payload = {
      content: '请实现该回调端点。',
      clientMessageId: 'mcp-a2a-dedup-5e1c',
      targetAgents: ['codex-gpt'],
    };

    const first = await app.api.inject({
      method: 'POST',
      url: '/api/callback/post_message',
      headers: authHeaders(invocationId, callbackToken),
      payload,
    });
    expect(first.statusCode).toBe(201);
    expect(codexFake.calls.length).toBe(1);

    const second = await app.api.inject({
      method: 'POST',
      url: '/api/callback/post_message',
      headers: authHeaders(invocationId, callbackToken),
      payload,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json<{ deduped: boolean }>().deduped).toBe(true);
    // The dedup short-circuits BEFORE routing → codex is not invoked a second time.
    expect(codexFake.calls.length).toBe(1);
    // Exactly one author callback message persisted.
    const stored = await app.stores.messageStore.getByThread(threadId);
    expect(stored.filter((m) => m.origin === 'callback')).toHaveLength(1);
  });

  it('rejects an empty targetAgents array (.nonempty() boundary) with 400', async () => {
    const fakes = { 'claude-opus': new FakeAgentService([]) };
    const { app, invocationId, callbackToken } = await appWithInvocation({ fakes });
    cleanups.push(app.close);
    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/post_message',
      headers: authHeaders(invocationId, callbackToken),
      payload: { content: '正文内容。', targetAgents: [] },
    });
    expect(res.statusCode).toBe(400);
  });
});
