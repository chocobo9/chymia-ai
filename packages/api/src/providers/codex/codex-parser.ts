// packages/api/src/providers/codex/codex-parser.ts
// M2: Codex `exec --json` 事件 → AgentMessage 纯解析器
//
// 设计来源：补充 §A8（parseCodexLine）+ extraction §2.2（codex-event-transform）。
//
// Research: reference codex-event-transform.ts —— 真实事件信封（codex-rs/exec schema）：
//   { "type": "thread.started", "thread_id": "..." }                         → session_init
//   { "type": "item.completed", "item": { "type": "agent_message", "text" } } → text
//   { "type": "item.completed", "item": { "type": "reasoning", "text" } }     → thinking
//   { "type": "item.started",   "item": { "type": "mcp_tool_call", server, tool, arguments } } → tool_use
//   { "type": "item.started",   "item": { "type": "command_execution", command } }            → tool_use(shell)
//   { "type": "error", "message": "..." }                                     → error
// 关键 edge case（来自 reference state）：codex 偶尔重复发送同一条最终 agent_message，
// 需用 lastAgentMessage 去重。我们 re-author 为不可变 state。
// 偏差：原版 reasoning 用 system_info 包 JSON；我们直接发 'thinking'（M1 已有该类型）。
//
// 纯、确定性、零 any。

import type { AgentId, AgentMessage, AgentMessageType } from '@choco/shared';

/** provider 标识常量（来源：本项目 provider 命名约定） */
export const CODEX_PROVIDER = 'codex' as const;

export interface CodexParserState {
  readonly sessionId?: string;
  readonly model?: string;
  /** 去重：上一条 agent_message 文本（codex 可能重复发最终消息） */
  readonly lastAgentMessage?: string;
}

export function createCodexParserState(): CodexParserState {
  return {};
}

export interface CodexParseResult {
  readonly messages: readonly AgentMessage[];
  readonly state: CodexParserState;
}

export interface CodexParserDeps {
  readonly agentId: AgentId;
  readonly now?: () => number;
  readonly model?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function makeMessage(
  deps: CodexParserDeps,
  type: AgentMessageType,
  fields: Partial<Omit<AgentMessage, 'type' | 'agentId' | 'timestamp'>>,
): AgentMessage {
  const now = deps.now ?? Date.now;
  return {
    type,
    agentId: deps.agentId,
    timestamp: now(),
    metadata: { provider: CODEX_PROVIDER, model: deps.model ?? '' },
    ...fields,
  };
}

/** mcp_tool_call → tool_use（server__tool 命名，沿用 reference 约定） */
function mapMcpToolUse(item: Record<string, unknown>, deps: CodexParserDeps): AgentMessage {
  const server = asString(item.server) ?? '';
  const tool = asString(item.tool) ?? 'unknown';
  const toolName = server ? `${server}__${tool}` : tool;
  return makeMessage(deps, 'tool_use', {
    toolName,
    toolUseId: asString(item.id) ?? asString(item.call_id),
    toolInput: asRecord(item.arguments) ?? {},
  });
}

/** command_execution → tool_use(shell)；command 并入 toolInput */
function mapCommandExecution(item: Record<string, unknown>, deps: CodexParserDeps): AgentMessage {
  const command = asString(item.command) ?? '';
  return makeMessage(deps, 'tool_use', {
    toolName: 'shell',
    toolUseId: asString(item.id),
    toolInput: { command },
  });
}

export function transformCodexEvent(
  event: unknown,
  state: CodexParserState,
  deps: CodexParserDeps,
): CodexParseResult {
  const e = asRecord(event);
  if (!e) {
    return { messages: [], state };
  }
  const eventType = asString(e.type) ?? '';

  // thread.started → session_init（codex resume 标识）
  if (eventType === 'thread.started') {
    const sessionId = asString(e.thread_id);
    const nextState: CodexParserState = sessionId ? { ...state, sessionId } : state;
    return {
      messages: [makeMessage(deps, 'session_init', { content: sessionId })],
      state: nextState,
    };
  }

  // 顶层 error
  if (eventType === 'error') {
    const content = asString(e.message) ?? 'codex cli error';
    return { messages: [makeMessage(deps, 'error', { content })], state };
  }

  const item = asRecord(e.item);
  if (!item) {
    return { messages: [], state };
  }
  const itemType = asString(item.type) ?? '';

  if (eventType === 'item.started') {
    if (itemType === 'mcp_tool_call') {
      return { messages: [mapMcpToolUse(item, deps)], state };
    }
    if (itemType === 'command_execution') {
      return { messages: [mapCommandExecution(item, deps)], state };
    }
    return { messages: [], state };
  }

  if (eventType === 'item.completed') {
    if (itemType === 'agent_message') {
      const text = asString(item.text);
      if (!text || text.trim().length === 0) {
        return { messages: [], state };
      }
      // 去重：与上一条相同则跳过（codex 重复发最终消息）。
      if (state.lastAgentMessage === text) {
        return { messages: [], state };
      }
      return {
        messages: [makeMessage(deps, 'text', { content: text })],
        state: { ...state, lastAgentMessage: text },
      };
    }
    if (itemType === 'reasoning') {
      const text = asString(item.text);
      if (!text || text.length === 0) {
        return { messages: [], state };
      }
      return { messages: [makeMessage(deps, 'thinking', { content: text })], state };
    }
    // mcp_tool_call / command_execution 的 completed 是 tool_result，
    // 但 M1 的 tool_result 由上层（M3/tool event）记录；解析器只发 tool_use（开始）。
    return { messages: [], state };
  }

  return { messages: [], state };
}

export function parseCodexLine(
  line: string,
  state: CodexParserState,
  deps: CodexParserDeps,
): CodexParseResult {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return { messages: [], state };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { messages: [], state };
  }
  return transformCodexEvent(parsed, state, deps);
}
