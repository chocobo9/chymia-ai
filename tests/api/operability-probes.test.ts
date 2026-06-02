// Operability dev happy-path: invariant probes fire end-to-end through the
// REAL buildApp invoke pipeline when a capturing logger is injected.
//
// Proves the probes are wired into the live data flow (not just unit-callable):
// a turn that produces zero output drives the productive-invocation probe via
// buildInvokeAgentFn's finally; a turn that writes outside the workspace drives
// the tool-write-escape probe via the message-handler pass. QA owns edge/adv.

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { resolve } from 'node:path';
import type { AgentMessage } from '@choco/shared';
import type { RouteLogger } from '@choco/api/routing/agent-router';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';
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

/** A turn that emits ONLY session_init + done — no text, no tools, no error. */
function emptyReply(): AgentMessage[] {
  const ts = 1_700_000_000_000;
  return [
    { type: 'session_init', agentId: CLAUDE, content: 'sess-claude', timestamp: ts },
    { type: 'done', agentId: CLAUDE, isFinal: true, timestamp: ts + 1 },
  ];
}

/** A turn whose tool_use writes a file OUTSIDE the configured workspace. */
function escapingWriteReply(): AgentMessage[] {
  const ts = 1_700_000_500_000;
  return [
    { type: 'session_init', agentId: CLAUDE, content: 'sess-claude', timestamp: ts },
    {
      type: 'tool_use',
      agentId: CLAUDE,
      toolName: 'Write',
      toolUseId: 'tu-esc',
      toolInput: { file_path: '/etc/cron.d/backdoor', content: '* * * * * root sh' },
      timestamp: ts + 10,
    },
    { type: 'tool_result', agentId: CLAUDE, toolUseId: 'tu-esc', content: 'written', timestamp: ts + 20 },
    { type: 'text', agentId: CLAUDE, content: '已写入计划任务。', timestamp: ts + 30 },
    { type: 'done', agentId: CLAUDE, isFinal: true, timestamp: ts + 40 },
  ];
}

describe('operability probes via buildApp (happy path)', () => {
  it('fires the productive-invocation warn when a turn produces zero output', async () => {
    const { logger, events } = capturing();
    const db = new Database(':memory:');
    const app: BuiltApp = buildApp({
      db,
      agentServices: { 'claude-opus': new FakeAgentService([emptyReply()]) },
      logger,
    });
    cleanups.push(app.close);

    await app.api.inject({
      method: 'POST',
      url: '/api/threads/thread-empty/messages',
      payload: { content: '@claude 给个方案' },
    });

    const warns = events.filter((e) => e.level === 'warn');
    expect(warns.some((w) => w.message.includes('0 output'))).toBe(true);
    // Invocation audit also lands on the same seam (start + end).
    expect(events.some((e) => e.level === 'info' && e.message.includes('invocation start'))).toBe(true);
    expect(events.some((e) => e.level === 'info' && e.message.includes('invocation end'))).toBe(true);
  });

  it('fires the tool-write-escape warn when a tool writes outside the workspace', async () => {
    const { logger, events } = capturing();
    const db = new Database(':memory:');
    const app: BuiltApp = buildApp({
      db,
      agentServices: { 'claude-opus': new FakeAgentService([escapingWriteReply()]) },
      defaultWorkspace: resolve('/srv/projects/clowder'),
      logger,
    });
    cleanups.push(app.close);

    await app.api.inject({
      method: 'POST',
      url: '/api/threads/thread-escape/messages',
      payload: { content: '@claude 帮我加个定时任务' },
    });

    const warns = events.filter((e) => e.level === 'warn');
    expect(warns.some((w) => w.message.includes('OUTSIDE workspace'))).toBe(true);
  });
});
