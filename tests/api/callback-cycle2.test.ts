// Cycle 2a dev happy-path suite for the NEW M8 callbacks the MCP server (M10)
// consumes: evidence_upsert / search_files / list_session_chain /
// read_session_digest / read_session_events, and post_message targetAgents fan-out.
//
// QA (≠ this dev) owns the edge/adversarial coverage (traversal escapes,
// cross-thread session reads, unknown-target validation, dedup interplay, etc.).
//
// Driven through buildApp + Fastify inject, mirroring tests/api/callback.test.ts.
// Real data only: real agent ids, real evidence content, real session ids.

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createAgentId } from '@clowder/shared';
import type { AgentMessage, SessionRecord, SessionDigest, SessionEvent } from '@clowder/shared';
import { buildApp, type BuiltApp } from '@clowder/api/app-factory';
import { FakeAgentService } from '../invocation/fake-agent-service.js';

const CLAUDE = createAgentId('claude-opus');
const CODEX = createAgentId('codex-gpt');

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

/** A `session_init` + `text` + `done` reply script for one agent turn. */
function replyScript(agentId: ReturnType<typeof createAgentId>, sessionId: string, text: string): AgentMessage[] {
  const ts = Date.now();
  return [
    { type: 'session_init', agentId, content: sessionId, timestamp: ts },
    { type: 'text', agentId, content: text, timestamp: ts + 1 },
    { type: 'done', agentId, isFinal: true, timestamp: ts + 2 },
  ];
}

/** Auth headers for a minted invocation. */
function authHeaders(invocationId: string, callbackToken: string): Record<string, string> {
  return { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken };
}

/** Build an app over an in-memory db + ensure the cycle2 thread (no invocation yet). */
function buildAppWithThread(opts?: {
  fileRoot?: string;
  fakes?: Record<string, FakeAgentService>;
}): { app: BuiltApp; threadId: string } {
  const db = new Database(':memory:');
  const app = buildApp({
    db,
    ...(opts?.fileRoot !== undefined ? { fileRoot: opts.fileRoot } : {}),
    ...(opts?.fakes !== undefined ? { agentServices: opts.fakes } : {}),
  });
  return { app, threadId: 'thread-cycle2' };
}

/**
 * Build an app over an in-memory db, ensure a thread, mint a live invocation for
 * CLAUDE on it, and (optionally) inject fake agent services for routing tests.
 *
 * NB: for tests that ALSO drive a routed turn (POST /messages), the invocation
 * must be minted AFTER the turn — the invoke seam mints a fresh invocation per
 * (thread, agent) and the prior one would verify as stale_invocation (401). Those
 * tests use {@link buildAppWithThread} + an explicit post-turn mint instead.
 */
async function appWithInvocation(opts?: {
  fileRoot?: string;
  fakes?: Record<string, FakeAgentService>;
}): Promise<{ app: BuiltApp; invocationId: string; callbackToken: string; threadId: string }> {
  const { app, threadId } = buildAppWithThread(opts);
  await app.stores.threadStore.ensureThread(threadId, 'cycle2 callbacks');
  const record = app.invocations.create({ userId: 'user', agentId: CLAUDE, threadId });
  return { app, invocationId: record.invocationId, callbackToken: record.callbackToken, threadId };
}

/** Mint a fresh live invocation for CLAUDE on `threadId` (after any routed turn). */
function mintInvocation(app: BuiltApp, threadId: string): { invocationId: string; callbackToken: string } {
  const record = app.invocations.create({ userId: 'user', agentId: CLAUDE, threadId });
  return { invocationId: record.invocationId, callbackToken: record.callbackToken };
}

describe('evidence_upsert callback (happy path)', () => {
  it('writes evidence that is then retrievable via getByAnchor + search', async () => {
    const { app, invocationId, callbackToken } = await appWithInvocation();
    cleanups.push(app.close);

    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/evidence_upsert',
      headers: authHeaders(invocationId, callbackToken),
      payload: {
        anchor: 'decision:session-archive',
        kind: 'decision',
        title: 'Session 归档采用 sealed + digest',
        summary: 'session 是一等公民归档制品，封存时计算 digest 并落库。',
      },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json<{ anchor: string; upserted: boolean }>()).toEqual({
      anchor: 'decision:session-archive',
      upserted: true,
    });

    const stored = app.stores.evidenceStore.getByAnchor('decision:session-archive');
    expect(stored).not.toBeNull();
    expect(stored?.status).toBe('active');
    expect(stored?.title).toBe('Session 归档采用 sealed + digest');

    const search = app.stores.evidenceStore.search('归档');
    expect(search.items.some((i) => i.anchor === 'decision:session-archive')).toBe(true);
  });
});

describe('search_files callback (happy path)', () => {
  it('finds a real substring match and returns line snippets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clowder-search-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'src', 'router.ts'),
      'export function route() {\n  // AgentRouter resolves targets\n  return true;\n}\n',
      'utf8',
    );
    writeFileSync(join(root, 'README.md'), '# Project\nNo match for the needle here.\n', 'utf8');

    const { app, invocationId, callbackToken } = await appWithInvocation({ fileRoot: root });
    cleanups.push(app.close);

    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/search_files',
      headers: authHeaders(invocationId, callbackToken),
      payload: { query: 'AgentRouter' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      query: string;
      matches: Array<{ path: string; snippets: Array<{ line: number; text: string }> }>;
    }>();
    expect(body.query).toBe('AgentRouter');
    const hit = body.matches.find((m) => m.path === 'src/router.ts');
    expect(hit).toBeDefined();
    expect(hit?.snippets[0]?.line).toBe(2);
    expect(hit?.snippets[0]?.text).toContain('AgentRouter');
    // The non-matching file is absent from results.
    expect(body.matches.some((m) => m.path === 'README.md')).toBe(false);
  });

  it('scopes the search to a sandboxed sub-path when path is supplied', async () => {
    const root = mkdtempSync(join(tmpdir(), 'clowder-search2-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    mkdirSync(join(root, 'pkg-a'), { recursive: true });
    mkdirSync(join(root, 'pkg-b'), { recursive: true });
    writeFileSync(join(root, 'pkg-a', 'a.ts'), 'const evidence = upsertEvidence();\n', 'utf8');
    writeFileSync(join(root, 'pkg-b', 'b.ts'), 'const evidence = upsertEvidence();\n', 'utf8');

    const { app, invocationId, callbackToken } = await appWithInvocation({ fileRoot: root });
    cleanups.push(app.close);

    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/search_files',
      headers: authHeaders(invocationId, callbackToken),
      payload: { query: 'upsertEvidence', path: 'pkg-a' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ matches: Array<{ path: string }> }>();
    expect(body.matches.map((m) => m.path)).toEqual(['pkg-a/a.ts']);
  });
});

describe('list_session_chain callback (happy path)', () => {
  it("returns the authed thread's session chain after a real routed turn", async () => {
    const fakes = { 'claude-opus': new FakeAgentService([replyScript(CLAUDE, 'sess-claude-1', '已分析完毕。')]) };
    const { app, threadId } = buildAppWithThread({ fakes });
    cleanups.push(app.close);

    // Drive one real turn so a SessionRecord exists for this thread. The turn
    // mints its own invocation; mint the callback's invocation AFTER it so ours
    // is the latest for (thread, claude) and verifies (not stale).
    const send = await app.api.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/messages`,
      payload: { content: '@claude 请分析当前架构。' },
    });
    expect(send.statusCode).toBe(200);
    const { invocationId, callbackToken } = mintInvocation(app, threadId);

    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/list_session_chain',
      headers: authHeaders(invocationId, callbackToken),
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const { sessions } = res.json<{ sessions: SessionRecord[] }>();
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    const session = sessions.find((s) => s.sessionId === 'sess-claude-1');
    expect(session).toBeDefined();
    expect(session?.threadId).toBe(threadId);
    expect(session?.agentId).toBe('claude-opus');
    expect(session?.sequenceNo).toBe(1);
  });
});

describe('read_session_digest callback (happy path)', () => {
  it("returns a thread-owned session's digest", async () => {
    const fakes = { 'claude-opus': new FakeAgentService([replyScript(CLAUDE, 'sess-claude-d', '完成实现。')]) };
    const { app, threadId } = buildAppWithThread({ fakes });
    cleanups.push(app.close);

    const send = await app.api.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/messages`,
      payload: { content: '@claude 实现回调端点。' },
    });
    expect(send.statusCode).toBe(200);
    const { invocationId, callbackToken } = mintInvocation(app, threadId);

    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/read_session_digest',
      headers: authHeaders(invocationId, callbackToken),
      payload: { sessionId: 'sess-claude-d' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ sessionId: string; digest: SessionDigest }>();
    expect(body.sessionId).toBe('sess-claude-d');
    expect(body.digest.messageCount).toBeGreaterThanOrEqual(1);
    expect(typeof body.digest.toolCounts).toBe('object');
    expect(Array.isArray(body.digest.filesTouched)).toBe(true);
  });
});

describe('read_session_events callback (happy path)', () => {
  it("returns a thread-owned session's transcript", async () => {
    const fakes = { 'claude-opus': new FakeAgentService([replyScript(CLAUDE, 'sess-claude-e', '架构评审通过。')]) };
    const { app, threadId } = buildAppWithThread({ fakes });
    cleanups.push(app.close);

    const send = await app.api.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/messages`,
      payload: { content: '@claude 给出架构评审结论。' },
    });
    expect(send.statusCode).toBe(200);
    const { invocationId, callbackToken } = mintInvocation(app, threadId);

    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/read_session_events',
      headers: authHeaders(invocationId, callbackToken),
      payload: { sessionId: 'sess-claude-e' },
    });

    expect(res.statusCode).toBe(200);
    const { sessionId, events } = res.json<{ sessionId: string; events: SessionEvent[] }>();
    expect(sessionId).toBe('sess-claude-e');
    const messageEvent = events.find((e) => e.kind === 'message');
    expect(messageEvent).toBeDefined();
    expect(messageEvent?.content).toContain('架构评审通过');
  });
});

describe('post_message targetAgents fan-out (happy path)', () => {
  it('persists the author message AND routes to the named target via M4', async () => {
    const claudeFake = new FakeAgentService([]);
    const codexFake = new FakeAgentService([replyScript(CODEX, 'sess-codex-1', '已收到，开始实现。')]);
    const fakes = { 'claude-opus': claudeFake, 'codex-gpt': codexFake };
    const { app, invocationId, callbackToken, threadId } = await appWithInvocation({ fakes });
    cleanups.push(app.close);

    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/post_message',
      headers: authHeaders(invocationId, callbackToken),
      payload: {
        content: '请帮我落地这个数据模型，细节见上文。',
        targetAgents: ['codex-gpt'],
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ messageId: string; routedReplies: Array<{ agentId: string; content: string }> }>();
    expect(body.messageId).toBeTruthy();

    // The named target was actually invoked through the router seam.
    expect(codexFake.calls.length).toBe(1);

    // The router-produced reply was persisted + returned.
    const codexReply = body.routedReplies.find((r) => r.agentId === 'codex-gpt');
    expect(codexReply).toBeDefined();
    expect(codexReply?.content).toContain('已收到');

    // The author's own callback message is persisted with the record's identity.
    const stored = await app.stores.messageStore.getByThread(threadId);
    expect(
      stored.some((m) => m.origin === 'callback' && m.agentId === 'claude-opus'),
    ).toBe(true);
    // The codex reply is also persisted (as a routed stream message).
    expect(stored.some((m) => m.origin === 'stream' && m.agentId === 'codex-gpt')).toBe(true);
  });

  it('behaves exactly as before when targetAgents is absent (no routing)', async () => {
    const codexFake = new FakeAgentService([replyScript(CODEX, 'sess-codex-2', 'should not run')]);
    const fakes = { 'claude-opus': new FakeAgentService([]), 'codex-gpt': codexFake };
    const { app, invocationId, callbackToken } = await appWithInvocation({ fakes });
    cleanups.push(app.close);

    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/post_message',
      headers: authHeaders(invocationId, callbackToken),
      payload: { content: '进度更新：数据模型已定稿。' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json<{ messageId: string; routedReplies?: unknown }>();
    expect(body.messageId).toBeTruthy();
    expect(body.routedReplies).toBeUndefined();
    // No target was routed to.
    expect(codexFake.calls.length).toBe(0);
  });
});
