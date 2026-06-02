// packages/api/src/routing/state-machine.ts
// M4: MultiMentionStateMachine — re-authored from clowder-architecture-design.md §6.4.
//
// Tracks the lifecycle of each target in a multi-mention invocation and an
// aggregate roll-up. State graph (§6.4):
//   pending → running → partial → done
//                     → done
//                     → timeout
//            → failed
//   pending → failed
//
// Transitions are validated; an illegal transition throws so a wiring bug
// surfaces loudly instead of silently corrupting state.

import type { AgentId } from '@choco/shared';

/** Per-target lifecycle state. Source: §6.4. */
export type MentionState =
  | 'pending'
  | 'running'
  | 'partial'
  | 'done'
  | 'timeout'
  | 'failed';

/** States from which no further transition is allowed. */
const TERMINAL_STATES: ReadonlySet<MentionState> = new Set<MentionState>([
  'done',
  'timeout',
  'failed',
]);

/** Allowed transitions per §6.4. */
const ALLOWED_TRANSITIONS: Readonly<Record<MentionState, readonly MentionState[]>> = {
  pending: ['running', 'failed'],
  running: ['partial', 'done', 'timeout', 'failed'],
  partial: ['done', 'timeout', 'failed'],
  done: [],
  timeout: [],
  failed: [],
};

/**
 * Tracks each target's {@link MentionState} for one multi-mention invocation.
 * All targets start `pending`. The aggregate is `pending` until something runs,
 * `running` while any target is active, and a terminal roll-up once all targets
 * settle (failed > timeout > done by severity).
 */
export class MultiMentionStateMachine {
  private readonly states = new Map<AgentId, MentionState>();

  constructor(targets: readonly AgentId[]) {
    for (const target of targets) {
      this.states.set(target, 'pending');
    }
  }

  /** Current state of a target, or undefined if it was never a target. */
  getState(agentId: AgentId): MentionState | undefined {
    return this.states.get(agentId);
  }

  /** All tracked targets with their current state. */
  entries(): ReadonlyArray<readonly [AgentId, MentionState]> {
    return [...this.states.entries()];
  }

  /** Whether every target has reached a terminal state. */
  isSettled(): boolean {
    for (const state of this.states.values()) {
      if (!TERMINAL_STATES.has(state)) {
        return false;
      }
    }
    return true;
  }

  markRunning(agentId: AgentId): void {
    this.transition(agentId, 'running');
  }

  markPartial(agentId: AgentId): void {
    this.transition(agentId, 'partial');
  }

  markDone(agentId: AgentId): void {
    this.transition(agentId, 'done');
  }

  markTimeout(agentId: AgentId): void {
    this.transition(agentId, 'timeout');
  }

  markFailed(agentId: AgentId): void {
    this.transition(agentId, 'failed');
  }

  /**
   * Aggregate roll-up across all targets:
   * - `pending`  — nothing has started
   * - `running`  — at least one target is still active (pending/running/partial)
   * - terminal   — all settled: `failed` if any failed, else `timeout` if any
   *   timed out, else `done`.
   */
  aggregate(): MentionState {
    let sawNonPending = false;
    let sawFailed = false;
    let sawTimeout = false;
    let settled = true;

    for (const state of this.states.values()) {
      if (state !== 'pending') {
        sawNonPending = true;
      }
      if (!TERMINAL_STATES.has(state)) {
        settled = false;
      }
      if (state === 'failed') {
        sawFailed = true;
      } else if (state === 'timeout') {
        sawTimeout = true;
      }
    }

    if (!settled) {
      return sawNonPending ? 'running' : 'pending';
    }
    if (sawFailed) {
      return 'failed';
    }
    if (sawTimeout) {
      return 'timeout';
    }
    return 'done';
  }

  private transition(agentId: AgentId, next: MentionState): void {
    const current = this.states.get(agentId);
    if (current === undefined) {
      throw new Error(
        `MultiMentionStateMachine: '${agentId as string}' is not a tracked target`,
      );
    }
    if (!ALLOWED_TRANSITIONS[current].includes(next)) {
      throw new Error(
        `MultiMentionStateMachine: illegal transition ${current} → ${next} for '${agentId as string}'`,
      );
    }
    this.states.set(agentId, next);
  }
}
