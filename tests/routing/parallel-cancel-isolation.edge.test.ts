// QA gate — per-agent cancel signal ISOLATION in parallel routing (the core
// "cancel A ⇏ abort B" regression — Clowder's parallel-cancel-signal-isolation).
// dev≠QA: authored independently of route-parallel.ts; NO product code touched.
//
// Drives the REAL routeParallel with a signalForAgent that returns a DISTINCT
// AbortController.signal per agent. We abort agent A's controller mid-flight and
// assert A's stream ends (aborted, partial) while B runs to completion and yields
// its full content. Also gates: each fan-out agent is invoked with ITS OWN
// signal (not a shared one), and the thread-wide `signal` is the fallback only
// when signalForAgent returns undefined for that agent.
//
// Deterministic: streams gate on AbortSignal events (no wall-clock sleeps for the
// core ordering — a small hard cap guards against a hang if a bug breaks abort).

import { describe, test, expect } from 'vitest';
import type { AgentId, AgentMessage } from '@choco/shared';
import { routeParallel } from '@choco/api/routing/route-parallel';
import type {
  InvokeAgentArgs,
  InvokeAgentFn,
  SignalForAgent,
} from '@choco/api/routing/agent-router';
import { CLAUDE, CODEX, GEMINI } from './helpers';

const TS = 1_700_000_000_000;
/** Hard cap so a broken-abort regression fails fast instead of hanging the suite. */
const HANG_GUARD_MS = 2000;

/**
 * A controllable invoke seam: each agent emits a session_init + one early text
 * frame, then BLOCKS until either (a) its abort signal fires — in which case it
 * stops WITHOUT a done (the turn was cancelled) — or (b) a per-agent `release`
 * promise resolves, in which case it emits its full reply text + a terminal done.
 * This lets a test cancel one agent and let another run to completion, both
 * deterministically.
 */
interface ControllableInvoke {
  readonly invoke: InvokeAgentFn;
  /** Resolve an agent's gate so it completes normally (emits reply + done). */
  release(agentId: AgentId): void;
  /** The signal each agent was invoked with (proves per-agent wiring). */
  readonly signalSeen: Map<AgentId, AbortSignal | undefined>;
}

function makeControllableInvoke(
  replies: Readonly<Record<string, string>>,
): ControllableInvoke {
  const gates = new Map<AgentId, () => void>();
  // Agents released BEFORE their generator reached the gate (avoids a lost-wakeup
  // race so completing-normally tests don't fall back to the slow hard cap).
  const preReleased = new Set<AgentId>();
  const signalSeen = new Map<AgentId, AbortSignal | undefined>();

  const invoke: InvokeAgentFn = (args: InvokeAgentArgs): AsyncIterable<AgentMessage> => {
    const agentId = args.agentId;
    const signal = args.signal;
    signalSeen.set(agentId, signal);
    const reply = replies[agentId as string] ?? '';
    return (async function* (): AsyncIterable<AgentMessage> {
      yield { type: 'session_init', agentId, content: `sess-${agentId as string}`, timestamp: TS };
      yield { type: 'text', agentId, content: '开始处理…', timestamp: TS + 1 };

      // Block until released OR aborted.
      const released = await new Promise<boolean>((resolve) => {
        const cap = setTimeout(() => resolve(true), HANG_GUARD_MS);
        const finishReleased = (): void => {
          clearTimeout(cap);
          resolve(true);
        };
        if (preReleased.has(agentId)) {
          finishReleased();
          return;
        }
        gates.set(agentId, finishReleased);
        const onAbort = (): void => {
          clearTimeout(cap);
          resolve(false);
        };
        if (signal !== undefined) {
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }
      });

      if (!released) {
        // Aborted: end the stream WITHOUT a done — a cancelled turn produced no
        // final reply (mirrors a provider that exits on its abort signal).
        return;
      }
      if (reply !== '') {
        yield { type: 'text', agentId, content: reply, timestamp: TS + 2 };
      }
      yield { type: 'done', agentId, isFinal: true, timestamp: TS + 3 };
    })();
  };

  return {
    invoke,
    release: (agentId) => {
      const gate = gates.get(agentId);
      if (gate !== undefined) gate();
      else preReleased.add(agentId);
    },
    signalSeen,
  };
}

/** Build a signalForAgent over a map of per-agent controllers. */
function perAgentSignals(
  controllers: ReadonlyMap<AgentId, AbortController>,
): SignalForAgent {
  return (agentId: AgentId): AbortSignal | undefined => controllers.get(agentId)?.signal;
}

describe('routeParallel — per-agent cancel isolation (adversarial: cancel A ⇏ abort B)', () => {
  test('aborting claude mid-flight ends claude but codex runs to completion and yields its reply', async () => {
    const claudeCtl = new AbortController();
    const codexCtl = new AbortController();
    const controllers = new Map<AgentId, AbortController>([
      [CLAUDE, claudeCtl],
      [CODEX, codexCtl],
    ]);

    const codexReply = 'Codex 方案：用 outbox 表 + 轮询投递保证至少一次。';
    const inv = makeControllableInvoke({ [CODEX as string]: codexReply });

    const events: AgentMessage[] = [];
    const gen = routeParallel({
      targets: [CLAUDE, CODEX],
      threadId: 'thread_todo_api',
      prompt: '为订单服务各提一个架构方案',
      invoke: inv.invoke,
      teammates: [CLAUDE, CODEX],
      mcpAvailable: true,
      promptTags: [],
      signalForAgent: perAgentSignals(controllers),
    });

    // Pump the merged stream in the background, collecting everything.
    const pump = (async (): Promise<void> => {
      for await (const ev of gen) events.push(ev);
    })();

    // Wait until BOTH agents have emitted their early text (both streams live).
    await waitFor(() => events.filter((e) => e.type === 'text').length >= 2);

    // Targeted-cancel CLAUDE only. Codex's controller is left untouched.
    claudeCtl.abort();

    // Release codex so it completes normally.
    inv.release(CODEX);

    await pump;

    // Codex ran to completion: its full reply text + a terminal done are present.
    const codexTexts = events
      .filter((e) => e.agentId === CODEX && e.type === 'text')
      .map((e) => e.content);
    expect(codexTexts).toContain(codexReply);
    expect(events.some((e) => e.agentId === CODEX && e.type === 'done')).toBe(true);

    // Claude was aborted: it emitted its early frame but NEVER a done and never
    // its (would-be) reply — the cancel landed on claude alone.
    expect(events.some((e) => e.agentId === CLAUDE && e.type === 'done')).toBe(false);
    expect(claudeCtl.signal.aborted).toBe(true);
    expect(codexCtl.signal.aborted).toBe(false);
  });

  test('each fan-out agent is invoked with its OWN distinct signal (not a shared one)', async () => {
    const claudeCtl = new AbortController();
    const codexCtl = new AbortController();
    const geminiCtl = new AbortController();
    const controllers = new Map<AgentId, AbortController>([
      [CLAUDE, claudeCtl],
      [CODEX, codexCtl],
      [GEMINI, geminiCtl],
    ]);
    const inv = makeControllableInvoke({
      [CLAUDE as string]: 'A',
      [CODEX as string]: 'B',
      [GEMINI as string]: 'C',
    });

    const gen = routeParallel({
      targets: [CLAUDE, CODEX, GEMINI],
      threadId: 'thread_evidence',
      prompt: '三个独立方案',
      invoke: inv.invoke,
      teammates: [CLAUDE, CODEX, GEMINI],
      mcpAvailable: true,
      promptTags: [],
      signalForAgent: perAgentSignals(controllers),
    });
    const pump = (async (): Promise<void> => {
      // Release everyone so the run drains cleanly.
      for (const id of [CLAUDE, CODEX, GEMINI]) inv.release(id);
      for await (const _ of gen) void _;
    })();
    await pump;

    expect(inv.signalSeen.get(CLAUDE)).toBe(claudeCtl.signal);
    expect(inv.signalSeen.get(CODEX)).toBe(codexCtl.signal);
    expect(inv.signalSeen.get(GEMINI)).toBe(geminiCtl.signal);
    // The three signals are genuinely distinct objects.
    const signals = new Set([
      inv.signalSeen.get(CLAUDE),
      inv.signalSeen.get(CODEX),
      inv.signalSeen.get(GEMINI),
    ]);
    expect(signals.size).toBe(3);
  });

  test('(edge) signalForAgent returning undefined for an agent falls back to the thread-wide signal', async () => {
    const batch = new AbortController();
    const inv = makeControllableInvoke({ [CLAUDE as string]: 'X' });
    // signalForAgent has no entry for claude → returns undefined → fallback.
    const gen = routeParallel({
      targets: [CLAUDE],
      threadId: 'thread_x',
      prompt: '回退到批量信号',
      invoke: inv.invoke,
      teammates: [CLAUDE],
      mcpAvailable: true,
      promptTags: [],
      signal: batch.signal,
      signalForAgent: () => undefined,
    });
    const pump = (async (): Promise<void> => {
      inv.release(CLAUDE);
      for await (const _ of gen) void _;
    })();
    await pump;
    expect(inv.signalSeen.get(CLAUDE)).toBe(batch.signal);
  });

  test('(adversarial) a stop-all (every per-agent controller aborted) ends BOTH streams with no dones', async () => {
    const claudeCtl = new AbortController();
    const codexCtl = new AbortController();
    const controllers = new Map<AgentId, AbortController>([
      [CLAUDE, claudeCtl],
      [CODEX, codexCtl],
    ]);
    const inv = makeControllableInvoke({
      [CLAUDE as string]: 'never',
      [CODEX as string]: 'never',
    });
    const events: AgentMessage[] = [];
    const gen = routeParallel({
      targets: [CLAUDE, CODEX],
      threadId: 'thread_stopall',
      prompt: '两个都要停',
      invoke: inv.invoke,
      teammates: [CLAUDE, CODEX],
      mcpAvailable: true,
      promptTags: [],
      signalForAgent: perAgentSignals(controllers),
    });
    const pump = (async (): Promise<void> => {
      for await (const ev of gen) events.push(ev);
    })();
    await waitFor(() => events.filter((e) => e.type === 'text').length >= 2);
    // Stop-all: abort BOTH per-agent controllers (what cancelThread does).
    claudeCtl.abort();
    codexCtl.abort();
    await pump;
    // Neither agent produced a done or its reply.
    expect(events.some((e) => e.type === 'done')).toBe(false);
    expect(events.some((e) => e.type === 'text' && e.content === 'never')).toBe(false);
  });
});

/** Poll `predicate` until true or a generous cap (avoids fixed sleeps). */
async function waitFor(predicate: () => boolean, capMs = HANG_GUARD_MS): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > capMs) {
      throw new Error('waitFor timed out — a stream never reached the expected state');
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}
