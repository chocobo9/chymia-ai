// task-snapshot-injection — the "agent 上下文注入" half of the 任务线 alignment.
//
// The user's explicit ask: aligning the 任务 tab should make the agent AWARE of
// the open task lines, not just render a board. This drives a REAL turn through
// the invoke seam (only the CLI is faked) and asserts the agent's recorded input
// (the `invoked` audit event's `prompt`, which IS the effectivePrompt) carries
// the [Task Snapshot] block for the thread's open tasks.
//
// 对齐 Clowder reference/.../session/formatTaskSnapshot.ts (injected at session
// bootstrap there; injected into the turn context here — choco assembles context
// per turn). RED before wiring: the prompt has no snapshot. GREEN: it does.

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

function turn(text: string): AgentMessage[] {
  const ts = 1_700_000_000_000;
  return [
    { type: 'session_init', agentId: CLAUDE, content: 'sess-inj', timestamp: ts },
    { type: 'text', agentId: CLAUDE, content: text, timestamp: ts + 1 },
    { type: 'done', agentId: CLAUDE, isFinal: true, timestamp: ts + 2 },
  ];
}

function makeApp(scripts: AgentMessage[][]): BuiltApp {
  const db = new Database(':memory:');
  const app = buildApp({ db, agentServices: { 'claude-opus': new FakeAgentService(scripts) } });
  cleanups.push(app.close);
  return app;
}

async function driveTurn(app: BuiltApp, channelId: string, text: string): Promise<string> {
  const r = await app.submitPlatformMessage({
    adapterName: 'wechat', channelId, platformUserId: 'u', platformMessageId: `m_${channelId}_${text}`,
    text: `@claude-opus ${text}`, receivedAt: 1_700_000_000_000,
  });
  return r.threadId;
}

async function invokedPrompts(app: BuiltApp, threadId: string): Promise<string[]> {
  const res = await app.api.inject({ method: 'GET', url: `/api/audit/thread/${threadId}` });
  return res
    .json<{ events: AuditEvent[] }>()
    .events.filter((e) => e.type === 'invoked')
    .map((e) => String(e.data.prompt ?? ''));
}

describe('task snapshot → agent context injection', () => {
  it('injects the open-task block into the turn the agent actually receives', async () => {
    const app = makeApp([turn('第一轮'), turn('第二轮')]);

    // Turn 1 resolves/creates the thread (no tasks yet → no snapshot).
    const threadId = await driveTurn(app, 'gh_inject', '开工');
    const before = await invokedPrompts(app, threadId);
    expect(before.some((p) => p.includes('[Task Snapshot'))).toBe(false);

    // A task line now exists on the thread.
    await app.api.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { threadId, title: '把社区 tab 降级为只读列表', why: '', createdBy: 'user' },
    });

    // Turn 2: the agent's input must now carry the snapshot for that open task.
    await driveTurn(app, 'gh_inject', '继续');
    const after = await invokedPrompts(app, threadId);
    const withSnapshot = after.find((p) => p.includes('[Task Snapshot'));
    expect(withSnapshot).toBeDefined();
    expect(withSnapshot).toContain('把社区 tab 降级为只读列表');
    expect(withSnapshot).toContain('1 todo');
  });

  it('a thread with no tasks injects no snapshot (empty → nothing)', async () => {
    const app = makeApp([turn('独立一轮')]);
    const threadId = await driveTurn(app, 'gh_clean', '你好');
    const prompts = await invokedPrompts(app, threadId);
    expect(prompts.every((p) => !p.includes('[Task Snapshot'))).toBe(true);
  });
});
