// tests/providers/antigravity-parser.test.ts
// @gemini 后端换 Antigravity (agy CLI)：plain-text 分类器单测。
//
// 对齐 Clowder providers/antigravity-cli-event-parser.ts `classifyAntigravityCliPlainText`。
// AGY print 模式不吐 NDJSON——它把最终答案当 plain stdout 打出，部分 provider 失败也
// 是 plain text/日志行。分类器据 stdout/stderr 形状判 text / error(timeout|missing_model)
// / empty。真实 agy 1.0.x 文本形状（非 mock 协议），无占位。

import { describe, it, expect } from 'vitest';
import { classifyAntigravityCliPlainText } from '@choco/api/providers/antigravity/antigravity-parser';

describe('classifyAntigravityCliPlainText (unit)', () => {
  it('plain reply text → kind text, content trimmed', () => {
    const r = classifyAntigravityCliPlainText({ stdout: '  1 + 1 = 2。\n' });
    expect(r.kind).toBe('text');
    if (r.kind === 'text') {
      expect(r.content).toBe('1 + 1 = 2。');
    }
  });

  it('multi-line reply keeps internal newlines (only outer whitespace trimmed)', () => {
    const r = classifyAntigravityCliPlainText({ stdout: '第一行\n第二行\n' });
    expect(r.kind).toBe('text');
    if (r.kind === 'text') {
      expect(r.content).toBe('第一行\n第二行');
    }
  });

  it('empty stdout → kind empty', () => {
    expect(classifyAntigravityCliPlainText({ stdout: '' }).kind).toBe('empty');
  });

  it('whitespace-only stdout → kind empty', () => {
    expect(classifyAntigravityCliPlainText({ stdout: '   \n\t ' }).kind).toBe('empty');
  });

  it('strips the fresh-conversation "not found" warning prefix before classifying', () => {
    const stdout = 'Warning: conversation "agy-abc123" not found.\n真正的回答在这里。';
    const r = classifyAntigravityCliPlainText({ stdout });
    expect(r.kind).toBe('text');
    if (r.kind === 'text') {
      expect(r.content).toBe('真正的回答在这里。');
    }
  });

  it('strips the warning even without a trailing period (version tolerance)', () => {
    const stdout = 'Warning: conversation "agy-xyz" not found\n回答。';
    const r = classifyAntigravityCliPlainText({ stdout });
    expect(r.kind).toBe('text');
    if (r.kind === 'text') {
      expect(r.content).toBe('回答。');
    }
  });

  it('print-timeout text → kind error/timeout (agy may still exit 0)', () => {
    const r = classifyAntigravityCliPlainText({ stdout: 'Error: timed out waiting for response' });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') {
      expect(r.errorKind).toBe('timeout');
    }
  });

  it('missing-model diagnostic (neither PlanModel nor RequestedModel) → kind error/missing_model', () => {
    const r = classifyAntigravityCliPlainText({
      stdout: 'Error: failed to construct executor: neither PlanModel nor RequestedModel specified',
    });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') {
      expect(r.errorKind).toBe('missing_model');
      expect(r.error).toMatch(/\/model/); // 提示用户去 agy 交互选模型
    }
  });

  it('missing-model diagnostic (Please use the /model command) → kind error/missing_model', () => {
    const r = classifyAntigravityCliPlainText({ stdout: 'Error: Please use the /model command first' });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') {
      expect(r.errorKind).toBe('missing_model');
    }
  });

  it('missing-model diagnostic carried on stderr (stdout empty) → kind error/missing_model', () => {
    const r = classifyAntigravityCliPlainText({
      stdout: '',
      stderr: 'Error: neither PlanModel nor RequestedModel specified',
    });
    expect(r.kind).toBe('error');
    if (r.kind === 'error') {
      expect(r.errorKind).toBe('missing_model');
    }
  });

  it('resumed turn still classifies plain text as text (we ignore Clowder textMode:replace)', () => {
    const r = classifyAntigravityCliPlainText({ stdout: '续接回答。', resumed: true });
    expect(r.kind).toBe('text');
    if (r.kind === 'text') {
      expect(r.content).toBe('续接回答。');
    }
  });
});
