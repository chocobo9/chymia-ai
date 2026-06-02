// packages/api/src/providers/gemini/gemini-parser.ts
// M2: Gemini CLI stream-json 事件 → AgentMessage 纯解析器
//
// 设计来源：补充 §A8（parseGeminiLine）+ extraction §2.2（gemini-event-parser）。
//
// Research: reference gemini-event-parser.ts —— 真实事件（gemini-cli stream-json schema）：
//   { "type": "init", "session_id": "..." }                   → session_init
//   { "type": "content", "text": "..." }                      → text
//   { "type": "thought", "text": "..." }                      → thinking
//   { "type": "tool_call", "name": "...", "args": {...} }      → tool_use
//   { "type": "result", "status": "success" | ... }           → 成功跳过 / 失败 error
//   { "type": "error", "message": "..." }                     → error
// 关键：result 是否错误由 status !== 'success' 判定（非 is_error 字段）。
// 偏差：原版 thought 用 system_info 包 JSON；我们直接发 'thinking'（M1 已有该类型）。
//
// 纯、确定性、零 any。

import type { AgentId, AgentMessage, AgentMessageType } from '@choco/shared';

/** provider 标识常量（来源：本项目 provider 命名约定） */
export const GEMINI_PROVIDER = 'gemini' as const;

export interface GeminiParserState {
  readonly sessionId?: string;
  readonly model?: string;
}

export function createGeminiParserState(): GeminiParserState {
  return {};
}

export interface GeminiParseResult {
  readonly messages: readonly AgentMessage[];
  readonly state: GeminiParserState;
}

export interface GeminiParserDeps {
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
  deps: GeminiParserDeps,
  type: AgentMessageType,
  fields: Partial<Omit<AgentMessage, 'type' | 'agentId' | 'timestamp'>>,
): AgentMessage {
  const now = deps.now ?? Date.now;
  return {
    type,
    agentId: deps.agentId,
    timestamp: now(),
    metadata: { provider: GEMINI_PROVIDER, model: deps.model ?? '' },
    ...fields,
  };
}

export function transformGeminiEvent(
  event: unknown,
  state: GeminiParserState,
  deps: GeminiParserDeps,
): GeminiParseResult {
  const e = asRecord(event);
  if (!e) {
    return { messages: [], state };
  }
  const type = asString(e.type);

  switch (type) {
    case 'init': {
      const sessionId = asString(e.session_id) ?? asString(e.sessionId);
      const model = asString(e.model) ?? state.model;
      const nextState: GeminiParserState = {
        ...state,
        ...(sessionId ? { sessionId } : {}),
        ...(model ? { model } : {}),
      };
      return {
        messages: [makeMessage(deps, 'session_init', { content: sessionId })],
        state: nextState,
      };
    }

    case 'content': {
      const text = asString(e.text);
      if (!text || text.length === 0) {
        return { messages: [], state };
      }
      return { messages: [makeMessage(deps, 'text', { content: text })], state };
    }

    case 'thought': {
      const text = asString(e.text);
      if (!text || text.length === 0) {
        return { messages: [], state };
      }
      return { messages: [makeMessage(deps, 'thinking', { content: text })], state };
    }

    case 'tool_call': {
      const name = asString(e.name);
      if (!name) {
        return { messages: [], state };
      }
      return {
        messages: [
          makeMessage(deps, 'tool_use', {
            toolName: name,
            toolUseId: asString(e.id) ?? asString(e.call_id),
            toolInput: asRecord(e.args) ?? {},
          }),
        ],
        state,
      };
    }

    case 'result': {
      const status = asString(e.status);
      if (status === 'success') {
        // 成功结束不产生用户消息；done 由 service 收尾时发。
        return { messages: [], state };
      }
      const content = asString(e.message) ?? asString(e.error) ?? 'gemini error';
      return { messages: [makeMessage(deps, 'error', { content, errorCode: status })], state };
    }

    case 'error': {
      const content = asString(e.message) ?? asString(e.error) ?? 'gemini cli error';
      return { messages: [makeMessage(deps, 'error', { content })], state };
    }

    default:
      return { messages: [], state };
  }
}

export function parseGeminiLine(
  line: string,
  state: GeminiParserState,
  deps: GeminiParserDeps,
): GeminiParseResult {
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
  return transformGeminiEvent(parsed, state, deps);
}
