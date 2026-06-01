// MonitorGrid (并行监看) — a full-screen overlay of per-agent live monitor panes.
//
// LIVE: one pane per roster agent, each reflecting its live status from the agent
// store (the dot/label/border flip as agent_status frames arrive — identical
// source to the right-column StatusBar). The "now" line shows the agent's live
// streaming text (from the chat store) for the active thread when present;
// otherwise an honest "—" placeholder. ConnStrip is LIVE (GET /health + socket).
//
// HONEST PLACEHOLDER: the summary cell's token quota has no backend source, so we
// render the design's STRUCTURE but clearly mark it 未接入 instead of fabricating
// "128k / 500k". The flow chain is built from the LIVE roster order.
//
// Ported visual from choco-panels.jsx MonitorGrid + directions.css `.monitor`.

import { useMemo, type ReactElement } from 'react';
import type { AgentStatus } from '@clowder/shared';
import { useAgentStore } from '../../stores/agent-store.js';
import { useChatStore } from '../../stores/chat-store.js';
import type { AgentRosterEntry } from '../../lib/api.js';
import type { HealthInfo } from '../../hooks/useHealth.js';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss.js';
import { Avatar, StatusDot, statusPresentation, shortName, modelBadge } from '../choco/primitives.js';
import { IconClose, IconFlow } from '../choco/icons.js';
import { ConnStrip } from './ConnStrip.js';

export interface MonitorGridProps {
  readonly onClose: () => void;
  readonly health: HealthInfo;
  readonly socketConnected: boolean;
}

interface MonCellData {
  readonly entry: AgentRosterEntry;
  readonly status: AgentStatus;
  readonly now: string;
}

interface MonCellProps {
  readonly data: MonCellData;
}

function MonCell({ data }: MonCellProps): ReactElement {
  const { entry, status, now } = data;
  const presentation = statusPresentation(status);
  return (
    <div
      className="mon-cell"
      data-testid="mon-cell"
      data-agent={entry.id}
      data-status={status}
      style={{ '--ac': entry.color.primary } as React.CSSProperties}
    >
      <div className="mon-top">
        <Avatar agentId={entry.id} name={entry.displayName} accent={entry.color.primary} small />
        <div className="mon-id">
          <b>{shortName(entry)}</b>
          <span>{modelBadge(entry)}</span>
        </div>
        <span className="mon-st" style={{ color: presentation.color }}>
          <StatusDot status={status} />
          {presentation.label}
        </span>
      </div>
      <div className="mon-now">{now}</div>
    </div>
  );
}

/** Per-agent live monitor grid overlay. */
export function MonitorGrid(props: MonitorGridProps): ReactElement {
  const { onClose, health, socketConnected } = props;
  const roster = useAgentStore((s) => s.roster);
  const statusById = useAgentStore((s) => s.statusById);
  const activeThreadId = useChatStore((s) => s.activeThreadId);
  const streamingByThread = useChatStore((s) => s.streamingByThread);

  useOverlayDismiss(true, onClose);

  const cells = useMemo<readonly MonCellData[]>(() => {
    const streaming = activeThreadId === null ? [] : streamingByThread[activeThreadId] ?? [];
    return roster.map((entry) => {
      const status = statusById[entry.id] ?? entry.status;
      const live = streaming.find((s) => (s.agentId as string) === entry.id);
      const liveText = live?.text.trim() ?? '';
      const now = liveText.length > 0 ? liveText.split('\n')[0].slice(0, 80) : '—';
      return { entry, status, now };
    });
  }, [roster, statusById, activeThreadId, streamingByThread]);

  const activeCount = cells.filter((c) => c.status === 'working' || c.status === 'thinking').length;

  return (
    <div className="overlay" data-testid="monitor-grid-scrim" onClick={onClose}>
      <div
        className="monitor"
        data-testid="monitor-grid"
        role="dialog"
        aria-modal="true"
        aria-label="并行监看"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="monitor-h">
          <div className="monitor-t">
            并行监看
            <span>
              {roster.length} agents · {activeCount} active
            </span>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭并行监看">
            <IconClose />
          </button>
        </div>

        <ConnStrip health={health} socketConnected={socketConnected} />

        <div className="mon-grid">
          {cells.map((c) => (
            <MonCell key={c.entry.id} data={c} />
          ))}
          {cells.length === 0 && (
            <div className="mon-empty" data-testid="monitor-grid-empty">
              尚未加载 agent 名册。
            </div>
          )}
          <div className="mon-cell summary">
            <div className="mon-sum-h">协作链</div>
            <div className="mon-sum-task">
              {roster.length > 0 ? '当前团队流转' : '尚无 agent'}
            </div>
            <div className="mon-flow">
              {roster.map((entry, i) => (
                <span key={entry.id} style={{ display: 'contents' }}>
                  <span
                    className="flow-step"
                    style={{ '--ac': entry.color.primary } as React.CSSProperties}
                  >
                    {shortName(entry)}
                  </span>
                  {i < roster.length - 1 && (
                    <span className="flow-arrow" aria-hidden="true">
                      <IconFlow />
                    </span>
                  )}
                </span>
              ))}
            </div>
            <div className="mon-sum-quota">
              <div className="q-row">
                <span>今日 token</span>
                <b data-testid="monitor-quota-placeholder">未接入</b>
              </div>
              <div className="quota-bar">
                <i style={{ width: '0%' }} />
              </div>
              <div className="mon-placeholder">用量统计尚未接入后端，即将上线。</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
