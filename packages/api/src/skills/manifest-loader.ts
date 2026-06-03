// M11 SkillManifest loader.
// Source: clowder-architecture-design.md §5.5 (SkillManifestLoader.loadManifest).
//
// Parses the YAML skills manifest into the frozen M1 SkillManifest shape.
// The manifest is the single source of truth for routing metadata
// (triggers / not_for / output / next / sop_step); the platform itself does
// NOT keyword-match — this metadata is injected into the system prompt so the
// agent self-selects which skill to load (§5.5 架构说明).

import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { z } from 'zod';
import type { SkillDefinition, SkillManifest } from '@choco/shared';
import { manifestPath as defaultManifestPath } from '@choco/skills';

/**
 * Raw per-skill shape as authored in manifest.yaml (snake_case on disk).
 * Mapped to the camelCase {@link SkillDefinition} after validation.
 */
const RawSkillSchema = z
  .object({
    description: z.string().min(1),
    triggers: z.array(z.string()),
    not_for: z.array(z.string()),
    output: z.string().min(1),
    next: z.array(z.string()).optional(),
    // SOP stage id this skill maps to; null when the skill is not part of a
    // gated SOP stage (matches SkillDefinition.sopStep: string | null).
    sop_step: z.union([z.string(), z.null()]).optional(),
    // Grouping label (dev-chain / memory / meta / multi-agent) — surfaced as the
    // skill's category in the settings 分类 filter.
    group: z.string().optional(),
  })
  .strict();

const RawManifestSchema = z.object({
  skills: z.record(z.string(), RawSkillSchema),
});

function toSkillDefinition(id: string, raw: z.infer<typeof RawSkillSchema>): SkillDefinition {
  const definition: SkillDefinition = {
    id,
    description: raw.description,
    triggers: raw.triggers,
    notFor: raw.not_for,
    output: raw.output,
    sopStep: raw.sop_step ?? null,
  };
  if (raw.next !== undefined) {
    definition.next = raw.next;
  }
  if (raw.group !== undefined) {
    definition.group = raw.group;
  }
  return definition;
}

/**
 * Load and validate the skills manifest into a {@link SkillManifest}.
 *
 * @param path Absolute path to manifest.yaml. Defaults to the @choco/skills
 *   package's exported {@link defaultManifestPath} (never hardcode the path).
 */
export function loadManifest(path: string = defaultManifestPath): SkillManifest {
  const rawText = readFileSync(path, 'utf-8');
  const parsed: unknown = load(rawText);
  const manifest = RawManifestSchema.parse(parsed);

  const skills: Record<string, SkillDefinition> = {};
  for (const [id, raw] of Object.entries(manifest.skills)) {
    skills[id] = toSkillDefinition(id, raw);
  }
  return { skills };
}
