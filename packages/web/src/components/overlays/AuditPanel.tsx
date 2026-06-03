// AuditPanel — the per-thread audit timeline (browse + filter). Shows, in time
// order, what each agent did on this thread: its reply outcomes (text size + tool
// count, notices flagged), its tool calls (name + duration), and its session
// boundaries (start / seal). Filterable by agent and by entry type. Reads the
// merged trail from GET /api/audit/thread/:id (tool-event log + replies + sessions);
// a ledger, so it's read-only — the "operation" here is browse/filter.

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import type { AuditEntry, AuditEntryType } from '@choco/shared';
import type { ApiClient, AgentRosterEntry } from '../../lib/api.js';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss.js';
import { IconClose } from '../choco/icons.js';

export interface AuditPanelProps {
  readonly onClose: () => void;
  readonly client: ApiClient;
  readonly threadId: string;
  readonly roster: readonly AgentRosterEntry[];
}

type LoadState = 'loading' | 'loaded' | 'error';

/** Type filter chips (null = all). */
const TYPE_FILTERS: readonly { readonly id: AuditEntryType | 'all'; readonly label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'reply', label: '回复' },
  { id: 'tool', label: '工具' },
  { id: 'session_start', label: '开会话' },
  { id: 'session_seal', label: '封会话' },
];

function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}

/** One-line description of an audit entry (type-specific). */
function describe(entry: AuditEntry): string {
  switch (entry.type) {
    case 'reply':
      return entry.isError === true
        ? `通知 / 错误回复 · ${entry.textChars ?? 0} 字`
        : `回复 · ${entry.textChars ?? 0} 字 · ${entry.toolCount ?? 0} 次工具`;
    case 'tool':
      return `🔧 ${entry.toolName ?? '工具'}${entry.durationMs !== undefined ? ` · ${entry.durationMs}ms` : ''}`;
    case 'session_start':
      return `▶ 开启 session #${entry.sequenceNo ?? '?'}`;
    case 'session_seal':
      return `■ 封存 session #${entry.sequenceNo ?? '?'}`;
  }
}

/** The audit timeline panel. */
export function AuditPanel(props: AuditPanelProps): ReactElement {
  const { onClose, client, threadId, roster } = props;
  const [state, setState] = useState<LoadState>('loading');
  const [entries, setEntries] = useState<readonly AuditEntry[]>([]);
  const [errorMsg, setErrorMsg] = useState('');
  const [agentFilter, setAgentFilter] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<AuditEntryType | 'all'>('all');

  const load = useCallback(async (): Promise<void> => {
    setState('loading');
    try {
      setEntries(await client.getAudit(threadId));
      setState('loaded');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '加载失败');
      setState('error');
    }
  }, [client, threadId]);

  useEffect(() => {
    void load();
  }, [load]);
  useOverlayDismiss(true, onClose);

  const agentLabel = (id: string): string => roster.find((a) => a.id === id)?.displayName ?? id;
  const agentColor = (id: string): string | undefined => roster.find((a) => a.id === id)?.color.primary;

  const visible = entries.filter(
    (e) =>
      (agentFilter === null || (e.agentId as string) === agentFilter) &&
      (typeFilter === 'all' || e.type === typeFilter),
  );

  return (
    <div className="wsp-scrim" data-testid="audit-panel-scrim" onClick={onClose}>
      <div
        className="wsp sess-panel"
        data-testid="audit-panel"
        role="dialog"
        aria-modal="true"
        aria-label="审计"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="wsp-head">
          <b>审计 · Audit</b>
          <span className="wsp-grow" />
          <button type="button" className="icon-btn sm" onClick={() => void load()} aria-label="刷新">
            ↻
          </button>
          <button type="button" className="icon-btn sm" onClick={onClose} aria-label="关闭审计">
            <IconClose />
          </button>
        </div>

        <div className="audit-filters" data-testid="audit-filters">
          <div className="audit-filter-row">
            <button
              type="button"
              className={`audit-chip${agentFilter === null ? ' on' : ''}`}
              onClick={() => setAgentFilter(null)}
            >
              全部成员
            </button>
            {roster.map((a) => (
              <button
                key={a.id}
                type="button"
                className={`audit-chip${agentFilter === a.id ? ' on' : ''}`}
                data-testid={`audit-agent-${a.id}`}
                style={agentFilter === a.id ? { color: a.color.primary, borderColor: a.color.primary } : undefined}
                onClick={() => setAgentFilter(a.id)}
              >
                {a.displayName}
              </button>
            ))}
          </div>
          <div className="audit-filter-row">
            {TYPE_FILTERS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`audit-chip${typeFilter === t.id ? ' on' : ''}`}
                data-testid={`audit-type-${t.id}`}
                onClick={() => setTypeFilter(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="wsp-body audit-body" data-testid="audit-panel-body">
          {state === 'loading' && <div className="sess-msg">加载审计…</div>}
          {state === 'error' && <div className="sess-msg sess-msg--err">加载失败：{errorMsg}</div>}
          {state === 'loaded' && entries.length === 0 && (
            <div className="sess-msg">该会话还没有可审计的活动。</div>
          )}
          {state === 'loaded' && entries.length > 0 && visible.length === 0 && (
            <div className="sess-msg">当前筛选下没有记录。</div>
          )}
          {state === 'loaded' &&
            visible.map((entry, i) => (
              <div
                className={`audit-row audit-row--${entry.type}`}
                data-testid="audit-row"
                data-type={entry.type}
                data-agent={entry.agentId}
                key={`${entry.type}:${entry.timestamp}:${i}`}
              >
                <span className="audit-time">{formatTime(entry.timestamp)}</span>
                <span
                  className="audit-agent"
                  style={(() => {
                    const c = agentColor(entry.agentId as string);
                    return c === undefined ? undefined : { color: c };
                  })()}
                >
                  {agentLabel(entry.agentId as string)}
                </span>
                <span className={`audit-desc${entry.isError === true ? ' audit-desc--err' : ''}`}>
                  {describe(entry)}
                </span>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
