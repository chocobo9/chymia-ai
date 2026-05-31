// Agent identity, configuration, and runtime state.
// Source: clowder-architecture-design.md §4.1 (Agent 配置).

/**
 * AgentId — agent 的品牌 ID（branded string）。
 * Source: §4.1. 用 createAgentId() 构造，防止裸 string 误用为 AgentId。
 */
export type AgentId = string & { readonly __brand: unique symbol };

/**
 * createAgentId — 把 raw string 标记为 AgentId 的 helper。
 * Source: §4.1（设计文档显式定义此 helper，下游模块需要它构造品牌 ID）。
 */
export function createAgentId(raw: string): AgentId {
  return raw as AgentId;
}

/**
 * ClientId — 支持的 CLI 客户端。
 * Source: §4.1.
 */
export type ClientId = 'anthropic' | 'openai' | 'google';

/**
 * AgentStatus — agent 运行时状态枚举。
 * Source: §4.1 (AgentState.status)。
 */
export type AgentStatus = 'idle' | 'thinking' | 'working' | 'error' | 'offline';

/**
 * AgentColor — agent 的展示配色。
 * Source: §4.1 (AgentConfig.color)。
 */
export interface AgentColor {
  readonly primary: string;
  readonly secondary: string;
}

/**
 * AgentConfig — agent 静态配置（不可变）。
 * Source: §4.1.
 */
export interface AgentConfig {
  readonly id: AgentId; // 唯一标识，如 'claude-opus'
  readonly name: string; // 显示名
  readonly displayName: string; // 完整显示名
  readonly clientId: ClientId; // 对应哪个 CLI
  readonly defaultModel: string; // 默认模型，如 'claude-opus-4-6'
  readonly mcpSupport: boolean; // 是否支持 MCP
  readonly mentionPatterns: readonly string[]; // @mention 触发词
  readonly personality: string; // 性格描述（注入 system prompt）
  readonly roleDescription: string; // 角色描述
  readonly strengths?: readonly string[]; // 强项标签
  readonly restrictions?: readonly string[]; // 限制规则
  readonly color: AgentColor;
}

/**
 * AgentState — agent 运行时状态（可变）。
 * Source: §4.1.
 */
export interface AgentState {
  id: AgentId;
  status: AgentStatus;
  currentThreadId?: string;
  lastActiveAt: number; // epoch ms
  sessionId?: string;
}
