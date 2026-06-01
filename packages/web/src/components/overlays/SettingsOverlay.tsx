// SettingsOverlay (设置) — the full-screen settings surface opened from the
// threads-footer owner gear (.cvo). Left nav + right pane, ported from the
// Claude-Design choco-settings.jsx (de-scoped to what we can honestly back).
//
// WIRING (live vs honest-placeholder):
//   • 成员管理   — LIVE: renders the real roster from the agent store (name,
//                  model badge, accent, strengths, live status dot).
//   • 运维监控   — LIVE: per-agent live status (agent store) + the /health-backed
//                  ConnStrip; the token-usage bars are clearly marked 未接入.
//   • 外观 / 系统 — appearance shows the active theme (Choco) honestly.
//   • 账户与密钥 / Skill / MCP / 能力市场 / 通知 / 规则 — HONEST PLACEHOLDER: no
//     backend management API yet, so each shows the design's heading + a clearly
//     marked "未接入" note. We never fabricate accounts / skill mount counts.
//
// Visual ported from directions.css `.set-*`.

import { useState, type ReactElement } from 'react';
import { useAgentStore } from '../../stores/agent-store.js';
import type { AgentRosterEntry } from '../../lib/api.js';
import type { HealthInfo } from '../../hooks/useHealth.js';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss.js';
import { Avatar, StatusDot, statusPresentation, shortName, modelBadge } from '../choco/primitives.js';
import { IconClose } from '../choco/icons.js';
import { ConnStrip } from './ConnStrip.js';

type SettingsNavId =
  | 'members'
  | 'ops'
  | 'appearance'
  | 'accounts'
  | 'skill'
  | 'mcp'
  | 'market'
  | 'notif'
  | 'rules';

interface NavEntry {
  readonly id: SettingsNavId;
  readonly label: string;
}

const NAV: readonly NavEntry[] = [
  { id: 'members', label: '成员管理' },
  { id: 'ops', label: '运维监控' },
  { id: 'appearance', label: '外观' },
  { id: 'accounts', label: '账户与密钥' },
  { id: 'skill', label: 'Skill 管理' },
  { id: 'mcp', label: 'MCP 管理' },
  { id: 'market', label: '能力市场' },
  { id: 'notif', label: '通知' },
  { id: 'rules', label: '规则与 SOP' },
];

const PANE_HEAD: Readonly<Record<SettingsNavId, { readonly title: string; readonly sub: string }>> = {
  members: { title: '成员管理', sub: '你的 AI 团队成员与角色 — 取自实时名册。' },
  ops: { title: '运维监控', sub: '服务健康与运行态观测。' },
  appearance: { title: '外观', sub: '主题、语言与界面密度。' },
  accounts: { title: '账户与密钥', sub: '模型账户、凭据与执行身份。' },
  skill: { title: 'Skill 管理', sub: 'Skill 包的挂载与同步。' },
  mcp: { title: 'MCP 管理', sub: 'MCP 服务与工具目录。' },
  market: { title: '能力市场', sub: '搜索并安装能力包。' },
  notif: { title: '通知', sub: '选择哪些事件需要打扰你。' },
  rules: { title: '规则与 SOP', sub: '团队遵循的规则与标准流程。' },
};

/** Honest placeholder card for the unbacked panes. */
function SoonCard({ note }: { readonly note: string }): ReactElement {
  return (
    <div className="set-soon" data-testid="settings-soon">
      未接入：{note}
    </div>
  );
}

interface MemberCardProps {
  readonly entry: AgentRosterEntry;
  readonly status: ReturnType<typeof statusPresentation>;
  readonly statusValue: AgentRosterEntry['status'];
}

function MemberCard(props: MemberCardProps): ReactElement {
  const { entry, status, statusValue } = props;
  const online = statusValue !== 'offline';
  return (
    <div
      className="member-card"
      data-testid="settings-member-card"
      data-agent={entry.id}
      style={{ '--ac': entry.color.primary } as React.CSSProperties}
    >
      <div className="member-top">
        <Avatar agentId={entry.id} name={entry.displayName} accent={entry.color.primary} />
        <div className="member-id">
          <b>{shortName(entry)}</b>
          <span className="set-mono">{modelBadge(entry)}</span>
        </div>
        <span className="member-on" style={{ color: status.color }}>
          <span className="member-dot" style={{ background: status.color }} />
          {online ? status.label : '离线'}
        </span>
      </div>
      <div className="si-chips">
        {entry.strengths.map((s) => (
          <span key={s} className="schip">
            {s}
          </span>
        ))}
      </div>
    </div>
  );
}

export interface SettingsOverlayProps {
  readonly onClose: () => void;
  readonly health: HealthInfo;
  readonly socketConnected: boolean;
}

/** The full settings surface. */
export function SettingsOverlay(props: SettingsOverlayProps): ReactElement {
  const { onClose, health, socketConnected } = props;
  const roster = useAgentStore((s) => s.roster);
  const statusById = useAgentStore((s) => s.statusById);
  const [nav, setNav] = useState<SettingsNavId>('members');

  useOverlayDismiss(true, onClose);

  const head = PANE_HEAD[nav];

  let pane: ReactElement;
  switch (nav) {
    case 'members':
      pane = (
        <div className="set-grid2" data-testid="settings-members">
          {roster.map((entry) => {
            const statusValue = statusById[entry.id] ?? entry.status;
            return (
              <MemberCard
                key={entry.id}
                entry={entry}
                status={statusPresentation(statusValue)}
                statusValue={statusValue}
              />
            );
          })}
          {roster.length === 0 && (
            <div className="set-soon">未加载到 agent 名册。</div>
          )}
        </div>
      );
      break;
    case 'ops':
      pane = (
        <div className="set-pane-body" data-testid="settings-ops">
          <ConnStrip health={health} socketConnected={socketConnected} />
          <div className="set-card">
            <div className="set-card-t">实时态</div>
            {roster.map((entry) => {
              const statusValue = statusById[entry.id] ?? entry.status;
              const s = statusPresentation(statusValue);
              return (
                <div key={entry.id} className="usage-row" data-agent={entry.id} data-status={statusValue}>
                  <Avatar agentId={entry.id} name={entry.displayName} accent={entry.color.primary} small />
                  <div className="usage-name">
                    {shortName(entry)} <span className="set-mono">{modelBadge(entry)}</span>
                  </div>
                  <span className="sdot-wrap" style={{ marginLeft: 'auto' }}>
                    <StatusDot status={statusValue} />
                    <span className="stext" style={{ color: s.color }}>
                      {s.label}
                    </span>
                  </span>
                </div>
              );
            })}
            {roster.length === 0 && <div className="set-soon">未加载到 agent 名册。</div>}
          </div>
          <div className="set-card">
            <div className="set-card-t">Token 用量</div>
            <div className="set-soon" data-testid="settings-usage-placeholder">
              未接入：用量统计尚未接入后端，接通后这里会显示各 agent 的真实 token 用量。
            </div>
          </div>
        </div>
      );
      break;
    case 'appearance':
      pane = (
        <div className="set-pane-body" data-testid="settings-appearance">
          <div className="set-card">
            <div className="set-card-t">主题</div>
            <div className="theme-swatches">
              <button type="button" className="theme-swatch on" data-testid="theme-choco">
                <div
                  className="theme-swatch-bar"
                  style={{ background: 'linear-gradient(150deg,#b9744a,#99572f)' }}
                />
                <div className="theme-swatch-t">暖可可 · Choco</div>
                <div className="theme-swatch-s">当前主题</div>
              </button>
            </div>
          </div>
          <div className="set-card">
            <div className="set-row">
              <div className="set-row-main">
                <div className="set-row-t">界面语言</div>
                <div className="set-row-s">简体中文</div>
              </div>
              <div className="set-row-r">
                <span className="set-mono">zh-CN</span>
              </div>
            </div>
            <div className="set-row">
              <div className="set-row-main">
                <div className="set-row-t">数据目录</div>
                <div className="set-row-s">checkpoint 与 transcript 落盘位置</div>
              </div>
              <div className="set-row-r">
                <span className="set-mono dim">~/.choco</span>
              </div>
            </div>
          </div>
        </div>
      );
      break;
    case 'accounts':
      pane = <SoonCard note="账户与密钥管理尚未接入后端，无法在此读取或编辑真实凭据。" />;
      break;
    case 'skill':
      pane = <SoonCard note="Skill 挂载与同步状态尚未接入后端。" />;
      break;
    case 'mcp':
      pane = <SoonCard note="MCP 服务目录尚未接入后端。" />;
      break;
    case 'market':
      pane = <SoonCard note="能力市场尚未接入。" />;
      break;
    case 'notif':
      pane = <SoonCard note="通知偏好尚未接入持久化后端。" />;
      break;
    case 'rules':
      pane = <SoonCard note="规则与 SOP 管理尚未接入后端。" />;
      break;
  }

  return (
    <div
      className="set-overlay"
      data-testid="settings-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="设置"
    >
      <aside className="set-nav">
        <div className="set-nav-h">
          设置<span>Choco</span>
        </div>
        <div className="set-nav-list" role="tablist" aria-label="设置导航">
          {NAV.map((it) => (
            <button
              key={it.id}
              type="button"
              role="tab"
              aria-selected={nav === it.id}
              className={`set-nav-item ${nav === it.id ? 'on' : ''}`}
              data-testid={`settings-nav-${it.id}`}
              onClick={() => setNav(it.id)}
            >
              {it.label}
            </button>
          ))}
        </div>
        <button type="button" className="set-back" onClick={onClose}>
          ← 返回工作台
        </button>
      </aside>
      <main className="set-main">
        <button type="button" className="set-close" onClick={onClose} aria-label="关闭设置">
          <IconClose />
        </button>
        <div className="set-head">
          <h2>{head.title}</h2>
          <p>{head.sub}</p>
        </div>
        <div className="set-content">{pane}</div>
      </main>
    </div>
  );
}
