// G7 QA — agent_status (broadcastAgentStatus) edge + adversarial coverage (dev≠QA).
//
// Independently authored against the FROZEN G7 contract in message-handler.ts:
//   - 'working' on the FIRST event from an agent (idempotent via a per-agent set)
//   - 'idle' on that agent's 'done'
//   - any still-working agent flipped to 'idle' in `finally` (cancel/error mid-stream)
//   - payload = AgentState {id, status, currentThreadId, lastActiveAt}
//
// Capture is DETERMINISTIC (no network): we wrap the real SocketManager's
// broadcastAgentStatus to record every (status, id) in emit order, then drive the
// REAL handleThreadMessage through the HTTP route / submitPlatformMessage with
// fake AgentServices whose scripts we fully control. Real @mention + real agent
// ids + real CJK content (CLAUDE §2.2).

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { AgentId, AgentMessage, AgentState } from '@clowder/shared';
import type { AgentService, InvokeOptions } from '@clowder/api/providers/base';
import { buildApp, type BuiltApp } from '@clowder/api/app-factory';
import { CLAUDE, CODEX, GEMINI, replyScript } from './helpers.js';
import { FakeAgentService } from '../invocation/fake-agent-service.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

/** Recorded agent_status emission: just what the assertions need, in emit order. */
interface StatusRecord {
  readonly id: AgentId;
  readonly status: AgentState['status'];
  readonly currentThreadId: string | undefined;
}

/**
 * Build an inject-only app over an in-memory db + fakes, and install a recorder
 * that captures every broadcastAgentStatus call (wrapping the real method so the
 * real G7 code path runs unchanged). Returns the app + the live record array.
 */
function injectAppWithStatusRecorder(
  scripts: Record<string, AgentService>,
): { app: BuiltApp; statuses: StatusRecord[] } {
  const db = new Database(':memory:');
  const app = buildApp({ db, agentServices: scripts });
  cleanups.push(app.close);

  const statuses: StatusRecord[] = [];
  const original = app.socket.broadcastAgentStatus.bind(app.socket);
  app.socket.broadcastAgentStatus = (threadId: string, state: AgentState): Promise<void> => {
    statuses.push({ id: state.id, status: state.status, currentThreadId: state.currentThreadId });
    return original(threadId, state);
  };
  return { app, statuses };
}

function fakes(scripts: Record<string, readonly (readonly AgentMessage[])[]>): Record<string, AgentService> {
  const out: Record<string, AgentService> = {};
  for (const [id, agentScripts] of Object.entries(scripts)) {
    out[id] = new FakeAgentService(agentScripts);
  }
  return out;
}

/** A provider that yields text then throws mid-stream WITHOUT ever emitting 'done'. */
class ThrowingAgentService implements AgentService {
  constructor(private readonly agentId: AgentId) {}
  invoke(_prompt: string, _options?: InvokeOptions): AsyncIterable<AgentMessage> {
    const agentId = this.agentId;
    return (async function* (): AsyncIterable<AgentMessage> {
      yield { type: 'session_init', agentId, content: 'sess-fault', timestamp: Date.now() };
      yield { type: 'text', agentId, content: '正在评审…', timestamp: Date.now() + 1 };
      throw new Error('上游 CLI 进程意外退出 (exit 137)');
    })();
  }
}

const THREAD = 'thread_status_edge';

async function postMessage(app: BuiltApp, content: string, threadId = THREAD): Promise<void> {
  const res = await app.api.inject({
    method: 'POST',
    url: `/api/threads/${threadId}/messages`,
    payload: { content },
  });
  expect(res.statusCode).toBe(200);
}

describe('agent_status ordering (edge)', () => {
  it('emits working THEN idle for a single agent over one turn', async () => {
    const { app, statuses } = injectAppWithStatusRecorder(
      fakes({ 'claude-opus': [replyScript(CLAUDE, '已评审你的层级上下文设计。')] }),
    );
    await postMessage(app, '@claude 评审一下这个层级上下文');

    const claude = statuses.filter((s) => s.id === CLAUDE);
    expect(claude.map((s) => s.status)).toEqual(['working', 'idle']);
    expect(claude[0]?.currentThreadId).toBe(THREAD);
  });

  it('emits exactly ONE working for an agent across many stream events (idempotent)', async () => {
    // Multi-text + tool events from one agent must NOT re-emit 'working' per frame.
    const ts = Date.now();
    const script: AgentMessage[] = [
      { type: 'session_init', agentId: CLAUDE, content: 'sess', timestamp: ts },
      { type: 'text', agentId: CLAUDE, content: '第一段。', timestamp: ts + 1 },
      { type: 'tool_use', agentId: CLAUDE, toolName: 'Read', toolUseId: 't1', timestamp: ts + 2 },
      { type: 'tool_result', agentId: CLAUDE, toolUseId: 't1', content: '...', timestamp: ts + 3 },
      { type: 'text', agentId: CLAUDE, content: '第二段。', timestamp: ts + 4 },
      { type: 'done', agentId: CLAUDE, isFinal: true, timestamp: ts + 5 },
    ];
    const { app, statuses } = injectAppWithStatusRecorder(
      fakes({ 'claude-opus': [script] }),
    );
    await postMessage(app, '@claude 读一下文件再回复');

    const working = statuses.filter((s) => s.id === CLAUDE && s.status === 'working');
    const idle = statuses.filter((s) => s.id === CLAUDE && s.status === 'idle');
    expect(working).toHaveLength(1);
    expect(idle).toHaveLength(1);
  });
});

describe('agent_status per-agent granularity in a parallel route (edge)', () => {
  it('each parallel agent gets its OWN working + idle keyed by AgentState.id', async () => {
    // `#ideate` + two mentions → parallel route; both agents stream interleaved.
    // Mention patterns are '@claude'/'@gemini' (agents.yaml); the agentIds they
    // resolve to are 'claude-opus'/'gemini-pro'.
    const { app, statuses } = injectAppWithStatusRecorder(
      fakes({
        'claude-opus': [replyScript(CLAUDE, '方案 A：单体先行。')],
        'gemini-pro': [replyScript(GEMINI, '方案 B：从一开始就拆服务。')],
      }),
    );
    await postMessage(app, '@claude @gemini #ideate 给两套架构方案');

    const claude = statuses.filter((s) => s.id === CLAUDE).map((s) => s.status);
    const gemini = statuses.filter((s) => s.id === GEMINI).map((s) => s.status);
    expect(claude).toEqual(['working', 'idle']);
    expect(gemini).toEqual(['working', 'idle']);
    // No status emitted for an agent that was never invoked.
    expect(statuses.some((s) => s.id === CODEX)).toBe(false);
  });
});

describe('agent_status resilience — no agent stuck working (adversarial)', () => {
  it('an agent that throws mid-stream (never emits done) still ends idle via finally', async () => {
    const { app, statuses } = injectAppWithStatusRecorder({
      'claude-opus': new ThrowingAgentService(CLAUDE),
    });
    await postMessage(app, '@claude 跑一下回归');

    const claude = statuses.filter((s) => s.id === CLAUDE);
    // It started (working) and, despite never reaching 'done', the finally flipped
    // it to idle — the UI must never stick on 'working'.
    expect(claude.map((s) => s.status)).toEqual(['working', 'idle']);
    // And the final emitted state for that agent is 'idle'.
    expect(claude.at(-1)?.status).toBe('idle');
  });

  it('every agent that started ends idle even when one of two parallel agents throws', async () => {
    const { app, statuses } = injectAppWithStatusRecorder({
      'claude-opus': new FakeAgentService([replyScript(CLAUDE, '我这边正常完成。')]),
      'gemini-pro': new ThrowingAgentService(GEMINI),
    });
    await postMessage(app, '@claude @gemini #ideate 两个方向都评估下');

    for (const id of [CLAUDE, GEMINI]) {
      const seq = statuses.filter((s) => s.id === id);
      expect(seq.length).toBeGreaterThan(0);
      // last status for each started agent is idle (no leak).
      expect(seq.at(-1)?.status).toBe('idle');
    }
    // Invariant: equal counts of working and idle overall → nothing left working.
    const working = statuses.filter((s) => s.status === 'working').length;
    const idle = statuses.filter((s) => s.status === 'idle').length;
    expect(idle).toBe(working);
  });
});

describe('agent_status absence / fallback cases (adversarial)', () => {
  it('a no-@mention turn (fallback to default agent) still yields a clean working→idle with no leak', async () => {
    // §5.2 rule 3: a message with no @mention falls back to the default agent
    // (claude-opus). G7 must emit a single working then a single idle for it —
    // never a spurious SECOND agent and never a stuck 'working'.
    const { app, statuses } = injectAppWithStatusRecorder(
      fakes({ 'claude-opus': [replyScript(CLAUDE, '已记录这条笔记。')] }),
    );
    await postMessage(app, '随便记一条没有 @ 任何人的笔记');

    // Only the default agent appears, exactly once working + once idle, in order.
    expect(new Set(statuses.map((s) => s.id))).toEqual(new Set([CLAUDE]));
    expect(statuses.map((s) => s.status)).toEqual(['working', 'idle']);
  });

  it('the platform ingress path emits the same working→idle lifecycle as HTTP', async () => {
    // G7 lives in the SHARED handler, so submitPlatformMessage must emit it too.
    const { app, statuses } = injectAppWithStatusRecorder(
      fakes({ 'claude-opus': [replyScript(CLAUDE, '微信侧已处理。')] }),
    );
    await app.submitPlatformMessage({
      adapterName: 'wechat',
      channelId: 'gh_a1b2c3d4e5f6',
      platformUserId: 'oABCdEf1234567890ghijklmnop',
      platformMessageId: 'wx_status_1',
      text: '@claude 处理一下这个工单',
      receivedAt: 1_700_000_000_000,
    });
    const claude = statuses.filter((s) => s.id === CLAUDE);
    expect(claude.map((s) => s.status)).toEqual(['working', 'idle']);
  });
});
