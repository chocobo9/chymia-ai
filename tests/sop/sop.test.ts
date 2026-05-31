import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { createAgentId } from '@clowder/shared';
import { loadSopDefinition } from '@clowder/api/sop/sop-loader';
import { SopServiceImpl } from '@clowder/api/sop/sop-service';
import { evaluateEnvCheck } from '@clowder/api/sop/predicates/env-check';

const DEV_SOP = resolve(process.cwd(), 'sop/development.yaml');
const CLAUDE = createAgentId('claude-opus');
const CODEX = createAgentId('codex-gpt');

describe('loadSopDefinition (happy path)', () => {
  it('loads development.yaml with 5 stages and hard_rules + pitfalls', () => {
    const def = loadSopDefinition(DEV_SOP);
    expect(def.id).toBe('development');
    expect(def.stages).toHaveLength(5);
    expect(def.stages.map((s) => s.id)).toEqual([
      'kickoff',
      'impl',
      'quality_gate',
      'review',
      'merge',
    ]);
    for (const stage of def.stages) {
      expect(stage.hardRules.length).toBeGreaterThan(0);
      expect(stage.pitfalls.length).toBeGreaterThan(0);
    }
  });
});

describe('SopServiceImpl (happy path)', () => {
  const service = new SopServiceImpl(DEV_SOP);

  it('getStageHint returns label and suggested skill for impl', () => {
    const hint = service.getStageHint('impl');
    expect(hint).toContain('实现');
    expect(hint).toContain('writing-plans');
  });

  it('getSuggestedSkill returns merge-gate for merge stage', () => {
    expect(service.getSuggestedSkill('merge')).toBe('merge-gate');
  });

  it('git_state_predicate passes when ahead=0 behind=0', () => {
    const result = service.evaluateTrace('impl', {
      agentId: CLAUDE,
      threadId: 'thread-todo-api',
      responseContent: '准备开 worktree',
      context: { commands: ['git worktree add ../feat-todo'], gitAhead: 0, gitBehind: 0 },
    });
    expect(result.violations.some((v) => v.ruleId === 'impl-main-sync-before-worktree')).toBe(false);
    expect(result.passed.some((p) => p.ruleId === 'impl-main-sync-before-worktree')).toBe(true);
  });

  it('git_state_predicate fails when ahead=1', () => {
    const result = service.evaluateTrace('impl', {
      agentId: CLAUDE,
      threadId: 'thread-todo-api',
      responseContent: '直接开 worktree',
      context: { commands: ['git worktree add ../feat-todo'], gitAhead: 1, gitBehind: 0 },
    });
    const v = result.violations.find((x) => x.ruleId === 'impl-main-sync-before-worktree');
    expect(v?.severity).toBe('blocker');
  });

  it('handle_check blocks self-review (same reviewer and author)', () => {
    const result = service.evaluateTrace('review', {
      agentId: CLAUDE,
      threadId: 'thread-todo-api',
      responseContent: '我自己 review 过了',
      context: { commands: [], authorId: CLAUDE as string, reviewerId: CLAUDE as string },
    });
    expect(result.violations.some((v) => v.ruleId === 'review-no-self-review')).toBe(true);
  });

  it('handle_check passes when reviewer differs from author', () => {
    const result = service.evaluateTrace('review', {
      agentId: CLAUDE,
      threadId: 'thread-todo-api',
      responseContent: '请 codex review',
      context: { commands: [], authorId: CLAUDE as string, reviewerId: CODEX as string },
    });
    expect(result.passed.some((p) => p.ruleId === 'review-no-self-review')).toBe(true);
  });

  it('evaluateTrace returns blocker violation for missing test command at quality_gate', () => {
    const result = service.evaluateTrace('quality_gate', {
      agentId: CLAUDE,
      threadId: 'thread-todo-api',
      responseContent: '开发完成，未跑测试',
      context: { commands: ['git status'] },
    });
    expect(result.violations.some((v) => v.ruleId === 'quality-gate-full-test-evidence')).toBe(true);
  });
});

describe('evaluateEnvCheck (happy path)', () => {
  it('passes when REDIS_URL uses port 6398 and excludes 6399', () => {
    const outcome = evaluateEnvCheck(
      { REDIS_URL: 'redis://127.0.0.1:6398/0' },
      { key: 'REDIS_URL', mustInclude: ':6398', mustNotInclude: ':6399' },
    );
    expect(outcome.status).toBe('pass');
  });
});
