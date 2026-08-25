// tests/invocation/invoke-single-agent-timeout.test.ts
// P0-2: invocation-level hard timeout —— provider gen 卡死（CLI hang、gen.next() 永不
// resolve）时，invocation 超时必须中断它、hard stop（不 retry）、并释放 SessionMutex。
// 否则卡死的 invocation 永久占用 mutex，后续同 (agent,thread) 消息全部排队卡死（飞书
// 后续消息卡死的一环）。对齐 Clowder invoke-single-cat 的 invocation timeout + abortableNext。
// 用真实定时器（invocation timeout 走真实 setTimeout）；HangingAgentService 模拟卡死 CLI。

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import type { AgentMessage } from '@choco/shared';
import { createAgentId } from '@choco/shared';
import type { AgentService, InvokeOptions } from '@choco/api/providers/base';
import { invokeSingleAgent } from '@choco/api/invocation/invoke-single-agent';
import { SessionStore } from '@choco/api/invocation/session-store';
import { SqliteMessageStore } from '@choco/api/stores/sqlite-message-store';
import { SqliteToolEventLog } from '@choco/api/stores/sqlite-tool-event-log';
import { SessionMutex } from '@choco/api/invocation/session-mutex';

const CLAUDE = createAgentId('claude-opus');

function makeSessionStore(db: Database.Database): SessionStore {
  return new SessionStore(db, {
    messageReader: new SqliteMessageStore(db),
    toolEventReader: new SqliteToolEventLog(db),
  });
}

async function drain(gen: AsyncGenerator<AgentMessage>): Promise<AgentMessage[]> {
  const out: AgentMessage[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

/** provider gen 永不 yield、永不结束 —— 模拟卡死的 CLI 子进程（gen.next() 永久 pending）。 */
class HangingAgentService implements AgentService {
  readonly calls: { options: InvokeOptions | undefined }[] = [];
  invoke(_prompt: string, options?: InvokeOptions): AsyncIterable<AgentMessage> {
    this.calls.push({ options });
    // 手写 async iterator，next() 永久 pending —— 精确模拟卡死 CLI 的 gen.next() 永不
    // resolve（abortableNext 必须能与 signal 竞速中断它）。手写而非 async generator：
    // 无 yield 的 generator 会触发 eslint require-yield，且手写更贴近“卡死的 next()”。
    return {
      [Symbol.asyncIterator](): AsyncIterator<AgentMessage> {
        return {
          next: (): Promise<IteratorResult<AgentMessage>> =>
            new Promise<IteratorResult<AgentMessage>>(() => {}),
        };
      },
    };
  }
}

describe('invokeSingleAgent — invocation hard timeout', () => {
  it('aborts a hung provider, emits one terminal error (no retry), and releases the mutex', async () => {
    const db = new Database(':memory:');
    const sessionStore = makeSessionStore(db);
    const sessionMutex = new SessionMutex();
    const hanging = new HangingAgentService();
    const threadId = 'thread-hang';

    // timeoutMs=40 → invocationTimeoutMs = 40 × 2 = 80ms：卡死 gen 80ms 后被中断。
    const events = await drain(
      invokeSingleAgent({
        agentService: hanging,
        sessionStore,
        sessionMutex,
        agentId: CLAUDE,
        threadId,
        prompt: 'this provider will hang forever',
        timeoutMs: 40,
      }),
    );

    // hard stop：恰一个 error 事件，无 retry（hanging 只被调用一次）。
    expect(hanging.calls).toHaveLength(1);
    expect(events.map((e) => e.type)).toEqual(['error']);
    expect(events[0]?.content).toContain('invocation_timeout');

    // mutex 已释放：再 acquire 立即成功（否则后续消息会永久卡死）。
    const release = await sessionMutex.acquire(`${CLAUDE as string}:${threadId}`);
    expect(typeof release).toBe('function');
    release();
    db.close();
  });

  it('caller abort mid-flight stops a hung provider and releases the mutex', async () => {
    const db = new Database(':memory:');
    const sessionStore = makeSessionStore(db);
    const sessionMutex = new SessionMutex();
    const hanging = new HangingAgentService();
    const threadId = 'thread-cancel';
    const ac = new AbortController();

    // 启动后短暂延迟主动取消（用户取消语义）；invocation timeout 远大于取消延迟，
    // 确保这里生效的是 caller abort，不是 invocation timeout。
    const timer = setTimeout(() => ac.abort(new Error('user cancelled')), 30);
    const events = await drain(
      invokeSingleAgent({
        agentService: hanging,
        sessionStore,
        sessionMutex,
        agentId: CLAUDE,
        threadId,
        prompt: 'cancel me',
        signal: ac.signal,
        timeoutMs: 60_000,
      }),
    );
    clearTimeout(timer);

    expect(events.some((e) => e.type === 'error')).toBe(true);
    const release = await sessionMutex.acquire(`${CLAUDE as string}:${threadId}`);
    expect(typeof release).toBe('function');
    release();
    db.close();
  });
});
