// M7 QA — system-prompt-builder edge/adversarial gate. Probes unknown-agent guards,
// hard restrictions, teammate roster filtering, and every InvocationContext branch
// (serial/parallel, ping-pong, direct message, cross-thread, routing feedback, SOP).
// dev≠QA.

import { describe, it, expect } from 'vitest';
import type { InvocationContext } from '@choco/shared';
import { createAgentId } from '@choco/shared';
import {
  buildInvocationContext,
  buildStaticIdentity,
  buildSystemPrompt,
} from '@choco/api/context/system-prompt-builder';
import { BASE_TS, CLAUDE, CODEX, resolveConfig } from './fixtures';

const UNKNOWN = createAgentId('ghost-agent');

function ctx(over: Partial<InvocationContext>): InvocationContext {
  return {
    agentId: CLAUDE,
    mode: 'independent',
    teammates: [CODEX],
    mcpAvailable: true,
    ...over,
  };
}

describe('buildStaticIdentity (edge)', () => {
  it('returns "" for an unknown agent (no config to anchor on)', () => {
    expect(buildStaticIdentity(UNKNOWN, [CODEX], resolveConfig)).toBe('');
  });

  it('declares the agent hard restrictions inline', () => {
    const out = buildStaticIdentity(CLAUDE, [CODEX], resolveConfig);
    expect(out).toContain('禁止直接合并到 main');
  });

  it('builds a teammate roster excluding self and unknown teammates', () => {
    const out = buildStaticIdentity(CLAUDE, [CLAUDE, CODEX, UNKNOWN], resolveConfig);
    expect(out).toContain('队友名册');
    expect(out).toContain('缅因猫'); // CODEX present as a teammate row
    // Self (布偶猫) appears only in the identity line, never as a teammate row.
    expect((out.match(/布偶猫/g) ?? []).length).toBe(1);
    expect(out).not.toContain('ghost-agent'); // unknown teammate skipped
  });
});

describe('buildInvocationContext (edge)', () => {
  it('renders serial chain position', () => {
    const out = buildInvocationContext(ctx({ mode: 'serial', chainIndex: 2, chainTotal: 3 }), resolveConfig);
    expect(out).toContain('当前模式：串行');
    expect(out).toContain('第 2/3 个');
  });

  it('renders parallel mode guidance', () => {
    const out = buildInvocationContext(ctx({ mode: 'parallel' }), resolveConfig);
    expect(out).toContain('当前模式：并行');
  });

  it('renders a ping-pong warning', () => {
    const out = buildInvocationContext(ctx({ pingPongWarning: { pairedWith: CODEX, count: 4 } }), resolveConfig);
    expect(out).toContain('🏓');
    expect(out).toContain('缅因猫');
    expect(out).toContain('4');
  });

  it('renders a direct message from another agent', () => {
    const out = buildInvocationContext(ctx({ directMessageFrom: CODEX }), resolveConfig);
    expect(out).toContain('Direct message from');
    expect(out).toContain('缅因猫');
  });

  it('renders the SOP stage hint', () => {
    const out = buildInvocationContext(ctx({ sopStageHint: 'impl: 写代码阶段' }), resolveConfig);
    expect(out).toContain('SOP: impl: 写代码阶段');
  });

  it('renders cross-thread, mention-routing feedback, and active participants', () => {
    const out = buildInvocationContext(
      ctx({
        crossThreadReplyHint: { sourceThreadId: 'thread-2', senderCatId: 'codex-gpt' },
        mentionRoutingFeedback: { items: [{ targetCatId: 'codex-gpt' }] },
        activeParticipants: [{ catId: 'codex-gpt', lastMessageAt: BASE_TS }],
      }),
      resolveConfig,
    );
    expect(out).toContain('📨 跨线程消息');
    expect(out).toContain('[路由提醒]');
    expect(out).toContain('最近活跃：@codex-gpt');
  });
});

describe('buildSystemPrompt (edge)', () => {
  it('combines static identity with the dynamic invocation block', () => {
    const out = buildSystemPrompt(ctx({ mode: 'serial', chainIndex: 1, chainTotal: 2 }), resolveConfig);
    expect(out).toContain('布偶猫'); // identity
    expect(out).toContain('当前模式：串行'); // dynamic
  });
});

describe('system-prompt-builder (adversarial)', () => {
  it('does not render a direct-message line when the sender is the agent itself', () => {
    const out = buildInvocationContext(ctx({ directMessageFrom: CLAUDE }), resolveConfig);
    expect(out).not.toContain('Direct message from');
  });

  it('emits no roster when there are no teammates', () => {
    const out = buildStaticIdentity(CLAUDE, [], resolveConfig);
    expect(out).not.toContain('队友名册');
  });

  it('returns "" from buildInvocationContext for an unknown agent', () => {
    expect(buildInvocationContext(ctx({ agentId: UNKNOWN }), resolveConfig)).toBe('');
  });
});
