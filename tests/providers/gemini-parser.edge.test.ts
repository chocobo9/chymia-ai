// tests/providers/gemini-parser.edge.test.ts
// M2 QA (edge + adversarial): Gemini stream-json parser. QA != dev.
// Gates parseGeminiLine against design §A8 / §4.2 using the REAL gemini-cli
// stream-json events (init, content, thought, tool_call, result, error).
// NDJSON robustness, session/model recording, result-status error mapping,
// and adversarial malformed shapes. Real frames + real Chinese/English content.

import { describe, it, expect } from 'vitest';
import type { AgentMessage } from '@choco/shared';
import { createAgentId } from '@choco/shared';
import {
  createGeminiParserState,
  parseGeminiLine,
  type GeminiParserState,
  type GeminiParserDeps,
} from '@choco/api/providers/gemini/gemini-parser';

const agentId = createAgentId('gemini');
const FIXED_TS = 1_700_000_922_000;
const deps: GeminiParserDeps = { agentId, now: () => FIXED_TS, model: 'gemini-2.5-pro' };

function run(lines: readonly string[]): { messages: AgentMessage[]; state: GeminiParserState } {
  let state = createGeminiParserState();
  const out: AgentMessage[] = [];
  for (const line of lines) {
    const res = parseGeminiLine(line, state, deps);
    state = res.state;
    out.push(...res.messages);
  }
  return { messages: out, state };
}

describe('parseGeminiLine — NDJSON robustness (edge)', () => {
  it('emits nothing on empty and whitespace-only lines, preserving state identity', () => {
    const start = createGeminiParserState();
    const a = parseGeminiLine('', start, deps);
    const b = parseGeminiLine('    ', start, deps);
    expect(a.messages).toEqual([]);
    expect(a.state).toBe(start);
    expect(b.messages).toEqual([]);
  });

  it('does not crash on truncated JSON spanning a chunk boundary', () => {
    const { messages } = run(['{"type":"content","text":"正在检查 telegram 适配器']);
    expect(messages).toEqual([]);
  });

  it('does not crash on a JSON primitive that is not an object', () => {
    const { messages } = run(['873', 'null', '"loose"']);
    expect(messages).toEqual([]);
  });

  it('ignores an unknown event type', () => {
    const { messages } = run([JSON.stringify({ type: 'usage_metadata', totalTokenCount: 873 })]);
    expect(messages).toEqual([]);
  });

  it('accepts the camelCase sessionId alias on init', () => {
    const { state, messages } = run([JSON.stringify({ type: 'init', sessionId: 'gemini-abc-9' })]);
    expect(messages[0]).toMatchObject({ type: 'session_init', content: 'gemini-abc-9' });
    expect(state.sessionId).toBe('gemini-abc-9');
  });
});

describe('parseGeminiLine — streaming semantics (edge)', () => {
  it('records sessionId and model on init and threads them through state', () => {
    const { state, messages } = run([
      JSON.stringify({ type: 'init', session_id: 'gemini-7f', model: 'gemini-2.5-flash' }),
    ]);
    expect(messages[0].type).toBe('session_init');
    expect(state.sessionId).toBe('gemini-7f');
    expect(state.model).toBe('gemini-2.5-flash');
  });

  it('emits one text message per content event, preserving order across frames', () => {
    const { messages } = run([
      JSON.stringify({ type: 'content', text: '正在检查 ' }),
      JSON.stringify({ type: 'content', text: 'telegram 适配器的限流逻辑。' }),
    ]);
    expect(messages.map((m) => m.type)).toEqual(['text', 'text']);
    expect(messages.map((m) => m.content)).toEqual(['正在检查 ', 'telegram 适配器的限流逻辑。']);
  });

  it('maps thought to a thinking message (not surfaced as text)', () => {
    const { messages } = run([JSON.stringify({ type: 'thought', text: '先评估 SOP 审批规则是否满足。' })]);
    expect(messages.some((m) => m.type === 'text')).toBe(false);
    expect(messages[0]).toMatchObject({ type: 'thinking', content: '先评估 SOP 审批规则是否满足。' });
  });

  it('emits tool_use from a tool_call with real Chinese args', () => {
    const { messages } = run([
      JSON.stringify({ type: 'tool_call', id: 'g1', name: 'read_file', args: { absolute_path: '/repo/sop/payment-refund.yaml' } }),
    ]);
    expect(messages[0]).toMatchObject({ type: 'tool_use', toolName: 'read_file', toolUseId: 'g1' });
    expect(messages[0].toolInput).toEqual({ absolute_path: '/repo/sop/payment-refund.yaml' });
  });

  it('maps a non-success result to an error carrying status as errorCode', () => {
    const { messages } = run([
      JSON.stringify({ type: 'result', status: 'quota_exceeded', message: '今日配额已用尽，请稍后再试。' }),
    ]);
    expect(messages[0]).toMatchObject({ type: 'error', content: '今日配额已用尽，请稍后再试。', errorCode: 'quota_exceeded' });
  });

  it('a successful result produces no user-visible message', () => {
    const { messages } = run([JSON.stringify({ type: 'result', status: 'success' })]);
    expect(messages).toEqual([]);
  });
});

describe('parseGeminiLine — adversarial', () => {
  it('drops a content event whose text is the wrong type (number) without crashing', () => {
    const { messages } = run([JSON.stringify({ type: 'content', text: 42 })]);
    expect(messages).toEqual([]);
  });

  it('skips an empty-string content event (no zero-length text message)', () => {
    const { messages } = run([JSON.stringify({ type: 'content', text: '' })]);
    expect(messages).toEqual([]);
  });

  it('ignores a tool_call that has no name', () => {
    const { messages } = run([JSON.stringify({ type: 'tool_call', args: { a: 1 } })]);
    expect(messages).toEqual([]);
  });

  it('defaults tool_call args to {} when omitted', () => {
    const { messages } = run([JSON.stringify({ type: 'tool_call', name: 'list_directory' })]);
    expect(messages[0]).toMatchObject({ type: 'tool_use', toolName: 'list_directory' });
    expect(messages[0].toolInput).toEqual({});
  });

  it('falls back to a generic error message when a non-success result has neither message nor error', () => {
    const { messages } = run([JSON.stringify({ type: 'result', status: 'safety_block' })]);
    expect(messages[0]).toMatchObject({ type: 'error', content: 'gemini error', errorCode: 'safety_block' });
  });
});
