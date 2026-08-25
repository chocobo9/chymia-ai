import { describe, it, expect } from 'vitest';
import type { InvocationContext } from '@choco/shared';
import {
  buildSystemPrompt,
  buildStaticIdentity,
  buildInvocationContext,
} from '@choco/api/context/system-prompt-builder';
import { CLAUDE, CODEX, GEMINI, resolveConfig } from './fixtures';

/**
 * M7 dev happy-path suite (unit). QA owns edge + adversarial coverage.
 * buildSystemPrompt is a pure function over an injected config resolver.
 */
describe('buildSystemPrompt (unit, happy path)', () => {
  function serialContext(overrides: Partial<InvocationContext> = {}): InvocationContext {
    return {
      agentId: CLAUDE,
      mode: 'serial',
      chainIndex: 1,
      chainTotal: 2,
      teammates: [CODEX, GEMINI],
      mcpAvailable: true,
      a2aEnabled: true,
      ...overrides,
    };
  }

  it('output contains identity, teammates, and restrictions', () => {
    const prompt = buildSystemPrompt(serialContext(), resolveConfig);

    // Identity
    expect(prompt).toContain('Claude');
    expect(prompt).toContain('Anthropic');
    expect(prompt).toContain('架构设计与核心实现');
    // Restrictions (current agent's hard limits)
    expect(prompt).toContain('禁止直接合并到 main');
    // Teammate roster: teammate display names + a teammate restriction
    expect(prompt).toContain('队友名册');
    expect(prompt).toContain('Codex');
    expect(prompt).toContain('@codex');
    expect(prompt).toContain('禁止写产品需求文档');
  });

  it('serial chain position and SOP hint surface in the invocation context', () => {
    const dyn = buildInvocationContext(
      serialContext({ sopStageHint: 'impl → 先写测试再实现' }),
      resolveConfig,
    );
    expect(dyn).toContain('第 1/2 个');
    expect(dyn).toContain('SOP: impl → 先写测试再实现');
  });

  it('parallel mode and critique tag change the dynamic block', () => {
    const dyn = buildInvocationContext(
      serialContext({ mode: 'parallel', chainIndex: undefined, chainTotal: undefined, promptTags: ['critique'] }),
      resolveConfig,
    );
    expect(dyn).toContain('并行');
    expect(dyn).toContain('批判性分析');
  });

  it('directMessageFrom names the A2A sender', () => {
    const dyn = buildInvocationContext(serialContext({ directMessageFrom: CODEX }), resolveConfig);
    expect(dyn).toContain('Direct message from');
    expect(dyn).toContain('Codex');
  });

  it('static identity alone returns identity + roster without invocation block', () => {
    const staticPart = buildStaticIdentity(CLAUDE, [CODEX, GEMINI], resolveConfig);
    expect(staticPart).toContain('Claude');
    expect(staticPart).toContain('队友名册');
    expect(staticPart).not.toContain('当前模式');
  });

  it('returns empty string for an unknown agent', () => {
    const unknown = buildSystemPrompt(
      serialContext({ agentId: CODEX, teammates: [] }),
      () => undefined,
    );
    expect(unknown).toBe('');
  });
});
