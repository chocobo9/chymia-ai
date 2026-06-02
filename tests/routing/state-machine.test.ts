// tests/routing/state-machine.test.ts
// M4 DEV happy-path: MultiMentionStateMachine lifecycle + aggregate roll-up.

import { describe, test, expect } from 'vitest';
import { MultiMentionStateMachine } from '@choco/api/routing/state-machine';
import { CLAUDE, CODEX } from './helpers';

describe('MultiMentionStateMachine — happy path (unit)', () => {
  test('targets start pending; aggregate is pending', () => {
    const sm = new MultiMentionStateMachine([CLAUDE, CODEX]);
    expect(sm.getState(CLAUDE)).toBe('pending');
    expect(sm.aggregate()).toBe('pending');
  });

  test('pending → running → partial → done full path', () => {
    const sm = new MultiMentionStateMachine([CLAUDE]);
    sm.markRunning(CLAUDE);
    expect(sm.aggregate()).toBe('running');
    sm.markPartial(CLAUDE);
    sm.markDone(CLAUDE);
    expect(sm.getState(CLAUDE)).toBe('done');
    expect(sm.isSettled()).toBe(true);
    expect(sm.aggregate()).toBe('done');
  });

  test('aggregate is running while any target is still active', () => {
    const sm = new MultiMentionStateMachine([CLAUDE, CODEX]);
    sm.markRunning(CLAUDE);
    sm.markDone(CLAUDE);
    // codex still pending → overall running.
    expect(sm.aggregate()).toBe('running');
    sm.markRunning(CODEX);
    sm.markDone(CODEX);
    expect(sm.aggregate()).toBe('done');
  });

  test('terminal roll-up prioritises failed over done', () => {
    const sm = new MultiMentionStateMachine([CLAUDE, CODEX]);
    sm.markRunning(CLAUDE);
    sm.markDone(CLAUDE);
    sm.markFailed(CODEX);
    expect(sm.isSettled()).toBe(true);
    expect(sm.aggregate()).toBe('failed');
  });
});
