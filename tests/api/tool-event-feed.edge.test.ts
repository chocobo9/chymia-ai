// M5-amend QA — ToolEventLog LIVE FEED edge + adversarial coverage (independent).
//
// Authored by the M5-amend QA subagent (CLAUDE.md §0.5.3). Drives the REAL
// POST /api/threads/:id/messages → router → invoke seam → message-routes durable
// sink (FakeAgentService injected at the DESIGNED provider boundary — NOT a mock
// of M5). Machine gate for: per-call tool_use↔tool_result correlation + durationMs,
// interleaved/parallel pairing, unpaired tool_use rows, real minted invocationId,
// BOTH sinks (extra.toolEvents AND tool_events) co-existing (M7 contract), cross-
// thread isolation, tool-less replies writing nothing, and the best-effort error
// path (a failing append must NOT fail the HTTP request).
//
// Real tool names only (read_file / evidence_search / post_message / run_tests).

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { AgentId, AgentMessage, StoredMessage } from '@choco/shared';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';
import type { RouteLogger } from '@choco/api/routing/agent-router';
import { FakeAgentService } from '../invocation/fake-agent-service.js';
import { CLAUDE, CODEX } from './helpers.js';

/** One structured log event captured from the injected {@link RouteLogger} seam. */
type CapturedLog = Parameters<RouteLogger>[0];

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

interface InjectedApp {
  readonly app: BuiltApp;
  readonly db: Database.Database;
}

function injectApp(services: Record<string, FakeAgentService>): InjectedApp {
  const db = new Database(':memory:');
  const app = buildApp({ db, agentServices: services });
  cleanups.push(app.close);
  return { app, db };
}

/** Like {@link injectApp} but wires a capturing {@link RouteLogger} into the app. */
function injectAppWithLogger(
  services: Record<string, FakeAgentService>,
  captured: CapturedLog[],
): InjectedApp {
  const db = new Database(':memory:');
  const logger: RouteLogger = (event) => {
    captured.push(event);
  };
  const app = buildApp({ db, agentServices: services, logger });
  cleanups.push(app.close);
  return { app, db };
}

async function post(injected: InjectedApp, threadId: string, content: string): Promise<number> {
  const res = await injected.app.api.inject({
    method: 'POST',
    url: `/api/threads/${threadId}/messages`,
    payload: { content, userId: 'user-makima' },
  });
  return res.statusCode;
}

/** A tool_use event for the given agent. */
function toolUse(
  agentId: AgentId,
  toolName: string,
  toolUseId: string,
  toolInput: Record<string, unknown>,
  ts: number,
): AgentMessage {
  return { type: 'tool_use', agentId, toolName, toolUseId, toolInput, timestamp: ts };
}

/** A tool_result event paired to a tool_use by id. */
function toolResult(agentId: AgentId, toolUseId: string, content: string, ts: number): AgentMessage {
  return { type: 'tool_result', agentId, toolUseId, content, timestamp: ts };
}

describe('ToolEventLog live feed — multi-call correlation (edge)', () => {
  it('pairs each of two tool calls with its OWN result (per-call durationMs)', async () => {
    const base = 1_700_002_000_000;
    const script: AgentMessage[] = [
      { type: 'session_init', agentId: CLAUDE, content: 'sess', timestamp: base },
      toolUse(CLAUDE, 'read_file', 'tu-a', { path: 'a.ts' }, base + 10),
      toolResult(CLAUDE, 'tu-a', '// file a', base + 30), // 20ms
      toolUse(CLAUDE, 'evidence_search', 'tu-b', { query: '路由设计' }, base + 40),
      toolResult(CLAUDE, 'tu-b', '命中 3 条证据', base + 115), // 75ms
      { type: 'text', agentId: CLAUDE, content: '评审完成。', timestamp: base + 120 },
      { type: 'done', agentId: CLAUDE, isFinal: true, timestamp: base + 130 },
    ];
    const inj = injectApp({ 'claude-opus': new FakeAgentService([script]) });

    expect(await post(inj, 'thread-multi', '@claude 双工具评审')).toBe(200);

    const rows = await inj.app.stores.toolEventLog.readByThread('thread-multi');
    expect(rows).toHaveLength(2);
    const byName = new Map(rows.map((r) => [r.toolName, r]));
    expect(byName.get('read_file')?.durationMs).toBe(20);
    expect(byName.get('read_file')?.toolResult).toBe('// file a');
    expect(byName.get('evidence_search')?.durationMs).toBe(75);
    expect(byName.get('evidence_search')?.toolInput).toBe(JSON.stringify({ query: '路由设计' }));
  });

  it('does not cross-assign results when tool_use/tool_result are interleaved out of order', async () => {
    // Both tool_use events arrive, THEN both results — results must still bind by
    // toolUseId to the correct call, not FIFO-misassign.
    const base = 1_700_002_100_000;
    const script: AgentMessage[] = [
      { type: 'session_init', agentId: CLAUDE, content: 'sess', timestamp: base },
      toolUse(CLAUDE, 'read_file', 'tu-x', { path: 'x.ts' }, base + 10),
      toolUse(CLAUDE, 'run_tests', 'tu-y', { suite: 'routing' }, base + 20),
      toolResult(CLAUDE, 'tu-y', '✓ 12 passed', base + 200), // y: 180ms
      toolResult(CLAUDE, 'tu-x', '// x', base + 35), // x: 25ms
      { type: 'done', agentId: CLAUDE, isFinal: true, timestamp: base + 210 },
    ];
    const inj = injectApp({ 'claude-opus': new FakeAgentService([script]) });

    expect(await post(inj, 'thread-interleave', '@claude 交错工具')).toBe(200);

    const rows = await inj.app.stores.toolEventLog.readByThread('thread-interleave');
    const byName = new Map(rows.map((r) => [r.toolName, r]));
    expect(byName.get('read_file')?.durationMs).toBe(25);
    expect(byName.get('run_tests')?.durationMs).toBe(180);
  });

  it('a stray tool_result with no matching tool_use creates NO row and does not crash', async () => {
    // Adversarial: a provider emits a tool_result whose toolUseId never had a
    // tool_use (truncated/garbled stream). Only tool_use events become rows; the
    // orphan result must be ignored without throwing or fabricating a row.
    const base = 1_700_002_150_000;
    const script: AgentMessage[] = [
      { type: 'session_init', agentId: CLAUDE, content: 'sess', timestamp: base },
      // A real, paired call.
      toolUse(CLAUDE, 'read_file', 'tu-real', { path: 'real.ts' }, base + 10),
      toolResult(CLAUDE, 'tu-real', '// real', base + 30),
      // A stray result with no opener.
      toolResult(CLAUDE, 'tu-ghost', '// orphaned result', base + 40),
      { type: 'done', agentId: CLAUDE, isFinal: true, timestamp: base + 50 },
    ];
    const inj = injectApp({ 'claude-opus': new FakeAgentService([script]) });

    expect(await post(inj, 'thread-stray-result', '@claude 残缺工具流')).toBe(200);

    const rows = await inj.app.stores.toolEventLog.readByThread('thread-stray-result');
    // Exactly one row — for the real tool_use. The stray result becomes no row,
    // and because pairing is by id, it must NOT have been (mis)consumed by tu-real.
    expect(rows).toHaveLength(1);
    expect(rows[0]?.toolName).toBe('read_file');
    expect(rows[0]?.durationMs).toBe(20); // tu-real paired with ITS own result, not the ghost
  });

  it('writes an unpaired tool_use row with durationMs undefined (still persisted)', async () => {
    const base = 1_700_002_200_000;
    const script: AgentMessage[] = [
      { type: 'session_init', agentId: CLAUDE, content: 'sess', timestamp: base },
      toolUse(CLAUDE, 'read_file', 'tu-paired', { path: 'p.ts' }, base + 10),
      toolResult(CLAUDE, 'tu-paired', '// p', base + 25),
      // This tool_use has NO matching result (e.g. cancelled / stream cut).
      toolUse(CLAUDE, 'evidence_search', 'tu-orphan', { query: '未完成' }, base + 40),
      { type: 'done', agentId: CLAUDE, isFinal: true, timestamp: base + 50 },
    ];
    const inj = injectApp({ 'claude-opus': new FakeAgentService([script]) });

    expect(await post(inj, 'thread-orphan', '@claude 一个工具未返回')).toBe(200);

    const rows = await inj.app.stores.toolEventLog.readByThread('thread-orphan');
    expect(rows).toHaveLength(2);
    const orphan = rows.find((r) => r.toolName === 'evidence_search');
    expect(orphan).toBeDefined();
    expect(orphan?.durationMs).toBeUndefined();
    expect(orphan?.toolResult).toBeUndefined();
  });
});

describe('ToolEventLog live feed — invocationId + dual-sink contract (edge)', () => {
  it("stamps the row's invocationId with the turn's real minted id (readByInvocation matches)", async () => {
    const base = 1_700_002_300_000;
    const script: AgentMessage[] = [
      { type: 'session_init', agentId: CLAUDE, content: 'sess', timestamp: base },
      toolUse(CLAUDE, 'read_file', 'tu-1', { path: 'app-factory.ts' }, base + 10),
      toolResult(CLAUDE, 'tu-1', '// wired', base + 60),
      { type: 'done', agentId: CLAUDE, isFinal: true, timestamp: base + 70 },
    ];
    const inj = injectApp({ 'claude-opus': new FakeAgentService([script]) });

    expect(await post(inj, 'thread-inv', '@claude 评审接线')).toBe(200);

    const [row] = await inj.app.stores.toolEventLog.readByThread('thread-inv');
    expect(row?.invocationId).toBeTruthy();
    expect(row?.invocationId).not.toBe('');
    const byInv = await inj.app.stores.toolEventLog.readByInvocation(row!.invocationId);
    expect(byInv).toHaveLength(1);
    expect(byInv[0]?.id).toBe(row?.id);
  });

  it('keeps BOTH sinks: stored message extra.toolEvents AND a tool_events row (M7 contract)', async () => {
    const base = 1_700_002_400_000;
    const script: AgentMessage[] = [
      { type: 'session_init', agentId: CLAUDE, content: 'sess', timestamp: base },
      toolUse(CLAUDE, 'evidence_search', 'tu-1', { query: '上下文层级' }, base + 10),
      toolResult(CLAUDE, 'tu-1', '命中证据', base + 40),
      { type: 'text', agentId: CLAUDE, content: '已检索。', timestamp: base + 50 },
      { type: 'done', agentId: CLAUDE, isFinal: true, timestamp: base + 60 },
    ];
    const inj = injectApp({ 'claude-opus': new FakeAgentService([script]) });

    expect(await post(inj, 'thread-both', '@claude 检索上下文')).toBe(200);

    // Durable sink (A6 log).
    expect(await inj.app.stores.toolEventLog.readByThread('thread-both')).toHaveLength(1);

    // Primary sink (M7 contract): the agent's StoredMessage carries extra.toolEvents.
    const messages = await inj.app.stores.messageStore.getByThread('thread-both');
    const agentReply = messages.find((m: StoredMessage) => m.agentId === CLAUDE);
    expect(agentReply).toBeDefined();
    const toolEvents = agentReply?.extra?.toolEvents as unknown[] | undefined;
    expect(Array.isArray(toolEvents)).toBe(true);
    // tool_use + tool_result both captured in the M7 bag.
    expect((toolEvents ?? []).length).toBeGreaterThanOrEqual(2);
  });

  it('isolates tool_events across threads driven through the same app', async () => {
    const mk = (toolName: string, ts: number): AgentMessage[] => [
      { type: 'session_init', agentId: CLAUDE, content: 'sess', timestamp: ts },
      toolUse(CLAUDE, toolName, 'tu', { path: 'f.ts' }, ts + 10),
      toolResult(CLAUDE, 'tu', 'ok', ts + 20),
      { type: 'done', agentId: CLAUDE, isFinal: true, timestamp: ts + 30 },
    ];
    const inj = injectApp({
      'claude-opus': new FakeAgentService([
        mk('read_file', 1_700_002_500_000),
        mk('run_tests', 1_700_002_600_000),
      ]),
    });

    expect(await post(inj, 'thread-iso-1', '@claude 读文件')).toBe(200);
    expect(await post(inj, 'thread-iso-2', '@claude 跑测试')).toBe(200);

    const one = await inj.app.stores.toolEventLog.readByThread('thread-iso-1');
    const two = await inj.app.stores.toolEventLog.readByThread('thread-iso-2');
    expect(one).toHaveLength(1);
    expect(one[0]?.toolName).toBe('read_file');
    expect(two).toHaveLength(1);
    expect(two[0]?.toolName).toBe('run_tests');
  });

  it('writes NO tool_events rows for a tool-less text reply (but still persists the reply)', async () => {
    const base = 1_700_002_700_000;
    const script: AgentMessage[] = [
      { type: 'session_init', agentId: CODEX, content: 'sess', timestamp: base },
      { type: 'text', agentId: CODEX, content: '不需要工具，直接回答。', timestamp: base + 10 },
      { type: 'done', agentId: CODEX, isFinal: true, timestamp: base + 20 },
    ];
    const inj = injectApp({ 'codex-gpt': new FakeAgentService([script]) });

    expect(await post(inj, 'thread-textonly', '@codex 直接回答即可')).toBe(200);

    expect(await inj.app.stores.toolEventLog.readByThread('thread-textonly')).toEqual([]);
    // The text reply itself is still persisted (regression guard on invocationId stamping).
    const messages = await inj.app.stores.messageStore.getByThread('thread-textonly');
    expect(messages.some((m: StoredMessage) => m.agentId === CODEX)).toBe(true);
  });
});

describe('ToolEventLog live feed — best-effort error path (adversarial)', () => {
  it('a failing toolEventLog.append does NOT fail the HTTP request (request still 200)', async () => {
    const base = 1_700_002_800_000;
    const script: AgentMessage[] = [
      { type: 'session_init', agentId: CLAUDE, content: 'sess', timestamp: base },
      toolUse(CLAUDE, 'read_file', 'tu-1', { path: 'doomed.ts' }, base + 10),
      toolResult(CLAUDE, 'tu-1', '// content', base + 40),
      { type: 'text', agentId: CLAUDE, content: '回答。', timestamp: base + 50 },
      { type: 'done', agentId: CLAUDE, isFinal: true, timestamp: base + 60 },
    ];
    const inj = injectApp({ 'claude-opus': new FakeAgentService([script]) });

    // Adversarial fault injection: drop the tool_events table out from under the
    // store's prepared INSERT so append() throws "no such table" at request time.
    // The message store (separate table) is untouched, so the durable sink is the
    // ONLY thing that breaks — exactly the best-effort path.
    inj.db.exec('DROP TABLE tool_events;');

    const statusCode = await post(inj, 'thread-feedfail', '@claude 触发日志写入失败');

    // Best-effort: the user's request must still succeed despite the sink failure.
    expect(statusCode).toBe(200);

    // The PRIMARY sink (the agent reply + extra.toolEvents) is unaffected.
    const messages = await inj.app.stores.messageStore.getByThread('thread-feedfail');
    const reply = messages.find((m: StoredMessage) => m.agentId === CLAUDE);
    expect(reply).toBeDefined();
    expect(Array.isArray(reply?.extra?.toolEvents)).toBe(true);
  });
});

describe('ToolEventLog live feed — multi-agent correlation (adversarial)', () => {
  it('parallel agents do not cross-assign tool results; each row carries its own agentId', async () => {
    // Two agents each run one tool. Routing them in one turn must keep each
    // tool_use bound to its own agent's result (per-agent FIFO + per-agent invocation).
    const cBase = 1_700_002_900_000;
    const xBase = 1_700_003_000_000;
    const claudeScript: AgentMessage[] = [
      { type: 'session_init', agentId: CLAUDE, content: 'sess-c', timestamp: cBase },
      toolUse(CLAUDE, 'read_file', 'c-tu', { path: 'router.ts' }, cBase + 10),
      toolResult(CLAUDE, 'c-tu', '// router', cBase + 30),
      { type: 'text', agentId: CLAUDE, content: 'claude 评审完。', timestamp: cBase + 40 },
      { type: 'done', agentId: CLAUDE, isFinal: true, timestamp: cBase + 50 },
    ];
    const codexScript: AgentMessage[] = [
      { type: 'session_init', agentId: CODEX, content: 'sess-x', timestamp: xBase },
      toolUse(CODEX, 'run_tests', 'x-tu', { suite: 'stores' }, xBase + 10),
      toolResult(CODEX, 'x-tu', '✓ all green', xBase + 90),
      { type: 'text', agentId: CODEX, content: 'codex 跑完测试。', timestamp: xBase + 100 },
      { type: 'done', agentId: CODEX, isFinal: true, timestamp: xBase + 110 },
    ];
    const inj = injectApp({
      'claude-opus': new FakeAgentService([claudeScript]),
      'codex-gpt': new FakeAgentService([codexScript]),
    });

    // Two @mentions → serial route through both agents (real router).
    expect(await post(inj, 'thread-two-agents', '@claude @codex 评审并跑测试')).toBe(200);

    const rows = await inj.app.stores.toolEventLog.readByThread('thread-two-agents');
    expect(rows).toHaveLength(2);
    const claudeRow = rows.find((r) => r.agentId === CLAUDE);
    const codexRow = rows.find((r) => r.agentId === CODEX);
    expect(claudeRow?.toolName).toBe('read_file');
    expect(claudeRow?.durationMs).toBe(20);
    expect(codexRow?.toolName).toBe('run_tests');
    expect(codexRow?.durationMs).toBe(80);
    // Each row's invocationId belongs to its own agent's turn (distinct invocations).
    expect(claudeRow?.invocationId).not.toBe(codexRow?.invocationId);
  });
});

describe('ToolEventLog live feed — append failure is LOGGED, never swallowed (adversarial)', () => {
  // Proves the fix for the silent `catch {}` in persistToolEvents: a best-effort
  // tool_events append failure must (a) still return 200, (b) be LOGGED at warn
  // through the injected RouteLogger seam with the correct threadId/agentId/tool,
  // and (c) leave the primary extra.toolEvents sink intact. This is the assertion
  // the prior QA round could not write — the logger seam did not exist then.
  it('logs a warn (threadId + agentId + tool name) when the durable append fails, stays best-effort 200', async () => {
    const base = 1_700_003_100_000;
    const script: AgentMessage[] = [
      { type: 'session_init', agentId: CLAUDE, content: 'sess', timestamp: base },
      toolUse(CLAUDE, 'read_file', 'tu-1', { path: 'doomed.ts' }, base + 10),
      toolResult(CLAUDE, 'tu-1', '// content', base + 40),
      { type: 'text', agentId: CLAUDE, content: '回答。', timestamp: base + 50 },
      { type: 'done', agentId: CLAUDE, isFinal: true, timestamp: base + 60 },
    ];
    const captured: CapturedLog[] = [];
    const inj = injectAppWithLogger({ 'claude-opus': new FakeAgentService([script]) }, captured);

    // Fault injection: drop tool_events so the store's prepared INSERT throws
    // "no such table" at request time. Only the durable sink breaks — the message
    // store (a separate table) is untouched, isolating the best-effort path.
    inj.db.exec('DROP TABLE tool_events;');

    const statusCode = await post(inj, 'thread-feedfail-log', '@claude 触发日志写入失败');

    // (a) Best-effort preserved: the user's request still succeeds.
    expect(statusCode).toBe(200);

    // (b) The failure is LOGGED at warn (not silently swallowed).
    const warns = captured.filter((e) => e.level === 'warn');
    expect(warns.length).toBeGreaterThanOrEqual(1);
    const feedWarn = warns.find(
      (e) => e.threadId === 'thread-feedfail-log' && e.agentId === CLAUDE,
    );
    expect(feedWarn).toBeDefined();
    // The warn carries enough context for an operator: the tool name + a reason.
    expect(feedWarn?.message).toContain('read_file');
    expect(feedWarn?.message.length).toBeGreaterThan(0);

    // (c) The PRIMARY sink (the agent reply + extra.toolEvents) is unaffected.
    const messages = await inj.app.stores.messageStore.getByThread('thread-feedfail-log');
    const reply = messages.find((m: StoredMessage) => m.agentId === CLAUDE);
    expect(reply).toBeDefined();
    const toolEvents = reply?.extra?.toolEvents as unknown[] | undefined;
    expect(Array.isArray(toolEvents)).toBe(true);
    expect((toolEvents ?? []).length).toBeGreaterThanOrEqual(2); // tool_use + tool_result
  });

  it('emits NO feed-failure warn when the durable append SUCCEEDS (no false-positive logging)', async () => {
    // Negative control: with the tool_events table intact, the append succeeds and
    // NO warn about a feed failure may be emitted. Guards against logging on the
    // happy path (which would make the warn meaningless / noisy).
    const base = 1_700_003_200_000;
    const script: AgentMessage[] = [
      { type: 'session_init', agentId: CLAUDE, content: 'sess', timestamp: base },
      toolUse(CLAUDE, 'evidence_search', 'tu-ok', { query: '路由编排' }, base + 10),
      toolResult(CLAUDE, 'tu-ok', '命中 2 条证据', base + 50),
      { type: 'text', agentId: CLAUDE, content: '检索完成。', timestamp: base + 60 },
      { type: 'done', agentId: CLAUDE, isFinal: true, timestamp: base + 70 },
    ];
    const captured: CapturedLog[] = [];
    const inj = injectAppWithLogger({ 'claude-opus': new FakeAgentService([script]) }, captured);

    expect(await post(inj, 'thread-feed-ok', '@claude 正常检索')).toBe(200);

    // The durable row was actually written (the append truly succeeded).
    expect(await inj.app.stores.toolEventLog.readByThread('thread-feed-ok')).toHaveLength(1);

    // And NO warn mentioning a feed append failure was emitted for this thread.
    const feedFailWarns = captured.filter(
      (e) => e.level === 'warn' && e.threadId === 'thread-feed-ok' && e.message.includes('append failed'),
    );
    expect(feedFailWarns).toHaveLength(0);
  });
});
