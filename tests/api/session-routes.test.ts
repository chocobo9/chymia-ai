// session-routes — the BROWSER-facing session-chain API: list a thread's chain
// (with digests), read a session's transcript, and SEAL a live session. Seeded
// directly through the SAME SessionStore + MessageStore the engine uses (BuiltApp
// exposes them), so the routes are exercised against REAL archived data, not mocks.

import Database from 'better-sqlite3';
import { describe, it, expect, afterEach } from 'vitest';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';
import { CLAUDE, CODEX } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function makeApp(): BuiltApp {
  const db = new Database(':memory:');
  const app = buildApp({ db, agentServices: {} });
  cleanups.push(app.close);
  return app;
}

const THREAD = 'thread_two_sum';

/** Seed a 2-session chain for (CLAUDE, THREAD): #1 (sealed, 1 message) → #2 (active). */
async function seedChain(app: BuiltApp): Promise<void> {
  await app.stores.threadStore.ensureThread(THREAD, 'Two Sum 可视化');
  app.sessionStore.startSession(CLAUDE, THREAD, 'cli-sess-1');
  await app.stores.messageStore.append({
    threadId: THREAD,
    userId: 'user',
    agentId: CLAUDE,
    content: '我先写两数之和的哈希解法，再加可视化。',
    mentions: [],
    origin: 'stream',
    timestamp: 1_700_000_100_000,
    sessionId: 'cli-sess-1',
  });
  // Opening #2 seals #1 (computing its digest from the 1 message above).
  app.sessionStore.startSession(CLAUDE, THREAD, 'cli-sess-2');
}

interface InjectResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
}
async function call(
  app: BuiltApp,
  method: 'GET' | 'POST',
  url: string,
): Promise<InjectResult> {
  const res = await app.api.inject({ method, url });
  return { status: res.statusCode, body: res.json<Record<string, unknown>>() };
}

describe('GET /api/threads/:id/sessions — chain listing (happy)', () => {
  it('returns the chain ascending by seq, each with a digest; #1 sealed (1 msg) + #2 active', async () => {
    const app = makeApp();
    await seedChain(app);

    const { status, body } = await call(app, 'GET', `/api/threads/${THREAD}/sessions`);
    expect(status).toBe(200);
    const sessions = body.sessions as Array<Record<string, unknown>>;
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.sequenceNo)).toEqual([1, 2]);
    expect(sessions[0]).toMatchObject({ sessionId: 'cli-sess-1', status: 'sealed', agentId: 'claude-opus' });
    expect(sessions[1]).toMatchObject({ sessionId: 'cli-sess-2', status: 'active' });
    // The sealed session's digest reflects its 1 archived message.
    expect((sessions[0].digest as { messageCount: number }).messageCount).toBe(1);
    // The active session also carries a (freshly computed) digest, not null.
    expect(sessions[1].digest).not.toBeNull();
  });

  it('a thread with no sessions returns an empty chain (not an error)', async () => {
    const app = makeApp();
    const { status, body } = await call(app, 'GET', '/api/threads/thread_empty/sessions');
    expect(status).toBe(200);
    expect(body.sessions).toEqual([]);
  });
});

describe('GET /api/sessions/:id/transcript — transcript', () => {
  it('returns the merged transcript of a session (contains the archived message)', async () => {
    const app = makeApp();
    await seedChain(app);
    const { status, body } = await call(app, 'GET', '/api/sessions/cli-sess-1/transcript');
    expect(status).toBe(200);
    expect(body).toMatchObject({ sessionId: 'cli-sess-1', threadId: THREAD, agentId: 'claude-opus' });
    const events = body.events as Array<Record<string, unknown>>;
    expect(events.some((e) => typeof e.content === 'string' && (e.content as string).includes('哈希解法'))).toBe(true);
  });

  it('(edge) 404 for an unknown session id', async () => {
    const app = makeApp();
    await seedChain(app);
    expect((await call(app, 'GET', '/api/sessions/no-such-session/transcript')).status).toBe(404);
  });
});

describe('POST /api/sessions/:id/seal — the operable action', () => {
  it('seals the LIVE session; it then reads back as sealed in the chain', async () => {
    const app = makeApp();
    await seedChain(app);

    const sealed = await call(app, 'POST', '/api/sessions/cli-sess-2/seal');
    expect(sealed.status).toBe(200);
    expect(sealed.body).toMatchObject({ sessionId: 'cli-sess-2', status: 'sealed' });

    const chain = await call(app, 'GET', `/api/threads/${THREAD}/sessions`);
    const sessions = chain.body.sessions as Array<Record<string, unknown>>;
    expect(sessions.every((s) => s.status === 'sealed')).toBe(true);
  });

  it('(adversarial) sealing an ALREADY-SEALED session → 409, not a double-seal', async () => {
    const app = makeApp();
    await seedChain(app);
    // #1 is already sealed (seedChain opened #2 over it).
    const { status, body } = await call(app, 'POST', '/api/sessions/cli-sess-1/seal');
    expect(status).toBe(409);
    expect(body).toMatchObject({ error: 'not_active', status: 'sealed' });
  });

  it('(adversarial) sealing an UNKNOWN session → 404 (no spurious mutation)', async () => {
    const app = makeApp();
    await seedChain(app);
    expect((await call(app, 'POST', '/api/sessions/ghost/seal')).status).toBe(404);
    // The real chain is untouched: #2 still active.
    const chain = await call(app, 'GET', `/api/threads/${THREAD}/sessions`);
    const sessions = chain.body.sessions as Array<Record<string, unknown>>;
    expect(sessions.find((s) => s.sessionId === 'cli-sess-2')?.status).toBe('active');
  });
});

describe('POST /api/sessions/:id/reopen — resume a sealed session', () => {
  it('reopens a SEALED session as the live one, sealing the previously-active one (≤1 active)', async () => {
    const app = makeApp();
    await seedChain(app); // #1 sealed, #2 active

    const reopened = await call(app, 'POST', '/api/sessions/cli-sess-1/reopen');
    expect(reopened.status).toBe(200);
    expect(reopened.body).toMatchObject({ sessionId: 'cli-sess-1', status: 'active' });

    const chain = await call(app, 'GET', `/api/threads/${THREAD}/sessions`);
    const sessions = chain.body.sessions as Array<Record<string, unknown>>;
    // #1 is now active; #2 (the previously active) got sealed → still exactly one active.
    expect(sessions.find((s) => s.sessionId === 'cli-sess-1')?.status).toBe('active');
    expect(sessions.find((s) => s.sessionId === 'cli-sess-2')?.status).toBe('sealed');
    expect(sessions.filter((s) => s.status === 'active')).toHaveLength(1);
  });

  it('(edge) reopening an ALREADY-ACTIVE session → 409', async () => {
    const app = makeApp();
    await seedChain(app);
    const { status, body } = await call(app, 'POST', '/api/sessions/cli-sess-2/reopen');
    expect(status).toBe(409);
    expect(body).toMatchObject({ error: 'already_active' });
  });

  it('(adversarial) reopening an UNKNOWN session → 404', async () => {
    const app = makeApp();
    await seedChain(app);
    expect((await call(app, 'POST', '/api/sessions/ghost/reopen')).status).toBe(404);
  });

  it('(adversarial, multi-agent) reopening one of CLAUDE\'s sealed sessions over HTTP seals CLAUDE\'s active but leaves CODEX\'s active untouched', async () => {
    const app = makeApp();
    // ONE thread: CLAUDE has a 2-session chain (#1 sealed, #2 active); CODEX has
    // its own active session on the same thread. Seeded through the real store.
    await app.stores.threadStore.ensureThread(THREAD, 'Two Sum 可视化');
    app.sessionStore.startSession(CLAUDE, THREAD, 'cli-claude-1');
    app.sessionStore.startSession(CLAUDE, THREAD, 'cli-claude-2'); // seals #1; #2 active
    app.sessionStore.startSession(CODEX, THREAD, 'cli-codex-1'); // independent active slot

    // Act: reopen CLAUDE's SEALED #1 over HTTP.
    const reopened = await call(app, 'POST', '/api/sessions/cli-claude-1/reopen');
    expect(reopened.status).toBe(200);
    expect(reopened.body).toMatchObject({ sessionId: 'cli-claude-1', status: 'active' });

    // The whole thread chain: CLAUDE side flipped, CODEX side untouched.
    const chain = await call(app, 'GET', `/api/threads/${THREAD}/sessions`);
    const sessions = chain.body.sessions as Array<Record<string, unknown>>;
    const byId = (id: string): string | undefined =>
      sessions.find((s) => s.sessionId === id)?.status as string | undefined;
    expect(byId('cli-claude-1')).toBe('active');
    expect(byId('cli-claude-2')).toBe('sealed');
    // The key adversarial assertion: CODEX's active session is NOT collateral-sealed.
    expect(byId('cli-codex-1')).toBe('active');
    // Exactly two active rows across the thread — one per agent, never one or three.
    expect(sessions.filter((s) => s.status === 'active')).toHaveLength(2);
    // Each agent has exactly one active session id.
    expect(app.sessionStore.getActiveSessionId(CLAUDE, THREAD)).toBe('cli-claude-1');
    expect(app.sessionStore.getActiveSessionId(CODEX, THREAD)).toBe('cli-codex-1');
  });
});
