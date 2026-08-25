// tests/context/reviewer-section.test.ts
// P0-3 cut 2 — reviewer section (F032).
//
// Aligned-To: reference/clowder-ai-main/.../context/SystemPromptBuilder.ts (:901)
//   buildReviewerSection — peer-reviewer teammates, cross-family preferred.
//   Here family = clientId (cross-provider review = independent perspective); lead /
//   reviewPolicy simplified (this repo has neither). Pure function — unit-tested.

import { describe, test, expect } from 'vitest';
import type { AgentConfig, AgentId } from '@choco/shared';
import { createAgentId } from '@choco/shared';
import {
  buildReviewerSection,
  buildSystemPrompt,
  type ReviewerDeps,
} from '@choco/api/context/system-prompt-builder';

function cfg(id: string, clientId: AgentConfig['clientId'], roles?: readonly string[]): AgentConfig {
  return {
    id: createAgentId(id),
    name: id,
    displayName: id,
    clientId,
    defaultModel: 'm',
    mcpSupport: false,
    mentionPatterns: [`@${id}`],
    personality: '',
    roleDescription: '',
    ...(roles ? { roles } : {}),
    color: { primary: '#000', secondary: '#000' },
  };
}

const CLAUDE = createAgentId('claude-opus');
const CODEX = createAgentId('codex-gpt');
const GEMINI = createAgentId('gemini-pro');
const RELAY = createAgentId('claude-opus-relay');

const configs = new Map<string, AgentConfig>([
  ['claude-opus', cfg('claude-opus', 'anthropic', ['peer-reviewer'])],
  ['codex-gpt', cfg('codex-gpt', 'openai', ['peer-reviewer'])],
  ['gemini-pro', cfg('gemini-pro', 'google', ['peer-reviewer'])],
  ['claude-opus-relay', cfg('claude-opus-relay', 'anthropic')], // no peer-reviewer role
]);
const resolveConfig = (id: AgentId): AgentConfig | undefined => configs.get(id as string);
const allAgentIds = [CLAUDE, CODEX, GEMINI, RELAY];
const allAvailable: ReviewerDeps = { allAgentIds, isAvailable: () => true };

describe('buildReviewerSection (F032)', () => {
  test('lists cross-provider peer-reviewers; excludes self + the role-less relay cat', () => {
    const section = buildReviewerSection(CLAUDE, allAvailable, resolveConfig);
    expect(section).toContain('## 你的 Reviewers');
    expect(section).toContain('@codex'); // openai — cross-provider
    expect(section).toContain('@gemini'); // google — cross-provider
    expect(section).not.toContain('@claude-opus '); // self excluded (space guards prefix)
    expect(section).not.toContain('@claude-opus-relay'); // no peer-reviewer role
  });

  test('cross-provider reviewers chosen (no same-provider fallback note)', () => {
    const section = buildReviewerSection(CLAUDE, allAvailable, resolveConfig);
    expect(section).not.toContain('fallback');
  });

  test('an unavailable reviewer is listed separately', () => {
    const deps: ReviewerDeps = { allAgentIds, isAvailable: (id) => id !== CODEX };
    const section = buildReviewerSection(CLAUDE, deps, resolveConfig);
    expect(section).toContain('不可用');
    expect(section).toContain('@codex'); // codex in the unavailable bucket
    expect(section).toContain('@gemini'); // gemini still an available reviewer
  });

  test('no peer-reviewers in the roster → null', () => {
    const noRole = new Map<string, AgentConfig>([
      ['claude-opus', cfg('claude-opus', 'anthropic')],
      ['codex-gpt', cfg('codex-gpt', 'openai')],
    ]);
    const section = buildReviewerSection(
      CLAUDE,
      { allAgentIds: [CLAUDE, CODEX], isAvailable: () => true },
      (id) => noRole.get(id as string),
    );
    expect(section).toBeNull();
  });
});

describe('buildSystemPrompt with reviewerDeps', () => {
  const baseCtx = { agentId: CLAUDE, mode: 'serial' as const, teammates: [], mcpAvailable: false };

  test('injects the reviewer section when reviewerDeps is provided', () => {
    const prompt = buildSystemPrompt(baseCtx, resolveConfig, allAvailable);
    expect(prompt).toContain('## 你的 Reviewers');
  });

  test('omits the reviewer section without reviewerDeps (back-compat)', () => {
    const prompt = buildSystemPrompt(baseCtx, resolveConfig);
    expect(prompt).not.toContain('## 你的 Reviewers');
  });
});
