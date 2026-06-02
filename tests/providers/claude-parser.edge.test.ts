// tests/providers/claude-parser.edge.test.ts
// M2 QA (edge + adversarial): Claude stream-json parser. QA != dev.
// Gates parseClaudeLine against design §A8 / §4.2: NDJSON robustness
// (blank/whitespace/garbage/non-object/unknown), streaming semantics
// (text_delta-per-delta, thinking_delta accumulation + content_block_stop
// flush, assistant multi-block ordering), and adversarial malformed shapes.
// Real Claude stream-json frames + real Chinese/English agent content.

import { describe, it, expect } from 'vitest';
import type { AgentMessage } from '@choco/shared';
import { createAgentId } from '@choco/shared';
import {
  createClaudeParserState,
  parseClaudeLine,
  type ParserState,
  type ClaudeParserDeps,
} from '@choco/api/providers/claude/claude-parser';

const agentId = createAgentId('claude-opus');
const FIXED_TS = 1_700_000_900_000;
const deps: ClaudeParserDeps = { agentId, now: () => FIXED_TS, model: 'claude-opus-4-6' };

/** Feed a sequence of raw lines, threading state; return all emitted messages + end state. */
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

function streamDelta(deltaType: 'text_delta' | 'thinking_delta', value: string): string {
  const key = deltaType === 'text_delta' ? 'text' : 'thinking';
  return JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: deltaType, [key]: value } },
  });
}
const stop = JSON.stringify({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });

describe('parseClaudeLine — NDJSON robustness (edge)', () => {
  it('returns no messages and preserves state for an empty line', () => {
    const start = createClaudeParserState();
    const res = parseClaudeLine('', start, deps);
    expect(res.messages).toEqual([]);
    expect(res.state).toBe(start);
  });

  it('returns no messages for a whitespace-only line', () => {
    const start = createClaudeParserState();
    const res = parseClaudeLine('   \t  ', start, deps);
    expect(res.messages).toEqual([]);
    expect(res.state).toBe(start);
  });

  it('does not crash and emits nothing on malformed/garbage JSON', () => {
    const { messages } = run([
      '{"type":"stream_event","event":{"type":"content_block_delta","delta":{"type":"text_delta","text":"已定位',
    ]);
    expect(messages).toEqual([]);
  });

  it('does not crash on JSON primitives that are not objects', () => {
    const { messages } = run(['42', 'true', '"a bare string"', 'null']);
    expect(messages).toEqual([]);
  });

  it('ignores an unknown top-level event type without emitting or mutating buffers', () => {
    const { state, messages } = run([
      JSON.stringify({ type: 'mcp_server_status', server: 'evidence-store', status: 'ready' }),
    ]);
    expect(messages).toEqual([]);
    expect(state.thinkingBuffer).toBe('');
  });

  it('keeps streaming correctly when blank/whitespace lines interleave', () => {
    const { messages } = run([
      streamDelta('text_delta', '已定位到 '),
      '',
      '   ',
      streamDelta('text_delta', 'src/router.ts 的空指针'),
    ]);
    expect(messages.map((m) => m.content)).toEqual(['已定位到 ', 'src/router.ts 的空指针']);
    expect(messages.every((m) => m.type === 'text')).toBe(true);
  });
});

describe('parseClaudeLine — streaming semantics (edge)', () => {
  it('emits one text message per text_delta immediately (no accumulation across deltas)', () => {
    const { messages } = run([
      streamDelta('text_delta', '修复方案：'),
      streamDelta('text_delta', '在 invoke() '),
      streamDelta('text_delta', '前加空值检查。'),
    ]);
    expect(messages.map((m) => m.type)).toEqual(['text', 'text', 'text']);
    expect(messages.map((m) => m.content)).toEqual(['修复方案：', '在 invoke() ', '前加空值检查。']);
  });

  it('accumulates thinking_delta silently and flushes ONE thinking block on content_block_stop', () => {
    const { messages, state } = run([
      streamDelta('thinking_delta', '先看调用栈，'),
      streamDelta('thinking_delta', '再看 evidence。'),
      stop,
    ]);
    // thinking deltas must not surface as text; only one flushed thinking emerges.
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: 'thinking', content: '先看调用栈，再看 evidence。' });
    expect(state.thinkingBuffer).toBe('');
  });

  it('content_block_stop with empty thinking buffer flushes nothing', () => {
    const { messages } = run([stop]);
    expect(messages).toEqual([]);
  });

  it('does not flush thinking twice across two consecutive stops', () => {
    const { messages } = run([streamDelta('thinking_delta', '推理：根因是竞态。'), stop, stop]);
    expect(messages.filter((m) => m.type === 'thinking')).toHaveLength(1);
  });

  it('emits tool_use with a realistic Chinese evidence_search query as input', () => {
    const frame = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_01F8',
            name: 'evidence_search',
            input: { query: '群聊里关于支付回调的讨论', limit: 5 },
          },
        ],
      },
    });
    const { messages } = run([frame]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: 'tool_use', toolName: 'evidence_search', toolUseId: 'toolu_01F8' });
    expect(messages[0].toolInput).toEqual({ query: '群聊里关于支付回调的讨论', limit: 5 });
  });

  it('defaults tool_use toolInput to {} when assistant tool_use block omits input', () => {
    const frame = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 't1', name: 'TodoWrite' }] },
    });
    const { messages } = run([frame]);
    expect(messages[0]).toMatchObject({ type: 'tool_use', toolName: 'TodoWrite' });
    expect(messages[0].toolInput).toEqual({});
  });

  it('preserves block order (text before tool_use) within one assistant message', () => {
    const frame = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: '我来读取该文件。' },
          { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/repo/packages/api/src/routing/router.ts' } },
        ],
      },
    });
    const { messages } = run([frame]);
    expect(messages.map((m) => m.type)).toEqual(['text', 'tool_use']);
    expect(messages[0].content).toBe('我来读取该文件。');
    expect(messages[1].toolInput).toEqual({ file_path: '/repo/packages/api/src/routing/router.ts' });
  });
});

describe('parseClaudeLine — adversarial', () => {
  it('emits session_init with undefined content when system/init lacks session_id (no crash)', () => {
    const { state, messages } = run([JSON.stringify({ type: 'system', subtype: 'init' })]);
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('session_init');
    expect(messages[0].content).toBeUndefined();
    expect(state.sessionId).toBeUndefined();
  });

  it('does NOT treat a non-init system subtype as session_init', () => {
    const { messages } = run([
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', session_id: 'sess-ignored' }),
    ]);
    expect(messages).toEqual([]);
  });

  it('drops a text_delta whose delta.text is the wrong type (number) without crashing', () => {
    const { messages } = run([
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 12345 } },
      }),
    ]);
    expect(messages).toEqual([]);
  });

  it('skips empty-string text_delta (no zero-length text message)', () => {
    const { messages } = run([streamDelta('text_delta', '')]);
    expect(messages).toEqual([]);
  });

  it('records sessionId then survives a malformed line wedged mid-stream', () => {
    const { state, messages } = run([
      JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-resilient-7', model: 'claude-opus-4-6' }),
      '{ this is not valid json at all ]',
      streamDelta('text_delta', '继续输出'),
      JSON.stringify({ type: 'result', subtype: 'success' }),
    ]);
    expect(state.sessionId).toBe('sess-resilient-7');
    expect(messages.map((m) => m.type)).toEqual(['session_init', 'text']);
    expect(messages[1].content).toBe('继续输出');
  });

  it('maps a result with errors[] array to a single joined error message', () => {
    const { messages } = run([
      JSON.stringify({ type: 'result', subtype: 'error_max_turns', errors: ['hit max turns', 'aborted tool loop'] }),
    ]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: 'error', content: 'hit max turns; aborted tool loop', errorCode: 'error_max_turns' });
  });
});
