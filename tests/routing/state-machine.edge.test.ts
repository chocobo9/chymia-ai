// tests/routing/state-machine.edge.test.ts
// M4 QA — independent edge + adversarial gate for MultiMentionStateMachine.
// Targets illegal-transition rejection, terminal locking, aggregate severity
// ordering (failed > timeout > done), and untracked/empty edge cases.

import { describe, test, expect } from 'vitest';
import { MultiMentionStateMachine } from '@choco/api/routing/state-machine';
import { CLAUDE, CODEX } from './helpers';

describe('MultiMentionStateMachine — edge', () => {
  test('(edge) pending → done is illegal (must pass through running)', () => {
    const sm = new MultiMentionStateMachine([CLAUDE]);
    expect(() => sm.markDone(CLAUDE)).toThrow(/illegal transition/);
  });

  test('(edge) pending → partial is illegal', () => {
    const sm = new MultiMentionStateMachine([CLAUDE]);
    expect(() => sm.markPartial(CLAUDE)).toThrow(/illegal transition/);
  });

  test('(edge) a terminal state cannot transition again (done → running)', () => {
    const sm = new MultiMentionStateMachine([CLAUDE]);
    sm.markRunning(CLAUDE);
    sm.markDone(CLAUDE);
    expect(() => sm.markRunning(CLAUDE)).toThrow(/illegal transition/);
  });

  test('(edge) aggregate is timeout when one timed out and none failed', () => {
    const sm = new MultiMentionStateMachine([CLAUDE, CODEX]);
    sm.markRunning(CLAUDE);
    sm.markDone(CLAUDE);
    sm.markRunning(CODEX);
    sm.markTimeout(CODEX);
    expect(sm.isSettled()).toBe(true);
    expect(sm.aggregate()).toBe('timeout');
  });

  test('(edge) failed outranks timeout in the aggregate roll-up', () => {
    const sm = new MultiMentionStateMachine([CLAUDE, CODEX]);
    sm.markRunning(CLAUDE);
    sm.markTimeout(CLAUDE);
    sm.markRunning(CODEX);
    sm.markFailed(CODEX);
    expect(sm.aggregate()).toBe('failed');
  });

  test('(edge) running may go directly to timeout or to failed', () => {
    const a = new MultiMentionStateMachine([CLAUDE]);
    a.markRunning(CLAUDE);
    expect(() => a.markTimeout(CLAUDE)).not.toThrow();

    const b = new MultiMentionStateMachine([CODEX]);
    b.markRunning(CODEX);
    expect(() => b.markFailed(CODEX)).not.toThrow();
  });
});

describe('MultiMentionStateMachine — adversarial', () => {
  test('(adversarial) transitioning an untracked agent throws', () => {
    const sm = new MultiMentionStateMachine([CLAUDE]);
    expect(() => sm.markRunning(CODEX)).toThrow(/not a tracked target/);
  });

  test('(adversarial) an empty target set is vacuously settled', () => {
    const sm = new MultiMentionStateMachine([]);
    expect(sm.isSettled()).toBe(true);
    expect(sm.aggregate()).toBe('done');
    expect(sm.entries()).toEqual([]);
  });

  test('(adversarial) marking done twice throws (terminal has no outgoing edges)', () => {
    const sm = new MultiMentionStateMachine([CLAUDE]);
    sm.markRunning(CLAUDE);
    sm.markDone(CLAUDE);
    expect(() => sm.markDone(CLAUDE)).toThrow(/illegal transition/);
  });
});
