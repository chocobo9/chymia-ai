// audit-routes — GET /api/audit/thread/:id returns the thread's EMITTED audit
// events. This is an integration test against the REAL engine: a turn is driven
// through buildApp (only the CLI is faked), so the invoke seam EMITS invoked +
// responded events, and the route reads them back from the real EventAuditLog —
// no hand-seeded audit rows, no mocks of the route.

import Database from 'better-sqlite3';
import { describe, it, expect, afterEach } from 'vitest';
import type { AgentMessage, AuditEvent } from '@choco/shared';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';
import { CLAUDE } from './helpers.js';
import { FakeAgentService } from '../invocation/fake-agent-service.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** A scripted turn: session_init → text → (optional tool) → done. */
function turn(text: string, withTool: boolean): AgentMessage[] {
  const ts = 1_700_000_000_000;
  const events: AgentMessage[] = [
    { type: 'session_init', agentId: CLAUDE, content: 'cli-sess-audit', timestamp: ts },
    { type: 'text', agentId: CLAUDE, content: text, timestamp: ts + 1 },
  ];
  if (withTool) {
    events.push({ type: 'tool_use', agentId: CLAUDE, toolName: 'Write', toolUseId: 't1', toolInput: { file_path: 'x.html' }, timestamp: ts + 2 });
    events.push({ type: 'tool_result', agentId: CLAUDE, toolUseId: 't1', content: 'ok', timestamp: ts + 3 });
  }
  events.push({ type: 'done', agentId: CLAUDE, isFinal: true, timestamp: ts + 4 });
  return events;
}

function makeApp(scripts: AgentMessage[][]): BuiltApp {
  const db = new Database(':memory:');
  const app = buildApp({ db, agentServices: { 'claude-opus': new FakeAgentService(scripts) } });
  cleanups.push(app.close);
  return app;
}

/** Drive one real turn on a platform channel and return its threadId. */
async function driveTurn(app: BuiltApp, channelId: string, text: string): Promise<string> {
  const r = await app.submitPlatformMessage({
    adapterName: 'wechat', channelId, platformUserId: 'u', platformMessageId: `m_${channelId}`,
    text: `@claude-opus ${text}`, receivedAt: 1_700_000_000_000,
  });
  return r.threadId;
}

async function getAudit(app: BuiltApp, threadId: string): Promise<{ status: number; events: AuditEvent[] }> {
  const res = await app.api.inject({ method: 'GET', url: `/api/audit/thread/${threadId}` });
  return { status: res.statusCode, events: res.json<{ events: AuditEvent[] }>().events };
}

describe('GET /api/audit/thread/:id — emitted audit events (happy)', () => {
  it('a real turn emits invoked + responded, carrying the turn summary in data', async () => {
    const app = makeApp([turn('已写好可视化。', true)]);
    const threadId = await driveTurn(app, 'gh_a', '写个可视化');

    const { status, events } = await getAudit(app, threadId);
    expect(status).toBe(200);

    const types = events.map((e) => e.type);
    expect(types).toContain('invoked');
    expect(types).toContain('responded');

    const invoked = events.find((e) => e.type === 'invoked');
    expect(invoked?.data).toMatchObject({ agentId: 'claude-opus', mode: 'serial' });
    expect(typeof invoked?.data.invocationId).toBe('string');
    // The agent's INPUT is recorded on `invoked` — so the user can see what each
    // agent actually received (prior gap: invocations carried no input at all).
    expect(typeof invoked?.data.prompt).toBe('string');
    expect(invoked?.data.prompt as string).toContain('写个可视化');

    const responded = events.find((e) => e.type === 'responded');
    expect(responded?.data).toMatchObject({ agentId: 'claude-opus', toolCalls: 1 });
    expect(typeof responded?.data.durationMs).toBe('number');
    expect(responded?.data.timings).toMatchObject({
      prepareMs: expect.any(Number),
      invokeMs: expect.any(Number),
      totalMs: expect.any(Number),
      mutexWaitMs: expect.any(Number),
      providerMs: expect.any(Number),
      firstProviderEventMs: expect.any(Number),
      firstOutputMs: expect.any(Number),
    });
    expect(responded?.data.textChars as number).toBeGreaterThan(0);
    // invoked + responded share the same invocationId (one turn).
    expect(responded?.data.invocationId).toBe(invoked?.data.invocationId);
  });

  it('events are returned newest-first', async () => {
    const app = makeApp([turn('一', false)]);
    const threadId = await driveTurn(app, 'gh_b', '一');
    const { events } = await getAudit(app, threadId);
    expect(events.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < events.length; i += 1) {
      expect(events[i - 1]!.timestamp).toBeGreaterThanOrEqual(events[i]!.timestamp);
    }
  });
});

describe('GET /api/audit/thread/:id — edge / adversarial', () => {
  it('[edge] a thread with no activity returns an empty event list (not an error)', async () => {
    const app = makeApp([]);
    const { status, events } = await getAudit(app, 'thread_nothing');
    expect(status).toBe(200);
    expect(events).toEqual([]);
  });

  it('[fallback] 老 thread (history but no emitted events) falls back to 派生 — non-empty, every event derived', async () => {
    // A thread whose history was persisted DIRECTLY through the stores (the
    // 9df7fb4-之前 shape) — never driven through the invoke seam, so NO audit event
    // was ever emitted for it. The route MUST fall back to deriving from
    // messages/tools/sessions so the old thread's audit is NOT empty. 上次重建炸掉
    // 的正是这一点：派生被删 → 老 thread 全空。这条测试钉住「老 thread 不变空」。
    const app = makeApp([]);
    const LEGACY = 'thread_legacy_pre_eventlog';
    await app.stores.threadStore.ensureThread(LEGACY, '两数之和可视化');
    await app.stores.messageStore.append({
      threadId: LEGACY,
      userId: 'user',
      agentId: CLAUDE,
      content: '写好了 two-sum-viz.html，含哈希解法的逐步动画。',
      mentions: [],
      origin: 'stream',
      timestamp: 1_700_000_020_000,
      sessionId: 'sess-legacy',
      extra: { toolEvents: [{ type: 'tool_use' }] },
    });
    await app.stores.toolEventLog.append({
      invocationId: 'inv-legacy',
      threadId: LEGACY,
      agentId: CLAUDE,
      toolName: 'Write',
      toolInput: '{"file_path":"two-sum-viz.html"}',
      toolResult: 'wrote 1.2KB',
      timestamp: 1_700_000_010_000,
      durationMs: 42,
      sessionId: 'sess-legacy',
    });
    // A still-active session (NOT sealed here). P0-6 made sealActiveSession emit a
    // REAL session_seal audit event (via SessionStore.onSeal) — sealing here would
    // make this thread non-empty and skip the derived path this test exercises. The
    // session boundary still surfaces as a DERIVED session_start from the sessions row.
    app.sessionStore.startSession(CLAUDE, LEGACY, 'sess-legacy');

    const { status, events } = await getAudit(app, LEGACY);
    expect(status).toBe(200);
    // NOT empty — the old thread still has an audit (the regression was it going empty).
    expect(events.length).toBeGreaterThan(0);
    // Every derived event is flagged, so the source is honest about the fallback.
    expect(events.every((e) => e.data.derived === true)).toBe(true);
    // The persisted history surfaces as derived events of the right kinds.
    const types = events.map((e) => e.type);
    expect(types).toContain('responded'); // the agent reply
    expect(types).toContain('session_start'); // the session boundary (derived from the sessions row)
  });

  it('[edge] sealing a session over HTTP emits a session_seal audit event', async () => {
    const app = makeApp([turn('开工', false)]);
    const threadId = await driveTurn(app, 'gh_seal', '开工');
    // The turn opened session cli-sess-audit (active) — seal it via the real route.
    const sealed = await app.api.inject({ method: 'POST', url: '/api/sessions/cli-sess-audit/seal' });
    expect(sealed.statusCode).toBe(200);

    const { events } = await getAudit(app, threadId);
    const seal = events.find((e) => e.type === 'session_seal');
    expect(seal?.data).toMatchObject({ sessionId: 'cli-sess-audit', agentId: 'claude-opus' });
  });

  it('[adversarial] audit events are thread-isolated (one thread never leaks another\'s)', async () => {
    const app = makeApp([turn('A', false), turn('B', false)]);
    const threadA = await driveTurn(app, 'gh_iso_a', 'A');
    const threadB = await driveTurn(app, 'gh_iso_b', 'B');
    expect(threadA).not.toBe(threadB);

    const a = await getAudit(app, threadA);
    const b = await getAudit(app, threadB);
    expect(a.events.length).toBeGreaterThan(0);
    expect(b.events.length).toBeGreaterThan(0);
    expect(a.events.every((e) => e.threadId === threadA)).toBe(true);
    expect(b.events.every((e) => e.threadId === threadB)).toBe(true);
  });
});
