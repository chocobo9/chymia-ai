// Invocation lifecycle + callback auth verification types.
// Source: clowder-architecture-design.md §4.6 (Invocation).

import type { AgentId } from './agent.js';

/**
 * InvocationRecord — 一次 agent 调用的记录。
 * Source: §4.6.
 */
export interface InvocationRecord {
  invocationId: string; // UUID
  callbackToken: string; // UUID，MCP 回调鉴权
  userId: string;
  agentId: AgentId;
  threadId: string;
  parentInvocationId?: string;
  a2aTriggerMessageId?: string; // A2A 触发的消息 ID
  claimedMessageIds: Set<string>; // 幂等性：已处理的 client message ID
  createdAt: number; // epoch ms
  expiresAt: number; // TTL 2 小时
}

/**
 * AuthFailureReason — callback 鉴权失败原因。
 * Source: §4.6.
 */
export type AuthFailureReason =
  | 'expired'
  | 'invalid_token'
  | 'unknown_invocation'
  | 'stale_invocation';

/**
 * VerifyResult — callback 鉴权校验结果（discriminated union, 按 `ok` 判别）。
 * Source: §4.6.
 */
export type VerifyResult =
  | { ok: true; record: InvocationRecord }
  | { ok: false; reason: AuthFailureReason };
