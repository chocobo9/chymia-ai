// packages/api/src/providers/claude/claude-parser.ts
// M2: Claude Code stream-json NDJSON → AgentMessage 纯解析器
//
// 设计来源：clowder-architecture-design.md §7.1（parser 与 spawn 分离、纯函数可测）
//   + 补充 §A8（parseClaudeLine 处理 system/init, assistant/text, assistant/tool_use,
//     result/error, result/success）+ extraction §2.2（stream-json / --include-partial-messages）。
//
// Research: reference claude-ndjson-parser.ts —— 关键 edge case：
//   - 增量文本走 stream_event/content_block_delta/text_delta（来自 --include-partial-messages）；
//   - thinking_delta 累积到 thinkingBuffer，content_block_stop 时整块 flush；
//   - assistant 事件的 content[] 同时可能含 text 与 tool_use block；
//   - result 事件 subtype !== 'success' 即为错误（不依赖 is_error 字段）。
// 我们 re-author 为不可变 state（输入只读、返回新 state），并把原版"thinking 用 system_info
// 包 JSON"改为直接发 'thinking' 类型（M1 AgentMessageType 已含 'thinking'，更贴合本项目模型）。
//
// 纯、确定性：输入 = 单个已 JSON.parse 的事件对象 + ParserState，输出 = 0..N 条 AgentMessage。
// 不 spawn 任何进程、无 I/O。全部经 unknown + 类型守卫窄化，零 any（CLAUDE §2.1）。

import type { AgentId, AgentMessage, AgentMessageType } from '@choco/shared';

/** provider 标识常量（写入 metadata.provider；来源：本项目 provider 命名约定） */
export const CLAUDE_PROVIDER = 'claude' as const;

/**
 * 解析器跨帧累积状态。不可变更新——transform 返回新 state，调用方替换。
 * 累积 thinking_delta，待 content_block_stop flush 为一条 thinking。
 */
export interface ParserState {
  /** CLI 报告的 session id（system/init 后填充），供 service 持久化 */
  readonly sessionId?: string;
  /** CLI 报告的 model（assistant/init 中可得），写入 metadata */
  readonly model?: string;
  /** 当前正在累积的 thinking 文本（跨多个 thinking_delta） */
  readonly thinkingBuffer: string;
  /**
   * 本轮是否已通过 stream_event/text_delta 增量发出过文本（--include-partial-messages 开启时）。
   * 为真时，随后 assistant 事件 content[] 里的整块 text 是同一文本的合并版，必须跳过以免重复
   * （否则持久化/渲染会翻倍）。assistant 事件处理后重置为 false。
   */
  readonly streamedText: boolean;
}

/** 创建初始状态 */
export function createClaudeParserState(): ParserState {
  return { thinkingBuffer: '', streamedText: false };
}

/** 单次 transform 的结果：要 emit 的消息 + 新状态 */
export interface ParseResult {
  readonly messages: readonly AgentMessage[];
  readonly state: ParserState;
}

/** 解析器构造参数（外部注入，避免硬编码 agentId / 时间源） */
export interface ClaudeParserDeps {
  readonly agentId: AgentId;
  /** 时间源，便于测试确定性；默认 Date.now */
  readonly now?: () => number;
  /** 当前模型名（来自 InvokeOptions / 默认常量），用于 metadata 兜底 */
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
function asArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}

function makeMessage(
  deps: ClaudeParserDeps,
  type: AgentMessageType,
  fields: Partial<Omit<AgentMessage, 'type' | 'agentId' | 'timestamp'>>,
  modelOverride?: string,
): AgentMessage {
  const now = deps.now ?? Date.now;
  const model = modelOverride ?? deps.model ?? '';
  return {
    type,
    agentId: deps.agentId,
    timestamp: now(),
    metadata: { provider: CLAUDE_PROVIDER, model },
    ...fields,
  };
}

/** 把一个 stream_event 内层 event 解析为消息 + 新状态 */
function transformStreamEvent(
  inner: Record<string, unknown>,
  state: ParserState,
  deps: ClaudeParserDeps,
): ParseResult {
  const innerType = asString(inner.type);
  const delta = asRecord(inner.delta);

  // content_block_delta：text_delta → text；thinking_delta → 累积
  if (innerType === 'content_block_delta' && delta) {
    const deltaType = asString(delta.type);
    if (deltaType === 'text_delta') {
      const text = asString(delta.text) ?? '';
      if (text.length === 0) {
        return { messages: [], state };
      }
      return {
        messages: [makeMessage(deps, 'text', { content: text }, state.model)],
        state: { ...state, streamedText: true },
      };
    }
    if (deltaType === 'thinking_delta') {
      const thought = asString(delta.thinking) ?? '';
      return {
        messages: [],
        state: { ...state, thinkingBuffer: state.thinkingBuffer + thought },
      };
    }
    // signature_delta 等忽略
    return { messages: [], state };
  }

  // content_block_stop：若有累积 thinking，整块 flush 为一条 thinking 消息
  if (innerType === 'content_block_stop') {
    if (state.thinkingBuffer.length > 0) {
      const flushed = makeMessage(
        deps,
        'thinking',
        { content: state.thinkingBuffer },
        state.model,
      );
      return { messages: [flushed], state: { ...state, thinkingBuffer: '' } };
    }
    return { messages: [], state };
  }

  return { messages: [], state };
}

/** 把 assistant 消息里的 content blocks 解析为 text / tool_use 消息 */
function transformAssistant(
  event: Record<string, unknown>,
  state: ParserState,
  deps: ClaudeParserDeps,
): ParseResult {
  const message = asRecord(event.message);
  const model = asString(message?.model) ?? state.model;
  // 本轮 assistant 事件处理完即重置 streamedText（下一轮重新判定）。
  const nextState: ParserState = { ...state, ...(model ? { model } : {}), streamedText: false };

  const content = asArray(message?.content);
  if (!content) {
    return { messages: [], state: nextState };
  }

  const messages: AgentMessage[] = [];
  for (const block of content) {
    const blk = asRecord(block);
    if (!blk) {
      continue;
    }
    const blkType = asString(blk.type);
    if (blkType === 'text') {
      // 该轮文本若已通过 stream_event/text_delta 增量发出，assistant content[] 的整块 text
      // 是同一文本的合并版，跳过以免与增量重复（--include-partial-messages 行为）。
      if (state.streamedText) {
        continue;
      }
      const text = asString(blk.text);
      if (text && text.length > 0) {
        messages.push(makeMessage(deps, 'text', { content: text }, model));
      }
    } else if (blkType === 'tool_use') {
      const toolInput = asRecord(blk.input) ?? {};
      messages.push(
        makeMessage(
          deps,
          'tool_use',
          {
            toolName: asString(blk.name),
            toolUseId: asString(blk.id),
            toolInput,
          },
          model,
        ),
      );
    }
  }
  return { messages, state: nextState };
}

/** result 事件（subtype !== 'success'）→ error 消息 */
function transformResult(
  event: Record<string, unknown>,
  state: ParserState,
  deps: ClaudeParserDeps,
): ParseResult {
  const subtype = asString(event.subtype);
  if (subtype === 'success' || subtype === undefined) {
    // 成功（或无 subtype 的普通 result）不产生用户可见消息；done 由 service 在收尾时发。
    return { messages: [], state };
  }
  // 优先取 errors 数组，其次 error/result 字符串，最后用 subtype 兜底。
  const errors = asArray(event.errors)
    ?.filter((item): item is string => typeof item === 'string')
    .join('; ');
  const content =
    (errors && errors.length > 0 ? errors : undefined) ??
    asString(event.error) ??
    asString(event.result) ??
    `claude error (${subtype})`;
  const errMsg = makeMessage(deps, 'error', { content, errorCode: subtype }, state.model);
  return { messages: [errMsg], state };
}

/**
 * 把单个 Claude stream-json 事件对象转为 0..N 条 AgentMessage（纯函数）。
 */
export function transformClaudeEvent(
  event: unknown,
  state: ParserState,
  deps: ClaudeParserDeps,
): ParseResult {
  const evt = asRecord(event);
  if (!evt) {
    return { messages: [], state };
  }

  const type = asString(evt.type);

  switch (type) {
    case 'system': {
      if (asString(evt.subtype) === 'init') {
        const sessionId = asString(evt.session_id);
        const model = asString(evt.model) ?? state.model;
        const nextState: ParserState = {
          ...state,
          ...(sessionId ? { sessionId } : {}),
          ...(model ? { model } : {}),
        };
        const msg = makeMessage(deps, 'session_init', { content: sessionId }, model);
        return { messages: [msg], state: nextState };
      }
      return { messages: [], state };
    }
    case 'stream_event': {
      const inner = asRecord(evt.event);
      if (!inner) {
        return { messages: [], state };
      }
      return transformStreamEvent(inner, state, deps);
    }
    case 'assistant':
      return transformAssistant(evt, state, deps);
    case 'result':
      return transformResult(evt, state, deps);
    case 'error': {
      const content =
        asString(evt.message) ??
        asString(asRecord(evt.error)?.message) ??
        asString(evt.error) ??
        'claude cli error';
      const errMsg = makeMessage(deps, 'error', { content }, state.model);
      return { messages: [errMsg], state };
    }
    default:
      return { messages: [], state };
  }
}

/**
 * 解析单行原始 NDJSON 文本 → ParseResult。
 * 空行 / 非 JSON 行视为噪声，返回空消息（设计 §7.1 容错要求）。
 */
export function parseClaudeLine(
  line: string,
  state: ParserState,
  deps: ClaudeParserDeps,
): ParseResult {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return { messages: [], state };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // 不完整 / 非 JSON 行：跳过，不破坏后续解析。
    return { messages: [], state };
  }
  return transformClaudeEvent(parsed, state, deps);
}
