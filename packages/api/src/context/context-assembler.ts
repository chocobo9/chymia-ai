// ContextAssembler — assemble recent thread history into a prompt-prepend string.
//
// Source: clowder-architecture-design.md §5.4 (Effective Prompt / Conversation
// History) + §7.3 (Context 预算控制: token 估算 + 从最近往前填充) + clowder-design-
// supplement.md §C4 (Conversation History 最多 2000 tokens).
//
// WHY (research, from Clowder ContextAssembler.ts): the reference walks the
// formatted lines backward from the most-recent, accumulating an estimated token
// budget, and truncates per-message head+tail so conclusions/requests at the end
// survive. We re-author that; sender naming is decoupled via an injected resolver
// (we have no global agent registry — supplement D forbids singletons).

import type { AgentConfig, AgentId, StoredMessage } from '@clowder/shared';

/** Resolve an AgentConfig by id (injected — no global registry). */
export type ResolveAgentConfig = (id: AgentId) => AgentConfig | undefined;

/**
 * Default ContextAssembler limits. Source: PROJECT_SPEC M7 (默认 20 条 / 2000
 * tokens / 1500 chars) — mirrors Clowder ContextAssembler defaults (§C4).
 */
export const DEFAULT_MAX_MESSAGES = 20; // 20 recent messages — Clowder ContextAssembler default
export const DEFAULT_MAX_CONTENT_LENGTH = 1500; // 1500 chars/message — Clowder ContextAssembler default
export const DEFAULT_MAX_TOTAL_TOKENS = 2000; // 2000 token history budget — design-supplement §C4

/** Label used for user (non-agent) messages. CLAUDE.md: 铲屎官 → 用户. */
export const USER_SENDER_LABEL = '用户';

export interface ContextAssemblerOptions {
  /** Max number of recent messages to include (default: 20). */
  maxMessages?: number;
  /** Max characters per message content before head+tail truncation (default: 1500). */
  maxContentLength?: number;
  /** Max total tokens for the assembled context (default: 2000). */
  maxTotalTokens?: number;
  /** Resolver for agent display names; user messages always use {@link USER_SENDER_LABEL}. */
  resolveConfig?: ResolveAgentConfig;
}

export interface AssembledContext {
  /** Formatted context string to prepend to the user prompt. */
  contextText: string;
  /** Number of messages actually included after budget trimming. */
  messageCount: number;
  /** Estimated token count of {@link AssembledContext.contextText}. */
  estimatedTokens: number;
}

/**
 * Estimate token count for a string. Heuristic (zero-dependency): CJK codepoints
 * count ~1 token each; remaining (latin/punct/whitespace) ~4 chars per token.
 * Source: §7.3 "token 估算" — Clowder uses a char-based estimator; we approximate
 * the same shape with a CJK-aware split so Chinese history is not undercounted.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  const cjkCount = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const rest = text.length - cjkCount;
  return cjkCount + Math.ceil(rest / 4);
}

/**
 * Format an epoch-ms timestamp as a UTC HH:MM stamp for prompt injection.
 * UTC keeps cats aligned with external UTC sources (Clowder formatPromptTime).
 */
export function formatPromptTime(epochMs: number): string {
  const d = new Date(epochMs);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** Format a [from, to] epoch-ms range as `HH:MM–HH:MM`. */
export function formatPromptTimeRange(from: number, to: number): string {
  return `${formatPromptTime(from)}–${formatPromptTime(to)}`;
}

/**
 * Display name for a message sender. User (agentId === null) → {@link USER_SENDER_LABEL};
 * agent → resolved displayName, falling back to the raw agent id.
 */
export function getSenderName(agentId: AgentId | null, resolveConfig?: ResolveAgentConfig): string {
  if (agentId === null) return USER_SENDER_LABEL;
  const config = resolveConfig?.(agentId);
  return config?.displayName ?? (agentId as string);
}

/**
 * Truncate content keeping head (40%) and tail (60%) — conclusions/requests live
 * at the end. Marker carries the dropped char count. Pattern from Clowder
 * ContextAssembler.truncateHeadTail (re-authored).
 */
function truncateHeadTail(content: string, limit: number): string {
  const dropped = content.length - limit;
  const marker = `\n\n[...truncated ${dropped} chars...]\n\n`;
  const available = limit - marker.length;
  if (available <= 0) return content.slice(0, limit);
  const headSize = Math.floor(available * 0.4);
  const tailSize = available - headSize;
  return content.slice(0, headSize) + marker + content.slice(-tailSize);
}

/**
 * Format a single message as `[HH:MM 角色名] 内容` (optionally truncated).
 */
export function formatMessage(
  msg: StoredMessage,
  options?: { truncate?: number; resolveConfig?: ResolveAgentConfig },
): string {
  const time = formatPromptTime(msg.timestamp);
  const sender = getSenderName(msg.agentId, options?.resolveConfig);
  let content = msg.content;
  if (options?.truncate !== undefined && content.length > options.truncate) {
    content = truncateHeadTail(content, options.truncate);
  }
  return `[${time} ${sender}] ${content}`;
}

/**
 * ContextAssembler — turns recent thread messages into a bounded context string.
 *
 * Stateless aside from its configured budgets; constructed once and reused
 * (supplement D: constructor injection, no global singletons).
 */
export class ContextAssembler {
  private readonly maxMessages: number;
  private readonly maxContentLength: number;
  private readonly maxTotalTokens: number;
  private readonly resolveConfig?: ResolveAgentConfig;

  constructor(options?: ContextAssemblerOptions) {
    this.maxMessages = options?.maxMessages ?? DEFAULT_MAX_MESSAGES;
    this.maxContentLength = options?.maxContentLength ?? DEFAULT_MAX_CONTENT_LENGTH;
    this.maxTotalTokens = options?.maxTotalTokens ?? DEFAULT_MAX_TOTAL_TOKENS;
    if (options?.resolveConfig) this.resolveConfig = options.resolveConfig;
  }

  /**
   * Assemble the most-recent window of messages, trimming oldest-first until the
   * token budget is met. Messages are expected in chronological (ascending) order.
   */
  assemble(messages: readonly StoredMessage[]): AssembledContext {
    if (messages.length === 0) {
      return { contextText: '', messageCount: 0, estimatedTokens: 0 };
    }

    const recent =
      messages.length > this.maxMessages ? messages.slice(-this.maxMessages) : [...messages];
    const formatted = recent.map((m) =>
      formatMessage(m, { truncate: this.maxContentLength, ...(this.resolveConfig ? { resolveConfig: this.resolveConfig } : {}) }),
    );

    // Reserve budget for the header/footer wrapper before filling lines.
    const overheadTokens = estimateTokens('[对话历史 - 最近 99 条]\n[/对话历史]');

    let totalTokens = overheadTokens;
    let startIndex = formatted.length;
    for (let i = formatted.length - 1; i >= 0; i--) {
      const lineTokens = estimateTokens(`${formatted[i] ?? ''}\n`);
      if (totalTokens + lineTokens > this.maxTotalTokens) break;
      totalTokens += lineTokens;
      startIndex = i;
    }

    const included = formatted.slice(startIndex);
    if (included.length === 0) {
      return { contextText: '', messageCount: 0, estimatedTokens: 0 };
    }

    const header = `[对话历史 - 最近 ${included.length} 条]`;
    const contextText = `${header}\n${included.join('\n')}\n[/对话历史]`;
    return { contextText, messageCount: included.length, estimatedTokens: totalTokens };
  }
}
