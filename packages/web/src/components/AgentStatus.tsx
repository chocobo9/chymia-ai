// M9 AgentStatus — compact roster of agents with a live status dot per agent.
// Reads the roster + live statuses from the agent store; the dot flips
// idle → working → idle as `agent_status` (AgentState) frames arrive (G7).

import type { ReactElement } from 'react';
import type { AgentStatus as AgentStatusValue } from '@clowder/shared';
import { useAgentStore } from '../stores/agent-store.js';

/** Human-readable label per status (externalized — no inline magic strings). */
const STATUS_LABEL: Readonly<Record<AgentStatusValue, string>> = {
  idle: '空闲',
  thinking: '思考中',
  working: '工作中',
  error: '错误',
  offline: '离线',
};

interface AgentStatusItemProps {
  readonly agentId: string;
  readonly displayName: string;
  readonly status: AgentStatusValue;
  readonly color: string;
}

function AgentStatusItem(props: AgentStatusItemProps): ReactElement {
  const { agentId, displayName, status, color } = props;
  return (
    <li
      className="agent-status__item"
      data-testid="agent-status-item"
      data-agent={agentId}
      data-status={status}
    >
      <span
        className="agent-status__dot"
        data-testid="agent-status-dot"
        style={{ backgroundColor: status === 'idle' ? undefined : color }}
        aria-hidden="true"
      />
      <span className="agent-status__name">{displayName}</span>
      <span className="agent-status__label">{STATUS_LABEL[status]}</span>
    </li>
  );
}

/** Render the live agent status roster. */
export function AgentStatus(): ReactElement {
  const roster = useAgentStore((s) => s.roster);
  const statusById = useAgentStore((s) => s.statusById);

  return (
    <ul className="agent-status" data-testid="agent-status">
      {roster.map((agent) => (
        <AgentStatusItem
          key={agent.id}
          agentId={agent.id}
          displayName={agent.displayName}
          status={statusById[agent.id] ?? agent.status}
          color={agent.color.primary}
        />
      ))}
    </ul>
  );
}
