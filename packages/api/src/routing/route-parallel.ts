// packages/api/src/routing/route-parallel.ts
// M4: parallel routing — fan out to all targets at once and interleave streams.
//
// Re-authored from clowder-architecture-design.md §6.1 (parallel path:
// "Promise.all(agents.map(invoke)) → mergeStreams"). Each target runs
// INDEPENDENTLY (no prior-reply context), so this is the `ideate` strategy.
// One agent's failure must not kill the others — that property is owned by
// mergeStreams; in-band `error` AgentMessages already flow through normally.

import type { AgentId, AgentMessage, InvocationContext } from '@choco/shared';
import { mergeStreams } from '@choco/api/routing/stream-merge';
import type {
  InvokeAgentFn,
  RouteLogger,
  SignalForAgent,
} from '@choco/api/routing/agent-router';

/** Parameters for {@link routeParallel}. */
export interface RouteParallelParams {
  readonly targets: readonly AgentId[];
  readonly threadId: string;
  /** Clean user prompt (intent tags already stripped). */
  readonly prompt: string;
  readonly invoke: InvokeAgentFn;
  readonly teammates: readonly AgentId[];
  readonly mcpAvailable: boolean;
  readonly promptTags: readonly string[];
  /** Thread-wide (stop-all) fallback signal. */
  readonly signal?: AbortSignal;
  /** Per-agent signal resolver — each fan-out agent gets its OWN abort signal. */
  readonly signalForAgent?: SignalForAgent;
  readonly logger?: RouteLogger;
}

/** Resolve a target's effective abort signal: its own (targeted) else the thread-wide one. */
function signalFor(params: RouteParallelParams, agentId: AgentId): AbortSignal | undefined {
  return params.signalForAgent?.(agentId) ?? params.signal;
}

/**
 * Drive a parallel routing fan-out. Builds one independent stream per target and
 * interleaves them via {@link mergeStreams}; values surface in arrival order.
 */
export async function* routeParallel(
  params: RouteParallelParams,
): AsyncGenerator<AgentMessage> {
  const total = params.targets.length;
  const streams: AsyncIterable<AgentMessage>[] = params.targets.map(
    (agentId, idx) => {
      const context: InvocationContext = {
        agentId,
        mode: 'parallel',
        chainIndex: idx + 1,
        chainTotal: total,
        teammates: params.teammates,
        mcpAvailable: params.mcpAvailable,
        a2aEnabled: true,
        ...(params.promptTags.length > 0 ? { promptTags: params.promptTags } : {}),
      };
      const agentSignal = signalFor(params, agentId);
      return params.invoke({
        agentId,
        threadId: params.threadId,
        prompt: params.prompt,
        context,
        ...(agentSignal !== undefined ? { signal: agentSignal } : {}),
      });
    },
  );

  const onError = (index: number, error: unknown): void => {
    const agentId: AgentId | undefined = params.targets[index];
    params.logger?.({
      level: 'warn',
      message: `parallel stream ${index} errored: ${error instanceof Error ? error.message : String(error)}`,
      threadId: params.threadId,
      ...(agentId !== undefined ? { agentId } : {}),
    });
  };

  yield* mergeStreams(streams, onError);
}
