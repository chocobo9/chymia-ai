// M12 QA — edge/adversarial gate for SOP module.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createAgentId } from '@choco/shared';
import { loadSopDefinition } from '@choco/api/sop/sop-loader';
import { SopServiceImpl } from '@choco/api/sop/sop-service';
import { evaluateEnvCheck } from '@choco/api/sop/predicates/env-check';
import { evaluateTrace } from '@choco/api/sop/trace-evaluator';

const CLAUDE = createAgentId('claude-opus');

describe('loadSopDefinition (edge)', () => {
  it('rejects YAML with an unknown predicate type', () => {
    const dir = mkdtempSync(join(tmpdir(), 'm12-sop-'));
    const path = join(dir, 'bad.yaml');
    writeFileSync(
      path,
      `id: x
domain: d
label: L
stages:
  - id: s1
    label: S
    hard_rules:
      - id: r1
        text: t
        severity: blocker
        predicate:
          type: sha_dedup
          scope: cloud
    pitfalls: []
`,
      'utf-8',
    );
    expect(() => loadSopDefinition(path)).toThrow();
  });

  it('rejects git_state_predicate with an empty checks array', () => {
    const dir = mkdtempSync(join(tmpdir(), 'm12-sop-'));
    const path = join(dir, 'bad.yaml');
    writeFileSync(
      path,
      `id: x
domain: d
label: L
stages:
  - id: s1
    label: S
    hard_rules:
      - id: r1
        text: t
        severity: blocker
        predicate:
          type: git_state_predicate
          checks: []
    pitfalls: []
`,
      'utf-8',
    );
    expect(() => loadSopDefinition(path)).toThrow();
  });
});

describe('SopServiceImpl (edge)', () => {
  it('getStageHint returns empty string for unknown stage id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'm12-sop-'));
    const path = join(dir, 'mini.yaml');
    writeFileSync(
      path,
      `id: mini
domain: d
label: Mini
stages:
  - id: only
    label: Only
    hard_rules:
      - id: r1
        text: rule
        severity: warn
        predicate: { type: manual_only, reason: manual }
    pitfalls:
      - id: p1
        text: pit
        severity: warn
        predicate: { type: manual_only, reason: manual }
`,
      'utf-8',
    );
    expect(new SopServiceImpl(path).getStageHint('missing')).toBe('');
  });

  it('evaluateTrace on unknown stage returns empty result buckets', () => {
    const dir = mkdtempSync(join(tmpdir(), 'm12-sop-'));
    const path = join(dir, 'mini.yaml');
    writeFileSync(
      path,
      `id: mini
domain: d
label: Mini
stages:
  - id: only
    label: Only
    hard_rules:
      - id: r1
        text: rule
        severity: warn
        predicate: { type: manual_only, reason: manual }
    pitfalls:
      - id: p1
        text: pit
        severity: warn
        predicate: { type: manual_only, reason: manual }
`,
      'utf-8',
    );
    const svc = new SopServiceImpl(path);
    const result = svc.evaluateTrace('unknown', {
      agentId: CLAUDE,
      threadId: 't1',
      responseContent: '',
      context: { commands: [] },
    });
    expect(result).toEqual({ violations: [], passed: [], skipped: [] });
  });
});

describe('evaluateEnvCheck (edge)', () => {
  it('fails when the env key is unset', () => {
    expect(evaluateEnvCheck({}, { key: 'REDIS_URL' }).status).toBe('violation');
  });

  it('fails when mustNotInclude substring is present', () => {
    const outcome = evaluateEnvCheck(
      { REDIS_URL: 'redis://127.0.0.1:6399/0' },
      { key: 'REDIS_URL', mustNotInclude: ':6399' },
    );
    expect(outcome.status).toBe('violation');
  });
});

describe('M12 SOP (adversarial)', () => {
  it('command_pattern accepts alternation patterns (vitest|pnpm test)', () => {
    const def = loadSopDefinition(
      (() => {
        const dir = mkdtempSync(join(tmpdir(), 'm12-sop-'));
        const path = join(dir, 'cmd.yaml');
        writeFileSync(
          path,
          `id: cmd
domain: d
label: Cmd
stages:
  - id: q
    label: Q
    hard_rules:
      - id: need-test
        text: need tests
        severity: blocker
        predicate:
          type: command_pattern
          must_match: vitest run|pnpm test
    pitfalls:
      - id: p1
        text: p
        severity: warn
        predicate: { type: manual_only, reason: m }
`,
          'utf-8',
        );
        return path;
      })(),
    );
    const result = evaluateTrace(
      'q',
      {
        agentId: CLAUDE,
        threadId: 't',
        responseContent: '',
        context: { commands: ['npx vitest run tests/sop/'] },
      },
      def,
    );
    expect(result.passed.some((p) => p.ruleId === 'need-test')).toBe(true);
  });

  it('manual_only rules are always skipped, never passed or violated', () => {
    const dir = mkdtempSync(join(tmpdir(), 'm12-sop-'));
    const path = join(dir, 'manual.yaml');
    writeFileSync(
      path,
      `id: manual
domain: d
label: M
stages:
  - id: s
    label: S
    hard_rules:
      - id: human
        text: human gate
        severity: blocker
        predicate: { type: manual_only, reason: needs human }
    pitfalls:
      - id: p1
        text: p
        severity: warn
        predicate: { type: manual_only, reason: m }
`,
      'utf-8',
    );
    const result = new SopServiceImpl(path).evaluateTrace('s', {
      agentId: CLAUDE,
      threadId: 't',
      responseContent: '',
      context: { commands: [] },
    });
    expect(result.skipped.some((s) => s.ruleId === 'human')).toBe(true);
    expect(result.passed).toHaveLength(0);
    expect(result.violations).toHaveLength(0);
  });
});
