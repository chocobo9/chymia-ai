// packages/api/src/routing/unavailable-notice.ts
// §C Unavailable-agent notice — the single source of truth for the visible
// notice surfaced when a user explicitly @mentions an agent whose provider CLI
// is not installed on this system (Clowder's `cat_disabled` with `alternatives`).
//
// The dogfooding bug: messages to unavailable agents (codex/gemini) got NO
// response and NO error — silence. Clowder instead returns a VISIBLE routing
// notice naming the disabled agent + the available alternatives. We mirror that:
// the handler composes ONE notice (this module) from the unavailable set + the
// router-supplied available alternatives, broadcasts it as a `system_info`
// AgentMessage (so the live transcript shows it), AND persists it as a
// `system`-origin StoredMessage (so it survives a reload).
//
// Honest data (CLAUDE.md §2.2): the named agents are the ACTUAL unavailable
// mentions and the alternatives are the ACTUALLY-available agents — never
// placeholders.

import type { AgentConfig, AgentId, AgentMessage } from '@clowder/shared';

/** A resolver from agent id → its config (for display names + mention patterns). */
export type ResolveAgentDisplay = (id: AgentId) => AgentConfig | undefined;

/** Inputs for composing the unavailable notice. */
export interface UnavailableNoticeInput {
  /** Explicitly @mentioned agents that are NOT available (≥1 to build a notice). */
  readonly unavailable: readonly AgentId[];
  /** The available agents to offer as alternatives (may be empty). */
  readonly alternatives: readonly AgentId[];
  /** Resolve an agent's display config (name + mention). */
  readonly resolve: ResolveAgentDisplay;
}

/** The notice carrier the handler broadcasts + persists. */
export interface UnavailableNotice {
  /** The user-facing notice text (Chinese, with the available alternatives). */
  readonly text: string;
  /** The unavailable agent the notice is attributed to (first one). */
  readonly agentId: AgentId;
}

/** A readable label for an agent: its displayName, falling back to the id. */
function labelFor(id: AgentId, resolve: ResolveAgentDisplay): string {
  const cfg = resolve(id);
  return cfg?.displayName ?? cfg?.name ?? (id as string);
}

/** The primary @mention for an agent (first pattern), falling back to `@<id>`. */
function mentionFor(id: AgentId, resolve: ResolveAgentDisplay): string {
  const cfg = resolve(id);
  return cfg?.mentionPatterns[0] ?? `@${id as string}`;
}

/**
 * Compose the notice text. Examples:
 *   "Codex (GPT) 未启用（未检测到 CLI）— 可用：@claude、@gemini"
 *   "Codex (GPT)、Gemini (Pro) 未启用（未检测到 CLI）— 当前无可用 agent"
 */
export function formatUnavailableNotice(input: UnavailableNoticeInput): string {
  const names = input.unavailable.map((id) => labelFor(id, input.resolve)).join('、');
  const head = `${names} 未启用（未检测到 CLI）`;
  if (input.alternatives.length === 0) {
    return `${head} — 当前无可用 agent`;
  }
  const alts = input.alternatives.map((id) => mentionFor(id, input.resolve)).join('、');
  return `${head} — 可用：${alts}`;
}

/**
 * Build the notice carrier (text + the attributed unavailable agent). Returns
 * undefined when there are no unavailable mentions (no notice to show).
 */
export function buildUnavailableNotice(
  input: UnavailableNoticeInput,
): UnavailableNotice | undefined {
  const first = input.unavailable[0];
  if (first === undefined) return undefined;
  return { text: formatUnavailableNotice(input), agentId: first };
}

/**
 * Render the notice as a `system_info` AgentMessage for the socket broadcast.
 * `system_info` is a terminal/lifecycle type (SocketManager never rate-limits
 * it), and the M1 AgentMessage shape carries the text in `content`. The frontend
 * renders it as a visible notice bubble (§D).
 */
export function noticeToAgentEvent(
  notice: UnavailableNotice,
  timestamp: number,
): AgentMessage {
  return {
    type: 'system_info',
    agentId: notice.agentId,
    content: notice.text,
    timestamp,
  };
}
