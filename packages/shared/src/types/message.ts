// Unified event stream + persisted message types.
// Source: clowder-architecture-design.md §4.2 (统一事件流) + §4.3 (持久化消息).

import type { AgentId } from './agent.js';

/**
 * AgentMessageType — agent 输出的统一事件类型。
 * Source: §4.2.
 */
export type AgentMessageType =
  | 'text' // 文本输出（流式）
  | 'tool_use' // 开始使用工具
  | 'tool_result' // 工具返回结果
  | 'thinking' // 思考过程（可选展示）
  | 'error' // 错误
  | 'done' // 完成
  | 'a2a_handoff' // A2A 传球事件
  | 'system_info' // 系统信息（invocation 创建、task progress 等）
  | 'session_init'; // CLI session 初始化

/**
 * MessageMetadata — provider/model/token usage 元数据。
 * Source: §4.2.
 */
export interface MessageMetadata {
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * AgentMessage — 统一事件格式（所有 provider 的输出都转成这个）。
 * Source: §4.2. 设计文档定义为单一扁平接口（非 discriminated union），
 * 字段按 type 语义可选填充。
 */
export interface AgentMessage {
  type: AgentMessageType;
  agentId: AgentId;
  content?: string;
  toolName?: string; // tool_use 时的工具名
  toolInput?: Record<string, unknown>; // tool_use 时的工具参数
  toolUseId?: string; // tool_use 的 ID（用于匹配 tool_result）
  invocationId?: string;
  sessionId?: string; // 补充 E E3.3: 该事件所属的 session（路由层据此给消息/工具事件打标）
  targetAgentId?: AgentId; // a2a_handoff 时的目标 agent
  isFinal?: boolean; // done 事件：是否是整个路由链的最后一个
  errorCode?: string; // done 事件：错误码
  metadata?: MessageMetadata;
  timestamp: number; // epoch ms
}

/**
 * StoredMessageOrigin — 持久化消息的来源。
 * Source: §4.3 (StoredMessage.origin)。
 */
export type StoredMessageOrigin = 'user' | 'stream' | 'callback' | 'system';

/**
 * StoredMessage — 存储在 SQLite 中的消息记录。
 * Source: §4.3.
 */
export interface StoredMessage {
  id: string; // UUID
  threadId: string;
  userId: string; // 'user' | 'system' | agent 回调时的 userId
  agentId: AgentId | null; // null = 用户消息
  content: string;
  mentions: AgentId[]; // 这条消息 @ 了哪些 agent
  origin?: StoredMessageOrigin;
  timestamp: number; // epoch ms
  extra?: Record<string, unknown>; // 额外结构化数据（cross-post、tracing 等）
  sessionId?: string; // 补充 E E3.3: 该 agent 回复所属的 session（user 消息为空）
}
