// QA gate — per-agent cancel CHAIN-STOP in serial routing. dev≠QA: authored
// independently of route-serial.ts; NO product code touched.
//
// Properties:
//   • aborting the ACTIVE serial step's per-agent signal during its stream ends
//     the chain — the next agent is NEVER invoked (a stopped step does not flow
//     on); the stopped agent still gets a final `done` so the UI clears.
//   • an un-aborted A proceeds normally to B (the targeted signal does not leak).
//   • a stop-all (the thread-wide batch signal) aborted BEFORE A starts → no
//     agents invoked at all.
//   • the active agent listens to ITS OWN per-agent signal; aborting a DIFFERENT
//     agent's signal does NOT stop the chain (isolation, serial flavour).
//
// Deterministic: the per-agent signal is aborted from inside the active agent's
// own generator (no wall-clock timing), then route-serial's post-stream
// `agentSignal.aborted` check fires.

import { describe, test, expect } from 'vitest';
import type { AgentId, AgentMessage } from '@choco/shared';
import { routeSerial } from '@choco/api/routing/route-serial';
import type {
  InvokeAgentArgs,
  InvokeAgentFn,
  SignalForAgent,
} from '@choco/api/routing/agent-router';
import { CLAUDE, CODEX, GEMINI, makeRecordingInvoke, drain } from './helpers';
import { serialParams } from './qa-helpers';

const TS = 1_700_000_000_000;

/** A signalForAgent over a fixed per-agent controller map. */
function perAgentSignals(
  controllers: ReadonlyMap<AgentId, AbortController>,
): SignalForAgent {
  return (agentId) => controllers.get(agentId)?.signal;
}

/**
 * An invoke seam that, for a designated agent, aborts the supplied controller
 * from INSIDE its own generator after yielding its reply — simulating a user
 * pressing 停止 on that agent while it streams. Records invocation order.
 */
function makeSelfAbortingInvoke(
  replies: Readonly<Record<string, string>>,
  abortDuring: AgentId,
  controllerToAbort: AbortController,
): { invoke: InvokeAgentFn; order: AgentId[] } {
  const order: AgentId[] = [];
  const invoke: InvokeAgentFn = (args: InvokeAgentArgs): AsyncIterable<AgentMessage> => {
    order.push(args.agentId);
    const agentId = args.agentId;
    const reply = replies[agentId as string] ?? '';
    const willAbort = agentId === abortDuring;
    return (async function* (): AsyncIterable<AgentMessage> {
      yield { type: 'text', agentId, content: '部分输出…', timestamp: TS };
      if (reply !== '') {
        yield { type: 'text', agentId, content: reply, timestamp: TS + 1 };
      }
      if (willAbort) {
        // The user stops THIS agent mid-turn: abort its per-agent controller.
        controllerToAbort.abort();
      }
      yield { type: 'done', agentId, isFinal: true, timestamp: TS + 2 };
    })();
  };
  return { invoke, order };
}

describe('routeSerial — targeted cancel stops the chain (adversarial)', () => {
  test('aborting the active step (claude) during its stream stops the chain BEFORE codex runs', async () => {
    const claudeCtl = new AbortController();
    const codexCtl = new AbortController();
    const controllers = new Map<AgentId, AbortController>([
      [CLAUDE, claudeCtl],
      [CODEX, codexCtl],
    ]);
    const { invoke, order } = makeSelfAbortingInvoke(
      {
        [CLAUDE as string]: '我已经完成了数据模型部分。',
        [CODEX as string]: '永远不该运行',
      },
      CLAUDE,
      claudeCtl,
    );

    const events = await drain(
      routeSerial(
        serialParams([CLAUDE, CODEX], invoke, {
          signalForAgent: perAgentSignals(controllers),
        }),
      ),
    );

    // Only claude ran; codex was never invoked (the stopped step does not flow on).
    expect(order).toEqual([CLAUDE]);
    // Claude still got a terminal final done so the UI clears it.
    const claudeDone = events.find((e) => e.agentId === CLAUDE && e.type === 'done');
    expect(claudeDone).toBeDefined();
    expect((claudeDone as AgentMessage & { isFinal?: boolean }).isFinal).toBe(true);
    expect(codexCtl.signal.aborted).toBe(false);
  });

  test('a normal (un-aborted) claude proceeds to codex — the targeted signal does not leak', async () => {
    const controllers = new Map<AgentId, AbortController>([
      [CLAUDE, new AbortController()],
      [CODEX, new AbortController()],
    ]);
    const rec = makeRecordingInvoke({
      [CLAUDE as string]: '我实现了 CRUD 路由。',
      [CODEX as string]: '我复查了，缺少鉴权。',
    });
    await drain(
      routeSerial(
        serialParams([CLAUDE, CODEX], rec.invoke, {
          signalForAgent: perAgentSignals(controllers),
        }),
      ),
    );
    // No signal aborted → both agents run, in order.
    expect(rec.calls.map((c) => c.agentId)).toEqual([CLAUDE, CODEX]);
  });

  test('aborting a DIFFERENT agent (codex) does NOT stop the chain while claude is active', async () => {
    const claudeCtl = new AbortController();
    const codexCtl = new AbortController();
    const controllers = new Map<AgentId, AbortController>([
      [CLAUDE, claudeCtl],
      [CODEX, codexCtl],
    ]);
    // While claude is the active step, abort CODEX's (not-yet-active) controller.
    const { invoke, order } = makeSelfAbortingInvoke(
      {
        [CLAUDE as string]: '我先实现。',
        [CODEX as string]: '我接着复查。',
      },
      CLAUDE, // self-abort hook runs during claude's turn…
      codexCtl, // …but it aborts CODEX's controller, not claude's.
    );

    await drain(
      routeSerial(
        serialParams([CLAUDE, CODEX], invoke, {
          signalForAgent: perAgentSignals(controllers),
        }),
      ),
    );

    // claude's OWN signal never aborted → the chain continues to codex. codex's
    // controller IS aborted, but codex's serial step listens to codex's signal
    // only at ITS turn; since it is already aborted when codex starts, codex runs
    // its (pre-scripted) stream then the post-stream check ends the chain — but
    // crucially the chain was NOT stopped at claude. Both agents were invoked.
    expect(order).toEqual([CLAUDE, CODEX]);
  });
});

describe('routeSerial — stop-all via the batch signal (edge)', () => {
  test('a batch signal aborted BEFORE the chain starts invokes no agents at all', async () => {
    const batch = new AbortController();
    batch.abort();
    const rec = makeRecordingInvoke({
      [CLAUDE as string]: '不该运行',
      [CODEX as string]: '不该运行',
    });
    const events = await drain(
      routeSerial(
        serialParams([CLAUDE, CODEX, GEMINI], rec.invoke, {
          signal: batch.signal,
          // No per-agent signals → each step falls back to the batch signal.
        }),
      ),
    );
    expect(rec.calls).toEqual([]);
    expect(events).toEqual([]);
  });

  test('a stop-all that aborts the active agent via its per-agent signal mid-stream ends the chain', async () => {
    // Models the message-handler wiring: each per-agent signal is
    // AbortSignal.any([perAgent, batch]); a stop-all aborts the batch, which
    // aborts the agent's combined signal too. Here we abort the combined signal
    // directly during claude's turn and assert the chain stops before codex.
    const claudeCtl = new AbortController();
    const controllers = new Map<AgentId, AbortController>([[CLAUDE, claudeCtl]]);
    const { invoke, order } = makeSelfAbortingInvoke(
      { [CLAUDE as string]: '处理中被全体停止。', [CODEX as string]: '不该运行' },
      CLAUDE,
      claudeCtl,
    );
    await drain(
      routeSerial(
        serialParams([CLAUDE, CODEX], invoke, {
          signalForAgent: perAgentSignals(controllers),
        }),
      ),
    );
    expect(order).toEqual([CLAUDE]);
  });
});
