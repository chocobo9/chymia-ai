// QA gating suite (dev≠QA, §0.5.3): availability-aware routing — §A + §B.
//
// Independently authored to gate the dev's availability work: the AgentRegistry's
// isAvailable concept, the AgentRouter filtering routing targets to AVAILABLE
// agents, the recent-mention fallback skipping an unavailable agent, the explicit
// @mention of an unavailable agent NOT spawning a live turn (and being reported in
// `unavailable`), the all-unavailable empty/no-crash case, and the
// everything-available regression.
//
// These exercise the REAL AgentRegistryImpl + AgentRouter over the standard three
// agents (claude default, codex, gemini) with availability injected via the
// registry's `availability` option — the same seam buildApp threads through from
// `agentAvailability`. The recording invoke seam records every actual spawn, so we
// can assert an unavailable agent is NEVER invoked (no silent spawn-fail).
//
// Roster note (helpers.ts): CLAUDE_CONFIG is the FIRST config → the registry
// default. CODEX → @codex, GEMINI → @gemini.

import { describe, it, expect } from 'vitest';
import type { AgentConfig, AgentId, StoredMessage } from '@choco/shared';
import type { AgentService } from '@choco/api/providers/base';
import { AgentRegistryImpl } from '@choco/api/routing/agent-registry';
import {
  AgentRouter,
  type RecentMessageReader,
} from '@choco/api/routing/agent-router';
import {
  ALL_CONFIGS,
  CLAUDE,
  CODEX,
  GEMINI,
  fixedNow,
  FIXED_TS,
  makeRecordingInvoke,
  drain,
} from './helpers.js';

/** A no-op AgentService stub — routing decisions go through the invoke seam. */
const noopService: AgentService = {
  invoke(): AsyncIterable<never> {
    return (async function* (): AsyncIterable<never> {})();
  },
};

/**
 * Build an AgentRegistryImpl over the standard three configs with an injected
 * availability map (absent ids default to AVAILABLE, mirroring buildApp).
 */
function makeRegistry(
  availability?: Readonly<Record<string, boolean>>,
  configs: readonly AgentConfig[] = ALL_CONFIGS,
): AgentRegistryImpl {
  const services: Record<string, AgentService> = {};
  for (const c of configs) services[c.id as string] = noopService;
  return new AgentRegistryImpl(
    configs,
    services,
    availability !== undefined ? { availability } : undefined,
  );
}

/** A history reader that replays a fixed list of stored user messages. */
function historyOf(messages: readonly StoredMessage[]): RecentMessageReader {
  return {
    getByThread: (_threadId: string, _limit?: number): Promise<StoredMessage[]> =>
      Promise.resolve([...messages]),
  };
}

/** A real-shaped user StoredMessage carrying parsed mentions, stamped at `ts`. */
function userMsg(
  id: string,
  content: string,
  mentions: readonly AgentId[],
  ts: number,
): StoredMessage {
  return {
    id,
    threadId: 'thread-availability',
    userId: 'user-makima',
    agentId: null,
    content,
    mentions: [...mentions],
    origin: 'user',
    timestamp: ts,
  };
}

/** claude available, codex + gemini UNavailable — the headline scenario. */
const CLAUDE_ONLY = { 'claude-opus': true, 'codex-gpt': false, 'gemini-pro': false };

// ===========================================================================
// §A — registry availability semantics
// ===========================================================================
describe('§A AgentRegistry.isAvailable', () => {
  it('happy: an id ABSENT from the availability map defaults to AVAILABLE (true)', () => {
    // No availability map at all → every agent routable (fakes/unprobed stay live).
    const registry = makeRegistry();
    expect(registry.isAvailable(CLAUDE)).toBe(true);
    expect(registry.isAvailable(CODEX)).toBe(true);
    expect(registry.isAvailable(GEMINI)).toBe(true);
  });

  it('edge: an id present-and-false in the map is UNavailable; present-and-true is available', () => {
    const registry = makeRegistry(CLAUDE_ONLY);
    expect(registry.isAvailable(CLAUDE)).toBe(true);
    expect(registry.isAvailable(CODEX)).toBe(false);
    expect(registry.isAvailable(GEMINI)).toBe(false);
  });

  it('edge: a partial map marks only listed ids; an unlisted id stays AVAILABLE (default true)', () => {
    // Only codex is recorded (false); claude + gemini are unlisted → default true.
    const registry = makeRegistry({ 'codex-gpt': false });
    expect(registry.isAvailable(CODEX)).toBe(false);
    expect(registry.isAvailable(CLAUDE)).toBe(true);
    expect(registry.isAvailable(GEMINI)).toBe(true);
  });

  it('adversarial: an UNKNOWN agent id (not in the roster) defaults to AVAILABLE (true)', () => {
    const registry = makeRegistry(CLAUDE_ONLY);
    expect(registry.isAvailable('ghost-agent' as AgentId)).toBe(true);
  });
});

// ===========================================================================
// §B — availability-aware routing (the headline)
// ===========================================================================
describe('§B routing filters to AVAILABLE agents', () => {
  function buildRouter(
    availability: Readonly<Record<string, boolean>>,
    opts: { history?: RecentMessageReader; replies?: Record<string, string> } = {},
  ): { router: AgentRouter; calls: ReturnType<typeof makeRecordingInvoke>['calls'] } {
    const registry = makeRegistry(availability);
    const { invoke, calls } = makeRecordingInvoke(opts.replies ?? {});
    const router = new AgentRouter({
      registry,
      invoke,
      now: fixedNow,
      ...(opts.history !== undefined ? { history: opts.history } : {}),
    });
    return { router, calls };
  }

  it('happy: a no-mention message resolves to the default AVAILABLE agent (claude), NOT codex', async () => {
    const { router } = buildRouter(CLAUDE_ONLY);
    const targets = await router.resolveTargets(
      '帮我把这个登录接口的限流加上',
      'thread-availability',
    );
    expect(targets).toEqual([CLAUDE]);
    expect(targets).not.toContain(CODEX);
  });

  it('edge: recent-mention fallback skips the unavailable prior @codex → falls through to claude', async () => {
    // A prior user message @mentioned codex (now unavailable). A no-mention
    // follow-up must NOT route to the dead codex — the unavailable mention is
    // filtered out of the fallback, leaving the default-available claude.
    const history = historyOf([
      userMsg('m1', '@codex 把重试逻辑补上，指数退避', [CODEX], FIXED_TS),
    ]);
    const { router } = buildRouter(CLAUDE_ONLY, { history });
    const targets = await router.resolveTargets('继续，把单测也补齐', 'thread-availability');
    expect(targets).toEqual([CLAUDE]);
    expect(targets).not.toContain(CODEX);
  });

  it('edge: recent-mention fallback keeps an AVAILABLE prior mention (the fallback still works)', async () => {
    // With everyone available, a prior @codex mention is honored by the fallback —
    // proving the skip above is availability-specific, not a blanket disable.
    const history = historyOf([
      userMsg('m1', '@codex 把重试逻辑补上', [CODEX], FIXED_TS),
    ]);
    const { router } = buildRouter(
      { 'claude-opus': true, 'codex-gpt': true, 'gemini-pro': true },
      { history },
    );
    const targets = await router.resolveTargets('继续', 'thread-availability');
    expect(targets).toEqual([CODEX]);
  });

  it('edge: an explicit @codex (unavailable) is NOT routed to a live spawn (targets empty, codex in unavailable set)', async () => {
    const { router, calls } = buildRouter(CLAUDE_ONLY, {
      replies: { 'codex-gpt': '不应被调用' },
    });
    const resolved = await router.resolveRouting(
      '@codex 帮我把这段并发池改成可配置上限',
      'thread-availability',
    );
    expect(resolved.targets).toEqual([]);
    expect(resolved.unavailable).toEqual([CODEX]);

    // And route() must NOT invoke codex (no silent spawn-fail against a dead CLI).
    const events = await drain(
      router.route('user-makima', '@codex 帮我把这段并发池改成可配置上限', 'thread-availability'),
    );
    expect(events).toEqual([]);
    expect(calls.map((c) => c.agentId)).not.toContain(CODEX);
    expect(calls).toHaveLength(0);
  });

  it('edge: explicit @claude @codex routes to claude ONLY (codex filtered) + codex reported unavailable', async () => {
    const { router, calls } = buildRouter(CLAUDE_ONLY, {
      replies: { 'claude-opus': '我来定架构。' },
    });
    const resolved = await router.resolveRouting(
      '@claude 你定架构，@codex 你来实现',
      'thread-availability',
    );
    expect(resolved.targets).toEqual([CLAUDE]);
    expect(resolved.unavailable).toEqual([CODEX]);

    // route() spawns claude only — codex is never invoked.
    const events = await drain(
      router.route('user-makima', '@claude 你定架构，@codex 你来实现', 'thread-availability'),
    );
    const spawned = calls.map((c) => c.agentId);
    expect(spawned).toContain(CLAUDE);
    expect(spawned).not.toContain(CODEX);
    expect(events.some((e) => e.agentId === CLAUDE && e.type === 'text')).toBe(true);
  });

  it('adversarial: ALL mentioned agents unavailable → empty targets, no crash, no spawn', async () => {
    const { router, calls } = buildRouter(CLAUDE_ONLY, {
      replies: { 'codex-gpt': 'x', 'gemini-pro': 'y' },
    });
    const resolved = await router.resolveRouting(
      '@codex @gemini 你们俩谁先来都行',
      'thread-availability',
    );
    expect(resolved.targets).toEqual([]);
    // Both unavailable mentions reported (order preserved).
    expect(resolved.unavailable).toEqual([CODEX, GEMINI]);

    const events = await drain(
      router.route('user-makima', '@codex @gemini 你们俩谁先来都行', 'thread-availability'),
    );
    expect(events).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('adversarial: NO agent available at all → pickFallback returns nothing, no-mention resolves to empty', async () => {
    const { router } = buildRouter({
      'claude-opus': false,
      'codex-gpt': false,
      'gemini-pro': false,
    });
    const targets = await router.resolveTargets('随便谁回我一下', 'thread-availability');
    expect(targets).toEqual([]);
  });

  it('edge: default unavailable but another agent available → no-mention picks the first AVAILABLE (gemini)', async () => {
    // claude (default) is down; codex down; gemini up → pickFallback walks the
    // registry order and returns the first available agent.
    const { router } = buildRouter({
      'claude-opus': false,
      'codex-gpt': false,
      'gemini-pro': true,
    });
    const targets = await router.resolveTargets('谁有空帮我看个 bug', 'thread-availability');
    expect(targets).toEqual([GEMINI]);
  });

  it('regression: everything available (no availability map) → unchanged routing semantics', async () => {
    // No availability injected → all agents available. A no-mention message goes
    // to the default; an explicit @gemini goes to gemini; nothing is reported
    // unavailable. This is the pre-availability behavior, unaltered.
    const { router, calls } = buildRouter(
      {} as Readonly<Record<string, boolean>>,
      { replies: { 'gemini-pro': '我来评审边界条件。' } },
    );

    const noMention = await router.resolveRouting('开始干活', 'thread-availability');
    expect(noMention.targets).toEqual([CLAUDE]);
    expect(noMention.unavailable).toEqual([]);

    const explicit = await router.resolveRouting(
      '@gemini 评审一下这个并发方案',
      'thread-availability',
    );
    expect(explicit.targets).toEqual([GEMINI]);
    expect(explicit.unavailable).toEqual([]);

    const events = await drain(
      router.route('user-makima', '@gemini 评审一下这个并发方案', 'thread-availability'),
    );
    expect(calls.map((c) => c.agentId)).toContain(GEMINI);
    expect(events.some((e) => e.agentId === GEMINI && e.type === 'text')).toBe(true);
  });

  it('edge: availableAlternatives reflects the ACTUAL available set, excluding the unavailable ones', async () => {
    // claude available, codex+gemini down. Alternatives for an unavailable @codex
    // are the available agents EXCLUDING codex → just claude (default-first).
    const { router } = buildRouter(CLAUDE_ONLY);
    expect(router.availableAlternatives([CODEX])).toEqual([CLAUDE]);
    // Exclude both unavailable → still just claude.
    expect(router.availableAlternatives([CODEX, GEMINI])).toEqual([CLAUDE]);
  });

  it('adversarial: when NO agent is available, availableAlternatives is empty (not a hardcoded list)', async () => {
    const { router } = buildRouter({
      'claude-opus': false,
      'codex-gpt': false,
      'gemini-pro': false,
    });
    expect(router.availableAlternatives([CODEX])).toEqual([]);
  });
});

// ===========================================================================
// §B — routeExplicit / partitionAvailability (A2A fan-out path)
// ===========================================================================
describe('§B routeExplicit + partitionAvailability (A2A fan-out)', () => {
  it('edge: routeExplicit skips an unavailable validated target (no spawn) and runs the available one', async () => {
    const registry = makeRegistry(CLAUDE_ONLY);
    const { invoke, calls } = makeRecordingInvoke({
      'claude-opus': '收到 A2A 转交，我来处理。',
      'codex-gpt': '不应被调用',
    });
    const router = new AgentRouter({ registry, invoke, now: fixedNow });

    const events = await drain(
      router.routeExplicit([CLAUDE, CODEX], 'A2A: 把这个 PR 评审了', 'thread-availability'),
    );
    const spawned = calls.map((c) => c.agentId);
    expect(spawned).toContain(CLAUDE);
    expect(spawned).not.toContain(CODEX);
    expect(events.some((e) => e.agentId === CLAUDE && e.type === 'text')).toBe(true);
  });

  it('edge: partitionAvailability splits validated targets into available/unavailable (order preserved, deduped)', () => {
    const registry = makeRegistry(CLAUDE_ONLY);
    const { invoke } = makeRecordingInvoke({});
    const router = new AgentRouter({ registry, invoke, now: fixedNow });
    const { available, unavailable } = router.partitionAvailability([
      CODEX,
      CLAUDE,
      CODEX, // duplicate — must be deduped
      GEMINI,
    ]);
    expect(available).toEqual([CLAUDE]);
    expect(unavailable).toEqual([CODEX, GEMINI]);
  });

  it('adversarial: routeExplicit with ALL targets unavailable spawns nothing and yields no events', async () => {
    const registry = makeRegistry(CLAUDE_ONLY);
    const { invoke, calls } = makeRecordingInvoke({ 'codex-gpt': 'x', 'gemini-pro': 'y' });
    const router = new AgentRouter({ registry, invoke, now: fixedNow });
    const events = await drain(
      router.routeExplicit([CODEX, GEMINI], 'A2A: 你们看下', 'thread-availability'),
    );
    expect(events).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});
