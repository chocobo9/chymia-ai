// InvocationContext: the context bundle consumed by buildSystemPrompt.
// Source: clowder-architecture-design.md §5.4 (SystemPromptBuilder / InvocationContext).

import type { AgentId } from './agent.js';

/**
 * InvocationMode — 本次 invocation 的执行模式。
 * Source: §5.4 (InvocationContext.mode)。
 */
export type InvocationMode = 'independent' | 'serial' | 'parallel';

/**
 * CrossThreadReplyHint — 跨 thread 回复提示。
 * Source: §5.4 (InvocationContext.crossThreadReplyHint)。
 */
export interface CrossThreadReplyHint {
  sourceThreadId: string;
  senderCatId: string;
}

/**
 * PingPongWarning — A2A 来回传球检测警告。
 * Source: §5.4 (InvocationContext.pingPongWarning)。
 */
export interface PingPongWarning {
  pairedWith: AgentId;
  count: number;
}

/**
 * MentionRoutingFeedback — 上次 @mention 未被路由的反馈。
 * Source: §5.4 (InvocationContext.mentionRoutingFeedback)。
 */
export interface MentionRoutingFeedback {
  items: Array<{ targetCatId: string }>;
}

/**
 * ActiveParticipant — 活跃参与者条目。
 * Source: §5.4 (InvocationContext.activeParticipants)。
 */
export interface ActiveParticipant {
  catId: string;
  lastMessageAt: number; // epoch ms
}

/**
 * InvocationContext — 传给 buildSystemPrompt 的上下文包。
 * Source: §5.4.
 */
export interface InvocationContext {
  agentId: AgentId;
  mode: InvocationMode;
  chainIndex?: number; // serial 模式下的位置（1-based）
  chainTotal?: number;
  teammates: readonly AgentId[];
  mcpAvailable: boolean;
  a2aEnabled?: boolean;
  /** A2A 直接消息来源（谁 @ 了当前 agent） */
  directMessageFrom?: AgentId;
  /** 跨 thread 回复提示 */
  crossThreadReplyHint?: CrossThreadReplyHint;
  /** ping-pong 警告（A2A 来回传球检测） */
  pingPongWarning?: PingPongWarning;
  /** 上次 @mention 未被路由的反馈 */
  mentionRoutingFeedback?: MentionRoutingFeedback;
  /** 当前 SOP 阶段提示（告示牌，不阻断执行） */
  sopStageHint?: string;
  promptTags?: readonly string[]; // #critique, skill:xxx 等
  /** 活跃参与者列表 */
  activeParticipants?: ActiveParticipant[];
}
