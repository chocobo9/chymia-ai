// audit-routes — GET /api/audit/thread/:id merges the tool-event log + agent
// replies + session boundaries into one time-ordered timeline. Seeded directly
// through the SAME stores the engine uses (BuiltApp exposes them) — real audit
// data, not mocks.

import Database from 'better-sqlite3';
import { describe, it, expect, afterEach } from 'vitest';
import type { AuditEntry } from '@choco/shared';
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

const THREAD = 'thread_audit';

/** Seed a thread with 1 tool call, 2 agent replies (1 normal + 1 system notice), 1 sealed session. */
async function seed(app: BuiltApp): Promise<void> {
  await app.stores.threadStore.ensureThread(THREAD, '审计测试');
  await app.stores.toolEventLog.append({
    invocationId: 'inv-1',
    threadId: THREAD,
    agentId: CLAUDE,
    toolName: 'Write',
    timestamp: 1_700_000_010_000,
    durationMs: 42,
    sessionId: 'sess-1',
  });
  await app.stores.messageStore.append({
    threadId: THREAD,
    userId: 'user',
    agentId: CLAUDE,
    content: '写好了 two-sum-viz.html，包含步骤演示。',
    mentions: [],
    origin: 'stream',
    timestamp: 1_700_000_020_000,
    sessionId: 'sess-1',
    extra: { toolEvents: [{ type: 'tool_use' }, { type: 'tool_use' }] },
  });
  await app.stores.messageStore.append({
    threadId: THREAD,
    userId: 'user',
    agentId: CODEX,
    content: '@codex 当前未启用（CLI 未检测到）。',
    mentions: [],
    origin: 'system',
    timestamp: 1_700_000_030_000,
  });
  app.sessionStore.startSession(CLAUDE, THREAD, 'sess-1');
  app.sessionStore.sealActiveSession(CLAUDE, THREAD);
}

async function getAudit(app: BuiltApp, threadId: string): Promise<{ status: number; entries: AuditEntry[] }> {
  const res = await app.api.inject({ method: 'GET', url: `/api/audit/thread/${threadId}` });
  const body = res.json<{ entries: AuditEntry[] }>();
  return { status: res.statusCode, entries: body.entries };
}

describe('GET /api/audit/thread/:id — merged timeline (happy)', () => {
  it('merges tool calls + replies + session boundaries, ascending by timestamp', async () => {
    const app = makeApp();
    await seed(app);
    const { status, entries } = await getAudit(app, THREAD);
    expect(status).toBe(200);

    // One of each kind seeded: 1 tool, 2 replies, session start + seal.
    const byType = (t: AuditEntry['type']): AuditEntry[] => entries.filter((e) => e.type === t);
    expect(byType('tool')).toHaveLength(1);
    expect(byType('reply')).toHaveLength(2);
    expect(byType('session_start')).toHaveLength(1);
    expect(byType('session_seal')).toHaveLength(1);

    // Sorted ascending by timestamp (the route sorts — holds for any values).
    for (let i = 1; i < entries.length; i += 1) {
      expect(entries[i]!.timestamp).toBeGreaterThanOrEqual(entries[i - 1]!.timestamp);
    }
  });

  it('attributes each entry to its agent + carries the type-specific fields', async () => {
    const app = makeApp();
    await seed(app);
    const { entries } = await getAudit(app, THREAD);

    const tool = entries.find((e) => e.type === 'tool');
    expect(tool).toMatchObject({ agentId: 'claude-opus', toolName: 'Write', durationMs: 42, invocationId: 'inv-1' });

    const normalReply = entries.find((e) => e.type === 'reply' && e.isError !== true);
    expect(normalReply).toMatchObject({ agentId: 'claude-opus', toolCount: 2 });
    expect(normalReply?.textChars).toBeGreaterThan(0);

    // The system/notice reply is flagged isError and attributed to codex.
    const notice = entries.find((e) => e.type === 'reply' && e.isError === true);
    expect(notice).toMatchObject({ agentId: 'codex-gpt', isError: true });
  });
});

describe('GET /api/audit/thread/:id — edge', () => {
  it('a thread with no activity returns an empty timeline (not an error)', async () => {
    const app = makeApp();
    const { status, entries } = await getAudit(app, 'thread_nothing');
    expect(status).toBe(200);
    expect(entries).toEqual([]);
  });

  it('user messages are NOT audited (only agent activity)', async () => {
    const app = makeApp();
    await app.stores.threadStore.ensureThread(THREAD, 'u');
    await app.stores.messageStore.append({
      threadId: THREAD,
      userId: 'user',
      agentId: null,
      content: '帮我写个 two-sum 可视化',
      mentions: [],
      origin: 'user',
      timestamp: 1_700_000_005_000,
    });
    const { entries } = await getAudit(app, THREAD);
    expect(entries).toEqual([]);
  });
});
