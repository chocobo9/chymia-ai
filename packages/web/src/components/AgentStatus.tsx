// M9 AgentStatus — the RIGHT column status bar (.col-status content) in the
// .d-choco design. Sections, all wired to REAL state (no fabricated numbers):
//
//   • Agent 状态     — live roster + statuses from the agent store (G7): the dot
//                      flips idle→working→idle as agent_status frames arrive.
//   • 消息统计       — counts computed from the ACTIVE thread's persisted messages
//                      (total / agent / system / user).
//   • Session Chain  — distinct sessionIds among the thread's messages (bind is
//                      deferred → no-op).
//   • 对话信息       — active thread title + thinking mode.
//   • 审计 & Session — no backend audit feed yet → honest empty state.
//   • 运行日志       — deferred (disabled link).
//
// Preserves the wiring/a11y hooks the M9 tests depend on: data-testid=
// "agent-status"/"agent-status-item"/"agent-status-dot", data-agent, data-status,
// and the per-status labels.

import { useMemo, useState, type ReactElement } from 'react';
import type { AgentStatus as AgentStatusValue, StoredMessage } from '@clowder/shared';
import { useAgentStore } from '../stores/agent-store.js';
import { useChatStore, type TranscriptNotice } from '../stores/chat-store.js';
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
      <span
        className="sb-ast agent-status__label"
        style={{ color: presentation.color }}
      >
        {STATUS_LABEL[status]}
      </span>
    </div>
  );
}

const AUDIT_TABS = ['审计事件', 'Session', '搜索'] as const;
type AuditTab = (typeof AUDIT_TABS)[number];

/** One distinct session with its message count, derived from the thread. */
interface SessionRow {
  readonly id: string;
  readonly count: number;
}

/** Short relative-time label (…前) from a timestamp; never fabricates. */
function relativeTime(now: number, ts: number): string {
  const sec = Math.max(0, Math.floor((now - ts) / 1000));
  if (sec < 60) return '刚刚';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  return `${Math.floor(hr / 24)} 天前`;
}

/** Aggregate distinct sessionIds (with message counts) from the thread. */
function sessionRows(messages: readonly StoredMessage[]): readonly SessionRow[] {
  const counts = new Map<string, number>();
  for (const m of messages) {
    if (m.sessionId !== undefined && m.sessionId.length > 0) {
      counts.set(m.sessionId, (counts.get(m.sessionId) ?? 0) + 1);
    }
  }
  return [...counts.entries()].map(([id, count]) => ({ id, count }));
}

/** Audit-event tag for a transcript notice (mirrors the design's tag style). */
function noticeTag(kind: TranscriptNotice['kind']): string {
  return kind === 'error' ? 'agent_error' : 'system_info';
}

/** One audit row for a notice (tag + detail + optional time). */
function NoticeRow({ notice, now }: { readonly notice: TranscriptNotice; readonly now?: number }): ReactElement {
  return (
    <div className="audit-row" data-testid="sb-audit-row">
      <span className={`audit-tag ${notice.kind === 'error' ? 'err' : ''}`}>{noticeTag(notice.kind)}</span>
      <span className="audit-d" title={notice.text}>{notice.text}</span>
      {now !== undefined && <span className="audit-t">{relativeTime(now, notice.timestamp)}</span>}
    </div>
  );
}

/** Render the right-column status bar. */
export function AgentStatus(): ReactElement {
  const roster = useAgentStore((s) => s.roster);
  const statusById = useAgentStore((s) => s.statusById);
  const activeThreadId = useChatStore((s) => s.activeThreadId);
  const threads = useChatStore((s) => s.threads);
  const messagesByThread = useChatStore((s) => s.messagesByThread);
  const noticesByThread = useChatStore((s) => s.noticesByThread);
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
  // Audit feed: there is no backend audit API yet, so the 审计事件 tab surfaces the
  // REAL agent errors / system notices we already capture for the thread (newest
  // first) — honest data, never fabricated rows. Sessions come from the thread's
  // own sessionIds. The 搜索 tab filters the same notices locally.
  const notices = useMemo(
    () => (activeThreadId === null ? [] : noticesByThread[activeThreadId] ?? []),
    [activeThreadId, noticesByThread],
  );
  const noticesNewestFirst = useMemo(() => notices.slice().reverse(), [notices]);
  const sessions = useMemo(() => sessionRows(messages), [messages]);
  const searchHits = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return noticesNewestFirst;
    return noticesNewestFirst.filter(
      (n) => n.text.toLowerCase().includes(q) || noticeTag(n.kind).includes(q),
    );
  }, [query, noticesNewestFirst]);
  const now = Date.now();

  const anyWorking = roster.some((a) => (statusById[a.id] ?? a.status) === 'working');

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
          <button type="button" className="sb-link" disabled title="即将上线">
            ＋ 绑定外部 Session
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
            {tab === '审计事件' &&
              (noticesNewestFirst.length === 0 ? (
                <div className="sb-empty">暂无审计记录。</div>
              ) : (
                noticesNewestFirst.map((n) => <NoticeRow key={n.id} notice={n} now={now} />)
              ))}

            {tab === 'Session' &&
              (sessions.length === 0 ? (
                <div className="sb-empty">暂无 session 记录。</div>
              ) : (
                sessions.map((s) => (
                  <div key={s.id} className="audit-row" data-testid="sb-session-row">
                    <span className="audit-tag" title={s.id}>
                      {s.id.length > 16 ? `${s.id.slice(0, 16)}…` : s.id}
                    </span>
                    <span className="audit-t">{s.count} 条</span>
                  </div>
                ))
              ))}

            {tab === '搜索' && (
              <>
                <div className="sb-search">
                  <IconSearch />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="搜索审计 / session…"
                    aria-label="搜索审计记录"
                    data-testid="sb-audit-search"
                  />
                </div>
                {notices.length === 0 ? (
                  <div className="sb-empty">暂无可搜索的记录。</div>
                ) : searchHits.length === 0 ? (
                  <div className="sb-empty">没有匹配「{query}」的记录。</div>
                ) : (
                  searchHits.map((n) => <NoticeRow key={n.id} notice={n} />)
                )}
              </>
            )}
          </div>
        </section>

        <div className="sb-foot">
          <span>运行日志</span>
          <span className="sb-a disabled" title="即将上线">
            查看日志
          </span>
        </div>
      </div>
    </>
  );
}
