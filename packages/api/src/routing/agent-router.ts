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
  ThreadRoutingPolicyV1,
  ThreadRoutingScope,
} from '@choco/shared';
import type { MessageContent } from '@choco/api/providers/base';
import type { AgentRegistry } from '@choco/api/routing/agent-registry';
import { parseUserMentions, hasBroadcastMention } from '@choco/api/routing/mention-parser';
import { parseIntent, stripIntentTags } from '@choco/api/routing/intent-parser';
import { routeSerial, DEFAULT_MAX_A2A_DEPTH, RELAY_AGENT_ID } from '@choco/api/routing/route-serial';
import { routeParallel } from '@choco/api/routing/route-parallel';

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

/**
 * A thread participant plus its in-thread activity (Clowder ParticipantActivity).
 * `lastResponseHealthy` absent ⇒ healthy (Clowder: `lastResponseHealthy !== false`)
 * — this repo has no reply-health signal yet, so the field is always absent today.
 */
export interface ParticipantActivity {
  readonly agentId: AgentId;
  readonly messageCount: number;
  readonly lastResponseHealthy?: boolean;
}

/**
 * Narrow thread-participant seam — satisfied structurally by SqliteThreadStore.
 * The router PERSISTS @mentions as participants at routing time (Clowder
 * resolveTargets → addParticipants) and READS participant activity for its
 * no-mention fallback (Clowder getParticipantsWithActivity). Kept as a narrow
 * port (like {@link RecentMessageReader}) so routing does not depend on the
 * stores layer.
 */
export interface ParticipantThreadStore {
  addParticipants(threadId: string, agentIds: readonly AgentId[]): Promise<void>;
  getParticipantsWithActivity(
    threadId: string,
  ): Promise<readonly ParticipantActivity[]>;
  /** Read the thread's routing policy (F042) for fallback shaping. */
  get(threadId: string): Promise<{ readonly routingPolicy?: ThreadRoutingPolicyV1 } | null>;
}

/**
 * Infer the routing scope of a message (Clowder inferRoutingScope, F042 v1).
 * Deterministic + conservative: review cues → 'review', architecture cues →
 * 'architecture', else null (no policy applies).
 */
function inferRoutingScope(message: string): ThreadRoutingScope | null {
  const lower = message.toLowerCase();
  const hasPrToken = /\bpr\b/i.test(lower);
  if (
    lower.includes('review') ||
    lower.includes('lgtm') ||
    lower.includes('merge') ||
    hasPrToken ||
    message.includes('合入') ||
    message.includes('开 PR') ||
    message.includes('云端 review') ||
    message.includes('帮我看看') ||
    message.includes('请 reviewer 看看') ||
    message.includes('请 review')
  ) {
    return 'review';
  }
  if (
    lower.includes('architecture') ||
    lower.includes('tradeoff') ||
    message.includes('架构') ||
    message.includes('设计') ||
    message.includes('方案')
  ) {
    return 'architecture';
  }
  return null;
}

/** Resolve the per-agent abort signal for a target — the targeted-cancel seam. */
export type SignalForAgent = (agentId: AgentId) => AbortSignal | undefined;

/** Per-message routing options. Source: §5.2 RouteOptions. */
export interface RouteOptions {
  readonly contentBlocks?: readonly MessageContent[];
  /** Thread-wide (stop-all) signal: aborts the serial chain + a not-yet-started agent. */
  readonly signal?: AbortSignal;
  /**
   * Per-agent abort signal resolver (targeted stop). When provided, each agent's
   * invocation listens to ITS OWN signal, so cancelling one agent does not abort
   * its siblings. Falls back to {@link RouteOptions.signal} when absent.
   */
  readonly signalForAgent?: SignalForAgent;
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
  /**
   * Optional participant seam (SqliteThreadStore). When present, route() persists
   * @mentions as thread participants and the no-mention fallback can continue with
   * a thread participant (Clowder participant model). Absent → the router stays
   * read-only (unit tests that wire no store).
   */
  readonly threadStore?: ParticipantThreadStore;
  readonly config?: AgentRouterConfig;
  readonly logger?: RouteLogger;
  readonly now?: () => number;
}

/**
 * Result of resolving a message's routing: the AVAILABLE targets to actually
 * dispatch to, plus any agents that were EXPLICITLY @mentioned but are NOT
 * available (so the caller can surface a visible notice — §C, Clowder's
 * `cat_disabled` with alternatives). `unavailable` is empty unless the user
 * explicitly @mentioned an unavailable agent.
 */
export interface ResolvedRouting {
  /** Available agents to dispatch to (may be empty if all mentions were unavailable). */
  readonly targets: readonly AgentId[];
  /** Explicitly @mentioned agents that are NOT available (for the notice). */
  readonly unavailable: readonly AgentId[];
  /**
   * The AVAILABLE agents that were EXPLICITLY @mentioned (or @all-expanded) this
   * turn — the set {@link AgentRouter.route} writes back as thread participants
   * (Clowder resolveTargets → addParticipants). Empty on a fallback/default route:
   * Clowder persists participants only on the explicit-mention branch.
   */
  readonly mentioned: readonly AgentId[];
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
  private readonly threadStore: ParticipantThreadStore | undefined;
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
    this.threadStore = deps.threadStore;
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
   * Resolve the target agents for a message (§5.2 rules, availability-aware — §A/§B):
   *   1. explicit @mentions → those agents (in order), FILTERED to AVAILABLE ones;
   *   2. else fallback to the most recent prior user message that had mentions
   *      (within the configured window), filtered to AVAILABLE ones;
   *   3. else the default agent IF available, else the first available agent
   *      (Clowder `pickFallbackCat`). Returns [] only if NO agent is available.
   *
   * Net (the dogfooding bug fix): a no-mention message routes to the default
   * AVAILABLE agent (claude); a recent-mention-of-codex (unavailable) is skipped
   * → claude; an explicit-only @codex resolves to [] here (the visible notice is
   * surfaced by the handler from {@link resolveRouting}).
   */
  async resolveTargets(message: string, threadId: string): Promise<AgentId[]> {
    return (await this.resolveRouting(message, threadId)).targets as AgentId[];
  }

  /**
   * Like {@link resolveTargets} but ALSO reports which explicitly-@mentioned
   * agents were unavailable, so the caller can surface a visible notice (§C).
   * The recent-mention fallback never contributes to `unavailable` — a notice
   * only fires for an EXPLICIT mention the user typed this turn.
   */
  async resolveRouting(message: string, threadId: string): Promise<ResolvedRouting> {
    // F078 (MVP): a GLOBAL broadcast (@all / @全体) routes to ALL available agents
    // and fans out in parallel (≥2 targets → ideate → parallel, via dispatch). It
    // addresses no one by name, so an offline agent is silently skipped — NO
    // unavailable notice (a broadcast must not spam one line per offline agent).
    // Group mention takes priority over any individual @mention in the same text.
    if (hasBroadcastMention(message)) {
      const everyone = this.registry
        .getAll()
        .map((config) => config.id)
        .filter((id) => this.registry.isAvailable(id));
      if (everyone.length > 0) {
        // @all addresses every available agent → all of them become participants.
        return { targets: everyone, unavailable: [], mentioned: everyone };
      }
      // Nobody available → the deterministic single fallback (never an empty spawn).
      const pick = this.pickFallback();
      return { targets: pick === undefined ? [] : [pick], unavailable: [], mentioned: [] };
    }

    const entries = this.registry.getMentionEntries();
    const parsed = parseUserMentions(message, entries);

    if (parsed.length > 0) {
      const available = parsed.filter((id) => this.registry.isAvailable(id));
      const unavailable = parsed.filter((id) => !this.registry.isAvailable(id));
      // If some mentions are available, route to those + still report the
      // unavailable ones for the notice. If ALL mentions were unavailable, route
      // to nothing (targets=[]) — the handler shows only the notice, never a
      // silent spawn-fail (§C). We do NOT silently re-route an explicit @codex to
      // claude (that would be the surprising behavior the user hit).
      // `mentioned` = the available explicit mentions — the set route() persists.
      return { targets: available, unavailable, mentioned: available };
    }

    // No explicit mention. Fallback chain (Clowder peekTargets/resolveTargets):
    //   1. recent USER @mention history,
    //   2. else a thread PARTICIPANT (getParticipantsWithActivity),
    //   3. else the default available agent.
    // Each fallback result is shaped by the thread routing policy (Clowder
    // applyThreadRoutingPolicy — FALLBACK only). None persist participants —
    // Clowder writes back only on the explicit-mention branch (so `mentioned`
    // stays empty here).
    const routingPolicy =
      this.threadStore !== undefined
        ? (await this.threadStore.get(threadId))?.routingPolicy
        : undefined;

    const fallback = await this.fallbackTargets(threadId);
    if (fallback.length > 0) {
      return {
        targets: this.applyRoutingPolicy(routingPolicy, message, fallback),
        unavailable: [],
        mentioned: [],
      };
    }

    const participants = await this.participantFallback(threadId);
    if (participants.length > 0) {
      return {
        targets: this.applyRoutingPolicy(routingPolicy, message, participants),
        unavailable: [],
        mentioned: [],
      };
    }

    const pick = this.pickFallback();
    const picked = pick === undefined ? [] : [pick];
    return {
      targets: this.applyRoutingPolicy(routingPolicy, message, picked),
      unavailable: [],
      mentioned: [],
    };
  }

  /**
   * Pick a deterministic fallback agent (Clowder `pickFallbackCat`): the default
   * agent IF available, else the first available agent (by registry order).
   * Returns undefined only when NO agent is available.
   */
  private pickFallback(): AgentId | undefined {
    return this.pickFallbackExcluding(new Set());
  }

  /**
   * Clowder pickFallbackCat(exclude): the default agent if available AND not
   * excluded, else the first available non-excluded agent (registry order).
   * Returns undefined when none qualifies.
   */
  private pickFallbackExcluding(exclude: ReadonlySet<string>): AgentId | undefined {
    const def = this.registry.getDefault();
    if (!exclude.has(def.id as string) && this.registry.isAvailable(def.id)) {
      return def.id;
    }
    for (const config of this.registry.getAll()) {
      if (exclude.has(config.id as string)) continue;
      if (this.registry.isAvailable(config.id)) return config.id;
    }
    return undefined;
  }

  /**
   * Apply a thread routing policy to a FALLBACK candidate list (Clowder
   * applyThreadRoutingPolicy). Only fallback routing is shaped — an explicit
   * @mention is never policy-filtered (avoidCats: "unless explicitly @mentioned").
   * For the inferred scope: preferCats first, avoidCats dropped (and if that
   * empties the list, a non-avoided fallback agent is chosen). No scope / no rule
   * / expired rule ⇒ the routable candidates unchanged.
   */
  private applyRoutingPolicy(
    policy: ThreadRoutingPolicyV1 | undefined,
    message: string,
    candidates: readonly AgentId[],
  ): AgentId[] {
    const routable = candidates.filter((id) => this.registry.isAvailable(id));
    const passthrough = (): AgentId[] => {
      if (routable.length > 0) return routable;
      const fb = this.pickFallbackExcluding(new Set());
      return fb !== undefined ? [fb] : [];
    };

    const scope = inferRoutingScope(message);
    if (scope === null) return passthrough();

    const rule = policy?.v === 1 ? policy.scopes?.[scope] : undefined;
    if (rule === undefined) return passthrough();
    if (typeof rule.expiresAt === 'number' && rule.expiresAt > 0 && rule.expiresAt < this.now()) {
      return passthrough();
    }

    const avoid = new Set((rule.avoidCats ?? []).map((id) => id as string));
    const prefer = (rule.preferCats ?? [])
      .map((id) => id as string)
      .filter((id) => !avoid.has(id));
    const filtered = routable.filter((id) => !avoid.has(id as string));

    const out: AgentId[] = [];
    const seen = new Set<string>();
    for (const id of prefer) {
      const aid = id as AgentId;
      if (!this.registry.isAvailable(aid) || seen.has(id)) continue;
      seen.add(id);
      out.push(aid);
    }
    for (const id of filtered) {
      const sid = id as string;
      if (seen.has(sid)) continue;
      seen.add(sid);
      out.push(id);
    }
    if (out.length > 0) return out;

    const fb = this.pickFallbackExcluding(avoid);
    return fb !== undefined ? [fb] : [...routable];
  }

  /**
   * The AVAILABLE agents to offer as alternatives when a mention was unavailable
   * (Clowder `buildAlts`) — excluding the unavailable ones themselves. Returns the
   * default-available agent first (if any), then the rest in registry order.
   */
  availableAlternatives(exclude: readonly AgentId[]): readonly AgentId[] {
    const excludeSet = new Set(exclude.map((id) => id as string));
    const out: AgentId[] = [];
    const def = this.registry.getDefault();
    if (this.registry.isAvailable(def.id) && !excludeSet.has(def.id as string)) {
      out.push(def.id);
    }
    for (const config of this.registry.getAll()) {
      if (config.id === def.id) continue;
      if (excludeSet.has(config.id as string)) continue;
      if (this.registry.isAvailable(config.id)) out.push(config.id);
    }
    return out;
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
    const { targets, mentioned } = await this.resolveRouting(message, threadId);
    // Clowder resolveTargets: persist EXPLICIT @mentions (incl. @all expansion) as
    // thread participants at routing time. No store wired → a harmless no-op.
    if (mentioned.length > 0 && this.threadStore !== undefined) {
      await this.threadStore.addParticipants(threadId, mentioned);
    }
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
    // §C: filter the validated targets to AVAILABLE ones too — an A2A fan-out
    // must not spawn-fail against an unavailable agent. Unavailable targets are
    // skipped here; the caller (callback-routes) can surface a notice from
    // {@link partitionAvailability}. If none remain, we dispatch to nothing
    // (rather than a silent spawn-fail).
    const { available } = this.partitionAvailability(targets);
    yield* this.dispatch(available, content, threadId, options);
  }

  /**
   * Split a target list into available vs. unavailable agents (preserving order,
   * deduped). Exposed so the post_message fan-out caller (M8 callback-routes) can
   * surface a notice for any unavailable target, mirroring {@link resolveRouting}.
   */
  partitionAvailability(targets: readonly AgentId[]): {
    readonly available: readonly AgentId[];
    readonly unavailable: readonly AgentId[];
  } {
    const available: AgentId[] = [];
    const unavailable: AgentId[] = [];
    const seen = new Set<string>();
    for (const id of targets) {
      if (seen.has(id as string)) continue;
      seen.add(id as string);
      (this.registry.isAvailable(id) ? available : unavailable).push(id);
    }
    return { available, unavailable };
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
      ...(options?.signalForAgent !== undefined ? { signalForAgent: options.signalForAgent } : {}),
      ...(this.logger !== undefined ? { logger: this.logger } : {}),
    };

    if (strategy === 'parallel') {
      yield* routeParallel({ ...common, targets });
      return;
    }

    // F215 AC-C3: inject the relay target by REGISTRATION presence, NOT availability.
    // The relay cat is forced unavailable (a system backup, not a routable roster
    // member), so checking isAvailable would wrongly skip it. route-serial pushes it
    // explicitly on form A exhaustion — that push is not availability-filtered.
    const relayAgentId =
      this.registry.get(RELAY_AGENT_ID) !== undefined ? RELAY_AGENT_ID : undefined;
    yield* routeSerial({
      ...common,
      targets,
      mentionEntries: this.registry.getMentionEntries(),
      maxA2ADepth: this.maxA2ADepth,
      now: this.now,
      ...(relayAgentId !== undefined ? { relayAgentId } : {}),
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
      if (msg.mentions.length === 0) continue;
      // §B: recent-mention fallback returns only AVAILABLE mentions — a prior
      // @codex (unavailable) is skipped so a no-mention continuation routes to
      // claude, not the dead agent. If the most-recent mentioning message had
      // ONLY unavailable mentions, keep scanning earlier ones.
      const available = msg.mentions.filter((id) => this.registry.isAvailable(id));
      if (available.length > 0) {
        return available;
      }
    }
    return [];
  }

  /**
   * No-mention fallback to a thread PARTICIPANT (Clowder getParticipantsWithActivity
   * three-tier). This repo has no preferredCats, so it collapses to two tiers:
   *   (1) a healthy participant who has actually replied (messageCount > 0),
   *   (2) else any healthy participant.
   * Health is absent-means-healthy (Clowder `lastResponseHealthy !== false`).
   * Returns [] when no store is wired or no routable participant exists.
   */
  private async participantFallback(threadId: string): Promise<AgentId[]> {
    if (this.threadStore === undefined) {
      return [];
    }
    const activity = await this.threadStore.getParticipantsWithActivity(threadId);
    const isHealthy = (p: ParticipantActivity): boolean => p.lastResponseHealthy !== false;
    const isRoutable = (p: ParticipantActivity): boolean =>
      this.registry.isAvailable(p.agentId);
    const healthyReplier = activity.find(
      (p) => p.messageCount > 0 && isHealthy(p) && isRoutable(p),
    );
    if (healthyReplier !== undefined) {
      return [healthyReplier.agentId];
    }
    const anyHealthy = activity.find((p) => isHealthy(p) && isRoutable(p));
    return anyHealthy !== undefined ? [anyHealthy.agentId] : [];
  }
}
