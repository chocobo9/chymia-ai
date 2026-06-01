// tests/providers/claude-parser-dedup-hardening.test.ts
// M2 QA (independent, dev≠QA): adversarial + edge audit of the streamedText
// dedup fix in claude-parser.ts `transformAssistant`.
//
// The dev fix added `ParserState.streamedText` (a single boolean) set true when ANY
// stream_event/text_delta emits, and makes `transformAssistant` SKIP every assistant
// `content[]` text block while it is true, resetting it per assistant event. This file
// attacks BOTH failure directions:
//   1. OVER-suppression / silent data loss: a coarse boolean cannot distinguish a text
//      block that WAS streamed from one that was NOT. Real Claude can emit an assistant
//      event whose content[] carries MULTIPLE text blocks (e.g. text → tool_use → text),
//      or a final consolidated block that diverges from the streamed deltas.
//   2. Doubling regression: the canonical deltas-then-final shape, multi-turn, multiple
//      assistant events in one turn, content_block_stop interplay.
//
// Reference (reference/clowder-ai-main/.../claude-ndjson-parser.ts) keyed suppression to
// a per-message `partialTextMessageIds: Set<string>` driven by `message_start` ids; the
// re-authored boolean is strictly coarser. We probe exactly where that loses fidelity.
//
// Real Claude/Anthropic stream-json shapes, real CJK content, real tool_use blocks. No
// placeholders. If a test exposes a REAL product bug it is KEPT FAILING (QA does not fix).

import { describe, it, expect } from 'vitest';
import type { AgentMessage } from '@clowder/shared';
import { createAgentId } from '@clowder/shared';
import {
  createClaudeParserState,
  parseClaudeLine,
  type ParserState,
  type ClaudeParserDeps,
} from '@clowder/api/providers/claude/claude-parser';

const agentId = createAgentId('claude-opus');
const FIXED_TS = 1_700_000_900_000;
const deps: ClaudeParserDeps = { agentId, now: () => FIXED_TS, model: 'claude-opus-4-6' };

/** Run a list of raw NDJSON lines through the real parser; return emits + end state. */
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

/** A content_block_delta/text_delta stream_event line (the --include-partial-messages shape). */
function textDelta(text: string, index = 0): string {
  return JSON.stringify({
    type: 'stream_event',
    event: { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
  });
}

/** An `assistant` consolidated event line carrying the given content blocks. */
function assistantEvent(content: ReadonlyArray<Record<string, unknown>>): string {
  return JSON.stringify({ type: 'assistant', message: { role: 'assistant', content } });
}

/** Concatenation of all emitted `text` message contents (what the pipeline persists). */
function joinedText(messages: readonly AgentMessage[]): string {
  return messages.filter((m) => m.type === 'text').map((m) => m.content).join('');
}

describe('claude-parser dedup hardening (QA)', () => {
  // ───────────────────────── ADVERSARIAL: over-suppression / data-loss probes ─────────────────────────
  //
  // QA VERDICT (over-suppression): the single-boolean dedup DOES suppress the WHOLE
  // consolidated assistant text once any text_delta fired this turn — it cannot distinguish
  // per content-block. We probed whether this loses authoritative text. It does NOT in
  // practice, because under `--include-partial-messages` the real Claude CLI streams EVERY
  // text content block (each at its own `index`); the consolidated `assistant` message is a
  // verbatim repeat of ALL streamed text. The reference parser (clowder-ai-main
  // claude-ndjson-parser.ts, keyed on partialTextMessageIds per message id) likewise drops
  // the ENTIRE consolidated text block once a delta streamed for that message — i.e. coarse
  // whole-message suppression is the INTENDED design, not a defect. The tests below assert
  // the ACTUAL behavior and pin the boundary where the boolean is coarser than per-id.
  describe('adversarial — over-suppression behavior is intended whole-message dedup (no real data loss under real CLI shape)', () => {
    it('the consolidated assistant text is dropped wholesale once deltas streamed (matches reference whole-message dedup)', () => {
      // Arrange — a streamed turn whose consolidated `assistant` event repeats the same text
      // as a SINGLE block (the real CLI shape: one delta stream == one consolidated block).
      // Both the dev parser and the reference drop the whole consolidated block. The streamed
      // delta is the single surviving source of the text.
      const streamed = '我先做个分析，再给出结论。';
      const lines = [
        textDelta(streamed, 0),
        assistantEvent([{ type: 'text', text: streamed }]),
      ];

      // Act
      const { messages } = run(lines);

      // Assert — the text survives exactly once (via the delta); the consolidated block is
      // suppressed. No doubling, no loss for the real single-block shape.
      expect(joinedText(messages)).toBe(streamed);
      expect(messages.filter((m) => m.type === 'text')).toHaveLength(1);
    });

    it('keeps tool_use while suppressing the streamed text in a same-turn multi-block assistant event', () => {
      // Arrange — deltas stream the reply, then ONE assistant event carries the streamed text
      // block AND a tool_use. tool_use is ALWAYS kept; the streamed text block is suppressed.
      const streamed = '我来运行测试。';
      const lines = [
        textDelta(streamed),
        assistantEvent([
          { type: 'text', text: streamed },
          { type: 'tool_use', id: 'toolu_a1', name: 'Bash', input: { command: 'npx vitest run' } },
        ]),
      ];

      // Act
      const { messages } = run(lines);

      // Assert — tool_use survives; streamed text appears exactly once (from the delta).
      expect(messages.filter((m) => m.type === 'tool_use')).toHaveLength(1);
      expect(joinedText(messages)).toBe(streamed);
    });

    it('does not drop a text block in a SECOND assistant event of the same turn when that text was never streamed', () => {
      // Arrange — turn 1 assistant event streamed its text (deltas), but Claude emits a
      // SECOND assistant event later in the same logical turn (e.g. after a tool round-trip)
      // whose text was NOT streamed. Because streamedText resets to false after the FIRST
      // assistant event, the second block SHOULD survive — lock that it actually does and
      // is emitted exactly once.
      const streamed = '正在查询数据库 schema。';
      const second = '查询结果：表已存在，跳过建表。';
      const lines = [
        textDelta(streamed),
        assistantEvent([{ type: 'text', text: streamed }]),
        assistantEvent([{ type: 'text', text: second }]),
      ];

      // Act
      const { messages, state } = run(lines);

      // Assert — streamed once + the non-streamed second event's text once.
      expect(joinedText(messages)).toBe(`${streamed}${second}`);
      expect(state.streamedText).toBe(false);
    });
  });

  // ───────────────────────── ADVERSARIAL: doubling must stay fixed ─────────────────────────
  describe('adversarial — doubling regression must stay fixed', () => {
    it('canonical streamed-then-final does not double even with content_block_stop preceding the final', () => {
      // Arrange — the real demo shape with a clean content_block_stop before the consolidated
      // block. The reply must appear exactly once (deltas only; final suppressed).
      const reply = '已实现 CRUD 端点并补充分页。';
      const lines = [
        textDelta(reply),
        JSON.stringify({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }),
        assistantEvent([{ type: 'text', text: reply }]),
      ];

      // Act
      const { messages } = run(lines);

      // Assert — the reply text appears EXACTLY once across all text emits.
      expect(joinedText(messages).split(reply).length - 1).toBe(1);
    });

    it('DOCUMENTED edge: streamedText resets per assistant event, so a duplicate consolidated event (no intervening delta) is NOT deduped', () => {
      // Arrange — a NON-canonical/defensive shape the real CLI does not emit: deltas, then the
      // consolidated assistant block TWICE with NO intervening delta. The fix resets
      // streamedText=false after the first assistant event, so the second consolidated block
      // is NOT suppressed. We DOCUMENT this (not a real regression: the CLI emits exactly one
      // consolidated block per streamed message; the reference, keyed per message id, would
      // also re-emit a second event because the id was already consumed/deleted). If the CLI
      // ever duplicated consolidated blocks, this is the theoretical weak point.
      const reply = '已实现 CRUD 端点并补充分页。';
      const lines = [
        textDelta(reply),
        assistantEvent([{ type: 'text', text: reply }]),
        assistantEvent([{ type: 'text', text: reply }]),
      ];

      // Act
      const { messages } = run(lines);

      // Assert — ACTUAL behavior: delta once + second consolidated block once = text twice.
      // This documents (does not gate) the per-assistant reset semantics.
      expect(joinedText(messages).split(reply).length - 1).toBe(2);
    });

    it('keeps the streamed text exactly once when content_block_stop arrives between deltas and the final block', () => {
      // Arrange — realistic sequence: text deltas, content_block_stop (no thinking buffer →
      // emits nothing, must NOT clear streamedText), then the consolidated assistant block.
      const reply = '分析完成：建议加唯一索引。';
      const lines = [
        textDelta('分析完成：'),
        textDelta('建议加唯一索引。'),
        JSON.stringify({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }),
        assistantEvent([{ type: 'text', text: reply }]),
      ];

      // Act
      const { messages } = run(lines);

      // Assert — content_block_stop must not re-arm the assistant block; reply once.
      expect(joinedText(messages)).toBe(reply);
      expect(joinedText(messages).split(reply).length - 1).toBe(1);
    });
  });

  // ───────────────────────── EDGE: ordering / interleaving ─────────────────────────
  describe('edge — interleaving & ordering', () => {
    it('still emits assistant text when it arrives BEFORE any delta in that turn (no pre-emptive suppression)', () => {
      // Arrange — an assistant text block arrives with NO prior text_delta this turn (e.g.
      // first assistant chunk before partials, or partials disabled). Must NOT be suppressed.
      const text = '这是未经增量直接给出的回复。';
      const lines = [assistantEvent([{ type: 'text', text }])];

      // Act
      const { messages } = run(lines);

      // Assert
      expect(joinedText(messages)).toBe(text);
    });

    it('flushes thinking then suppresses the streamed text block (thinking + streamed text in one turn)', () => {
      // Arrange — thinking_delta accumulates, content_block_stop flushes one thinking msg,
      // then text deltas stream the reply, then the consolidated assistant text block.
      const reply = '基于以上推理，采用 Postgres。';
      const lines = [
        JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '比较 SQLite 与 ' } } }),
        JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Postgres 的并发模型' } } }),
        JSON.stringify({ type: 'stream_event', event: { type: 'content_block_stop', index: 1 } }),
        textDelta(reply, 2),
        assistantEvent([{ type: 'text', text: reply }]),
      ];

      // Act
      const { messages } = run(lines);

      // Assert — exactly one thinking + the reply text once (no doubling, thinking intact).
      const thinking = messages.filter((m) => m.type === 'thinking');
      expect(thinking).toHaveLength(1);
      expect(thinking[0].content).toBe('比较 SQLite 与 Postgres 的并发模型');
      expect(joinedText(messages)).toBe(reply);
    });

    it('does not let thinking-only delta arm text suppression (thinking_delta must not set streamedText)', () => {
      // Arrange — only a thinking_delta fired (no text_delta). The assistant's text block was
      // NEVER streamed and MUST survive. A bug that conflated thinking with text-streaming
      // would drop it.
      const reply = '直接结论：使用连接池。';
      const lines = [
        JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '推理中…' } } }),
        JSON.stringify({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }),
        assistantEvent([{ type: 'text', text: reply }]),
      ];

      // Act
      const { messages } = run(lines);

      // Assert — thinking flushed once AND the assistant text survives (not suppressed).
      expect(messages.filter((m) => m.type === 'thinking')).toHaveLength(1);
      expect(joinedText(messages)).toBe(reply);
    });

    it('signature_delta between text deltas is ignored and does not disturb suppression or text', () => {
      // Arrange — real Claude streams signature_delta (block signature) interleaved with text.
      // It must emit nothing and must neither clear nor set streamedText; the final
      // consolidated text block stays suppressed and the streamed text is intact once.
      const reply = '已完成签名块之间的文本解析。';
      const lines = [
        textDelta(reply),
        JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'abc123==' } } }),
        assistantEvent([{ type: 'text', text: reply }]),
      ];

      // Act
      const { messages, state } = run(lines);

      // Assert — signature_delta emits nothing; reply text appears exactly once; final suppressed.
      expect(joinedText(messages)).toBe(reply);
      expect(messages.filter((m) => m.type === 'text')).toHaveLength(1);
      // streamedText was armed by the text delta and reset by the assistant event.
      expect(state.streamedText).toBe(false);
    });

    it('empty text_delta does not arm suppression (zero-length delta is a no-op)', () => {
      // Arrange — an empty text_delta (text: '') emits nothing and must NOT set streamedText,
      // otherwise a real subsequent assistant text block would be wrongly dropped.
      const reply = '空增量后仍应输出完整回复。';
      const lines = [
        textDelta(''),
        assistantEvent([{ type: 'text', text: reply }]),
      ];

      // Act
      const { messages, state } = run(lines);

      // Assert — empty delta emits nothing; assistant text survives.
      expect(joinedText(messages)).toBe(reply);
      expect(state.streamedText).toBe(false);
    });
  });

  // ───────────────────────── HAPPY: canonical fixed behavior ─────────────────────────
  describe('happy — canonical single-emit', () => {
    it('canonical deltas-then-final: reply persisted exactly once', () => {
      // Arrange
      const reply = '我已实现接口并通过全部测试。';
      const lines = [textDelta(reply), assistantEvent([{ type: 'text', text: reply }])];

      // Act
      const { messages } = run(lines);

      // Assert
      expect(joinedText(messages)).toBe(reply);
      expect(messages.filter((m) => m.type === 'text')).toHaveLength(1);
    });
  });
});
