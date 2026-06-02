// M9 agent store — Zustand state for the agent roster (from GET /api/agents)
// and live runtime status driven by the `agent_status` socket event (G7).
//
// The roster is the static AgentConfig-derived list (id/name/color/mentions).
// `statusById` is the live AgentStatus per agent, updated from AgentState
// payloads: server emits 'working' when an agent starts its turn and 'idle'
// when it ends. Updates are immutable (new map each time).

import { create } from 'zustand';
import type { AgentId, AgentState, AgentStatus } from '@choco/shared';
import type { AgentRosterEntry } from '../lib/api.js';

interface AgentStoreState {
  /** Static roster from GET /api/agents. */
  readonly roster: readonly AgentRosterEntry[];
  /** Live status per agent id (overrides the roster baseline). */
  readonly statusById: Readonly<Record<string, AgentStatus>>;

  setRoster(roster: readonly AgentRosterEntry[]): void;
  /** Apply an `agent_status` (AgentState) frame from the socket. */
  applyAgentStatus(state: AgentState): void;
}

export const useAgentStore = create<AgentStoreState>((set) => ({
  roster: [],
  statusById: {},

  setRoster: (roster) =>
    set((state) => {
      // Seed statuses from the roster baseline, preserving any live status
      // we've already received for an agent.
      const statusById: Record<string, AgentStatus> = { ...state.statusById };
      for (const entry of roster) {
        if (statusById[entry.id] === undefined) statusById[entry.id] = entry.status;
      }
      return { roster, statusById };
    }),

  applyAgentStatus: (agentState) =>
    set((state) => ({
      statusById: {
        ...state.statusById,
        [agentState.id as string]: agentState.status,
      },
    })),
}));

/** Read one agent's effective status (defaults to 'offline' if unknown). */
export function selectAgentStatus(
  state: Pick<AgentStoreState, 'statusById'>,
  agentId: AgentId | string,
): AgentStatus {
  return state.statusById[agentId as string] ?? 'offline';
}
