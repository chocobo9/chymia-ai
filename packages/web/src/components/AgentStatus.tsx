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
import { useChatStore } from '../stores/chat-store.js';
import { statusPresentation } from './choco/primitives.js';

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

/** Render the right-column status bar. */
export function AgentStatus(): ReactElement {
  const roster = useAgentStore((s) => s.roster);
  const statusById = useAgentStore((s) => s.statusById);
  const activeThreadId = useChatStore((s) => s.activeThreadId);
  const threads = useChatStore((s) => s.threads);
  const messagesByThread = useChatStore((s) => s.messagesByThread);
  const [tab, setTab] = useState<AuditTab>('审计事件');

  const messages = useMemo(
    () => (activeThreadId === null ? [] : messagesByThread[activeThreadId] ?? []),
    [activeThreadId, messagesByThread],
  );
  const stats = useMemo(() => computeStats(messages), [messages]);
  const activeThread = useMemo(
    () => threads.find((t) => t.id === activeThreadId),
    [threads, activeThreadId],
  );

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
          <div className="sb-tabs">
            {AUDIT_TABS.map((t) => (
              <button
                key={t}
                type="button"
                className={tab === t ? 'on' : ''}
                onClick={() => setTab(t)}
              >
                {t}
              </button>
            ))}
          </div>
          <div className="sb-audit">
            <div className="sb-empty">暂无审计记录。</div>
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
