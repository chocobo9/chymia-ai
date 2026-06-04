// M12 SOP YAML loader — parse sop/*.yaml into frozen SopDefinition (M1).

import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import { z } from 'zod';
import type { SopDefinition, SopPredicate, SopRule, SopStage } from '@choco/shared';

const RawPredicateSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('manual_only'), reason: z.string().min(1) }).strict(),
  z
    .object({
      type: z.literal('git_state_predicate'),
      checks: z.array(z.string()).min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal('command_pattern'),
      must_match: z.string().min(1),
      must_not_match: z.string().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('handle_check'),
      constraint: z.string().min(1),
    })
    .strict(),
]);

const RawRuleSchema = z
  .object({
    id: z.string().min(1),
    text: z.string().min(1),
    severity: z.enum(['blocker', 'warn']),
    predicate: RawPredicateSchema,
  })
  .strict();

const RawStageSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    suggested_skill: z.string().optional(),
    hard_rules: z.array(RawRuleSchema).default([]),
    pitfalls: z.array(RawRuleSchema).default([]),
  })
  .strict();

const RawSopSchema = z
  .object({
    id: z.string().min(1),
    domain: z.string().min(1),
    label: z.string().min(1),
    description: z.string().optional(),
    stages: z.array(RawStageSchema).min(1),
  })
  .strict();

function mapPredicate(raw: z.infer<typeof RawPredicateSchema>): SopPredicate {
  switch (raw.type) {
    case 'manual_only':
      return { type: 'manual_only', reason: raw.reason };
    case 'git_state_predicate':
      return { type: 'git_state_predicate', checks: [...raw.checks] };
    case 'command_pattern': {
      const p: SopPredicate = { type: 'command_pattern', mustMatch: raw.must_match };
      return p;
    }
    case 'handle_check':
      return { type: 'handle_check', constraint: raw.constraint };
  }
}

function mapRule(raw: z.infer<typeof RawRuleSchema>): SopRule {
  return {
    id: raw.id,
    text: raw.text,
    severity: raw.severity,
    predicate: mapPredicate(raw.predicate),
  };
}

function mapStage(raw: z.infer<typeof RawStageSchema>): SopStage {
  const stage: SopStage = {
    id: raw.id,
    label: raw.label,
    hardRules: raw.hard_rules.map(mapRule),
    pitfalls: raw.pitfalls.map(mapRule),
  };
  if (raw.suggested_skill !== undefined) {
    stage.suggestedSkill = raw.suggested_skill;
  }
  return stage;
}

/** Load a SOP YAML file into {@link SopDefinition}. */
export function loadSopDefinition(path: string): SopDefinition {
  const parsed: unknown = load(readFileSync(path, 'utf-8'));
  const raw = RawSopSchema.parse(parsed);
  return {
    id: raw.id,
    domain: raw.domain,
    label: raw.label,
    ...(raw.description !== undefined ? { description: raw.description } : {}),
    stages: raw.stages.map(mapStage),
  };
}
