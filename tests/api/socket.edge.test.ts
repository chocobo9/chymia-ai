// M8 QA — Socket.io edge + adversarial coverage (independently authored).
//
// Uses a REAL socket.io-client against a listening buildApp (the designed seam)
// to attack:
//   - `cancel` actually aborts a live, long-running route (AbortController wiring)
//   - room isolation under interleaving (thread A never receives thread B events)
//   - the rate limiter throttles a flood of high-frequency text frames but the
//     terminal `done` lifecycle event still reaches the client (bypass guarantee)

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { AgentId, AgentMessage } from '@clowder/shared';
import type { AgentService, InvokeOptions } from '@clowder/api/providers/base';
import { buildApp, type BuiltApp } from '@clowder/api/app-factory';
import { FakeAgentService } from '../invocation/fake-agent-service.js';
import { CLAUDE, connectClient, replyScript } from './helpers.js';

interface Listening {
  readonly app: BuiltApp;
  readonly baseUrl: string;
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

async function listen(services: Record<string, AgentService>): Promise<Listening> {
  const db = new Database(':memory:');
  const app = buildApp({ db, agentServices: services });
  cleanups.push(async () => {
    await app.close();
  });
  const address = await app.api.listen({ port: 0, host: '127.0.0.1' });
  const baseUrl = typeof address === 'string' ? address : 'http://127.0.0.1';
  return { app, baseUrl };
}

/**
 * A provider whose stream blocks on an external promise so the route stays live
 * long enough for a `cancel` to abort it. It yields one text frame, then awaits
 * its abort signal; when aborted it stops (throws AbortError-like) cleanly.
 */
class BlockingAgentService implements AgentService {
  /** Mutable flag object the generator closure mutates (avoids aliasing `this`). */
  readonly state = { aborted: false };
  constructor(private readonly agentId: AgentId) {}
  invoke(_prompt: string, options?: InvokeOptions): AsyncIterable<AgentMessage> {
    const agentId = this.agentId;
    const signal = options?.signal;
    const state = this.state;
    return (async function* (): AsyncIterable<AgentMessage> {
      yield { type: 'session_init', agentId, content: 'sess-block', timestamp: Date.now() };
      yield { type: 'text', agentId, content: '开始一个很长的任务…', timestamp: Date.now() + 1 };
      // Block until aborted (or a hard cap so a bug cannot hang the suite).
      await new Promise<void>((resolve) => {
        const cap = setTimeout(resolve, 3000);
        const onAbort = (): void => {
          state.aborted = true;
          clearTimeout(cap);
          resolve();
        };
        if (signal) {
          if (signal.aborted) {
            onAbort();
          } else {
            signal.addEventListener('abort', onAbort);
          }
        }
      });
      // After cancel we do NOT emit a normal done — the turn was aborted.
    })();
  }
}

describe('socket cancel aborts a live route (adversarial)', () => {
  it('emitting cancel for a thread aborts the in-flight provider stream', async () => {
    const blocking = new BlockingAgentService(CLAUDE);
    const { app, baseUrl } = await listen({ 'claude-opus': blocking });
    void app; // keep ref

    const threadId = 'thread-cancel';
    const client = await connectClient(baseUrl, threadId);
    cleanups.push(() => {
      client.disconnect();
    });

    // Fire the message (do not await — it stays live until aborted).
    void fetch(`${baseUrl}/api/threads/${threadId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '@claude 跑一个长任务' }),
    });

    // Wait until the stream is live (first text frame seen), then cancel.
    await new Promise<void>((resolve) => {
      client.on('agent_event', (msg: AgentMessage) => {
        if (msg.type === 'text') resolve();
      });
    });
    client.emit('cancel', { threadId });

    // The provider's signal must fire well before the 3s hard cap.
    await new Promise((r) => setTimeout(r, 600));
    expect(blocking.state.aborted).toBe(true);
  });
});

describe('socket room isolation under interleaving (adversarial)', () => {
  it('a client in thread A receives only A events while B and A run together', async () => {
    const { baseUrl } = await listen({
      'claude-opus': new FakeAgentService([
        replyScript(CLAUDE, 'A 线程的回复内容'),
        replyScript(CLAUDE, 'B 线程的回复内容'),
      ]),
    });

    const clientA = await connectClient(baseUrl, 'thread-A');
    cleanups.push(() => {
      clientA.disconnect();
    });
    const seenByA: AgentMessage[] = [];
    clientA.on('agent_event', (m: AgentMessage) => seenByA.push(m));

    // Interleave: kick A and B almost simultaneously.
    await Promise.all([
      fetch(`${baseUrl}/api/threads/thread-A/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '@claude A 线程消息' }),
      }),
      fetch(`${baseUrl}/api/threads/thread-B/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '@claude B 线程消息' }),
      }),
    ]);

    await new Promise((r) => setTimeout(r, 400));
    // Client A must have seen only A's content, never B's.
    expect(seenByA.length).toBeGreaterThan(0);
    expect(seenByA.every((m) => m.type !== 'text' || m.content?.includes('A 线程'))).toBe(true);
    expect(seenByA.some((m) => m.type === 'text' && m.content?.includes('B 线程'))).toBe(false);
  });

  it('after leave_thread a client receives no further events for that thread', async () => {
    const { baseUrl } = await listen({
      'claude-opus': new FakeAgentService([replyScript(CLAUDE, '离开后不应收到')]),
    });
    const threadId = 'thread-leave';
    const client = await connectClient(baseUrl, threadId);
    cleanups.push(() => {
      client.disconnect();
    });
    const seen: AgentMessage[] = [];
    client.on('agent_event', (m: AgentMessage) => seen.push(m));

    client.emit('leave_thread', { threadId });
    await new Promise((r) => setTimeout(r, 60)); // let the leave land

    await fetch(`${baseUrl}/api/threads/${threadId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '@claude 我已离开房间' }),
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(seen).toHaveLength(0);
  });
});

describe('rate-limiter throttles floods but lifecycle events bypass (adversarial)', () => {
  it('a flood of >capacity text frames is throttled yet the terminal done still arrives', async () => {
    // Build a long flood of text frames (>> default burst capacity of 40), then done.
    const ts = Date.now();
    const flood: AgentMessage[] = [
      { type: 'session_init', agentId: CLAUDE, content: 'sess-flood', timestamp: ts },
    ];
    const FRAMES = 200;
    for (let i = 0; i < FRAMES; i += 1) {
      flood.push({ type: 'text', agentId: CLAUDE, content: `片段${i} `, timestamp: ts + 1 + i });
    }
    flood.push({ type: 'done', agentId: CLAUDE, isFinal: true, timestamp: ts + 1 + FRAMES });

    const { baseUrl } = await listen({ 'claude-opus': new FakeAgentService([flood]) });
    const threadId = 'thread-flood';
    const client = await connectClient(baseUrl, threadId);
    cleanups.push(() => {
      client.disconnect();
    });

    const seen: AgentMessage[] = [];
    const sawDone = new Promise<void>((resolve) => {
      client.on('agent_event', (m: AgentMessage) => {
        seen.push(m);
        if (m.type === 'done') resolve();
      });
    });

    await fetch(`${baseUrl}/api/threads/${threadId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: '@claude 输出一大段' }),
    });

    await Promise.race([sawDone, new Promise((r) => setTimeout(r, 2500))]);

    const textFrames = seen.filter((m) => m.type === 'text').length;
    // Throttled: far fewer text frames delivered than emitted.
    expect(textFrames).toBeLessThan(FRAMES);
    // But the terminal lifecycle event bypassed the limiter and arrived.
    expect(seen.some((m) => m.type === 'done')).toBe(true);
  });
});
