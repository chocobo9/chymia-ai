// packages/api/src/routing/agent-registry.ts
// M4: AgentRegistry — re-authored from clowder-design-supplement.md §A2.
//
// Holds the static AgentConfig set and binds each agent id to its (injected)
// AgentService instance (supplement D: constructor injection, no global
// singleton). Mention patterns are flattened into entries once for the parsers.

import type { AgentConfig, AgentId } from '@clowder/shared';
import type { AgentService } from '@clowder/api/providers/base';
import type { MentionEntry } from '@clowder/api/routing/mention-parser';

/** AgentRegistry contract. Source: §A2. */
export interface AgentRegistry {
  /** All registered agent configs. */
  getAll(): readonly AgentConfig[];
  /** Config by id, or undefined if unknown. */
  get(id: AgentId): AgentConfig | undefined;
  /** Config whose mentionPatterns include the given mention (case-insensitive). */
  resolveByMention(mention: string): AgentConfig | undefined;
  /** The AgentService bound to an id (throws if none registered). */
  getService(id: AgentId): AgentService;
  /** Default agent (fallback for a brand-new conversation with no mentions). */
  getDefault(): AgentConfig;
  /** Flattened (agentId, pattern) entries for the mention parsers. */
  getMentionEntries(): readonly MentionEntry[];
  /**
   * Whether an agent is AVAILABLE — i.e. routable. Grounded (at the edge) in
   * whether the agent's provider CLI is installed on this system (§A). An agent
   * with no recorded availability defaults to AVAILABLE (true) — so injected
   * fakes and any agent we couldn't probe stay routable (Clowder: "not in roster
   * = available" backward-compat). The router filters routing targets through
   * this; an explicit @mention of an unavailable agent surfaces a visible notice
   * instead of a silent spawn-fail.
   */
  isAvailable(id: AgentId): boolean;
}

/** Options for {@link AgentRegistryImpl}. */
export interface AgentRegistryOptions {
  /** Which agent is the default fallback; defaults to the first config. */
  readonly defaultAgentId?: AgentId;
  /**
   * Availability map keyed by agent id (§A). An id ABSENT from this map (or the
   * whole map omitted) defaults to AVAILABLE — so tests/fakes that pass no map
   * keep every agent routable. Production (main.ts) derives this from CLI
   * presence at boot and passes it through buildApp.
   */
  readonly availability?: Readonly<Record<string, boolean>>;
}

/**
 * In-memory AgentRegistry. Services are injected as an id→AgentService map
 * (matching supplement D wiring, e.g. { 'claude-opus': claudeService }).
 */
export class AgentRegistryImpl implements AgentRegistry {
  private readonly configs: readonly AgentConfig[];
  private readonly byId: ReadonlyMap<AgentId, AgentConfig>;
  private readonly services: ReadonlyMap<AgentId, AgentService>;
  private readonly mentionEntries: readonly MentionEntry[];
  private readonly defaultConfig: AgentConfig;
  private readonly availability: ReadonlyMap<AgentId, boolean>;

  constructor(
    configs: readonly AgentConfig[],
    services: Readonly<Record<string, AgentService>>,
    options?: AgentRegistryOptions,
  ) {
    if (configs.length === 0) {
      throw new Error('AgentRegistryImpl requires at least one AgentConfig');
    }
    this.configs = configs;
    this.byId = new Map(configs.map((c) => [c.id, c]));
    this.services = new Map(
      Object.entries(services).map(([id, svc]) => [id as AgentId, svc]),
    );
    this.availability = new Map(
      Object.entries(options?.availability ?? {}).map(([id, ok]) => [id as AgentId, ok]),
    );

    const entries: MentionEntry[] = [];
    for (const config of configs) {
      for (const pattern of config.mentionPatterns) {
        entries.push({ agentId: config.id, pattern });
      }
    }
    this.mentionEntries = entries;

    const defaultConfig =
      options?.defaultAgentId !== undefined
        ? this.byId.get(options.defaultAgentId)
        : configs[0];
    if (defaultConfig === undefined) {
      throw new Error(
        `AgentRegistryImpl: defaultAgentId not found among configs`,
      );
    }
    this.defaultConfig = defaultConfig;
  }

  getAll(): readonly AgentConfig[] {
    return this.configs;
  }

  get(id: AgentId): AgentConfig | undefined {
    return this.byId.get(id);
  }

  resolveByMention(mention: string): AgentConfig | undefined {
    const needle = mention.trim().toLowerCase();
    for (const config of this.configs) {
      for (const pattern of config.mentionPatterns) {
        if (pattern.toLowerCase() === needle) {
          return config;
        }
      }
    }
    return undefined;
  }

  getService(id: AgentId): AgentService {
    const service = this.services.get(id);
    if (service === undefined) {
      throw new Error(`AgentRegistryImpl: no AgentService registered for '${id as string}'`);
    }
    return service;
  }

  getDefault(): AgentConfig {
    return this.defaultConfig;
  }

  getMentionEntries(): readonly MentionEntry[] {
    return this.mentionEntries;
  }

  isAvailable(id: AgentId): boolean {
    // Absent from the map ⇒ AVAILABLE (default true) — fakes/unprobed agents stay
    // routable, matching Clowder's "not-in-roster = available" backward-compat.
    return this.availability.get(id) ?? true;
  }
}
