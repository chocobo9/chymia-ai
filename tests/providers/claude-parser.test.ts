// tests/providers/claude-parser.test.ts
// M2 dev (happy-path unit): Claude stream-json parser 确定性解析。
// 用真实 Claude Code stream-json 事件形状 + 真实中文内容，不 spawn CLI。

import { describe, it, expect } from 'vitest';
import type { AgentMessage } from '@clowder/shared';
import { createAgentId } from '@clowder/shared';
import {
  createClaudeParserState,
  parseClaudeLine,
  transformClaudeEvent,
  type ParserState,
  type ClaudeParserDeps,
} from '@clowder/api/providers/claude/claude-parser';

const agentId = createAgentId('claude-opus');
const FIXED_TS = 1_700_000_000_000;
const deps: ClaudeParserDeps = { agentId, now: () => FIXED_TS, model: 'claude-opus-4-6' };

/** 跑一串行，返回所有 emit 的消息 + 末态 */
function run(lines: readonly string[]): { messages: AgentMessage[]; state: ParserState } {
  let state = createClaudeParserState();
  const out: AgentMessage[] = [];
  for (const line of lines) {
    const res = parseClaudeLine(line, state, deps);
    state = res.state;
    out.push(...res.messages);
  }
  return { messages: out, state };
}

describe('claude-parser (unit, happy path)', () => {
  it('maps system/init to session_init and records sessionId', () => {
    // Arrange
    const line = JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 'sess_018ab3f2-claude',
      model: 'claude-opus-4-6',
    });

    // Act
    const { messages, state } = run([line]);

    // Assert
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'session_init',
      agentId,
      content: 'sess_018ab3f2-claude',
      timestamp: FIXED_TS,
    });
    expect(state.sessionId).toBe('sess_018ab3f2-claude');
  });

  it('maps stream_event/text_delta to streaming text with Chinese content', () => {
    // Arrange — 真实 content_block_delta + text_delta 形状
    const frame = JSON.stringify({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '我已完成 TODO API 的实现' },
      },
    });

    // Act
    const { messages } = run([frame]);

    // Assert
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('text');
    expect(messages[0].content).toBe('我已完成 TODO API 的实现');
    expect(messages[0].metadata?.provider).toBe('claude');
  });

  it('maps assistant content tool_use block to tool_use message', () => {
    // Arrange — 真实 assistant 事件含 tool_use block
    const frame = JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-6',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_01XyZ',
            name: 'Write',
            input: { file_path: 'src/routes/todo.ts', content: 'export const x = 1' },
          },
        ],
      },
    });

    // Act
    const { messages } = run([frame]);

    // Assert
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'tool_use',
      toolName: 'Write',
      toolUseId: 'toolu_01XyZ',
    });
    expect(messages[0].toolInput).toEqual({
      file_path: 'src/routes/todo.ts',
      content: 'export const x = 1',
    });
  });

  it('emits both text and tool_use when assistant content has multiple blocks', () => {
    // Arrange
    const frame = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: '现在运行测试' },
          { type: 'tool_use', id: 't9', name: 'Bash', input: { command: 'npm test' } },
        ],
      },
    });

    // Act
    const { messages } = run([frame]);

    // Assert
    expect(messages.map((m) => m.type)).toEqual(['text', 'tool_use']);
    expect(messages[0].content).toBe('现在运行测试');
    expect(messages[1].toolName).toBe('Bash');
  });

  it('does NOT double text: suppresses the assistant text block when deltas already streamed it (--include-partial-messages)', () => {
    // Arrange — real Claude shape with --include-partial-messages: incremental text_delta
    // frames, THEN the consolidated `assistant` event repeating the SAME full text.
    const lines = [
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '我是 ' } },
      }),
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Claude，运行于演示平台。' } },
      }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: '我是 Claude，运行于演示平台。' }] },
      }),
    ];

    // Act
    const { messages } = run(lines);

    // Assert — only the two streamed deltas survive; the assistant full-text block is suppressed
    // (no doubling). Concatenated deltas reconstruct the full text exactly once.
    expect(messages.map((m) => m.type)).toEqual(['text', 'text']);
    expect(messages.map((m) => m.content).join('')).toBe('我是 Claude，运行于演示平台。');
  });

  it('does NOT double text across MULTIPLE turns: each turn streams deltas then a final block (state resets per turn)', () => {
    // Arrange — two turns, each: text_delta(s) → consolidated assistant text block.
    // After turn 1's assistant event resets streamedText, turn 2's deltas re-arm
    // suppression so turn 2's final block is also dropped. No turn doubles.
    const lines = [
      // turn 1
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '第一轮：' } } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '已建表。' } } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '第一轮：已建表。' }] } }),
      // turn 2
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '第二轮：' } } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '已加索引。' } } }),
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '第二轮：已加索引。' }] } }),
    ];

    // Act
    const { messages, state } = run(lines);

    // Assert — only the four streamed deltas survive; both consolidated blocks suppressed.
    expect(messages.map((m) => m.type)).toEqual(['text', 'text', 'text', 'text']);
    expect(messages.map((m) => m.content).join('')).toBe('第一轮：已建表。第二轮：已加索引。');
    expect(state.streamedText).toBe(false); // reset after the last assistant event
  });

  it('keeps tool_use but suppresses text in a SAME-turn multi-block assistant event after deltas streamed', () => {
    // Arrange — deltas stream the reply text, then a single assistant event carries
    // BOTH the consolidated text (must be dropped) AND a tool_use block (must survive).
    const lines = [
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '我来运行测试。' } } }),
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: '我来运行测试。' },
            { type: 'tool_use', id: 'toolu_77', name: 'Bash', input: { command: 'npx vitest run' } },
          ],
        },
      }),
    ];

    // Act
    const { messages } = run(lines);

    // Assert — streamed text once + the tool_use; the consolidated text block is dropped.
    expect(messages.map((m) => m.type)).toEqual(['text', 'tool_use']);
    expect(messages[0].content).toBe('我来运行测试。');
    expect(messages[1].toolName).toBe('Bash');
    expect(messages[1].toolInput).toEqual({ command: 'npx vitest run' });
  });

  it('still emits assistant text when it was NOT streamed via deltas (no false suppression)', () => {
    // Arrange — assistant text with NO preceding text_delta (e.g. partials off) must survive.
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '直接给出的完整回复' }] },
    });

    // Act
    const { messages } = run([line]);

    // Assert
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('text');
    expect(messages[0].content).toBe('直接给出的完整回复');
  });

  it('accumulates thinking_delta and flushes one thinking message on content_block_stop', () => {
    // Arrange
    const d1 = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '先设计 ' } },
    });
    const d2 = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '数据库 schema' } },
    });
    const stop = JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 0 },
    });

    // Act
    const { messages, state } = run([d1, d2, stop]);

    // Assert — 两个 delta 累积成一条 thinking，stop 时 flush
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('thinking');
    expect(messages[0].content).toBe('先设计 数据库 schema');
    expect(state.thinkingBuffer).toBe('');
  });

  it('maps error result (subtype !== success) to error message with errorCode', () => {
    // Arrange — Claude result/error: subtype 表明错误类型，errors 数组承载详情
    const frame = JSON.stringify({
      type: 'result',
      subtype: 'error_during_execution',
      errors: ['tool execution failed'],
    });

    // Act
    const { messages } = run([frame]);

    // Assert
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'error',
      content: 'tool execution failed',
      errorCode: 'error_during_execution',
    });
  });

  it('skips successful result (no user-visible message)', () => {
    // Arrange
    const frame = JSON.stringify({ type: 'result', subtype: 'success' });

    // Act
    const { messages } = run([frame]);

    // Assert
    expect(messages).toHaveLength(0);
  });

  it('parses a full realistic stream in order', () => {
    // Arrange — init → 两段 text → tool_use → 成功 result
    const lines = [
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-opus-4-6' }),
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '正在创建 ' } } }),
      JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'CRUD 端点' } } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } }),
      JSON.stringify({ type: 'result', subtype: 'success' }),
    ];

    // Act
    const { messages } = run(lines);

    // Assert
    expect(messages.map((m) => m.type)).toEqual(['session_init', 'text', 'text', 'tool_use']);
  });

  it('transformClaudeEvent is pure: same input twice yields equal output', () => {
    // Arrange
    const evt = { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '幂等' } } };
    const state = createClaudeParserState();

    // Act
    const a = transformClaudeEvent(evt, state, deps);
    const b = transformClaudeEvent(evt, state, deps);

    // Assert
    expect(a.messages).toEqual(b.messages);
  });
});
