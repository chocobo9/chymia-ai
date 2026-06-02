import { describe, it, expect } from 'vitest';
import {
  ContextAssembler,
  estimateTokens,
  formatMessage,
  getSenderName,
  formatPromptTime,
} from '@choco/api/context/context-assembler';
import { CLAUDE, makeMessage, resolveConfig } from './fixtures';

describe('ContextAssembler (unit, happy path)', () => {
  it('assembles recent history with a header/footer wrapper', () => {
    const msgs = [
      makeMessage({ agentId: null, content: '@claude 写一个 TODO API。', mentions: [CLAUDE], offsetMin: 0 }),
      makeMessage({ agentId: CLAUDE, content: '布偶猫：好的，我来设计 schema。', offsetMin: 1 }),
    ];
    const assembled = new ContextAssembler({ resolveConfig }).assemble(msgs);
    expect(assembled.messageCount).toBe(2);
    expect(assembled.contextText).toContain('[对话历史 - 最近 2 条]');
    expect(assembled.contextText).toContain('布偶猫');
    expect(assembled.contextText).toContain('用户');
    expect(assembled.contextText).toContain('[/对话历史]');
    expect(assembled.estimatedTokens).toBeGreaterThan(0);
  });

  it('keeps only the newest messages within the token budget', () => {
    const msgs = Array.from({ length: 40 }, (_, i) =>
      makeMessage({ agentId: null, content: `进度更新 #${i}：还在写 database 迁移脚本。`, offsetMin: i }),
    );
    const assembled = new ContextAssembler({ maxTotalTokens: 80, resolveConfig }).assemble(msgs);
    expect(assembled.messageCount).toBeGreaterThan(0);
    expect(assembled.messageCount).toBeLessThan(40);
    // Newest line survives; oldest is trimmed.
    expect(assembled.contextText).toContain('#39');
    expect(assembled.contextText).not.toContain('#0：');
  });

  it('estimateTokens weights CJK chars higher than latin', () => {
    expect(estimateTokens('数据库')).toBe(3);
    expect(estimateTokens('database')).toBe(2); // ceil(8/4)
    expect(estimateTokens('')).toBe(0);
  });

  it('getSenderName resolves agents and labels users', () => {
    expect(getSenderName(null)).toBe('用户');
    expect(getSenderName(CLAUDE, resolveConfig)).toBe('布偶猫');
    expect(getSenderName(CLAUDE)).toBe('claude-opus'); // no resolver → raw id
  });

  it('formatMessage emits [HH:MM sender] content', () => {
    const msg = makeMessage({ agentId: CLAUDE, content: '完成。', offsetMin: 0 });
    const line = formatMessage(msg, { resolveConfig });
    expect(line).toBe(`[${formatPromptTime(msg.timestamp)} 布偶猫] 完成。`);
  });
});
