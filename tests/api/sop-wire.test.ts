// SOP-Cycle-1 dev happy-path suite — the 告示牌 producer + injection loop (M12).
//
// QA (≠ this dev) owns edge + adversarial + e2e gating. These happy tests prove
// the four wired pieces end-to-end through the REAL buildApp pipeline (in-memory
// db + Fake provider), with real agent ids and real stage ids — no placeholders:
//   A) the SOP stage hint reaches the agent's system prompt when a stage is set,
//      and a thread with NO stage produces no SOP line.
//   B) a project thread defaults to 'kickoff'; a non-project thread stays unstaged.
//   C) PATCH /api/threads/:id/sop-stage sets a valid stage (200) / rejects unknown (400).
//   D) POST /api/callback/sop_advance_stage advances the verified record's thread,
//      and the MCP server registers/lists the sop_advance_stage tool.

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { AgentMessage, Thread } from '@clowder/shared';
import { createAgentId } from '@clowder/shared';
import { buildApp, type BuiltApp } from '@clowder/api/app-factory';
import { SqliteThreadStore } from '@clowder/api/stores/sqlite-thread-store';
import { CallbackClient } from '@clowder/mcp-server/callback-client';
import { createServer } from '@clowder/mcp-server/index';
import { FakeAgentService } from '../invocation/fake-agent-service.js';

const CLAUDE = createAgentId('claude-opus');

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

/** A `session_init`→`text`→`done` reply script for one Claude turn. */
function claudeReply(text: string): AgentMessage[] {
  const ts = 1_748_600_000_000;
  return [
    { type: 'session_init', agentId: CLAUDE, content: 'sess-claude', timestamp: ts },
    { type: 'text', agentId: CLAUDE, content: text, timestamp: ts + 1 },
    { type: 'done', agentId: CLAUDE, isFinal: true, timestamp: ts + 2 },
  ];
}

/** Build an inject-only app with a single scripted Claude turn. */
function appWithClaude(): { app: BuiltApp; fake: FakeAgentService } {
  const fake = new FakeAgentService([claudeReply('已收到，按 SOP 推进。')]);
  const app = buildApp({ db: new Database(':memory:'), agentServices: { 'claude-opus': fake } });
  cleanups.push(app.close);
  return { app, fake };
}

/** Drive one user turn that mentions Claude through the HTTP message route. */
async function postClaudeTurn(app: BuiltApp, threadId: string): Promise<void> {
  await app.api.inject({
    method: 'POST',
    url: `/api/threads/${threadId}/messages`,
    payload: { content: '@claude 请按当前阶段推进这个功能。' },
  });
}

describe('A) SOP hint injection at the invoke seam (happy path)', () => {
  it('injects the stage hint into the system prompt when the thread has a stage', async () => {
    const { app, fake } = appWithClaude();

    // A project thread defaults to 'kickoff' (piece B) — set 'impl' explicitly so
    // the asserted hint text is unambiguous.
    const threadId = 'thread-sop-impl';
    await app.stores.threadStore.create({ id: threadId, projectPath: 'D:/proj/choco-ai' });
    await app.stores.threadStore.updateSopStage(threadId, 'impl');

    await postClaudeTurn(app, threadId);

    expect(fake.calls).toHaveLength(1);
    const systemPrompt = fake.calls[0]?.options?.systemPrompt ?? '';
    // The 告示牌 line buildSystemPrompt renders from sopStageHint (impl stage).
    expect(systemPrompt).toContain('SOP:');
    expect(systemPrompt).toContain('实现'); // impl stage label
    expect(systemPrompt).toContain('writing-plans'); // impl suggested skill
  });

  it('renders NO SOP line when the thread has no stage', async () => {
    const { app, fake } = appWithClaude();

    // Auto-created on first message → no projectPath → no SOP stage.
    const threadId = 'thread-no-stage';
    await postClaudeTurn(app, threadId);

    expect(fake.calls).toHaveLength(1);
    const systemPrompt = fake.calls[0]?.options?.systemPrompt ?? '';
    expect(systemPrompt).not.toContain('SOP:');
  });
});

describe('B) project-thread default SOP stage (happy path)', () => {
  it("defaults a project thread to 'kickoff' and leaves a non-project thread unstaged", async () => {
    const db = new Database(':memory:');
    const store = new SqliteThreadStore(db);

    const projectThread = await store.create({
      title: 'TODO API 重构',
      projectPath: 'D:/proj/choco-ai',
    });
    expect(projectThread.sopStageId).toBe('kickoff');

    const plainThread = await store.create({ title: '随手讨论' });
    expect(plainThread.sopStageId).toBeUndefined();

    // The default round-trips through SQLite, not just the in-memory object.
    const fetched = await store.get(projectThread.id);
    expect(fetched?.sopStageId).toBe('kickoff');

    db.close();
  });

  it('honours an explicit sopStageId over the project default', async () => {
    const db = new Database(':memory:');
    const store = new SqliteThreadStore(db);

    const thread = await store.create({
      projectPath: 'D:/proj/choco-ai',
      sopStageId: 'review',
    });
    expect(thread.sopStageId).toBe('review');

    db.close();
  });
});

describe('C) PATCH /api/threads/:id/sop-stage (happy path)', () => {
  it('sets a valid stage (200) and persists it on the thread', async () => {
    const { app } = appWithClaude();
    const created = await app.stores.threadStore.create({ title: '支付服务功能' });

    const res = await app.api.inject({
      method: 'PATCH',
      url: `/api/threads/${created.id}/sop-stage`,
      payload: { stageId: 'quality_gate' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<Thread>().sopStageId).toBe('quality_gate');
    expect((await app.stores.threadStore.get(created.id))?.sopStageId).toBe('quality_gate');
  });

  it('clears the stage when stageId is null (200)', async () => {
    const { app } = appWithClaude();
    const created = await app.stores.threadStore.create({
      title: '清空阶段',
      projectPath: 'D:/proj/choco-ai',
    });
    expect(created.sopStageId).toBe('kickoff');

    const res = await app.api.inject({
      method: 'PATCH',
      url: `/api/threads/${created.id}/sop-stage`,
      payload: { stageId: null },
    });

    expect(res.statusCode).toBe(200);
    expect((await app.stores.threadStore.get(created.id))?.sopStageId).toBeUndefined();
  });

  it('rejects an unknown stage with 400', async () => {
    const { app } = appWithClaude();
    const created = await app.stores.threadStore.create({ title: '未知阶段' });

    const res = await app.api.inject({
      method: 'PATCH',
      url: `/api/threads/${created.id}/sop-stage`,
      payload: { stageId: 'not-a-real-stage' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('unknown_sop_stage');
  });

  it('returns 404 for an unknown thread', async () => {
    const { app } = appWithClaude();
    const res = await app.api.inject({
      method: 'PATCH',
      url: '/api/threads/no-such-thread/sop-stage',
      payload: { stageId: 'impl' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('D) sop_advance_stage callback + MCP tool (happy path)', () => {
  it('advances the verified record\'s thread to a valid stage (200)', async () => {
    const db = new Database(':memory:');
    const app = buildApp({ db });
    cleanups.push(app.close);

    const threadId = 'thread-agent-advance';
    await app.stores.threadStore.ensureThread(threadId, '功能开发');
    const record = app.invocations.create({ userId: 'user', agentId: CLAUDE, threadId });

    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/sop_advance_stage',
      headers: {
        'x-invocation-id': record.invocationId,
        'x-callback-token': record.callbackToken,
      },
      payload: { stageId: 'review' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ stageId: string }>().stageId).toBe('review');
    // Effect lands on THIS thread (the verified record's), not a body-supplied one.
    expect((await app.stores.threadStore.get(threadId))?.sopStageId).toBe('review');
  });

  it('rejects an unknown stage with 400', async () => {
    const db = new Database(':memory:');
    const app = buildApp({ db });
    cleanups.push(app.close);

    const threadId = 'thread-bad-advance';
    await app.stores.threadStore.ensureThread(threadId, '功能开发');
    const record = app.invocations.create({ userId: 'user', agentId: CLAUDE, threadId });

    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/sop_advance_stage',
      headers: {
        'x-invocation-id': record.invocationId,
        'x-callback-token': record.callbackToken,
      },
      payload: { stageId: 'totally-unknown' },
    });

    expect(res.statusCode).toBe(400);
  });

  it('registers the sop_advance_stage MCP tool in tools/list', async () => {
    const server = createServer(new CallbackClient({ env: {} }));
    const client = new Client({ name: 'sop-test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const listed = await client.listTools();
    expect(listed.tools.map((t) => t.name)).toContain('sop_advance_stage');

    await client.close();
    await server.close();
  });
});
