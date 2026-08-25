// tests/providers/claude-malformed-formA.test.ts
// gap #4 Layer 2 — form A malformed tool-call detection (F215 AC-B1).
//
// Aligned-To: reference/clowder-ai-main/.../providers/ClaudeAgentService.ts (:648)
//   isMalformedToolCall = hasAssistantEvent && !lastAssistantHasToolUseBlock &&
//                         !lastAssistantHasTextBlock && !sawResultError
//
// Evidence: REAL claude stream-json NDJSON wire data (a thinking-only assistant
// turn — the form A 炸毛 shape). The parser + service logic under test is real;
// only the process spawn is faked. A real spawn cannot reliably induce
// thinking-only (claude #49747 — intermittent), so wire data + unit assertions are
// the dependable evidence here (constraint accepted by the user; end-to-end real
// spawn of form A stays PARTIAL).

import { describe, test, expect } from 'vitest';
import type { AgentMessage } from '@choco/shared';
import { createAgentId } from '@choco/shared';
import {
  parseClaudeLine,
  createClaudeParserState,
  isMalformedFormAState,
  type ParserState,
} from '@choco/api/providers/claude/claude-parser';
import { ClaudeAgentService } from '@choco/api/providers/claude/claude-service';
import type { CliLineStream } from '@choco/api/providers/cli-spawn';

const CLAUDE = createAgentId('claude-opus');

/** Real claude stream-json shapes (init → … → result). */
const INIT = JSON.stringify({
  type: 'system',
  subtype: 'init',
  session_id: 'sess-formA',
  model: 'claude-opus-4-6',
});
const RESULT_OK = JSON.stringify({ type: 'result', subtype: 'success' });

/** form A: a thinking-only assistant turn — content has ONLY a thinking block. */
const FORM_A_LINES: readonly string[] = [
  INIT,
  JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '让我先想想这个问题……' } },
  }),
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: '让我先想想这个问题……', signature: 'sig-abc' }] },
  }),
  RESULT_OK,
];

/** Normal: a plain text reply (consolidated assistant text block). */
const NORMAL_LINES: readonly string[] = [
  INIT,
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text: '答案是 42。' }] },
  }),
  RESULT_OK,
];

/** Tool-use: a pure tool_use turn (legitimate, not malformed). */
const TOOL_LINES: readonly string[] = [
  INIT,
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'x.ts' } }] },
  }),
  RESULT_OK,
];

/** Thinking-only assistant BUT the turn ends in a result error → not form A. */
const ERROR_LINES: readonly string[] = [
  INIT,
  JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: '……', signature: 's' }] },
  }),
  JSON.stringify({ type: 'result', subtype: 'error_max_turns' }),
];

/** Streamed text via text_delta, assistant content carries no text block. */
const STREAMED_TEXT_LINES: readonly string[] = [
  INIT,
  JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '增量回复文本' } },
  }),
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [] } }),
  RESULT_OK,
];

function parseAll(lines: readonly string[]): ParserState {
  let state = createClaudeParserState();
  for (const line of lines) {
    state = parseClaudeLine(line, state, { agentId: CLAUDE }).state;
  }
  return state;
}

/** Fake spawn that replays scripted lines then exits cleanly. */
function makeSpawn(lines: readonly string[]): () => CliLineStream {
  return () => ({
    lines: (async function* () {
      for (const line of lines) yield line;
    })(),
    exit: Promise.resolve({ reason: 'exit' as const, code: 0, signal: null, stderr: '' }),
    kill: () => {},
  });
}

async function drainInvoke(lines: readonly string[]): Promise<AgentMessage[]> {
  const svc = new ClaudeAgentService({ agentId: CLAUDE, spawn: makeSpawn(lines) });
  const events: AgentMessage[] = [];
  for await (const ev of svc.invoke('@claude do something')) {
    events.push(ev);
  }
  return events;
}

describe('form A detection (parser, real wire)', () => {
  test('thinking-only assistant turn is form A malformed', () => {
    const state = parseAll(FORM_A_LINES);
    expect(state.sawAssistantEvent).toBe(true);
    expect(state.lastAssistantHadTextBlock).toBeFalsy();
    expect(state.lastAssistantHadToolUseBlock).toBeFalsy();
    expect(state.sawResultError).toBeFalsy();
    expect(isMalformedFormAState(state)).toBe(true);
  });

  test('a normal text reply is NOT malformed', () => {
    const state = parseAll(NORMAL_LINES);
    expect(state.lastAssistantHadTextBlock).toBe(true);
    expect(isMalformedFormAState(state)).toBe(false);
  });

  test('a pure tool_use turn is NOT malformed', () => {
    const state = parseAll(TOOL_LINES);
    expect(state.lastAssistantHadToolUseBlock).toBe(true);
    expect(isMalformedFormAState(state)).toBe(false);
  });

  test('thinking-only BUT result error is NOT form A (error takes precedence)', () => {
    const state = parseAll(ERROR_LINES);
    expect(state.sawResultError).toBe(true);
    expect(isMalformedFormAState(state)).toBe(false);
  });

  test('streamed text (no assistant text block) is NOT malformed', () => {
    const state = parseAll(STREAMED_TEXT_LINES);
    expect(state.lastAssistantHadTextBlock).toBe(true); // streamedText counts as text
    expect(isMalformedFormAState(state)).toBe(false);
  });
});

describe('form A detection (service emits signal + error before done)', () => {
  test('thinking-only turn emits malformed_toolcall_detected + malformed error BEFORE done', async () => {
    const events = await drainInvoke(FORM_A_LINES);
    const detectedIdx = events.findIndex(
      (e) => e.type === 'system_info' && (e.content ?? '').includes('malformed_toolcall_detected'),
    );
    const errorIdx = events.findIndex((e) => e.type === 'error' && e.errorCode === 'malformed_toolcall');
    const doneIdx = events.findIndex((e) => e.type === 'done');

    expect(detectedIdx).toBeGreaterThanOrEqual(0);
    expect(errorIdx).toBeGreaterThanOrEqual(0);
    expect(doneIdx).toBeGreaterThanOrEqual(0);
    // The recovery signals precede the done so invoke-layer can suppress + retry.
    expect(detectedIdx).toBeLessThan(doneIdx);
    expect(errorIdx).toBeLessThan(doneIdx);
  });

  test('a normal turn emits NO malformed signal or error', async () => {
    const events = await drainInvoke(NORMAL_LINES);
    expect(events.some((e) => e.type === 'error' && e.errorCode === 'malformed_toolcall')).toBe(false);
    expect(
      events.some((e) => e.type === 'system_info' && (e.content ?? '').includes('malformed_toolcall_detected')),
    ).toBe(false);
    expect(events.some((e) => e.type === 'text')).toBe(true);
    expect(events.some((e) => e.type === 'done')).toBe(true);
  });
});
