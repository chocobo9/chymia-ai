// tests/providers/gemini-parser.test.ts
// M2 dev (happy-path unit): Gemini stream-json parser 确定性解析。
// 用真实 Gemini CLI 事件形状 + 真实中文内容，不 spawn CLI。

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
const FIXED_TS = 1_700_000_222_000;
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

describe('gemini-parser (unit, happy path)', () => {
  it('maps init to session_init and records sessionId + model', () => {
    // Arrange
    const line = JSON.stringify({ type: 'init', session_id: 'gemini-sess-3', model: 'gemini-2.5-pro' });

    // Act
    const { messages, state } = run([line]);

    // Assert
    expect(messages[0].type).toBe('session_init');
    expect(messages[0].content).toBe('gemini-sess-3');
    expect(state.sessionId).toBe('gemini-sess-3');
    expect(state.model).toBe('gemini-2.5-pro');
  });

  it('maps the REAL assistant message shape {type:message, role:assistant, content} to text (the live-schema fix)', () => {
    // The installed gemini CLI emits assistant text as type:'message' role:'assistant'
    // (delta chunks), NOT the doc's type:'content' — which had silently produced 0 output.
    const line = JSON.stringify({
      type: 'message',
      role: 'assistant',
      content: '收到，我来分析两数之和。',
      delta: true,
    });
    const { messages } = run([line]);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: 'text', content: '收到，我来分析两数之和。' });
  });

  it('IGNORES the role:user message (the prompt echo gemini emits before replying)', () => {
    const line = JSON.stringify({ type: 'message', role: 'user', content: '帮我写两数之和' });
    expect(run([line]).messages).toEqual([]);
  });

  it('maps content to text with Chinese content', () => {
    // Arrange
    const line = JSON.stringify({ type: 'content', text: '这是一个关于数据库选型的建议。' });

    // Act
    const { messages } = run([line]);

    // Assert
    expect(messages[0].type).toBe('text');
    expect(messages[0].content).toBe('这是一个关于数据库选型的建议。');
    expect(messages[0].metadata?.provider).toBe('gemini');
  });

  it('maps thought to thinking', () => {
    // Arrange
    const line = JSON.stringify({ type: 'thought', text: '考虑索引策略' });

    // Act
    const { messages } = run([line]);

    // Assert
    expect(messages[0]).toMatchObject({ type: 'thinking', content: '考虑索引策略' });
  });

  it('maps tool_call to tool_use with args', () => {
    // Arrange
    const line = JSON.stringify({ type: 'tool_call', id: 'g-call-1', name: 'run_shell_command', args: { command: 'ls -la' } });

    // Act
    const { messages } = run([line]);

    // Assert
    expect(messages[0]).toMatchObject({ type: 'tool_use', toolName: 'run_shell_command', toolUseId: 'g-call-1' });
    expect(messages[0].toolInput).toEqual({ command: 'ls -la' });
  });

  it('emits done on a successful result and maps non-success result to error', () => {
    // Arrange
    const ok = JSON.stringify({ type: 'result', status: 'success' });
    const fail = JSON.stringify({ type: 'result', status: 'quota_exceeded', message: 'quota exhausted' });

    // Act
    const okRun = run([ok]);
    const failRun = run([fail]);

    // Assert — result/success = logical turn end → done (lets the service finish +
    // reclaim the process without waiting for the slow CLI exit).
    expect(okRun.messages).toHaveLength(1);
    expect(okRun.messages[0]).toMatchObject({ type: 'done', isFinal: true });
    expect(failRun.messages[0]).toMatchObject({ type: 'error', content: 'quota exhausted', errorCode: 'quota_exceeded' });
  });

  it('maps top-level error event to error message', () => {
    // Arrange
    const line = JSON.stringify({ type: 'error', message: 'gemini api unavailable' });

    // Act
    const { messages } = run([line]);

    // Assert
    expect(messages[0]).toMatchObject({ type: 'error', content: 'gemini api unavailable' });
  });

  it('parses a full realistic stream in order', () => {
    // Arrange
    const lines = [
      JSON.stringify({ type: 'init', session_id: 's3', model: 'gemini-2.5-pro' }),
      JSON.stringify({ type: 'thought', text: '规划步骤' }),
      JSON.stringify({ type: 'content', text: '第一步：建表' }),
      JSON.stringify({ type: 'tool_call', name: 'write_file', args: { path: 'schema.sql' } }),
      JSON.stringify({ type: 'result', status: 'success' }),
    ];

    // Act
    const { messages } = run(lines);

    // Assert
    expect(messages.map((m) => m.type)).toEqual(['session_init', 'thinking', 'text', 'tool_use', 'done']);
  });

  // ── Doubling-bug audit (#6) — Gemini VERDICT: NOT susceptible. ──
  // Gemini CLI stream-json emits reply text via a SINGLE event path (`content`), with NO
  // separate "incremental deltas + final consolidated block" shape (the `result/success`
  // terminator carries NO text). There is therefore no second source that could repeat the
  // reply. `thought` is a distinct `thinking` channel, never echoed as `content`. The test
  // below LOCKS the single-emit behavior so a future event-model change can't reintroduce
  // doubling.
  describe('doubling audit: single emit per content text (no delta + final-block shape)', () => {
    it('emits each content text exactly once and the terminating result adds no text', () => {
      // Arrange — a realistic turn: thought, the reply content, then a success result.
      const reply = '建议采用 Postgres：并发写入与事务一致性优于 SQLite。';
      const lines = [
        JSON.stringify({ type: 'init', session_id: 'gemini-doubling', model: 'gemini-2.5-pro' }),
        JSON.stringify({ type: 'thought', text: '比较读写并发与事务需求' }),
        JSON.stringify({ type: 'content', text: reply }),
        JSON.stringify({ type: 'result', status: 'success' }),
      ];

      // Act
      const { messages } = run(lines);

      // Assert — exactly one text message; result/success contributes nothing (no doubling).
      const texts = messages.filter((m) => m.type === 'text');
      expect(texts).toHaveLength(1);
      expect(texts.map((m) => m.content).join('')).toBe(reply);
    });
  });
});
