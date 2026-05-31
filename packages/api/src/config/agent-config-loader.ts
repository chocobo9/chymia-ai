// M8 agent-config loader — parse the externalized agent roster (agents.yaml)
// into the frozen M1 AgentConfig[] shape.
//
// Data externalization (CLAUDE.md §3.3): the roster is YAML, not TS. This loader
// validates the on-disk shape with zod and maps snake-free YAML → AgentConfig.
// The app-factory feeds the result to AgentRegistryImpl (M4); no global state.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { load } from 'js-yaml';
import { z } from 'zod';
import type { AgentConfig, ClientId } from '@clowder/shared';
import { createAgentId } from '@clowder/shared';

/** Default roster path: the agents.yaml shipped beside this loader. */
export const DEFAULT_AGENTS_CONFIG_PATH: string = join(
  dirname(fileURLToPath(import.meta.url)),
  'agents.yaml',
);

/** Allowed CLI clients (mirrors frozen M1 ClientId union). */
const CLIENT_IDS = ['anthropic', 'openai', 'google'] as const satisfies readonly ClientId[];

const ColorSchema = z
  .object({
    primary: z.string().min(1),
    secondary: z.string().min(1),
  })
  .strict();

/** Raw per-agent shape as authored in agents.yaml. */
const RawAgentSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    displayName: z.string().min(1),
    clientId: z.enum(CLIENT_IDS),
    defaultModel: z.string().min(1),
    mcpSupport: z.boolean(),
    mentionPatterns: z.array(z.string().min(1)).min(1),
    personality: z.string().min(1),
    roleDescription: z.string().min(1),
    strengths: z.array(z.string().min(1)).optional(),
    restrictions: z.array(z.string().min(1)).optional(),
    color: ColorSchema,
  })
  .strict();

const RawRosterSchema = z.object({
  agents: z.array(RawAgentSchema).min(1),
});

function toAgentConfig(raw: z.infer<typeof RawAgentSchema>): AgentConfig {
  return {
    id: createAgentId(raw.id),
    name: raw.name,
    displayName: raw.displayName,
    clientId: raw.clientId,
    defaultModel: raw.defaultModel,
    mcpSupport: raw.mcpSupport,
    mentionPatterns: raw.mentionPatterns,
    personality: raw.personality,
    roleDescription: raw.roleDescription,
    ...(raw.strengths !== undefined ? { strengths: raw.strengths } : {}),
    ...(raw.restrictions !== undefined ? { restrictions: raw.restrictions } : {}),
    color: raw.color,
  };
}

/**
 * Load + validate the agent roster from a YAML file.
 * Throws (fail-fast, CLAUDE.md error-handling) if the file is missing or the
 * shape is invalid — a malformed roster must not boot a half-wired registry.
 *
 * @param path roster YAML path. Defaults to {@link DEFAULT_AGENTS_CONFIG_PATH}.
 */
export function loadAgentConfigs(path: string = DEFAULT_AGENTS_CONFIG_PATH): AgentConfig[] {
  const text = readFileSync(path, 'utf8');
  const parsed: unknown = load(text);
  const roster = RawRosterSchema.parse(parsed);
  return roster.agents.map(toAgentConfig);
}
