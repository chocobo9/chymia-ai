// M7 QA — tool-scrub edge/adversarial gate. scrubToolPayloads + tool-event readers
// were UNTESTED by the dev happy suite (no tool-scrub.test.ts existed). This file
// closes that gap. Authored independently of the M7 product code (dev≠QA).

import { describe, it, expect } from 'vitest';
import type { StoredMessage } from '@choco/shared';
import {
  getToolEvents,
  hasToolResult,
  hasToolUse,
  scrubToolPayloads,
} from '@choco/api/context/tool-scrub';
import { CLAUDE, CODEX, makeMessage } from './fixtures';

/** Build a message carrying a raw (possibly-malformed) extra.toolEvents bag. */
function withRawToolEvents(content: string, toolEvents: unknown): StoredMessage {
  return { ...makeMessage({ agentId: CODEX, content, offsetMin: 0 }), extra: { toolEvents } };
}

describe('tool-scrub: getToolEvents / hasToolUse / hasToolResult (edge)', () => {
  it('returns [] when the message has no extra at all', () => {
    const msg = makeMessage({ agentId: CLAUDE, content: '布偶猫：直接给结论，无工具调用。', offsetMin: 0 });
    expect(getToolEvents(msg)).toEqual([]);
    expect(hasToolUse(msg)).toBe(false);
    expect(hasToolResult(msg)).toBe(false);
  });

  it('parses well-formed tool_use and tool_result events with labels', () => {
    const msg = makeMessage({
      agentId: CODEX,
      content: '缅因猫读取迁移脚本。',
      offsetMin: 1,
      toolEvents: [
        { type: 'tool_use', label: 'read_file' },
        { type: 'tool_result', label: 'read_file' },
      ],
    });
    expect(getToolEvents(msg)).toEqual([
      { type: 'tool_use', label: 'read_file' },
      { type: 'tool_result', label: 'read_file' },
    ]);
    expect(hasToolUse(msg)).toBe(true);
    expect(hasToolResult(msg)).toBe(true);
  });

  it('keeps an event whose label is missing (label omitted, type preserved)', () => {
    const msg = withRawToolEvents('工具调用无 label。', [{ type: 'tool_use' }]);
    expect(getToolEvents(msg)).toEqual([{ type: 'tool_use' }]);
    expect(hasToolUse(msg)).toBe(true);
  });

  it('drops entries with an unknown type but keeps the valid ones', () => {
    const msg = withRawToolEvents('混入非法 type。', [
      { type: 'bogus', label: 'x' },
      { type: 'tool_result', label: 'grep' },
    ]);
    expect(getToolEvents(msg)).toEqual([{ type: 'tool_result', label: 'grep' }]);
    expect(hasToolResult(msg)).toBe(true);
    expect(hasToolUse(msg)).toBe(false);
  });

  it('ignores a non-string label (type kept, label dropped)', () => {
    const msg = withRawToolEvents('label 是数字。', [{ type: 'tool_use', label: 42 }]);
    expect(getToolEvents(msg)).toEqual([{ type: 'tool_use' }]);
  });
});

describe('tool-scrub: scrubToolPayloads (edge)', () => {
  it('replaces a non-terminal tool_result payload with a label-aware digest', () => {
    const messages = [
      makeMessage({
        agentId: CODEX,
        content: '迁移脚本完整内容：CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT) ...很长...',
        offsetMin: 0,
        toolEvents: [{ type: 'tool_result', label: 'read_file' }],
      }),
      makeMessage({ agentId: CODEX, content: '缅因猫 review 结论：补 created_at 索引。', offsetMin: 1 }),
    ];
    const scrubbed = scrubToolPayloads(messages);
    expect(scrubbed[0]?.content).toBe('<tool_result truncated: read_file executed>');
    expect(scrubbed[1]?.content).toBe('缅因猫 review 结论：补 created_at 索引。');
  });

  it('preserves the LAST message verbatim even if it carries a tool_result', () => {
    const messages = [
      makeMessage({ agentId: CODEX, content: '前置说明。', offsetMin: 0 }),
      makeMessage({
        agentId: CODEX,
        content: '最后一条 tool_result 必须保留原文。',
        offsetMin: 1,
        toolEvents: [{ type: 'tool_result', label: 'grep' }],
      }),
    ];
    const scrubbed = scrubToolPayloads(messages);
    expect(scrubbed[1]?.content).toBe('最后一条 tool_result 必须保留原文。');
  });

  it('leaves non-terminal messages WITHOUT a tool_result untouched', () => {
    const messages = [
      makeMessage({ agentId: CLAUDE, content: '布偶猫纯文本回复。', offsetMin: 0 }),
      makeMessage({ agentId: CODEX, content: '收尾。', offsetMin: 1 }),
    ];
    const scrubbed = scrubToolPayloads(messages);
    expect(scrubbed[0]?.content).toBe('布偶猫纯文本回复。');
  });

  it('uses the "tool" fallback label when a scrubbed tool_result has no label', () => {
    const messages = [
      withRawToolEvents('巨大 tool_result 内容。', [{ type: 'tool_result' }]),
      makeMessage({ agentId: CODEX, content: '末条。', offsetMin: 2 }),
    ];
    const scrubbed = scrubToolPayloads(messages);
    expect(scrubbed[0]?.content).toBe('<tool_result truncated: tool executed>');
  });

  it('returns fresh objects and never mutates the input messages', () => {
    const original = makeMessage({
      agentId: CODEX,
      content: '原始 tool_result 内容。',
      offsetMin: 0,
      toolEvents: [{ type: 'tool_result', label: 'read_file' }],
    });
    const tail = makeMessage({ agentId: CODEX, content: '末条。', offsetMin: 1 });
    const scrubbed = scrubToolPayloads([original, tail]);
    expect(original.content).toBe('原始 tool_result 内容。'); // input unchanged
    expect(scrubbed[0]).not.toBe(original); // new object
  });
});

describe('tool-scrub: scrubToolPayloads (adversarial)', () => {
  it('returns [] for an empty message list', () => {
    expect(scrubToolPayloads([])).toEqual([]);
  });

  it('returns [] from getToolEvents when extra.toolEvents is not an array', () => {
    const msg = withRawToolEvents('toolEvents 不是数组。', { type: 'tool_use' });
    expect(getToolEvents(msg)).toEqual([]);
  });

  it('skips null / primitive entries inside the toolEvents array', () => {
    const msg = withRawToolEvents('混入 null 和字符串。', [null, 'tool_use', 7, { type: 'tool_use', label: 'bash' }]);
    expect(getToolEvents(msg)).toEqual([{ type: 'tool_use', label: 'bash' }]);
  });

  it('keeps a single-element list verbatim even when it is a tool_result', () => {
    const only = makeMessage({
      agentId: CODEX,
      content: '唯一一条，且是 tool_result，应保留。',
      offsetMin: 0,
      toolEvents: [{ type: 'tool_result', label: 'read_file' }],
    });
    const scrubbed = scrubToolPayloads([only]);
    expect(scrubbed[0]?.content).toBe('唯一一条，且是 tool_result，应保留。');
  });
});
