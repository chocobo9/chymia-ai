// tests/providers/codex-parser.test.ts
// M2 dev (happy-path unit): Codex exec --json parser 确定性解析。
// 用真实 codex 事件形状（item.completed / thread.started 信封）+ 真实中文内容，不 spawn CLI。

import { describe, it, expect } from 'vitest';
import type { AgentMessage } from '@clowder/shared';
import { createAgentId } from '@clowder/shared';
import {
  createCodexParserState,
  parseCodexLine,
  type CodexParserState,
  type CodexParserDeps,
} from '@clowder/api/providers/codex/codex-parser';

const agentId = createAgentId('codex');
const FIXED_TS = 1_700_000_111_000;
const deps: CodexParserDeps = { agentId, now: () => FIXED_TS, model: 'gpt-5-codex' };

function run(lines: readonly string[]): { messages: AgentMessage[]; state: CodexParserState } {
  let state = createCodexParserState();
  const out: AgentMessage[] = [];
  for (const line of lines) {
    const res = parseCodexLine(line, state, deps);
    state = res.state;
    out.push(...res.messages);
  }
  return { messages: out, state };
}

describe('codex-parser (unit, happy path)', () => {
  it('maps thread.started to session_init', () => {
    // Arrange
    const line = JSON.stringify({ type: 'thread.started', thread_id: 'codex-thread-77' });

    // Act
    const { messages, state } = run([line]);

    // Assert
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('session_init');
    expect(messages[0].content).toBe('codex-thread-77');
    expect(state.sessionId).toBe('codex-thread-77');
  });

  it('maps item.completed/agent_message to text with Chinese content', () => {
    // Arrange — 真实 { type: 'item.completed', item: { type: 'agent_message', text } }
    const line = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: '我审查了代码，建议增加输入校验。' },
    });

    // Act
    const { messages } = run([line]);

    // Assert
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('text');
    expect(messages[0].content).toBe('我审查了代码，建议增加输入校验。');
    expect(messages[0].metadata?.provider).toBe('codex');
  });

  it('de-duplicates a repeated final agent_message', () => {
    // Arrange — codex 偶尔重复发最终消息
    const same = JSON.stringify({
      type: 'item.completed',
      item: { type: 'agent_message', text: '审查完成，无阻断问题。' },
    });

    // Act
    const { messages } = run([same, same]);

    // Assert — 第二条被去重
    expect(messages).toHaveLength(1);
  });

  it('maps item.started/mcp_tool_call to tool_use with server__tool name', () => {
    // Arrange
    const line = JSON.stringify({
      type: 'item.started',
      item: { type: 'mcp_tool_call', id: 'call_9', server: 'clowder', tool: 'evidence_search', arguments: { query: '数据库选型' } },
    });

    // Act
    const { messages } = run([line]);

    // Assert
    expect(messages[0]).toMatchObject({ type: 'tool_use', toolName: 'clowder__evidence_search', toolUseId: 'call_9' });
    expect(messages[0].toolInput).toEqual({ query: '数据库选型' });
  });

  it('maps item.started/command_execution to shell tool_use', () => {
    // Arrange
    const line = JSON.stringify({
      type: 'item.started',
      item: { type: 'command_execution', command: 'pnpm test' },
    });

    // Act
    const { messages } = run([line]);

    // Assert
    expect(messages[0]).toMatchObject({ type: 'tool_use', toolName: 'shell' });
    expect(messages[0].toolInput).toEqual({ command: 'pnpm test' });
  });

  it('maps item.completed/reasoning to thinking', () => {
    // Arrange
    const line = JSON.stringify({
      type: 'item.completed',
      item: { type: 'reasoning', text: '分析需求：需要分页参数与排序' },
    });

    // Act
    const { messages } = run([line]);

    // Assert
    expect(messages[0]).toMatchObject({ type: 'thinking', content: '分析需求：需要分页参数与排序' });
  });

  it('maps top-level error event to error message', () => {
    // Arrange
    const line = JSON.stringify({ type: 'error', message: 'codex sandbox denied write' });

    // Act
    const { messages } = run([line]);

    // Assert
    expect(messages[0]).toMatchObject({ type: 'error', content: 'codex sandbox denied write' });
  });

  it('parses a full realistic stream in order', () => {
    // Arrange
    const lines = [
      JSON.stringify({ type: 'thread.started', thread_id: 's2' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '开始审查' } }),
      JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'cat a.ts' } }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '审查完成' } }),
    ];

    // Act
    const { messages } = run(lines);

    // Assert
    expect(messages.map((m) => m.type)).toEqual(['session_init', 'text', 'tool_use', 'text']);
  });

  // ── Doubling-bug audit (#6) — Codex VERDICT: NOT susceptible. ──
  // Codex `exec --json` has NO incremental streaming text path (no delta-then-final shape,
  // unlike Claude's --include-partial-messages). Reply text arrives ONLY via the final
  // consolidated `item.completed` / `agent_message`. The only repeat risk is Codex
  // re-emitting an IDENTICAL final message, which `lastAgentMessage` de-dups. The tests
  // below LOCK that single-emit behavior so a future event-model change cannot silently
  // reintroduce text doubling.
  describe('doubling audit: single emit per final text (no streaming-delta path)', () => {
    it('emits the consolidated agent_message text exactly once (single source of text)', () => {
      // Arrange — a complete reply turn: tool activity, then ONE final agent_message.
      const reply = '我已在 src/db/schema.ts 建好数据表，并补充了迁移脚本。';
      const lines = [
        JSON.stringify({ type: 'thread.started', thread_id: 'codex-thread-doubling' }),
        JSON.stringify({ type: 'item.started', item: { type: 'command_execution', command: 'cat src/db/schema.ts' } }),
        JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: reply } }),
      ];

      // Act
      const { messages } = run(lines);

      // Assert — exactly one text message; concatenation equals the reply once (not doubled).
      const texts = messages.filter((m) => m.type === 'text');
      expect(texts).toHaveLength(1);
      expect(texts.map((m) => m.content).join('')).toBe(reply);
    });

    it('a repeated identical final agent_message stays single (de-dup guards the only repeat path)', () => {
      // Arrange — Codex re-emits the SAME final message (the only doubling vector here).
      const reply = '审查完成：建议为分页接口补充上限校验。';
      const same = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: reply } });

      // Act
      const { messages } = run([same, same]);

      // Assert — concatenated text equals the reply exactly once.
      expect(messages.filter((m) => m.type === 'text').map((m) => m.content).join('')).toBe(reply);
    });
  });
});
