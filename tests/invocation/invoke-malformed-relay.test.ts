// tests/invocation/invoke-malformed-relay.test.ts
// gap #4 Layer 3 — invoke-layer form A recovery (F215 AC-C1/C2/C3/D1).
//
// Aligned-To: reference/clowder-ai-main/.../invocation/invoke-single-cat.ts (:2094-2484)
//   suppress malformed_toolcall_detected + malformed error → seal + fresh-context
//   retry → on exhaustion emit relay card + malformed_toolcall_relay_46 + final error.
//
// Real evidence class: real invokeSingleAgent + real SessionStore (in-memory SQLite).
// The provider is a scripted fake replaying a form A turn (thinking + detected
// signal + malformed error) — same constraint as Layer 2: a real spawn cannot
// reliably induce thinking-only (claude #49747). The invoke/retry/relay logic + the
// session seal round-trip are real.

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

/** A form A turn: session_init → thinking-only → detected signal → malformed error → done. */
function formA(sessionId: string): AgentMessage[] {
  return [
    { type: 'session_init', agentId: CLAUDE, content: sessionId, timestamp: 1 },
    { type: 'thinking', agentId: CLAUDE, content: '让我想想这个问题……', timestamp: 1 },
    {
      type: 'system_info',
      agentId: CLAUDE,
      content: JSON.stringify({ type: 'malformed_toolcall_detected', form: 'A', sessionId }),
      timestamp: 1,
    },
    {
      type: 'error',
      agentId: CLAUDE,
      content: 'malformed_toolcall: Claude 输出无效（仅 thinking）',
      errorCode: 'malformed_toolcall',
      timestamp: 1,
    },
    { type: 'done', agentId: CLAUDE, isFinal: true, timestamp: 1 },
  ];
}

/** A healthy turn: session_init → text → done. */
function healthy(sessionId: string, text: string): AgentMessage[] {
  return [
    { type: 'session_init', agentId: CLAUDE, content: sessionId, timestamp: 1 },
    { type: 'text', agentId: CLAUDE, content: text, timestamp: 1 },
    { type: 'done', agentId: CLAUDE, isFinal: true, timestamp: 1 },
  ];
}

/** Provider that replays a scripted turn per invoke (last script repeats). */
class ScriptedService implements AgentService {
  readonly calls: (InvokeOptions | undefined)[] = [];
  constructor(private readonly scripts: readonly (readonly AgentMessage[])[]) {}
  invoke(_prompt: string, options?: InvokeOptions): AsyncIterable<AgentMessage> {
    const idx = this.calls.length;
    this.calls.push(options);
    const script = this.scripts[Math.min(idx, this.scripts.length - 1)] ?? [];
    return (async function* () {
      for (const m of script) yield m;
    })();
  }
}

function setup(scripts: readonly (readonly AgentMessage[])[]): {
  svc: ScriptedService;
  run: () => Promise<AgentMessage[]>;
} {
  const db = new Database(':memory:');
  const sessionStore = makeSessionStore(db);
  const svc = new ScriptedService(scripts);
  const run = (): Promise<AgentMessage[]> =>
    drain(
      invokeSingleAgent({
        agentService: svc,
        sessionStore,
        sessionMutex: new SessionMutex(),
        agentId: CLAUDE,
        threadId: 'tA',
        prompt: 'x',
        now: () => 1,
      }),
    );
  return { svc, run };
}

describe('invokeSingleAgent — form A malformed recovery (F215 Layer 3)', () => {
  it('suppresses the detection signal (it never reaches the user)', async () => {
    const events = await setup([formA('s1')]).run();
    expect(
      events.some(
        (e) => e.type === 'system_info' && (e.content ?? '').includes('malformed_toolcall_detected'),
      ),
    ).toBe(false);
  });

  it('fresh-retries form A (thinking is not produced output), exhausts, then relays', async () => {
    const { svc, run } = setup([formA('s1')]); // always form A
    const events = await run();

    // initial + 2 retries = 3 attempts. This ALSO proves thinking is excluded from
    // producedOutput — were it counted, attempt 0 would stop (output_produced) at 1 call.
    expect(svc.calls).toHaveLength(3);
    // each retry is fresh-context (sealed → no resumed sessionId)
    expect(svc.calls[1]?.sessionId).toBeUndefined();
    expect(svc.calls[2]?.sessionId).toBeUndefined();

    // exhausted → user-visible relay card + internal relay signal + explicit final error
    expect(events.some((e) => e.type === 'text' && (e.content ?? '').includes('切换备用模型'))).toBe(true);
    expect(
      events.some(
        (e) => e.type === 'system_info' && (e.content ?? '').includes('malformed_toolcall_relay_46'),
      ),
    ).toBe(true);
    expect(events.some((e) => e.type === 'error' && e.errorCode === 'malformed_toolcall')).toBe(true);
  });

  it('fresh-retry recovers when the next attempt is healthy (no relay)', async () => {
    const { svc, run } = setup([formA('s1'), healthy('s2', '恢复后的正常回复')]);
    const events = await run();

    expect(svc.calls).toHaveLength(2); // form A → fresh-retry → healthy success
    expect(events.some((e) => e.type === 'text' && (e.content ?? '').includes('恢复后的正常回复'))).toBe(true);
    expect(
      events.some(
        (e) => e.type === 'system_info' && (e.content ?? '').includes('malformed_toolcall_relay_46'),
      ),
    ).toBe(false);
  });
});
