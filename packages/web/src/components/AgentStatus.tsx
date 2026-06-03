// M9 AgentStatus — the RIGHT column status bar (.col-status). Restores the original
// 状态栏 design (the tabbed 审计 & Session block + 会话链 link + 运行日志 foot), but
// every surface is wired to REAL state — no fabricated numbers, no dead placeholders,
// no permanent "暂无审计记录". Sections:
//
//   • Agent 状态     — live roster + statuses from the agent store (G7).
//   • 消息统计       — counts computed from the ACTIVE thread's persisted messages.
//   • Session Chain  — distinct sessionIds in the thread + the 打开会话链 entry
//                      (opens SessionPanel: chain / transcript / seal / 恢复).
//   • 对话信息       — active thread title + thinking mode (real fields only).
//   • 审计 & Session — the restored TAB block. 审计事件 / Session / 搜索 tabs preview
//                      the thread's REAL recent activity + session chain (derived from
//                      the store, not fetched here); 搜索 filters that preview live.
//                      Rows + the 运行日志 · 查看日志 foot open the full on-demand
//                      panels (AuditPanel / SessionPanel) where the complete trail lives.
//
// The audit/session DETAIL (tool events, seals, transcripts, seal/恢复 actions) lives
// in those on-demand panels — this column is a compact LIVE summary + the entries into
// them. Preserves the wiring/a11y hooks: data-testid="agent-status"/"agent-status-item"/
// "agent-status-dot", data-agent, data-status, plus sb-open-audit / sb-open-sessions on
// the functional entries.

import { useMemo, useState, type ReactElement } from 'react';
import type { AgentStatus as AgentStatusValue, StoredMessage } from '@choco/shared';
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

/** The three 审计 & Session preview tabs (original design). */
type AuditTab = '审计事件' | 'Session' | '搜索';
const AUDIT_TABS: readonly AuditTab[] = ['审计事件', 'Session', '搜索'];

/** Max preview rows shown in-column before deferring to the full panel. */
const PREVIEW_LIMIT = 6;

interface MessageStats {
  readonly total: number;
  readonly agent: number;
  readonly system: number;
  readonly user: number;
  readonly sessions: number;
}

/** Compute message statistics from the active thread's persisted messages. */
function computeStats(messages: readonly StoredMessage[]): MessageStats {
  let agent = 0;
  let system = 0;
  let user = 0;
  const sessionIds = new Set<string>();
  for (const message of messages) {
    if (message.agentId === null) user += 1;
    else agent += 1;
    if (message.origin === 'system') system += 1;
    if (message.sessionId !== undefined && message.sessionId.length > 0) {
      sessionIds.add(message.sessionId);
    }
  }
  return { total: messages.length, agent, system, user, sessions: sessionIds.size };
}

/** One row of the 审计事件 preview — a real persisted message, compactly tagged. */
interface ActivityRow {
  readonly key: string;
  readonly who: string;
  readonly color?: string;
  readonly text: string;
  readonly time: string;
  readonly isError: boolean;
}

/** One row of the Session preview — a distinct session in the thread. */
interface SessionRow {
  readonly sessionId: string;
  readonly count: number;
}

/** Local HH:MM:SS for an epoch-ms timestamp (best-effort, stable for tests). */
function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}

/**
 * Derive the 审计事件 preview from the thread's REAL messages (newest first). A
 * persisted reply IS a `reply` audit entry; the full trail (tools / seals) lives
 * in AuditPanel, reachable from the row / 查看日志.
 */
function deriveActivity(
  messages: readonly StoredMessage[],
  nameOf: (id: string) => string,
  colorOf: (id: string) => string | undefined,
): readonly ActivityRow[] {
  const rows: ActivityRow[] = [];
  for (const m of messages) {
    const who =
      m.origin === 'system' ? '系统' : m.agentId === null ? '用户' : nameOf(m.agentId);
    rows.push({
      key: m.id,
      who,
      color: m.agentId === null || m.origin === 'system' ? undefined : colorOf(m.agentId),
      text: m.content,
      time: formatTime(m.timestamp),
      isError: m.origin === 'system',
    });
  }
  // Newest first (the persisted order is chronological).
  return rows.reverse();
}

/** Derive the distinct session chain from the thread's messages (first-seen order). */
function deriveSessions(messages: readonly StoredMessage[]): readonly SessionRow[] {
  const counts = new Map<string, number>();
  for (const m of messages) {
    if (m.sessionId !== undefined && m.sessionId.length > 0) {
      counts.set(m.sessionId, (counts.get(m.sessionId) ?? 0) + 1);
    }
  }
  return Array.from(counts, ([sessionId, count]) => ({ sessionId, count }));
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

/** A single clickable preview row (audit/session). Opens its full panel when enabled. */
function PreviewRow(props: {
  readonly tag: string;
  readonly color?: string;
  readonly meta: string;
  readonly title: string;
  readonly testid: string;
  readonly isError?: boolean;
  readonly onOpen?: () => void;
}): ReactElement {
  const { tag, color, meta, title, testid, isError, onOpen } = props;
  return (
    <button
      type="button"
      className="audit-row"
      data-testid={testid}
      title={title}
      disabled={onOpen === undefined}
      onClick={onOpen}
    >
      <span
        className={`audit-tag${isError === true ? ' err' : ''}`}
        style={color === undefined ? undefined : { color }}
      >
        {tag}
      </span>
      <span className="audit-t">{meta}</span>
    </button>
  );
}

export interface AgentStatusProps {
  /** Open the real 审计 (audit timeline) panel. Omitted → the entry is inert. */
  readonly onOpenAudit?: () => void;
  /** Open the real 会话链 (session chain) panel. Omitted → the entry is inert. */
  readonly onOpenSessions?: () => void;
}

/** Render the right-column status bar. */
export function AgentStatus(props: AgentStatusProps = {}): ReactElement {
  const { onOpenAudit, onOpenSessions } = props;
  const roster = useAgentStore((s) => s.roster);
  const statusById = useAgentStore((s) => s.statusById);
  const activeThreadId = useChatStore((s) => s.activeThreadId);
  const threads = useChatStore((s) => s.threads);
  const messagesByThread = useChatStore((s) => s.messagesByThread);

  const [tab, setTab] = useState<AuditTab>('审计事件');
  const [query, setQuery] = useState('');

  const messages = useMemo(
    () => (activeThreadId === null ? [] : messagesByThread[activeThreadId] ?? []),
    [activeThreadId, messagesByThread],
  );
  const stats = useMemo(() => computeStats(messages), [messages]);
  const activeThread = useMemo(
    () => threads.find((t) => t.id === activeThreadId),
    [threads, activeThreadId],
  );

  const nameOf = useMemo(() => {
    const byId = new Map(roster.map((a) => [a.id, a.displayName]));
    return (id: string): string => byId.get(id) ?? id;
  }, [roster]);
  const colorOf = useMemo(() => {
    const byId = new Map(roster.map((a) => [a.id, a.color.primary]));
    return (id: string): string | undefined => byId.get(id);
  }, [roster]);

  const activity = useMemo(
    () => deriveActivity(messages, nameOf, colorOf),
    [messages, nameOf, colorOf],
  );
  const sessions = useMemo(() => deriveSessions(messages), [messages]);

  // 搜索 tab: filter the real preview rows live (over who/content and session id).
  const q = query.trim().toLowerCase();
  const matchedActivity = useMemo(
    () =>
      q.length === 0
        ? activity
        : activity.filter(
            (r) => r.who.toLowerCase().includes(q) || r.text.toLowerCase().includes(q),
          ),
    [activity, q],
  );
  const matchedSessions = useMemo(
    () => (q.length === 0 ? sessions : sessions.filter((s) => s.sessionId.toLowerCase().includes(q))),
    [sessions, q],
  );

  const anyWorking = roster.some((a) => (statusById[a.id] ?? a.status) === 'working');
  // The panels are per-thread, so the entries are only active with a thread open.
  const noThread = activeThreadId === null;
  const auditEntry = noThread ? undefined : onOpenAudit;
  const sessionEntry = noThread ? undefined : onOpenSessions;

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
          <div className="sb-sec-h">
            <span>Session Chain</span>
            <span className="sb-sec-r">{stats.sessions} session</span>
          </div>
          <button
            type="button"
            className="sb-link"
            data-testid="sb-open-sessions"
            disabled={sessionEntry === undefined}
            onClick={sessionEntry}
            title="打开会话链：查看 session 链 / transcript，封存 / 恢复"
          >
            ＋ 打开会话链
          </button>
        </section>

        <section className="sb-sec">
          <div className="sb-sec-h">
            <span>对话信息</span>
          </div>
          <div className="sb-kv">
            <span>Thread</span>
            <code>{activeThread?.title ?? '未选择会话'}</code>
          </div>
          <div className="sb-kv">
            <span>Thinking</span>
            <span className="sb-kvr">{activeThread?.thinkingMode ?? '—'}</span>
          </div>
        </section>

        <section className="sb-sec">
          <div className="sb-sec-h">
            <span>审计 &amp; Session</span>
          </div>
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

          <div className="sb-audit" data-testid="sb-audit-body">
            {noThread && <div className="sb-audit-empty">未选择会话。</div>}

            {!noThread && tab === '审计事件' && (
              <>
                {activity.length === 0 && (
                  <div className="sb-audit-empty">该会话还没有活动。</div>
                )}
                {activity.slice(0, PREVIEW_LIMIT).map((r) => (
                  <PreviewRow
                    key={r.key}
                    tag={r.who}
                    color={r.color}
                    meta={r.time}
                    title={r.text}
                    isError={r.isError}
                    testid="sb-activity-row"
                    onOpen={auditEntry}
                  />
                ))}
              </>
            )}

            {!noThread && tab === 'Session' && (
              <>
                {sessions.length === 0 && (
                  <div className="sb-audit-empty">该会话还没有 session。</div>
                )}
                {sessions.slice(0, PREVIEW_LIMIT).map((s) => (
                  <PreviewRow
                    key={s.sessionId}
                    tag={s.sessionId}
                    meta={`${s.count} 条`}
                    title={`Session ${s.sessionId} · ${s.count} 条消息`}
                    testid="sb-session-row"
                    onOpen={sessionEntry}
                  />
                ))}
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
                {q.length > 0 && matchedActivity.length === 0 && matchedSessions.length === 0 && (
                  <div className="sb-audit-empty">没有匹配的审计 / session。</div>
                )}
                {matchedActivity.slice(0, PREVIEW_LIMIT).map((r) => (
                  <PreviewRow
                    key={r.key}
                    tag={r.who}
                    color={r.color}
                    meta={r.time}
                    title={r.text}
                    isError={r.isError}
                    testid="sb-activity-row"
                    onOpen={auditEntry}
                  />
                ))}
                {matchedSessions.slice(0, PREVIEW_LIMIT).map((s) => (
                  <PreviewRow
                    key={s.sessionId}
                    tag={s.sessionId}
                    meta={`${s.count} 条`}
                    title={`Session ${s.sessionId} · ${s.count} 条消息`}
                    testid="sb-session-row"
                    onOpen={sessionEntry}
                  />
                ))}
              </>
            )}
          </div>
        </section>

        <div className="sb-foot">
          <span>运行日志</span>
          <button
            type="button"
            className="sb-a"
            data-testid="sb-open-audit"
            disabled={auditEntry === undefined}
            onClick={auditEntry}
            title="打开审计时间线：本会话的调用 / 工具 / 封会话流水"
          >
            查看日志
          </button>
        </div>
      </div>
    </>
  );
}
