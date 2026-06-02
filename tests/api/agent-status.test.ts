// G7 agent_status dev happy-path suite. QA owns edge + adversarial coverage.
//
// Drives a real socket.io-client against a listening buildApp and asserts the
// agent_status (AgentState) lifecycle the M9 UI consumes: an agent flips to
// 'working' when its turn starts and back to 'idle' when its stream ends.
// Real @mention + real agent ids; the reply is driven through the HTTP route.

import { describe, it, expect, afterEach } from 'vitest';
import type { AgentState } from '@choco/shared';
import type { Socket as ClientSocket } from 'socket.io-client';
import { startTestApp, connectClient, replyScript, CLAUDE } from './helpers.js';

/** Collect agent_status payloads until both a 'working' and an 'idle' arrive. */
function collectAgentStatus(socket: ClientSocket, timeoutMs = 2000): Promise<AgentState[]> {
  return new Promise((resolve) => {
    const states: AgentState[] = [];
    const timer = setTimeout(() => resolve(states), timeoutMs);
    socket.on('agent_status', (state: AgentState) => {
      states.push(state);
      const sawWorking = states.some((s) => s.status === 'working');
      const sawIdle = states.some((s) => s.status === 'idle');
      if (sawWorking && sawIdle) {
        clearTimeout(timer);
        setTimeout(() => resolve(states), 60);
      }
    });
  });
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

describe('agent_status lifecycle (happy path)', () => {
  it('emits working then idle for an agent over the course of its turn', async () => {
    const test = await startTestApp({
      'claude-opus': [replyScript(CLAUDE, '正在评审你的方案。')],
    });
    cleanups.push(test.close);

    const threadId = 'thread_status_demo';
    const client = await connectClient(test.baseUrl, threadId);
    cleanups.push(async () => {
      client.disconnect();
    });

    const statusesPromise = collectAgentStatus(client);

    const res = await test.app.api.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/messages`,
      payload: { content: '@claude-opus 评审一下这个设计' },
    });
    expect(res.statusCode).toBe(200);

    const statuses = await statusesPromise;
    const working = statuses.find((s) => s.status === 'working');
    const idle = statuses.find((s) => s.status === 'idle');

    expect(working).toBeDefined();
    expect(working?.id).toBe(CLAUDE);
    expect(working?.currentThreadId).toBe(threadId);
    expect(idle).toBeDefined();
    expect(idle?.id).toBe(CLAUDE);

    // working must precede idle for the same agent.
    const workingIdx = statuses.findIndex((s) => s.status === 'working');
    const idleIdx = statuses.findIndex((s) => s.status === 'idle');
    expect(workingIdx).toBeLessThan(idleIdx);
  });
});
