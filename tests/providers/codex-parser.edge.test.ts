// tests/providers/codex-parser.edge.test.ts
// M2 QA (edge + adversarial): Codex exec --json parser. QA != dev.
// Gates parseCodexLine against design §A8 / §4.2 using the REAL codex-rs exec
// envelope (thread.started, item.started/{mcp_tool_call,command_execution},
// item.completed/{agent_message,reasoning}, error). NDJSON robustness, the
// agent_message dedup seam, and adversarial malformed shapes.
// Real codex frames + real Chinese/English content.

import { describe, it, expect } from 'vitest';
import type { AgentMessage } from '@choco/shared';
import { createAgentId } from '@choco/shared';
import {
  createCodexParserState,
  parseCodexLine,
  type CodexParserState,
  type CodexParserDeps,
} from '@choco/api/providers/codex/codex-parser';

const agentId = createAgentId('codex');
const FIXED_TS = 1_700_000_911_000;
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

const agentMessage = (text: string): string =>
  JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } });

describe('parseCodexLine — NDJSON robustness (edge)', () => {
  it('emits nothing on empty and whitespace-only lines and preserves state identity', () => {
    const start = createCodexParserState();
    const a = parseCodexLine('', start, deps);
    const b = parseCodexLine('\t  \t', start, deps);
    expect(a.messages).toEqual([]);
    expect(a.state).toBe(start);
    expect(b.messages).toEqual([]);
  });

  it('does not crash on a truncated JSON line', () => {
    const { messages } = run(['{"type":"item.completed","item":{"type":"agent_message","text":"重构 routing']);
    expect(messages).toEqual([]);
  });

  it('does not crash on a JSON primitive that is not an object', () => {
    const { messages } = run(['1024', 'false', '"loose"']);
    expect(messages).toEqual([]);
  });

  it('ignores an unknown top-level event type', () => {
    const { messages } = run([JSON.stringify({ type: 'token_count', input_tokens: 1024 })]);
    expect(messages).toEqual([]);
  });

  it('ignores an item.completed with an unknown item type', () => {
    const { messages } = run([
      JSON.stringify({ type: 'item.completed', item: { type: 'web_search', query: 'sqlite-vec' } }),
    ]);
    expect(messages).toEqual([]);
  });

  it('does not emit session_init when thread.started lacks thread_id', () => {
    const { state, messages } = run([JSON.stringify({ type: 'thread.started' })]);
    // session_init is still emitted (envelope matched) but with undefined content; sessionId stays unset.
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('session_init');
    expect(messages[0].content).toBeUndefined();
    expect(state.sessionId).toBeUndefined();
  });
});

describe('parseCodexLine — streaming semantics (edge)', () => {
  it('de-duplicates a repeated final agent_message but allows a later distinct one', () => {
    const { messages } = run([
      agentMessage('审查完成，无阻断问题。'),
      agentMessage('审查完成，无阻断问题。'),
      agentMessage('补充：建议给退款接口加幂等键。'),
    ]);
    expect(messages.map((m) => m.content)).toEqual([
      '审查完成，无阻断问题。',
      '补充：建议给退款接口加幂等键。',
    ]);
  });

  it('records lastAgentMessage in state so cross-frame dedup is stateful', () => {
    const first = parseCodexLine(agentMessage('初版回复'), createCodexParserState(), deps);
    expect(first.state.lastAgentMessage).toBe('初版回复');
    const second = parseCodexLine(agentMessage('初版回复'), first.state, deps);
    expect(second.messages).toEqual([]);
  });

  it('emits mcp_tool_call as tool_use with server__tool name and real Chinese query args', () => {
    const { messages } = run([
      JSON.stringify({
        type: 'item.started',
        item: {
          type: 'mcp_tool_call',
          id: 'call_42',
          server: 'choco',
          tool: 'evidence_search',
          arguments: { query: '退款超时的历史讨论', limit: 8 },
        },
      }),
    ]);
    expect(messages[0]).toMatchObject({ type: 'tool_use', toolName: 'choco__evidence_search', toolUseId: 'call_42' });
    expect(messages[0].toolInput).toEqual({ query: '退款超时的历史讨论', limit: 8 });
  });

  it('emits command_execution as a shell tool_use carrying the real command', () => {
    const { messages } = run([
      JSON.stringify({ type: 'item.started', item: { type: 'command_execution', id: 'cmd_3', command: 'pnpm vitest run tests/providers/' } }),
    ]);
    expect(messages[0]).toMatchObject({ type: 'tool_use', toolName: 'shell', toolUseId: 'cmd_3' });
    expect(messages[0].toolInput).toEqual({ command: 'pnpm vitest run tests/providers/' });
  });

  it('maps reasoning to a thinking message', () => {
    const { messages } = run([
      JSON.stringify({ type: 'item.completed', item: { type: 'reasoning', text: '先复现失败用例，再缩小到 router 的空指针。' } }),
    ]);
    expect(messages[0]).toMatchObject({ type: 'thinking', content: '先复现失败用例，再缩小到 router 的空指针。' });
  });

  it('emits an error event carrying the CLI message', () => {
    const { messages } = run([
      JSON.stringify({ type: 'error', message: 'stream error: exceeded retry limit while contacting model' }),
    ]);
    expect(messages[0]).toMatchObject({ type: 'error', content: 'stream error: exceeded retry limit while contacting model' });
  });
});

describe('parseCodexLine — adversarial', () => {
  it('skips an agent_message whose text is whitespace-only (no empty text block)', () => {
    const { messages } = run([agentMessage('   \n\t  ')]);
    expect(messages).toEqual([]);
  });

  it('uses a fallback message when an error event has no message field', () => {
    const { messages } = run([JSON.stringify({ type: 'error', code: 'E_UNKNOWN' })]);
    expect(messages[0]).toMatchObject({ type: 'error', content: 'codex cli error' });
  });

  it('ignores an item-bearing event whose item is not an object', () => {
    const { messages } = run([JSON.stringify({ type: 'item.completed', item: 'not-an-object' })]);
    expect(messages).toEqual([]);
  });

  it('defaults mcp_tool_call arguments to {} and tool to "unknown" when omitted', () => {
    const { messages } = run([
      JSON.stringify({ type: 'item.started', item: { type: 'mcp_tool_call', server: 'choco' } }),
    ]);
    expect(messages[0]).toMatchObject({ type: 'tool_use', toolName: 'choco__unknown' });
    expect(messages[0].toolInput).toEqual({});
  });

  it('treats item.completed for a tool item as a no-op (parser emits tool_use only on start)', () => {
    const { messages } = run([
      JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'pnpm test', exit_code: 0 } }),
    ]);
    expect(messages).toEqual([]);
  });
});
