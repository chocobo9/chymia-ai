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
}

/** Options for {@link AgentRegistryImpl}. */
export interface AgentRegistryOptions {
  /** Which agent is the default fallback; defaults to the first config. */
  readonly defaultAgentId?: AgentId;
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
}
