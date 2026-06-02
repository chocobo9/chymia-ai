// tests/routing/qa-helpers.ts
// M4 QA (independent gate) shared utilities: prefix-collision mention entries,
// a logger capture, and a serial-params builder. Reuses the dev happy-path
// helpers (read-only) for the standard three-agent fixtures. Deterministic.

import type { AgentId, AgentMessage } from '@choco/shared';
import { createAgentId } from '@choco/shared';
import type { MentionEntry } from '@choco/api/routing/mention-parser';
import type {
  InvokeAgentFn,
  RouteLogger,
} from '@choco/api/routing/agent-router';
import type { RouteSerialParams } from '@choco/api/routing/route-serial';
import { ALL_CONFIGS, fixedNow } from './helpers';

/** Flattened (agentId, pattern) entries over the standard three agents. */
export const ENTRIES: readonly MentionEntry[] = ALL_CONFIGS.flatMap((c) =>
  c.mentionPatterns.map((pattern) => ({ agentId: c.id, pattern })),
);

// Prefix-collision fixture: a short handle that is a strict prefix of a longer
// one, bound to DIFFERENT agents, to prove the longest-match boundary logic.
export const PLAIN_CLAUDE: AgentId = createAgentId('agent-claude');
export const CLAUDE_PRO: AgentId = createAgentId('agent-claude-pro');

export const PREFIX_ENTRIES: readonly MentionEntry[] = [
  { agentId: PLAIN_CLAUDE, pattern: '@claude' },
  { agentId: CLAUDE_PRO, pattern: '@claude-pro' },
];

/** A logger that records the structured events routing emits (ping-pong, etc.). */
export interface LoggerCapture {
  readonly logger: RouteLogger;
  readonly events: Array<{ readonly level: string; readonly message: string }>;
}

export function captureLogger(): LoggerCapture {
  const events: Array<{ level: string; message: string }> = [];
  const logger: RouteLogger = (e) => {
    events.push({ level: e.level, message: e.message });
  };
  return { logger, events };
}

/** Build {@link RouteSerialParams}, overriding only what a test cares about. */
export function serialParams(
  targets: readonly AgentId[],
  invoke: InvokeAgentFn,
  extra?: Partial<RouteSerialParams>,
): RouteSerialParams {
  return {
    targets,
    threadId: 'thread-rate-limiter',
    prompt: 'implement a token-bucket rate limiter for the API gateway',
    invoke,
    mentionEntries: ENTRIES,
    teammates: targets,
    mcpAvailable: true,
    promptTags: [],
    now: fixedNow,
    ...extra,
  };
}

/**
 * An invoke seam whose per-agent reply is scripted AND which can run a side
 * effect (e.g. abort a controller) the first time a given agent is invoked.
 * Records every (agentId, prompt, context) like the dev recorder, but lets a QA
 * test drive abort/timing without wall-clock sleeps.
 */
export interface ScriptedInvoke {
  readonly invoke: InvokeAgentFn;
  readonly calls: Array<{ agentId: AgentId; prompt: string }>;
}

export function makeAbortingInvoke(
  replies: Readonly<Record<string, string>>,
  abortAfterAgent: AgentId,
  controller: AbortController,
): ScriptedInvoke {
  const calls: Array<{ agentId: AgentId; prompt: string }> = [];
  const invoke: InvokeAgentFn = (args) => {
    calls.push({ agentId: args.agentId, prompt: args.prompt });
    const reply = replies[args.agentId as string] ?? '';
    const willAbort = args.agentId === abortAfterAgent;
    return (async function* (): AsyncIterable<AgentMessage> {
      if (reply !== '') {
        yield {
          type: 'text',
          agentId: args.agentId,
          content: reply,
          timestamp: 1_700_000_000_000,
        };
      }
      yield {
        type: 'done',
        agentId: args.agentId,
        isFinal: true,
        timestamp: 1_700_000_000_000,
      };
      if (willAbort) {
        controller.abort();
      }
    })();
  };
  return { invoke, calls };
}
