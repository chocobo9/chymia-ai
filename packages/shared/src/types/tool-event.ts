// Persisted tool-call event types (M5 ToolEventLog).
// Source: clowder-design-supplement.md §A6 (IToolEventLog + StoredToolEvent).

import type { AgentId } from './agent.js';

/**
 * StoredToolEvent — 持久化的工具调用事件（agent 在一次 invocation 中调用某个工具的记录）。
 * Source: §A6.
 *
 * agentId 使用品牌 AgentId（与 StoredMessage.agentId 的约定一致）。toolInput /
 * toolResult 以 JSON 字符串形态存储（A6 标注 toolInput 为 JSON），durationMs 在
 * tool_use → tool_result 配对成功时记录，未配对时省略（可选）。
 */
export interface StoredToolEvent {
  id: string;
  invocationId: string;
  threadId: string;
  agentId: AgentId;
  toolName: string;
  toolInput?: string; // JSON
  toolResult?: string;
  durationMs?: number;
  timestamp: number; // epoch ms
  sessionId?: string; // 补充 E E3.3: 该工具事件所属的 session
}

/**
 * IToolEventLog — A6 工具事件日志接口。append 写入一条事件并返回带 id 的完整记录；
 * readByThread / readByInvocation 分别按 thread 与 invocation 维度回读。
 * Source: §A6.
 */
export interface IToolEventLog {
  append(event: Omit<StoredToolEvent, 'id'>): Promise<StoredToolEvent>;
  readByThread(threadId: string): Promise<StoredToolEvent[]>;
  readByInvocation(invocationId: string): Promise<StoredToolEvent[]>;
}
