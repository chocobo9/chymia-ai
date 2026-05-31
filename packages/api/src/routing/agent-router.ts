// packages/api/src/routing/agent-router.ts
// M4: AgentRouter — the orchestration entry point.
//
// Re-authored from clowder-architecture-design.md §5.2 (AgentRouter contract +
// deterministic routing rules) and §6.1 (routing flow). Pure decision logic (no
// LLM): resolve @mention targets (with fallback), parse intent, pick the
// serial/parallel strategy, and delegate to routeSerial / routeParallel.
//
// The actual agent invocation is an INJECTED seam ({@link InvokeAgentFn}) so M4
// is testable without M2/M3/M7 wiring: production passes a function that builds
// the system prompt (M7) from the InvocationContext and calls invokeSingleAgent
// (M3). This keeps M4 free of a hard dependency on not-yet-built modules
// (deviation noted in the M4 report).

import type {
  AgentId,
  AgentMessage,
  InvocationContext,
  StoredMessage,
} from '@clowder/shared';
import type { MessageContent } from '@clowder/api/providers/base';
import type { AgentRegistry } from '@clowder/api/routing/agent-registry';
import { parseUserMentions } from '@clowder/api/routing/mention-parser';
import { parseIntent, stripIntentTags } from '@clowder/api/routing/intent-parser';
import { routeSerial, DEFAULT_MAX_A2A_DEPTH } from '@clowder/api/routing/route-serial';
import { routeParallel } from '@clowder/api/routing/route-parallel';

/** Arguments passed to the injected invocation seam for one agent turn. */
export interface InvokeAgentArgs {
  readonly agentId: AgentId;
  readonly threadId: string;
  /** The (already context-composed) prompt for this agent. */
  readonly prompt: string;
  /** Routing-derived context (mode, chain position, A2A hints, ping-pong, tags). */
  readonly context: InvocationContext;
  readonly signal?: AbortSignal;
  readonly contentBlocks?: readonly MessageContent[];
}

/**
 * The seam M4 calls to actually run one agent turn. Returns that agent's event
 * stream. Production wiring (M8) implements this by building the system prompt
 * (M7) from `args.context` and invoking invokeSingleAgent (M3); tests inject a
 * fake that records args and replays scripted events.
 */
export type InvokeAgentFn = (args: InvokeAgentArgs) => AsyncIterable<AgentMessage>;

/** Structured logger for non-fatal routing notes. Never console.log (CLAUDE.md §2.1). */
export type RouteLogger = (event: {
  readonly level: 'info' | 'warn';
  readonly message: string;
  readonly threadId: string;
  readonly agentId?: AgentId;
}) => void;

/**
 * Narrow read seam for fallback routing — satisfied by the M5 SqliteMessageStore
 * (getByThread). M4 only needs recent history, so it depends on this shape
 * rather than the whole store (decoupling; deviation noted in report).
 */
export interface RecentMessageReader {
  getByThread(threadId: string, limit?: number): Promise<StoredMessage[]>;
}

/** Per-message routing options. Source: §5.2 RouteOptions. */
export interface RouteOptions {
  readonly contentBlocks?: readonly MessageContent[];
  readonly signal?: AbortSignal;
}

/** Tunables for {@link AgentRouter}. */
export interface AgentRouterConfig {
  /** Max A2A worklist expansions per serial route. Default {@link DEFAULT_MAX_A2A_DEPTH}. */
  readonly maxA2ADepth?: number;
  /** Whether MCP is available (surfaced in InvocationContext). Default true. */
  readonly mcpAvailable?: boolean;
  /** Fallback: how many recent user messages to scan for prior mentions. */
  readonly fallbackMessageLimit?: number;
  /** Fallback: only consider user messages within this window (ms). */
  readonly fallbackWindowMs?: number;
}

/** Constructor dependencies for {@link AgentRouter}. */
export interface AgentRouterDeps {
  readonly registry: AgentRegistry;
  readonly invoke: InvokeAgentFn;
  /** Optional history reader for @mention fallback (rule 2). */
  readonly history?: RecentMessageReader;
  readonly config?: AgentRouterConfig;
  readonly logger?: RouteLogger;
  readonly now?: () => number;
}

/**
 * Default count of recent user messages scanned for mention fallback.
 * Source: §5.2 rule 2 ("最近 5 条 user message 的 mention 历史").
 */
const DEFAULT_FALLBACK_MESSAGE_LIMIT = 5;

/**
 * Default fallback window — 1 hour.
 * Source: §5.2 rule 2 ("1h 窗口").
 */
const DEFAULT_FALLBACK_WINDOW_MS = 60 * 60 * 1000;

/**
 * AgentRouter — resolves targets + strategy and streams the result.
 * Implements clowder-architecture-design.md §5.2.
 */
export class AgentRouter {
  private readonly registry: AgentRegistry;
  private readonly invoke: InvokeAgentFn;
  private readonly history: RecentMessageReader | undefined;
  private readonly logger: RouteLogger | undefined;
  private readonly now: () => number;
  private readonly maxA2ADepth: number;
  private readonly mcpAvailable: boolean;
  private readonly fallbackLimit: number;
  private readonly fallbackWindowMs: number;

  constructor(deps: AgentRouterDeps) {
    this.registry = deps.registry;
    this.invoke = deps.invoke;
    this.history = deps.history;
    this.logger = deps.logger;
    this.now = deps.now ?? Date.now;
    this.maxA2ADepth = deps.config?.maxA2ADepth ?? DEFAULT_MAX_A2A_DEPTH;
    this.mcpAvailable = deps.config?.mcpAvailable ?? true;
    this.fallbackLimit =
      deps.config?.fallbackMessageLimit ?? DEFAULT_FALLBACK_MESSAGE_LIMIT;
    this.fallbackWindowMs =
      deps.config?.fallbackWindowMs ?? DEFAULT_FALLBACK_WINDOW_MS;
  }

  /**
   * Resolve the target agents for a message (§5.2 rules):
   *   1. explicit @mentions → those agents (in order of appearance);
   *   2. else fallback to the most recent prior user message that had mentions
   *      (within the configured window);
   *   3. else the default agent.
   */
  async resolveTargets(message: string, threadId: string): Promise<AgentId[]> {
    const entries = this.registry.getMentionEntries();
    const mentioned = parseUserMentions(message, entries);
    if (mentioned.length > 0) {
      return mentioned;
    }

    const fallback = await this.fallbackTargets(threadId);
    if (fallback.length > 0) {
      return fallback;
    }

    return [this.registry.getDefault().id];
  }

  /**
   * Route a message: resolve targets + intent, choose serial/parallel, and yield
   * the merged/sequenced agent event stream. Deterministic — no LLM.
   */
  async *route(
    _userId: string,
    message: string,
    threadId: string,
    options?: RouteOptions,
  ): AsyncGenerator<AgentMessage> {
    const targets = await this.resolveTargets(message, threadId);
    yield* this.dispatch(targets, message, threadId, options);
  }

  /**
   * Route to an EXPLICIT, pre-validated target list — never re-deriving targets
   * from the message text. This is the non-spoofable A2A fan-out seam (M8
   * post_message targetAgents): the caller has already validated `targets`
   * against the roster, and `content` is the raw agent-supplied message. Because
   * targets do NOT come from {@link parseUserMentions} over `content`, any
   * @mention an agent embeds in `content` can never widen the routed set beyond
   * `targets` (content-injection / fan-out escalation guard).
   *
   * Intent parsing still runs over `content` (it only selects serial/parallel and
   * strips intent tags from the prompt — it does not select agents), matching the
   * deterministic behaviour of {@link route}.
   */
  async *routeExplicit(
    targets: readonly AgentId[],
    content: string,
    threadId: string,
    options?: RouteOptions,
  ): AsyncGenerator<AgentMessage> {
    yield* this.dispatch(targets, content, threadId, options);
  }

  /**
   * Shared dispatch: given an already-decided target list and the message text,
   * parse intent, choose the serial/parallel strategy, and stream the result.
   * The target list is taken AS GIVEN — this method never derives targets from
   * the message (that decision belongs to the caller: {@link route} via
   * resolveTargets, or {@link routeExplicit} with a validated list).
   */
  private async *dispatch(
    targets: readonly AgentId[],
    message: string,
    threadId: string,
    options?: RouteOptions,
  ): AsyncGenerator<AgentMessage> {
    const intentResult = parseIntent(message, targets.length);
    const cleanPrompt = stripIntentTags(message);

    // §5.2 rule 4: ideate → parallel (divergent), execute → serial.
    const strategy: 'serial' | 'parallel' =
      intentResult.intent === 'ideate' ? 'parallel' : 'serial';

    const common = {
      threadId,
      prompt: cleanPrompt,
      invoke: this.invoke,
      teammates: targets,
      mcpAvailable: this.mcpAvailable,
      promptTags: intentResult.promptTags,
      ...(options?.signal !== undefined ? { signal: options.signal } : {}),
      ...(this.logger !== undefined ? { logger: this.logger } : {}),
    };

    if (strategy === 'parallel') {
      yield* routeParallel({ ...common, targets });
      return;
    }

    yield* routeSerial({
      ...common,
      targets,
      mentionEntries: this.registry.getMentionEntries(),
      maxA2ADepth: this.maxA2ADepth,
      now: this.now,
    });
  }

  /** Find targets from recent mention history (rule 2). Returns [] if none. */
  private async fallbackTargets(threadId: string): Promise<AgentId[]> {
    if (this.history === undefined) {
      return [];
    }
    const recent = await this.history.getByThread(threadId, this.fallbackLimit);
    const cutoff = this.now() - this.fallbackWindowMs;

    // Most-recent user messages first; the freshest one carrying mentions wins.
    const userMessages = recent
      .filter((m) => m.agentId === null && m.timestamp >= cutoff)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, this.fallbackLimit);

    for (const msg of userMessages) {
      if (msg.mentions.length > 0) {
        return [...msg.mentions];
      }
    }
    return [];
  }
}
