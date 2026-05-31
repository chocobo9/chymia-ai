// packages/api/src/routing/intent-parser.ts
// M4: deterministic intent parsing — re-authored from clowder-design-supplement.md
// §A5 (IntentParser). NO LLM: intent is decided by explicit `#ideate` / `#execute`
// hash tags (case-insensitive), else auto-inferred from the number of targets.
//
// Also separates "prompt tags" (e.g. #critique) which change how an agent thinks
// but do NOT change routing.

/** Intent of a routed message. Source: §A5. */
export type Intent = 'ideate' | 'execute';

/** Result of {@link parseIntent}. Source: §A5. */
export interface IntentResult {
  readonly intent: Intent;
  /** Whether the user explicitly tagged the intent (vs auto-inferred). */
  readonly explicit: boolean;
  /** Prompt-level tags (e.g. 'critique') — change thinking mode, not routing. */
  readonly promptTags: readonly string[];
}

/** Known intent tags (case-insensitive). Source: §A5 INTENT_TAGS. */
const INTENT_TAGS: ReadonlySet<string> = new Set<Intent>(['ideate', 'execute']);

/** Known prompt tags (case-insensitive). Source: §A5 PROMPT_TAGS. */
const PROMPT_TAGS: ReadonlySet<string> = new Set(['critique']);

/**
 * Target-count threshold at/above which an untagged message auto-infers `ideate`
 * (parallel divergent thinking); below it infers `execute` (serial).
 * Source: clowder-architecture-design.md §5.2 rule 4 ("≥2 targets → ideate").
 */
const IDEATE_TARGET_THRESHOLD = 2;

/** Build a fresh `#tag` matcher each call (avoids shared lastIndex state). */
function tagPattern(): RegExp {
  return /#(\w+)/gi;
}

/**
 * Parse intent + prompt tags from a message. Deterministic, no LLM.
 * Explicit `#ideate`/`#execute` wins; otherwise ≥2 targets → ideate, else execute.
 * Source: §A5 parseIntent.
 */
export function parseIntent(message: string, targetCount: number): IntentResult {
  let explicitIntent: Intent | null = null;
  const promptTags: string[] = [];

  for (const match of message.matchAll(tagPattern())) {
    const tag = match[1]?.toLowerCase();
    if (tag === undefined) {
      continue;
    }
    if (INTENT_TAGS.has(tag)) {
      explicitIntent = tag as Intent;
    } else if (PROMPT_TAGS.has(tag)) {
      promptTags.push(tag);
    }
  }

  if (explicitIntent !== null) {
    return { intent: explicitIntent, explicit: true, promptTags };
  }

  const intent: Intent =
    targetCount >= IDEATE_TARGET_THRESHOLD ? 'ideate' : 'execute';
  return { intent, explicit: false, promptTags };
}

/**
 * Strip known intent + prompt tags from a message, leaving the clean user text.
 * Unknown `#tags` are preserved (they may be meaningful content). Collapses the
 * whitespace left behind. Source: §A5 stripIntentTags.
 */
export function stripIntentTags(message: string): string {
  return message
    .replace(tagPattern(), (full, tag: string) => {
      const lower = tag.toLowerCase();
      return INTENT_TAGS.has(lower) || PROMPT_TAGS.has(lower) ? '' : full;
    })
    .replace(/\s{2,}/g, ' ')
    .trim();
}
