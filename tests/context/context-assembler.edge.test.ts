// M7 QA — context-assembler edge/adversarial gate. Probes the CJK-aware token
// estimator, head+tail truncation, sender naming, time formatting, and the
// recent-window budget trimming. dev≠QA.

import { describe, it, expect } from 'vitest';
import {
  ContextAssembler,
  estimateTokens,
  formatMessage,
  formatPromptTime,
  formatPromptTimeRange,
  getSenderName,
} from '@choco/api/context/context-assembler';
import { BASE_TS, CLAUDE, GEMINI, makeMessage, resolveConfig } from './fixtures';

describe('estimateTokens (edge)', () => {
  it('returns 0 for the empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('counts CJK codepoints as ~1 token each', () => {
    expect(estimateTokens('数据库')).toBe(3);
  });

  it('counts latin/punct as ~4 chars per token (ceil)', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });

  it('sums CJK + latin for mixed content', () => {
    expect(estimateTokens('数据abcd')).toBe(3); // 2 CJK + ceil(4/4)
  });
});

describe('formatMessage / getSenderName / time (edge)', () => {
  it('truncates long content with a head+tail marker', () => {
    const msg = makeMessage({ agentId: CLAUDE, content: 'x'.repeat(2000), offsetMin: 0 });
    const out = formatMessage(msg, { truncate: 100 });
    expect(out).toContain('[...truncated');
  });

  it('resolves sender names: user → 用户, known agent → displayName, unknown → raw id', () => {
    expect(getSenderName(null)).toBe('用户');
    expect(getSenderName(CLAUDE, resolveConfig)).toBe('布偶猫');
    expect(getSenderName(GEMINI)).toBe('gemini-pro'); // no resolver → raw branded id
  });

  it('formats a timestamp as a UTC HH:MM stamp', () => {
    expect(formatPromptTime(BASE_TS)).toBe('14:00');
  });

  it('formats a time range as HH:MM–HH:MM', () => {
    expect(formatPromptTimeRange(BASE_TS, BASE_TS + 5 * 60_000)).toBe('14:00–14:05');
  });
});

describe('ContextAssembler.assemble (edge)', () => {
  it('returns an empty assembly for no messages', () => {
    expect(new ContextAssembler().assemble([])).toEqual({
      contextText: '',
      messageCount: 0,
      estimatedTokens: 0,
    });
  });

  it('clamps to the most-recent maxMessages window (default 20)', () => {
    const msgs = Array.from({ length: 25 }, (_, i) =>
      makeMessage({ agentId: null, content: `M#${i}`, offsetMin: i }),
    );
    const assembled = new ContextAssembler({ maxTotalTokens: 100_000 }).assemble(msgs);
    expect(assembled.messageCount).toBe(20);
  });

  it('trims oldest-first under a tight token budget, keeping the most recent', () => {
    const msgs = Array.from({ length: 10 }, (_, i) =>
      makeMessage({ agentId: null, content: `M#${i}`, offsetMin: i }),
    );
    const assembled = new ContextAssembler({ maxTotalTokens: 40 }).assemble(msgs);
    expect(assembled.contextText).toContain('M#9');
    expect(assembled.contextText).not.toContain('M#0');
  });
});

describe('ContextAssembler.assemble (adversarial)', () => {
  it('returns an empty context when even one message cannot fit the budget+overhead', () => {
    const msgs = [makeMessage({ agentId: null, content: 'x'.repeat(4000), offsetMin: 0 })];
    const assembled = new ContextAssembler({ maxTotalTokens: 5 }).assemble(msgs);
    expect(assembled.contextText).toBe('');
    expect(assembled.messageCount).toBe(0);
  });
});
