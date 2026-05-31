// tests/api/session-archive.edge.test.ts
// QA lifecycle integration for the session archive (补充 E E3.3/E3.4), via the
// REAL wiring: buildApp() + a FakeAgentService at the provider seam (the design,
// not a mock). Independently authored (≠ the dev). Asserts that an agent reply's
// persisted message + tool events get tagged with the turn's session_id, that the
// user's own message stays null, that a fresh session_init seals the prior active
// session and opens a new one, and that getTranscript partitions events per
// session. Real :memory: SQLite, real agent ids / tool names.

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { AgentMessage } from '@clowder/shared';
import { buildApp, type BuiltApp } from '@clowder/api/app-factory';
import { FakeAgentService } from '../invocation/fake-agent-service.js';
import { CLAUDE } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

/** A reply scripted to a specific session id: init → tool_use/result → text → done. */
function replyWithSession(sessionId: string, base: number, toolPath: string): AgentMessage[] {
  return [
    { type: 'session_init', agentId: CLAUDE, content: sessionId, timestamp: base },
    {
      type: 'tool_use',
      agentId: CLAUDE,
      toolName: 'write_file',
      toolUseId: `tu-${sessionId}`,
      toolInput: { path: toolPath },
      timestamp: base + 10,
    },
    {
      type: 'tool_result',
      agentId: CLAUDE,
      toolUseId: `tu-${sessionId}`,
      content: 'ok',
      timestamp: base + 40,
    },
    { type: 'text', agentId: CLAUDE, content: `done in ${sessionId}`, timestamp: base + 50 },
    { type: 'done', agentId: CLAUDE, isFinal: true, timestamp: base + 60 },
  ];
}

async function post(app: BuiltApp, threadId: string, content: string): Promise<number> {
  const res = await app.api.inject({
    method: 'POST',
    url: `/api/threads/${threadId}/messages`,
    payload: { content, userId: 'user-makima' },
  });
  return res.statusCode;
}

describe('Session archive lifecycle (integration via buildApp, edge)', () => {
  it("tags the agent reply's persisted message + tool events with the turn's session_id", async () => {
    const db = new Database(':memory:');
    const fakes = {
      'claude-opus': new FakeAgentService([replyWithSession('sess-life-1', 1_700_000_000_000, 'src/auth.ts')]),
    };
    const app = buildApp({ db, agentServices: fakes });
    cleanups.push(app.close);
    const threadId = 'thread-life-1';

    expect(await post(app, threadId, '@claude implement the auth guard')).toBe(200);

    // The session row was opened (active) by session_init.
    expect(app.sessionStore.getActiveSessionId(CLAUDE, threadId)).toBe('sess-life-1');

    // The agent reply message is tagged with the session id.
    const replies = await app.stores.messageStore.getBySession('sess-life-1');
    expect(replies).toHaveLength(1);
    expect(replies[0]?.agentId).toBe(CLAUDE);
    expect(replies[0]?.content).toBe('done in sess-life-1');

    // The durable tool event is tagged with the same session id.
    const toolEvents = await app.stores.toolEventLog.readBySession('sess-life-1');
    expect(toolEvents).toHaveLength(1);
    expect(toolEvents[0]?.toolName).toBe('write_file');

    // getTranscript merges both, by timestamp.
    const tx = await app.sessionStore.getTranscript('sess-life-1');
    expect(tx.map((e) => e.kind)).toEqual(['tool_event', 'message']);
    db.close();
  });

  it('leaves the user message untagged (null session_id) while tagging the agent reply', async () => {
    const db = new Database(':memory:');
    const fakes = {
      'claude-opus': new FakeAgentService([replyWithSession('sess-user-null', 1_700_000_100_000, 'src/x.ts')]),
    };
    const app = buildApp({ db, agentServices: fakes });
    cleanups.push(app.close);
    const threadId = 'thread-user-null';

    expect(await post(app, threadId, '@claude add a healthcheck endpoint')).toBe(200);

    // Full thread history: the user message (null agentId) carries no session tag,
    // so it never appears in any session transcript.
    const all = await app.stores.messageStore.getByThread(threadId, 100);
    const userMsg = all.find((m) => m.agentId === null);
    expect(userMsg).toBeDefined();
    expect(userMsg?.sessionId).toBeUndefined();

    const tagged = await app.stores.messageStore.getBySession('sess-user-null');
    expect(tagged.every((m) => m.agentId !== null)).toBe(true);
    db.close();
  });

  it('a second turn with a fresh session_init seals the prior active session and opens a new one', async () => {
    const db = new Database(':memory:');
    const fakes = {
      'claude-opus': new FakeAgentService([
        replyWithSession('sess-turn-1', 1_700_000_200_000, 'src/first.ts'),
        replyWithSession('sess-turn-2', 1_700_000_300_000, 'src/second.ts'),
      ]),
    };
    const app = buildApp({ db, agentServices: fakes });
    cleanups.push(app.close);
    const threadId = 'thread-two-turns';

    expect(await post(app, threadId, '@claude start the feature')).toBe(200);
    expect(app.sessionStore.getActiveSessionId(CLAUDE, threadId)).toBe('sess-turn-1');

    expect(await post(app, threadId, '@claude continue with a new session')).toBe(200);

    // The new session is active; the old one is sealed (kept, with a digest).
    expect(app.sessionStore.getActiveSessionId(CLAUDE, threadId)).toBe('sess-turn-2');
    const first = app.sessionStore.getSession('sess-turn-1');
    expect(first?.status).toBe('sealed');
    expect(first?.sealedAt).toBeDefined();
    expect(first?.digest).toBeDefined();
    const second = app.sessionStore.getSession('sess-turn-2');
    expect(second?.status).toBe('active');

    // The chain lists both, in sequence order.
    const chain = app.sessionStore.listByThread(threadId);
    expect(chain.map((s) => s.sessionId)).toEqual(['sess-turn-1', 'sess-turn-2']);
    expect(chain.map((s) => s.sequenceNo)).toEqual([1, 2]);
    db.close();
  });

  it('getTranscript partitions events between the two sessions of a thread', async () => {
    const db = new Database(':memory:');
    const fakes = {
      'claude-opus': new FakeAgentService([
        replyWithSession('sess-part-1', 1_700_000_400_000, 'src/one.ts'),
        replyWithSession('sess-part-2', 1_700_000_500_000, 'src/two.ts'),
      ]),
    };
    const app = buildApp({ db, agentServices: fakes });
    cleanups.push(app.close);
    const threadId = 'thread-partition';

    expect(await post(app, threadId, '@claude phase one')).toBe(200);
    expect(await post(app, threadId, '@claude phase two')).toBe(200);

    const tx1 = await app.sessionStore.getTranscript('sess-part-1');
    const tx2 = await app.sessionStore.getTranscript('sess-part-2');

    // Each transcript contains exactly its own turn's tool event + reply.
    const files1 = tx1.filter((e) => e.kind === 'tool_event').map((e) => e.toolInput);
    const files2 = tx2.filter((e) => e.kind === 'tool_event').map((e) => e.toolInput);
    expect(files1).toEqual([JSON.stringify({ path: 'src/one.ts' })]);
    expect(files2).toEqual([JSON.stringify({ path: 'src/two.ts' })]);
    expect(tx1.some((e) => e.content === 'done in sess-part-1')).toBe(true);
    expect(tx1.some((e) => e.content === 'done in sess-part-2')).toBe(false);
    expect(tx2.some((e) => e.content === 'done in sess-part-2')).toBe(true);

    // The sealed (first) session's digest reflects its single tool call + reply.
    const digest1 = await app.sessionStore.getDigest('sess-part-1');
    expect(digest1?.messageCount).toBe(1);
    expect(digest1?.toolCounts['write_file']).toBe(1);
    expect(digest1?.filesTouched).toEqual(['src/one.ts']);
    db.close();
  });
});
