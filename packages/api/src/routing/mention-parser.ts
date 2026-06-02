// packages/api/src/routing/mention-parser.ts
// M4: @mention parsing — re-authored from clowder-architecture-design.md §5.2
// (routing rule 1: "有 @mention → 路由到指定 agent(s)") and the line-start A2A
// rules in Clowder's a2a-mentions.ts (understood, NOT copied).
//
// Two surfaces:
//   - parseUserMentions: a user message may @mention agents anywhere in the text;
//     returns the targets in order of first appearance, deduped.
//   - parseA2AMentions: an agent reply only hands off when the @mention sits at
//     the START of a line (after optional markdown list/quote prefix), code
//     fences stripped, self filtered, capped at MAX_A2A_MENTION_TARGETS.
//
// Both share boundary handling so "@opus" never falsely matches inside "@opus-45".

import type { AgentId } from '@choco/shared';

/**
 * One mention trigger for an agent, e.g. { agentId, pattern: '@claude' }.
 * Patterns come from AgentConfig.mentionPatterns (one agent may have several).
 */
export interface MentionEntry {
  readonly agentId: AgentId;
  readonly pattern: string;
}

/**
 * Max distinct agents a single agent reply may hand off to.
 * Source: Clowder a2a-mentions.ts MAX_A2A_MENTION_TARGETS (default 2) — a safety
 * limit so one reply cannot fan out the worklist uncontrollably.
 */
export const MAX_A2A_MENTION_TARGETS = 2;

/**
 * Characters that may continue a handle token ([a-z0-9_.-]). If the char right
 * after a matched pattern is one of these (and not a token boundary), the match
 * is a prefix of a longer handle and must be rejected.
 * Source: Clowder a2a-mentions.ts HANDLE_CONTINUATION_RE.
 */
const HANDLE_CONTINUATION_RE = /[a-z0-9_.-]/;

/**
 * Token boundary characters (ASCII + CJK punctuation) that cleanly terminate a
 * mention. Source: Clowder a2a-mentions.ts TOKEN_BOUNDARY_RE.
 */
const TOKEN_BOUNDARY_RE =
  /[\s,.:;!?()[\]{}<>，。！？、：；（）【】《》「」『』〈〉]/;

/** Leading markdown prefixes (blockquote / list markers) before a line-start @mention. */
const LEADING_MARKDOWN_PREFIX_RE = /^(?:(?:>\s*)|(?:[-*+]\s+)|(?:\d+[.)]\s+))+/;

/** Fenced code block matcher; stripped before A2A parsing so code is never routed. */
const CODE_FENCE_RE = /```[\s\S]*?```/g;

/** A right-hand boundary exists when the next char is missing, punctuation, or a non-handle char. */
function isRightBoundary(after: string | undefined): boolean {
  return (
    after === undefined ||
    TOKEN_BOUNDARY_RE.test(after) ||
    !HANDLE_CONTINUATION_RE.test(after)
  );
}

/** Sort longest pattern first so a longer handle wins over its prefix at the same spot. */
function byLongestPattern(a: MentionEntry, b: MentionEntry): number {
  return b.pattern.length - a.pattern.length;
}

/**
 * Parse the @mentions a USER message addresses, anywhere in the text.
 * Returns the matched agents in order of first appearance, deduped.
 *
 * Boundary rules: the char before '@' must not be a handle char (rejects
 * "email@claude"); the char after the pattern must be a boundary (rejects the
 * "@opus" prefix of "@opus-45").
 */
export function parseUserMentions(
  text: string,
  entries: readonly MentionEntry[],
): AgentId[] {
  if (text === '') {
    return [];
  }
  const lower = text.toLowerCase();
  const sorted = [...entries].sort(byLongestPattern);
  const earliestByAgent = new Map<AgentId, number>();

  for (const entry of sorted) {
    const pattern = entry.pattern.toLowerCase();
    if (pattern === '') {
      continue;
    }
    let from = 0;
    for (;;) {
      const idx = lower.indexOf(pattern, from);
      if (idx < 0) {
        break;
      }
      from = idx + 1;
      const before = idx > 0 ? lower[idx - 1] : undefined;
      if (before !== undefined && HANDLE_CONTINUATION_RE.test(before)) {
        continue;
      }
      if (!isRightBoundary(lower[idx + pattern.length])) {
        continue;
      }
      const prev = earliestByAgent.get(entry.agentId);
      if (prev === undefined || idx < prev) {
        earliestByAgent.set(entry.agentId, idx);
      }
    }
  }

  return [...earliestByAgent.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([agentId]) => agentId);
}

/**
 * Parse A2A hand-off @mentions from an agent reply. Only line-start mentions
 * (after optional whitespace + markdown list/quote prefix) route — this mirrors
 * Clowder's "行首即路由" rule so prose like "ask @claude later" does not trigger
 * a handoff. Code fences are stripped, self-mentions filtered, and the result is
 * capped at {@link MAX_A2A_MENTION_TARGETS}.
 */
export function parseA2AMentions(
  text: string,
  entries: readonly MentionEntry[],
  selfId?: AgentId,
  maxTargets: number = MAX_A2A_MENTION_TARGETS,
): AgentId[] {
  if (text === '') {
    return [];
  }
  const stripped = text.replace(CODE_FENCE_RE, '');
  const sorted = [...entries]
    .filter((e) => selfId === undefined || e.agentId !== selfId)
    .sort(byLongestPattern);

  const found: AgentId[] = [];
  const seen = new Set<AgentId>();

  for (const rawLine of stripped.split(/\r?\n/)) {
    if (found.length >= maxTargets) {
      break;
    }
    const leadingWs = rawLine.match(/^\s*/)?.[0].length ?? 0;
    const normalized = rawLine
      .slice(leadingWs)
      .toLowerCase()
      .replace(LEADING_MARKDOWN_PREFIX_RE, '');
    if (!normalized.startsWith('@')) {
      continue;
    }

    // Walk consecutive mentions on this line ("@claude @codex ...").
    let cursor = 0;
    while (cursor < normalized.length && found.length < maxTargets) {
      const segment = normalized.slice(cursor);
      let matched = false;
      for (const entry of sorted) {
        const pattern = entry.pattern.toLowerCase();
        if (pattern === '' || !segment.startsWith(pattern)) {
          continue;
        }
        if (!isRightBoundary(segment[pattern.length])) {
          continue;
        }
        if (!seen.has(entry.agentId)) {
          seen.add(entry.agentId);
          found.push(entry.agentId);
        }
        cursor += pattern.length;
        matched = true;
        break; // longest-first: lock one winner at this cursor
      }
      if (!matched) {
        break;
      }
      while (cursor < normalized.length && TOKEN_BOUNDARY_RE.test(normalized[cursor] ?? '')) {
        cursor += 1;
      }
      if (normalized[cursor] !== '@') {
        break;
      }
    }
  }

  return found;
}
