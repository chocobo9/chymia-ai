// packages/api/src/routing/route-serial.ts
// M4: serial routing + A2A dynamic worklist + WorklistEntry + ping-pong control.
//
// Re-authored from clowder-architecture-design.md §6.1/§6.3 (serial path +
// dynamic worklist) and clowder-design-supplement.md §C5 (WorklistEntry, push
// reasons, ping-pong thresholds). The worklist is created PER route call (no
// global module-level registry — that F108 concurrency machinery belongs to the
// callback path in M8, out of scope here; deviation noted in the M4 report).
//
// Each agent runs in turn; its prompt carries the prior agents' replies (serial
// context passing). After an agent finishes, its reply text is scanned for
// line-start @mentions which, subject to depth + ping-pong limits, extend the
// worklist (organic A2A handoff).

import type {
  AgentId,
  AgentMessage,
  InvocationContext,
  PingPongWarning,
  ThreadRoutingPolicyV1,
} from '@choco/shared';
import { createAgentId } from '@choco/shared';
import type { MentionEntry } from '@choco/api/routing/mention-parser';
import { parseA2AMentions } from '@choco/api/routing/mention-parser';
import type {
  InvokeAgentFn,
  RouteLogger,
  SignalForAgent,
} from '@choco/api/routing/agent-router';

/**
 * Default max A2A worklist expansions per route call.
 * Source: clowder-architecture-design.md §7.4 ("maxA2ADepth 配置（默认 3）").
 */
export const DEFAULT_MAX_A2A_DEPTH = 3;

/**
 * F215: the backup model cat the malformed relay pushes to — must match the
 * `claude-opus-relay` entry in agents.yaml. Single source of truth for the id.
 */
export const RELAY_AGENT_ID: AgentId = createAgentId('claude-opus-relay');

/** True when an event is the internal malformed_toolcall_relay_46 signal. */
function isRelay46Signal(event: AgentMessage): boolean {
  if (event.type !== 'system_info' || event.content === undefined) {
    return false;
  }
  try {
    return (JSON.parse(event.content) as { type?: unknown }).type === 'malformed_toolcall_relay_46';
  } catch {
    return false;
  }
}

/** True when an event is the malformed final error (suppressed once relay is queued). */
function isMalformedRelayError(event: AgentMessage): boolean {
  return (
    event.type === 'error' &&
    (event.errorCode === 'malformed_toolcall' ||
      (event.content ?? '').startsWith('malformed_toolcall:'))
  );
}

/**
 * ping-pong streak at which a warning is injected into the next turn.
 * Source: §C5 PINGPONG_WARN_THRESHOLD.
 */
export const PINGPONG_WARN_THRESHOLD = 2;

/**
 * ping-pong streak at which further same-pair handoffs are blocked.
 * Source: §C5 PINGPONG_BLOCK_THRESHOLD (verify: "同对 agent 来回 ≥4 次 → block").
 */
export const PINGPONG_BLOCK_THRESHOLD = 4;

/** Header prefixed to the prior-replies block injected into a serial prompt. */
const SERIAL_CONTEXT_HEADER = '--- 此前队友在本链中的回复（供你参考）---';

/** Why a {@link tryPushMentions} call added nothing. Source: §C5 PushReason. */
export type PushReason =
  | 'not_found'
  | 'depth_limit'
  | 'caller_mismatch'
  | 'all_duplicate'
  | 'pingpong_terminated';

/** Structured result of attempting to extend the worklist. Source: §C5 PushResult. */
export interface PushResult {
  readonly added: AgentId[];
  readonly reason?: PushReason;
  /** streak ≥ warn and < block: next turn should carry a ping-pong warning. */
  readonly warnPingPong?: boolean;
  /** streak ≥ block: the push was rejected. */
  readonly blockPingPong?: boolean;
  readonly pairCount?: number;
}

/**
 * Per-invocation worklist state. Source: §C5 WorklistEntry.
 * `pingPongWarn` is an addition to §C5: it records the warning to surface on a
 * pushed target's turn (deviation noted in report).
 */
export interface WorklistEntry {
  /** Mutable execution list — push to extend (A2A). */
  list: AgentId[];
  /** Count of original user-selected targets at registration. */
  readonly originalCount: number;
  /** A2A expansion counter — incremented per accepted push. */
  a2aCount: number;
  /** Max allowed A2A expansions. */
  readonly maxDepth: number;
  /** Index of the agent currently executing (for pending-tail dedup). */
  executedIndex: number;
  /** For each enqueued target: who @mentioned it (drives directMessageFrom). */
  readonly a2aFrom: Map<AgentId, AgentId>;
  /** For each enqueued target: the message id that triggered the enqueue. */
  readonly a2aTriggerMessageId: Map<AgentId, string>;
  /** ping-pong streak tracking for the last same (unordered) pair. */
  streakPair?: { from: AgentId; to: AgentId; count: number };
  /** Pending ping-pong warning to inject when a pushed target runs (extension). */
  readonly pingPongWarn: Map<AgentId, PingPongWarning>;
}

/** Result of a streak update. Source: §C5 (warn/block/count). */
export interface StreakResult {
  readonly warnPingPong: boolean;
  readonly blockPingPong: boolean;
  readonly count: number;
}

/** Create a fresh worklist for one route call. */
export function createWorklist(
  targets: readonly AgentId[],
  maxDepth: number = DEFAULT_MAX_A2A_DEPTH,
): WorklistEntry {
  return {
    list: [...targets],
    originalCount: targets.length,
    a2aCount: 0,
    maxDepth,
    executedIndex: 0,
    a2aFrom: new Map(),
    a2aTriggerMessageId: new Map(),
    pingPongWarn: new Map(),
  };
}

/** Two pairs are equal if they share the same unordered set of agents. */
function samePair(
  pair: { from: AgentId; to: AgentId },
  from: AgentId,
  to: AgentId,
): boolean {
  return (
    (pair.from === from && pair.to === to) ||
    (pair.from === to && pair.to === from)
  );
}

/**
 * Update the ping-pong streak for a 1:1 handoff (caller → target).
 * Same unordered pair as last time → count++; a different pair → reset to 1.
 * Source: §C5 thresholds (simplified — the Clowder "substantive activity"
 * exemption is omitted; deviation noted in report).
 */
export function updateStreak(
  entry: WorklistEntry,
  from: AgentId,
  to: AgentId,
): StreakResult {
  if (entry.streakPair !== undefined && samePair(entry.streakPair, from, to)) {
    entry.streakPair = { from, to, count: entry.streakPair.count + 1 };
  } else {
    entry.streakPair = { from, to, count: 1 };
  }
  const count = entry.streakPair.count;
  return {
    warnPingPong: count >= PINGPONG_WARN_THRESHOLD && count < PINGPONG_BLOCK_THRESHOLD,
    blockPingPong: count >= PINGPONG_BLOCK_THRESHOLD,
    count,
  };
}

/**
 * Attempt to extend the worklist with `mentions` raised by `callerId`.
 *
 * Rules (§C5 + §6.3):
 * - dedup only against the PENDING tail (already-executed agents may re-enqueue);
 * - stop at maxDepth;
 * - a 1:1 same-pair handoff increments the ping-pong streak: ≥ block → reject all,
 *   ≥ warn → enqueue but flag a warning for the target's next turn.
 */
export function tryPushMentions(
  entry: WorklistEntry,
  callerId: AgentId,
  mentions: readonly AgentId[],
): PushResult {
  if (mentions.length === 0) {
    return { added: [] };
  }

  const pending = entry.list.slice(entry.executedIndex);

  let warnPingPong = false;
  let pairCount = 0;
  // ping-pong only governs single-target handoffs (A↔B inertia).
  if (mentions.length === 1) {
    const target = mentions[0]!;
    const wouldEnqueue =
      entry.a2aCount < entry.maxDepth && !pending.includes(target);
    if (wouldEnqueue) {
      const streak = updateStreak(entry, callerId, target);
      if (streak.blockPingPong) {
        return {
          added: [],
          reason: 'pingpong_terminated',
          blockPingPong: true,
          pairCount: streak.count,
        };
      }
      warnPingPong = streak.warnPingPong;
      pairCount = streak.count;
    }
  }

  const added: AgentId[] = [];
  let hitDepth = false;
  for (const mention of mentions) {
    if (entry.a2aCount >= entry.maxDepth) {
      hitDepth = true;
      break;
    }
    if (pending.includes(mention)) {
      continue;
    }
    entry.list.push(mention);
    entry.a2aCount += 1;
    entry.a2aFrom.set(mention, callerId);
    pending.push(mention);
    added.push(mention);
    if (warnPingPong && mentions.length === 1) {
      entry.pingPongWarn.set(mention, { pairedWith: callerId, count: pairCount });
    }
  }

  if (added.length === 0) {
    return { added: [], reason: hitDepth ? 'depth_limit' : 'all_duplicate' };
  }
  return warnPingPong ? { added, warnPingPong: true, pairCount } : { added };
}

/** A prior agent's collected reply, used to build the next agent's prompt. */
interface ChainResponse {
  readonly agentId: AgentId;
  readonly text: string;
}

/** Compose a serial prompt: base user text + the prior replies in this chain. */
function composeSerialPrompt(
  basePrompt: string,
  previous: readonly ChainResponse[],
): string {
  if (previous.length === 0) {
    return basePrompt;
  }
  const block = previous
    .map((r) => `[${r.agentId as string}]: ${r.text}`)
    .join('\n\n');
  return `${basePrompt}\n\n${SERIAL_CONTEXT_HEADER}\n${block}`;
}

/** Parameters for {@link routeSerial}. */
export interface RouteSerialParams {
  readonly targets: readonly AgentId[];
  readonly threadId: string;
  /** Clean user prompt (intent tags already stripped). */
  readonly prompt: string;
  /** Injected invocation seam (defaults to invokeSingleAgent wiring in M8). */
  readonly invoke: InvokeAgentFn;
  /** Mention entries used to detect A2A handoffs in agent replies. */
  readonly mentionEntries: readonly MentionEntry[];
  /** Teammates surfaced in each agent's InvocationContext. */
  readonly teammates: readonly AgentId[];
  readonly mcpAvailable: boolean;
  readonly promptTags: readonly string[];
  /** F042: thread routing policy injected into each agent's system prompt. */
  readonly routingPolicy?: ThreadRoutingPolicyV1;
  readonly maxA2ADepth?: number;
  /** Thread-wide (stop-all) signal: stops the chain from starting more agents. */
  readonly signal?: AbortSignal;
  /** Per-agent signal resolver — the active agent listens to ITS OWN abort signal. */
  readonly signalForAgent?: SignalForAgent;
  readonly now?: () => number;
  readonly logger?: RouteLogger;
  /**
   * F215: the backup model cat to relay to when an agent exhausts malformed
   * (form A) retries. The router injects it only when the relay cat is registered
   * AND available; absent → no relay push (the malformed signal is still consumed).
   */
  readonly relayAgentId?: AgentId;
}

/**
 * Drive a serial routing chain. Yields each agent's events in turn (one `done`
 * per agent, with a corrected `isFinal`), passing prior replies forward and
 * organically extending the worklist on line-start A2A @mentions.
 */
export async function* routeSerial(
  params: RouteSerialParams,
): AsyncGenerator<AgentMessage> {
  const now = params.now ?? Date.now;
  const worklist = createWorklist(params.targets, params.maxA2ADepth);
  const previous: ChainResponse[] = [];

  for (let index = 0; index < worklist.list.length; index += 1) {
    if (params.signal?.aborted === true) {
      return;
    }
    worklist.executedIndex = index;
    const agentId = worklist.list[index]!;
    const directMessageFrom = worklist.a2aFrom.get(agentId);
    const pingPongWarning = worklist.pingPongWarn.get(agentId);

    const context: InvocationContext = {
      agentId,
      mode: 'serial',
      chainIndex: index + 1,
      chainTotal: worklist.list.length,
      teammates: params.teammates,
      mcpAvailable: params.mcpAvailable,
      a2aEnabled: true,
      ...(directMessageFrom !== undefined ? { directMessageFrom } : {}),
      ...(pingPongWarning !== undefined ? { pingPongWarning } : {}),
      ...(params.promptTags.length > 0 ? { promptTags: params.promptTags } : {}),
      ...(params.routingPolicy !== undefined ? { routingPolicy: params.routingPolicy } : {}),
    };

    const agentPrompt = composeSerialPrompt(params.prompt, previous);

    let collectedText = '';
    let capturedDone: AgentMessage | undefined;
    let relayPending = false;

    // The active agent listens to its OWN signal (targeted stop) when available,
    // else the thread-wide signal. A targeted stop of THIS agent ends the chain too
    // (checked after its stream) — a serial pipeline can't meaningfully continue
    // past a step the user explicitly stopped.
    const agentSignal = params.signalForAgent?.(agentId) ?? params.signal;

    for await (const event of params.invoke({
      agentId,
      threadId: params.threadId,
      prompt: agentPrompt,
      context,
      ...(agentSignal !== undefined ? { signal: agentSignal } : {}),
    })) {
      // F215 AC-C3: consume the internal relay signal (never forwarded); flag that
      // the backup cat should be pushed after this agent finishes.
      if (isRelay46Signal(event)) {
        relayPending = true;
        continue;
      }
      // Once relay is queued AND a backup target exists, suppress the malformed final
      // error — the backup takes over. With NO relay target, let the error surface so
      // the user is not left with a "switching backup" card and no actual recovery.
      if (relayPending && params.relayAgentId !== undefined && isMalformedRelayError(event)) {
        continue;
      }
      if (event.type === 'text' && event.content !== undefined) {
        collectedText += event.content;
      }
      if (event.type === 'done') {
        // Hold the done; re-stamp isFinal once the (possibly grown) chain is known.
        capturedDone = event;
        continue;
      }
      yield event;
    }

    // If THIS agent was stopped (targeted, or a stop-all), end the chain — a serial
    // pipeline can't continue past a step the user explicitly stopped. Emit a final
    // done so the UI clears this agent, then stop (no A2A expansion, no next agent).
    if (agentSignal?.aborted === true) {
      yield { type: 'done', agentId, isFinal: true, timestamp: now() };
      return;
    }

    // Scan the reply for A2A handoffs and (subject to limits) extend the chain.
    const mentions = parseA2AMentions(collectedText, params.mentionEntries, agentId);
    const push = tryPushMentions(worklist, agentId, mentions);
    if (push.blockPingPong === true) {
      params.logger?.({
        level: 'warn',
        message: `ping-pong terminated for pair count=${String(push.pairCount)}`,
        threadId: params.threadId,
        agentId,
      });
    }

    previous.push({ agentId, text: collectedText });

    // F215 AC-C3: malformed retries exhausted → push the backup model cat onto the
    // worklist so it runs next (organic relay). Dedup vs the pending tail; never
    // relay onto itself. isFinal below recomputes against the grown list.
    if (
      relayPending &&
      params.relayAgentId !== undefined &&
      agentId !== params.relayAgentId &&
      !worklist.list.slice(index + 1).includes(params.relayAgentId)
    ) {
      worklist.list.push(params.relayAgentId);
      worklist.a2aCount += 1;
      worklist.a2aFrom.set(params.relayAgentId, agentId);
      params.logger?.({
        level: 'warn',
        message: `malformed relay → pushed backup cat ${params.relayAgentId as string}`,
        threadId: params.threadId,
        agentId,
      });
    }

    const isFinal = index === worklist.list.length - 1;
    if (capturedDone !== undefined) {
      yield { ...capturedDone, isFinal };
    } else {
      yield { type: 'done', agentId, isFinal, timestamp: now() };
    }
  }
}
