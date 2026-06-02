// M-MEMBER agent-overrides — a mutable, persisted RUNTIME OVERLAY over the static
// agents.yaml roster.
//
// WHY (research, from Clowder's runtime catalog): the reference keeps the
// authored agent definitions immutable on disk but lets an operator edit a
// member at runtime (role/personality/strengths/display fields/color) and have
// the edit take effect on the NEXT turn's system prompt WITHOUT a restart. It
// does this by layering a small per-agent override on top of the static config
// whenever a config is resolved.
//
// We mirror that overlay model: `applyAgentOverride` merges a partial override
// onto a base AgentConfig (pure, immutable — a NEW config out), and an
// AgentOverrideStore holds the editable layer. The app-factory wraps its
// `resolveConfig` seam with `applyAgentOverride(base, store.get(id))`, so the
// SAME static roster powers routing/spawn (which read clientId/mentionPatterns/
// defaultModel/mcpSupport — DELIBERATELY NOT editable here) while the system
// prompt + the GET /api/agents roster reflect live edits.
//
// SCOPE: EDIT existing members only. The overlay never adds/removes agents and
// never touches clientId/mentionPatterns/defaultModel/mcpSupport (the registry +
// provider services are built once at boot from those; mutating them at runtime
// would desync routing/spawn).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { AgentConfig } from '@choco/shared';

/** Color override shape — both members required when color is edited (§4.1). */
const ColorOverrideSchema = z
  .object({
    primary: z.string().min(1),
    secondary: z.string().min(1),
  })
  .strict();

/**
 * AgentOverrideSchema — the editable layer over an AgentConfig. EVERY field is
 * optional (a PATCH carries only what changed); `.strict()` rejects unknown keys
 * so a caller can never smuggle in a non-editable field (e.g. clientId).
 */
export const AgentOverrideSchema = z
  .object({
    displayName: z.string().min(1),
    name: z.string().min(1),
    roleDescription: z.string().min(1),
    personality: z.string().min(1),
    strengths: z.array(z.string().min(1)),
    restrictions: z.array(z.string().min(1)),
    color: ColorOverrideSchema,
  })
  .partial()
  .strict();

/** The editable per-agent override (all fields optional). */
export type AgentOverride = z.infer<typeof AgentOverrideSchema>;

/** The on-disk shape of {@link JsonAgentOverrideStore}: agentId → override. */
const OverrideMapSchema = z.record(z.string(), AgentOverrideSchema);

/**
 * Apply a partial override onto a base AgentConfig. PURE + IMMUTABLE: returns
 * `base` unchanged when there is no override, else a NEW AgentConfig with ONLY
 * the present override fields layered on. Never mutates `base` (CLAUDE.md
 * immutability). Absent override fields keep the base value — so a partial edit
 * (e.g. only roleDescription) leaves everything else intact.
 */
export function applyAgentOverride(
  base: AgentConfig,
  override: AgentOverride | undefined,
): AgentConfig {
  if (override === undefined) return base;
  return {
    ...base,
    ...(override.displayName !== undefined ? { displayName: override.displayName } : {}),
    ...(override.name !== undefined ? { name: override.name } : {}),
    ...(override.roleDescription !== undefined
      ? { roleDescription: override.roleDescription }
      : {}),
    ...(override.personality !== undefined ? { personality: override.personality } : {}),
    ...(override.strengths !== undefined ? { strengths: override.strengths } : {}),
    ...(override.restrictions !== undefined ? { restrictions: override.restrictions } : {}),
    ...(override.color !== undefined ? { color: override.color } : {}),
  };
}

/**
 * AgentOverrideStore — the mutable overlay layer. `get` returns the current
 * override for an agent (or undefined), `set` records/merges one, `all` returns
 * the whole map. Implementations decide persistence.
 */
export interface AgentOverrideStore {
  get(agentId: string): AgentOverride | undefined;
  set(agentId: string, override: AgentOverride): void;
  all(): Record<string, AgentOverride>;
}

/**
 * NullAgentOverrideStore — the buildApp default: no persistence, no overrides.
 * Tests with injected fakes get this, so the static roster flows through
 * unchanged (no behavior change vs. before M-MEMBER).
 */
export class NullAgentOverrideStore implements AgentOverrideStore {
  get(): AgentOverride | undefined {
    return undefined;
  }

  set(): void {
    /* no persistence */
  }

  all(): Record<string, AgentOverride> {
    return {};
  }
}

/**
 * JsonAgentOverrideStore — persists the overlay map to a JSON file. The map is
 * loaded once on construct (fail-open: a missing/malformed file → empty map,
 * NEVER throws at boot — a corrupt override file must not stop the API). Every
 * `set` MERGES field-wise over any existing override for that id (so a partial
 * PATCH never drops an earlier edit), updates the in-memory map IMMUTABLY, and
 * rewrites the whole map as pretty JSON (creating the parent dir first).
 */
export class JsonAgentOverrideStore implements AgentOverrideStore {
  private readonly filePath: string;
  private overrides: Readonly<Record<string, AgentOverride>>;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.overrides = JsonAgentOverrideStore.load(filePath);
  }

  /** Read + validate the override file. Fail-open to an empty map. */
  private static load(filePath: string): Readonly<Record<string, AgentOverride>> {
    try {
      const text = readFileSync(filePath, 'utf8');
      const parsed: unknown = JSON.parse(text);
      return OverrideMapSchema.parse(parsed);
    } catch {
      // Missing or malformed file — start with no overrides (fail-open).
      return {};
    }
  }

  get(agentId: string): AgentOverride | undefined {
    return this.overrides[agentId];
  }

  set(agentId: string, override: AgentOverride): void {
    const prev = this.overrides[agentId];
    // Field-wise merge so a partial PATCH accumulates over earlier edits.
    const merged: AgentOverride = prev === undefined ? override : { ...prev, ...override };
    // Immutable update: a NEW map (never mutate the held one).
    this.overrides = { ...this.overrides, [agentId]: merged };
    this.persist();
  }

  all(): Record<string, AgentOverride> {
    // Return a copy so callers cannot mutate the held map.
    return { ...this.overrides };
  }

  /** Rewrite the whole map as pretty JSON, creating the parent dir first. */
  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.overrides, null, 2), 'utf8');
  }
}
