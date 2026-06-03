// M9 AgentStatus — the RIGHT column status bar (.col-status). Live readout + the
// 审计 & Session panel, built to the original Choco design (collapsible card, three
// tabs 审计事件 / Session / 搜索, rows shown as [type-tag] … [relative time], and a
// 运行日志 · 查看日志 foot) — but wired to REAL data, not the mock cat_invoked rows.
//
//   • Agent 状态  — live roster + statuses from the agent store (G7).
//   • 消息统计    — counts computed from the ACTIVE thread's persisted messages.
//   • 审计 & Session (collapsible):
//       – 审计事件 (getAudit): the thread's audit events — a [type] tag + relative time.
//       – Session  (getSessions): the session chain — each with 封存 / 恢复 inline.
//       – 搜索     : filters the audit + session rows live (over type / session id).
//       – 查看日志 : expands the audit list past its preview cap (show all).
//
// No main-bar audit/session buttons and no overlays — this inline panel is the ONLY
// 审计 & Session surface. Preserves data-testid="agent-status"/"agent-status-item"/
// "agent-status-dot", data-agent, data-status.

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import type { AgentStatus as AgentStatusValue, AuditEntry, StoredMessage } from '@choco/shared';
import type { ApiClient, SessionChainEntry } from '../lib/api.js';
import { useAgentStore } from '../stores/agent-store.js';
import { useChatStore } from '../stores/chat-store.js';
import { statusPresentation } from './choco/primitives.js';
import { IconSearch } from './choco/icons.js';

/** Human-readable label per status (matches the design's STATUS labels). */
const STATUS_LABEL: Readonly<Record<AgentStatusValue, string>> = {
  idle: '待命',
  thinking: '思考中',
  working: '工作中',
  error: '阻塞',
  offline: '离线',
};

/** The three 审计 & Session tabs (original design). */
type AuditTab = '审计事件' | 'Session' | '搜索';
const AUDIT_TABS: readonly AuditTab[] = ['审计事件', 'Session', '搜索'];

/** Audit rows shown before 查看日志 expands the rest. */
const PREVIEW_LIMIT = 6;

interface MessageStats {
  readonly total: number;
  readonly agent: number;
  readonly system: number;
  readonly user: number;
}

/** Compute message statistics from the active thread's persisted messages. */
function computeStats(messages: readonly StoredMessage[]): MessageStats {
  let agent = 0;
  let system = 0;
  let user = 0;
  for (const message of messages) {
    if (message.agentId === null) user += 1;
    else agent += 1;
    if (message.origin === 'system') system += 1;
  }
  return { total: messages.length, agent, system, user };
}

/** A compact relative time, e.g. "3h ago" / "2d ago" (matches the design). */
function timeAgo(ms: number, now: number): string {
  const sec = Math.max(0, Math.floor((now - ms) / 1000));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/** The snake_case type tag + error flag shown as the row's pill. */
function auditTag(e: AuditEntry): { readonly label: string; readonly err: boolean } {
  switch (e.type) {
    case 'reply':
      return e.isError === true ? { label: 'error', err: true } : { label: 'replied', err: false };
    case 'tool':
      return { label: e.toolName !== undefined ? `tool · ${e.toolName}` : 'tool', err: false };
    case 'session_start':
      return { label: 'session_start', err: false };
    case 'session_seal':
      return { label: 'session_seal', err: false };
  }
}

interface AgentStatusItemProps {
  readonly agentId: string;
  readonly displayName: string;
  readonly status: AgentStatusValue;
  readonly color: string;
}

function AgentStatusItem(props: AgentStatusItemProps): ReactElement {
  const { agentId, displayName, status, color } = props;
  const presentation = statusPresentation(status);
  return (
    <div
      className="sb-agent agent-status__item"
      data-testid="agent-status-item"
      data-agent={agentId}
      data-status={status}
    >
      <span
        className="sb-adot agent-status__dot"
        data-testid="agent-status-dot"
        style={{ background: status === 'idle' ? undefined : color }}
        aria-hidden="true"
      />
      <span className="sb-aname agent-status__name">{displayName}</span>
      <span className="sb-ast agent-status__label" style={{ color: presentation.color }}>
        {STATUS_LABEL[status]}
      </span>
    </div>
  );
}

export interface AgentStatusProps {
  /**
   * API client for the 审计 & Session panel (getSessions / getAudit / seal / reopen).
   * Omitted (status-only test) → the panel is inert + shows its honest empty state.
   */
  readonly client?: ApiClient;
}

/** One audit-event row: a [type] pill + relative time (the design's row shape). */
function AuditRow(props: { readonly entry: AuditEntry; readonly now: number }): ReactElement {
  const { entry, now } = props;
  const tag = auditTag(entry);
  return (
    <div className="audit-row" data-testid="sb-audit-event" data-type={entry.type}>
      <span className={`audit-tag${tag.err ? ' err' : ''}`}>{tag.label}</span>
      <span className="audit-t">{timeAgo(entry.timestamp, now)}</span>
    </div>
  );
}

/** Render the right-column status bar + the 审计 & Session panel. */
export function AgentStatus(props: AgentStatusProps = {}): ReactElement {
  const { client } = props;
  const roster = useAgentStore((s) => s.roster);
  const statusById = useAgentStore((s) => s.statusById);
  const activeThreadId = useChatStore((s) => s.activeThreadId);
  const messagesByThread = useChatStore((s) => s.messagesByThread);

  const [tab, setTab] = useState<AuditTab>('审计事件');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [sessions, setSessions] = useState<readonly SessionChainEntry[]>([]);
  const [audit, setAudit] = useState<readonly AuditEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const messages = useMemo(
    () => (activeThreadId === null ? [] : messagesByThread[activeThreadId] ?? []),
    [activeThreadId, messagesByThread],
  );
  const stats = useMemo(() => computeStats(messages), [messages]);

  const nameOf = useMemo(() => {
    const byId = new Map(roster.map((a) => [a.id, a.displayName]));
    return (id: string): string => byId.get(id) ?? id;
  }, [roster]);
  const colorOf = useMemo(() => {
    const byId = new Map(roster.map((a) => [a.id, a.color.primary]));
    return (id: string): string | undefined => byId.get(id);
  }, [roster]);

  const anyWorking = roster.some((a) => (statusById[a.id] ?? a.status) === 'working');
  const noThread = activeThreadId === null;
  // A single render-time clock for all relative times (stable within one paint).
  const now = Date.now();

  // Load the audit events + session chain for the active thread.
  useEffect(() => {
    if (client === undefined || activeThreadId === null) {
      setSessions([]);
      setAudit([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setShowAll(false);
    void (async () => {
      try {
        const [a, s] = await Promise.all([
          client.getAudit(activeThreadId),
          client.getSessions(activeThreadId),
        ]);
        if (cancelled) return;
        setAudit(a);
        setSessions(s);
      } catch {
        if (!cancelled) {
          setAudit([]);
          setSessions([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, activeThreadId]);

  // 封存 / 恢复 a session inline, then refetch the chain so the badge flips.
  const sealOrReopen = useCallback(
    async (sessionId: string, action: 'seal' | 'reopen'): Promise<void> => {
      if (client === undefined || activeThreadId === null) return;
      setBusyId(sessionId);
      try {
        if (action === 'seal') await client.sealSession(sessionId);
        else await client.reopenSession(sessionId);
        setSessions(await client.getSessions(activeThreadId));
      } catch {
        /* keep current chain on failure */
      } finally {
        setBusyId(null);
      }
    },
    [client, activeThreadId],
  );

  const q = query.trim().toLowerCase();
  const matchedAudit = useMemo(
    () => (q.length === 0 ? audit : audit.filter((e) => auditTag(e).label.toLowerCase().includes(q))),
    [audit, q],
  );
  const matchedSessions = useMemo(
    () => (q.length === 0 ? sessions : sessions.filter((s) => s.sessionId.toLowerCase().includes(q))),
    [sessions, q],
  );
  const auditShown = showAll ? audit : audit.slice(0, PREVIEW_LIMIT);

  const renderSessionRow = (s: SessionChainEntry): ReactElement => (
    <div className="audit-row sb-sess" data-testid="sb-session-row" data-session={s.sessionId} data-status={s.status} key={s.sessionId}>
      <span className="audit-tag" title={s.sessionId} style={{ color: colorOf(s.agentId as string) }}>
        #{s.sequenceNo} {nameOf(s.agentId as string)}
      </span>
      <span className={`sess-badge sess-badge--${s.status}`}>{s.status === 'active' ? '进行中' : '已封存'}</span>
      {s.status === 'active' ? (
        <button
          type="button"
          className="sb-chain-act"
          data-testid="sb-session-seal"
          disabled={busyId === s.sessionId || client === undefined}
          onClick={() => void sealOrReopen(s.sessionId, 'seal')}
        >
          {busyId === s.sessionId ? '…' : '封存'}
        </button>
      ) : (
        <button
          type="button"
          className="sb-chain-act"
          data-testid="sb-session-reopen"
          disabled={busyId === s.sessionId || client === undefined}
          onClick={() => void sealOrReopen(s.sessionId, 'reopen')}
        >
          {busyId === s.sessionId ? '…' : '恢复'}
        </button>
      )}
    </div>
  );

  return (
    <>
      <div className="sb-head">
        <span className="sb-title">状态栏</span>
      </div>
      <div className="sb-mode">
        当前模式 · <b>{anyWorking ? '协作中' : '待命'}</b>
      </div>
      <div className="sb-scroll">
        <section className="sb-sec">
          <div className="sb-sec-h">
            <span>Agent 状态</span>
          </div>
          <ul className="sb-agents agent-status" data-testid="agent-status">
            {roster.map((agent) => (
              <AgentStatusItem
                key={agent.id}
                agentId={agent.id}
                displayName={agent.displayName}
                status={statusById[agent.id] ?? agent.status}
                color={agent.color.primary}
              />
            ))}
            {roster.length === 0 && <li className="sb-empty">尚未加载 agent 名册。</li>}
          </ul>
        </section>

        <section className="sb-sec">
          <div className="sb-sec-h">
            <span>消息统计</span>
          </div>
          <div className="sb-stat">
            <span>总数</span>
            <b>{stats.total}</b>
          </div>
          <div className="sb-stat">
            <span>Agent 消息</span>
            <b>{stats.agent}</b>
          </div>
          <div className="sb-stat">
            <span>用户消息</span>
            <b>{stats.user}</b>
          </div>
          <div className="sb-stat">
            <span>系统消息</span>
            <b>{stats.system}</b>
          </div>
        </section>

        <section className="sb-sec">
          <button
            type="button"
            className="sb-sec-h sb-collapse"
            data-testid="sb-explorer-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            <span>审计 &amp; Session</span>
            <span className="sb-collapse-i" aria-hidden="true">{expanded ? '▲' : '▼'}</span>
          </button>

          {expanded && (
            <>
              <div className="sb-tabs" role="tablist">
                {AUDIT_TABS.map((t) => (
                  <button
                    key={t}
                    type="button"
                    role="tab"
                    aria-selected={tab === t}
                    className={tab === t ? 'on' : ''}
                    data-testid={`sb-audit-tab-${t}`}
                    onClick={() => setTab(t)}
                  >
                    {t}
                  </button>
                ))}
              </div>

              <div className="sb-audit" data-testid="sb-explorer-body">
                {noThread && <div className="sb-audit-empty">未选择会话。</div>}

                {!noThread && tab === '审计事件' && (
                  <>
                    {loading && <div className="sb-audit-empty">加载审计…</div>}
                    {!loading && audit.length === 0 && (
                      <div className="sb-audit-empty">该会话还没有可审计的活动。</div>
                    )}
                    {!loading &&
                      auditShown.map((e, i) => <AuditRow key={`${e.type}:${e.timestamp}:${i}`} entry={e} now={now} />)}
                  </>
                )}

                {!noThread && tab === 'Session' && (
                  <>
                    {loading && <div className="sb-audit-empty">加载 session…</div>}
                    {!loading && sessions.length === 0 && (
                      <div className="sb-audit-empty">该会话还没有 session。</div>
                    )}
                    {!loading && sessions.map(renderSessionRow)}
                  </>
                )}

                {!noThread && tab === '搜索' && (
                  <>
                    <div className="sb-search">
                      <IconSearch />
                      <input
                        data-testid="sb-audit-search"
                        placeholder="搜索审计 / session…"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        aria-label="搜索审计 / session"
                      />
                    </div>
                    {q.length > 0 && matchedAudit.length === 0 && matchedSessions.length === 0 && (
                      <div className="sb-audit-empty">没有匹配的审计 / session。</div>
                    )}
                    {matchedAudit.slice(0, PREVIEW_LIMIT).map((e, i) => (
                      <AuditRow key={`${e.type}:${e.timestamp}:${i}`} entry={e} now={now} />
                    ))}
                    {matchedSessions.map(renderSessionRow)}
                  </>
                )}
              </div>

              <div className="sb-foot">
                <span>运行日志</span>
                <button
                  type="button"
                  className="sb-a"
                  data-testid="sb-view-logs"
                  disabled={noThread || audit.length <= PREVIEW_LIMIT}
                  onClick={() => {
                    setTab('审计事件');
                    setShowAll(true);
                  }}
                >
                  查看日志
                </button>
              </div>
            </>
          )}
        </section>
      </div>
    </>
  );
}
