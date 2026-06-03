// packages/api/src/config/runtime-roster.ts
// Runtime roster store — the persisted layer of MEMBERS ADDED at runtime, on top
// of the static agents.yaml base roster. Re-authored from Clowder's
// runtime-cat-catalog.ts (createRuntimeCat / deleteRuntimeCat persist a JSON
// catalog merged over the static config), adapted to our flat AgentConfig roster.
//
// Where agent-overrides.ts OVERLAYS editable fields on EXISTING agents, this store
// holds WHOLE new AgentConfigs. At boot the composition root merges
// [...agents.yaml, ...runtimeRoster.all()] into the registry; POST /api/agents
// appends here (and hot-registers), DELETE removes here (and unregisters). Base
// agents (from yaml) are NOT in this store and cannot be deleted.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { createAgentId, type AgentConfig } from '@choco/shared';

/** The client ids we can build a provider for (anthropic/openai/google). */
export const CLIENT_IDS = ['anthropic', 'openai', 'google'] as const;

/**
 * Schema for a NEW member submitted to POST /api/agents. Mirrors AgentConfig but
 * id is derived/validated as a slug, mentionPatterns must be non-empty + @-prefixed,
 * and every routing-critical field (clientId/defaultModel/mcpSupport) is required
 * (unlike a field overlay, a new member must stand on its own).
 */
export const NewMemberSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'id must be a lowercase slug (a-z, 0-9, -)'),
  name: z.string().trim().min(1),
  displayName: z.string().trim().min(1),
  clientId: z.enum(CLIENT_IDS),
  defaultModel: z.string().trim().min(1),
  mcpSupport: z.boolean().default(true),
  mentionPatterns: z
    .array(z.string().trim().min(1))
    .min(1, 'at least one @mention is required'),
  personality: z.string().trim().default(''),
  roleDescription: z.string().trim().default(''),
  strengths: z.array(z.string().trim().min(1)).default([]),
  color: z.object({ primary: z.string().min(1), secondary: z.string().min(1) }),
});

export type NewMemberInput = z.infer<typeof NewMemberSchema>;

/** Normalize an @mention token: trim, ensure a single leading '@', lowercase. */
function normalizeMention(raw: string): string {
  const t = raw.trim();
  const body = t.startsWith('@') ? t.slice(1) : t;
  return `@${body}`;
}

/**
 * Build a frozen AgentConfig from a validated new-member input. Mentions are
 * normalized (@-prefixed, deduped); the id is branded.
 */
export function newMemberToConfig(input: NewMemberInput): AgentConfig {
  const mentions = Array.from(new Set(input.mentionPatterns.map(normalizeMention)));
  return Object.freeze({
    id: createAgentId(input.id),
    name: input.name,
    displayName: input.displayName,
    clientId: input.clientId,
    defaultModel: input.defaultModel,
    mcpSupport: input.mcpSupport,
    mentionPatterns: Object.freeze(mentions),
    personality: input.personality,
    roleDescription: input.roleDescription,
    strengths: Object.freeze([...input.strengths]),
    color: Object.freeze({ ...input.color }),
  }) as AgentConfig;
}

/**
 * RuntimeRosterStore — the mutable set of runtime-added members. `all` returns the
 * added configs (base yaml agents are NOT here); `add`/`remove` persist; `has`
 * answers "is this a runtime-added (deletable) member?".
 */
export interface RuntimeRosterStore {
  all(): readonly AgentConfig[];
  has(id: string): boolean;
  add(config: AgentConfig): void;
  remove(id: string): boolean;
}

/**
 * No-op store: tests with injected fakes and the prior (yaml-only) behavior get
 * this, so nothing is persisted and the base roster is unchanged.
 */
export class NullRuntimeRosterStore implements RuntimeRosterStore {
  all(): readonly AgentConfig[] {
    return [];
  }
  has(): boolean {
    return false;
  }
  add(): void {
    /* no-op */
  }
  remove(): boolean {
    return false;
  }
}

/**
 * File-backed store. Loaded fail-open at construction (a missing/corrupt file →
 * empty roster, never blocks boot). `add`/`remove` rewrite the whole array as
 * pretty JSON (creating the parent dir first), mirroring JsonAgentOverrideStore.
 */
export class JsonRuntimeRosterStore implements RuntimeRosterStore {
  private readonly filePath: string;
  private members: AgentConfig[];

  constructor(filePath: string) {
    this.filePath = filePath;
    this.members = JsonRuntimeRosterStore.read(filePath);
  }

  private static read(filePath: string): AgentConfig[] {
    try {
      const text = readFileSync(filePath, 'utf8');
      const raw: unknown = JSON.parse(text);
      if (!Array.isArray(raw)) return [];
      const out: AgentConfig[] = [];
      for (const item of raw) {
        const parsed = NewMemberSchema.safeParse(item);
        if (parsed.success) out.push(newMemberToConfig(parsed.data));
      }
      return out;
    } catch {
      return []; // fail-open: a missing/corrupt file is an empty runtime roster
    }
  }

  all(): readonly AgentConfig[] {
    return this.members;
  }

  has(id: string): boolean {
    return this.members.some((m) => (m.id as string) === id);
  }

  add(config: AgentConfig): void {
    this.members = [...this.members.filter((m) => m.id !== config.id), config];
    this.persist();
  }

  remove(id: string): boolean {
    const next = this.members.filter((m) => (m.id as string) !== id);
    if (next.length === this.members.length) return false;
    this.members = next;
    this.persist();
    return true;
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.members, null, 2), 'utf8');
  }
}
