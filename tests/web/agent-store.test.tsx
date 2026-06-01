// @vitest-environment jsdom
//
// M9 agent-store happy-path unit tests: roster seeding + status transitions
// driven by agent_status (AgentState) frames (idle → working → idle).

import '@testing-library/jest-dom';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  useAgentStore,
  selectAgentStatus,
} from '../../packages/web/src/stores/agent-store.js';
import { ROSTER, CLAUDE, CODEX, workingStatus, idleStatus } from './fixtures.js';

function resetStore(): void {
  useAgentStore.setState({ roster: [], statusById: {} });
}

describe('agent-store (unit, happy path)', () => {
  beforeEach(resetStore);

  it('setRoster seeds baseline idle status for every agent', () => {
    useAgentStore.getState().setRoster(ROSTER);
    const state = useAgentStore.getState();
    expect(state.roster).toHaveLength(3);
    expect(selectAgentStatus(state, CLAUDE)).toBe('idle');
    expect(selectAgentStatus(state, CODEX)).toBe('idle');
  });

  it('applyAgentStatus flips an agent idle → working → idle immutably', () => {
    useAgentStore.getState().setRoster(ROSTER);
    const seeded = useAgentStore.getState().statusById;

    useAgentStore.getState().applyAgentStatus(workingStatus(CLAUDE, 'thread_todo_api'));
    const working = useAgentStore.getState();
    expect(working.statusById).not.toBe(seeded);
    expect(selectAgentStatus(working, CLAUDE)).toBe('working');
    // Other agents are untouched.
    expect(selectAgentStatus(working, CODEX)).toBe('idle');

    useAgentStore.getState().applyAgentStatus(idleStatus(CLAUDE, 'thread_todo_api'));
    expect(selectAgentStatus(useAgentStore.getState(), CLAUDE)).toBe('idle');
  });

  it('preserves a live status already received when roster is set later', () => {
    useAgentStore.getState().applyAgentStatus(workingStatus(CODEX, 'thread_todo_api'));
    useAgentStore.getState().setRoster(ROSTER);
    expect(selectAgentStatus(useAgentStore.getState(), CODEX)).toBe('working');
  });

  it('selectAgentStatus defaults to offline for an unknown agent', () => {
    expect(selectAgentStatus(useAgentStore.getState(), 'unknown-agent')).toBe('offline');
  });
});
