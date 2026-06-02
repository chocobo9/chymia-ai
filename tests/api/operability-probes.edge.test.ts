// Operability QA — edge/adversarial integration of the probes through the REAL
// buildApp pipeline, plus /health edges and the no-op-default-logger guarantee.
//
// dev≠QA: authored by the QA instance. The dev happy-path covered probe 4 (zero
// output) and probe 3 (tool-write escape) via buildApp. This file adds: probe 2
// (reply self-duplication) firing through the message-handler persisted-reply
// pass — the real doubling bug shape (two identical text events => X+X); probe-3
// PRECISION (an in-workspace write must NOT warn through the pipeline); probe-4
// PRECISION (a productive turn must NOT warn); /health uptime non-negativity; and
// a no-op-default guard proving an empty-output turn writes no real log file.

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import type { AgentMessage } from '@choco/shared';
import type { RouteLogger } from '@choco/api/routing/agent-router';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';
import { DEFAULT_LOG_DIR } from '@choco/api/infrastructure/logger';
import { FakeAgentService } from '../invocation/fake-agent-service.js';
import { CLAUDE } from './helpers.js';

interface Captured {
  readonly level: 'info' | 'warn';
  readonly message: string;
  readonly threadId: string;
  readonly agentId?: string;
}

function capturing(): { logger: RouteLogger; events: Captured[] } {
  const events: Captured[] = [];
  const logger: RouteLogger = (event) => {
    events.push({
      level: event.level,
      message: event.message,
      threadId: event.threadId,
      ...(event.agentId !== undefined ? { agentId: event.agentId as string } : {}),
    });
  };
  return { logger, events };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

const WORKSPACE = resolve('/srv/projects/clowder');

/** A turn that emits the SAME text twice — the message-handler concatenates text
 * events, so acc.text becomes X+X: the exact reply-doubling bug shape. */
function doubledTextReply(): AgentMessage[] {
  const ts = 1_700_000_900_000;
  const x = '已根据上下文窗口配置生成压缩摘要，冷启动阈值取 15 条消息。';
  return [
    { type: 'session_init', agentId: CLAUDE, content: 'sess-claude', timestamp: ts },
    { type: 'text', agentId: CLAUDE, content: x, timestamp: ts + 1 },
    { type: 'text', agentId: CLAUDE, content: x, timestamp: ts + 2 },
    { type: 'done', agentId: CLAUDE, isFinal: true, timestamp: ts + 3 },
  ];
}

/** A turn that writes a file INSIDE the workspace (probe-3 precision). */
function inWorkspaceWriteReply(): AgentMessage[] {
  const ts = 1_700_001_000_000;
  return [
    { type: 'session_init', agentId: CLAUDE, content: 'sess-claude', timestamp: ts },
    {
      type: 'tool_use',
      agentId: CLAUDE,
      toolName: 'Write',
      toolUseId: 'tu-ok',
      toolInput: { file_path: 'packages/api/src/routes/health-routes.ts', content: '// ok' },
      timestamp: ts + 10,
    },
    { type: 'tool_result', agentId: CLAUDE, toolUseId: 'tu-ok', content: 'written', timestamp: ts + 20 },
    { type: 'text', agentId: CLAUDE, content: '已更新健康检查路由。', timestamp: ts + 30 },
    { type: 'done', agentId: CLAUDE, isFinal: true, timestamp: ts + 40 },
  ];
}

/** A normal productive turn: real text, one tool, no errors (probe-4 precision). */
function productiveReply(): AgentMessage[] {
  const ts = 1_700_001_100_000;
  return [
    { type: 'session_init', agentId: CLAUDE, content: 'sess-claude', timestamp: ts },
    {
      type: 'tool_use',
      agentId: CLAUDE,
      toolName: 'Read',
      toolUseId: 'tu-r',
      toolInput: { file_path: 'packages/api/src/app-factory.ts' },
      timestamp: ts + 5,
    },
    { type: 'tool_result', agentId: CLAUDE, toolUseId: 'tu-r', content: '...', timestamp: ts + 6 },
    {
      type: 'text',
      agentId: CLAUDE,
      content: '已确认 buildInvokeAgentFn 在 finally 中调用了 checkInvocationProductive。',
      timestamp: ts + 7,
    },
    { type: 'done', agentId: CLAUDE, isFinal: true, timestamp: ts + 8 },
  ];
}

describe('probe 2 (reply duplication) via buildApp — RECALL', () => {
  it('fires the self-duplication warn when a turn emits the same text twice (X+X)', async () => {
    const { logger, events } = capturing();
    const db = new Database(':memory:');
    const app: BuiltApp = buildApp({
      db,
      agentServices: { 'claude-opus': new FakeAgentService([doubledTextReply()]) },
      logger,
    });
    cleanups.push(app.close);

    await app.api.inject({
      method: 'POST',
      url: '/api/threads/thread-doubled/messages',
      payload: { content: '@claude 生成上下文摘要' },
    });

    const warns = events.filter((e) => e.level === 'warn');
    expect(warns.some((w) => w.message.includes('self-duplicated'))).toBe(true);
  });
});

describe('probe 3 (tool-write escape) via buildApp — PRECISION', () => {
  it('does NOT fire the escape warn for a write that stays inside the workspace', async () => {
    const { logger, events } = capturing();
    const db = new Database(':memory:');
    const app: BuiltApp = buildApp({
      db,
      agentServices: { 'claude-opus': new FakeAgentService([inWorkspaceWriteReply()]) },
      defaultWorkspace: WORKSPACE,
      logger,
    });
    cleanups.push(app.close);

    await app.api.inject({
      method: 'POST',
      url: '/api/threads/thread-inside/messages',
      payload: { content: '@claude 更新一下路由' },
    });

    const warns = events.filter((e) => e.level === 'warn');
    expect(warns.some((w) => w.message.includes('OUTSIDE workspace'))).toBe(false);
  });
});

describe('probe 4 (productive) via buildApp — PRECISION', () => {
  it('does NOT fire any productivity warn for a normal text+tool turn', async () => {
    const { logger, events } = capturing();
    const db = new Database(':memory:');
    const app: BuiltApp = buildApp({
      db,
      agentServices: { 'claude-opus': new FakeAgentService([productiveReply()]) },
      logger,
    });
    cleanups.push(app.close);

    await app.api.inject({
      method: 'POST',
      url: '/api/threads/thread-productive/messages',
      payload: { content: '@claude 确认探针接线' },
    });

    const warns = events.filter((e) => e.level === 'warn');
    expect(warns.some((w) => w.message.includes('0 output'))).toBe(false);
    expect(warns.some((w) => w.message.includes('error spike'))).toBe(false);
    // The invocation audit (start/end) still lands on the seam at info level.
    expect(events.some((e) => e.level === 'info' && e.message.includes('invocation end'))).toBe(true);
  });
});

describe('probe 1 (workspace match) via buildApp — wiring observation', () => {
  // FINDING (reported in prose, not as a forced-fail): at the ONLY wired call site
  // (app-factory.ts:382 & :388) the probe's two compared args are the SAME
  // expression — `thread?.projectPath ?? deps.defaultWorkspace` — assigned to both
  // `workingDirectory` and `expectedWorkspace`. The probe is thus handed the
  // INTENDED workspace twice and never the provider's ACTUAL resolved cwd, so it can
  // never observe the "wrong cwd" drift it was built to catch (recall = 0 at the
  // wired site). We do NOT force a false-positive warn here (there is genuinely no
  // drift when the intended path is used); we pin the OBSERVABLE consequence: with a
  // workspace configured and a normal turn, no workspace-drift warn ever appears.
  it('emits no workspace-drift warn for a normal turn (probe sees intended path on both sides)', async () => {
    const { logger, events } = capturing();
    const db = new Database(':memory:');
    const app: BuiltApp = buildApp({
      db,
      agentServices: { 'claude-opus': new FakeAgentService([productiveReply()]) },
      defaultWorkspace: WORKSPACE,
      logger,
    });
    cleanups.push(app.close);

    await app.api.inject({
      method: 'POST',
      url: '/api/threads/thread-ws/messages',
      payload: { content: '@claude 跑一下' },
    });

    const driftWarns = events.filter(
      (e) =>
        e.level === 'warn' &&
        (e.message.includes('expected workspace') || e.message.includes('workingDirectory is unset')),
    );
    // No drift warn — correct here, but the probe is also INCAPABLE of firing one at
    // this site (self-comparison). See QA report: dead-wiring recall defect.
    expect(driftWarns).toHaveLength(0);
    // The audit trail still confirms the turn ran (probe was reached, just inert).
    expect(events.some((e) => e.level === 'info' && e.message.includes('invocation start'))).toBe(true);
  });
});

describe('/health — edge', () => {
  function injectApp(): BuiltApp {
    const db = new Database(':memory:');
    return buildApp({ db, agentServices: { 'claude-opus': new FakeAgentService([]) } });
  }

  it('reports a non-negative uptimeMs and a deterministic injected timestamp shape', async () => {
    const app = injectApp();
    cleanups.push(app.close);
    const res = await app.api.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ status: string; uptimeMs: number; timestamp: number }>();
    expect(body.status).toBe('ok');
    expect(body.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(body.uptimeMs)).toBe(true);
    expect(Number.isInteger(body.timestamp)).toBe(true);
  });

  it('uptimeMs is monotonic non-decreasing across two sequential calls', async () => {
    const app = injectApp();
    cleanups.push(app.close);
    const first = (await app.api.inject({ method: 'GET', url: '/health' })).json<{ uptimeMs: number }>();
    const second = (await app.api.inject({ method: 'GET', url: '/health' })).json<{ uptimeMs: number }>();
    expect(second.uptimeMs).toBeGreaterThanOrEqual(first.uptimeMs);
  });

  it('is unauthenticated (no token) and ignores a stray query string', async () => {
    const app = injectApp();
    cleanups.push(app.close);
    const res = await app.api.inject({ method: 'GET', url: '/health?probe=lb' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ status: string }>().status).toBe('ok');
  });
});

describe('buildApp default logger no-op — empty-output turn writes no real log file', () => {
  it('drives a zero-output turn with NO injected logger and adds no file to DEFAULT_LOG_DIR', async () => {
    const before = existsSync(DEFAULT_LOG_DIR) ? readdirSync(DEFAULT_LOG_DIR).sort() : null;

    const db = new Database(':memory:');
    const ts = 1_700_002_000_000;
    const empty: AgentMessage[] = [
      { type: 'session_init', agentId: CLAUDE, content: 'sess-claude', timestamp: ts },
      { type: 'done', agentId: CLAUDE, isFinal: true, timestamp: ts + 1 },
    ];
    const app = buildApp({
      db,
      agentServices: { 'claude-opus': new FakeAgentService([empty]) },
    });
    cleanups.push(app.close);

    await app.api.inject({
      method: 'POST',
      url: '/api/threads/thread-noop-empty/messages',
      payload: { content: '@claude 静默一次' },
    });

    const after = existsSync(DEFAULT_LOG_DIR) ? readdirSync(DEFAULT_LOG_DIR).sort() : null;
    if (before === null) {
      expect(after).toBeNull();
    } else {
      expect(after).toEqual(before);
    }
  });
});
