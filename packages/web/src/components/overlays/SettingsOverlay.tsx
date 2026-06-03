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
import type { AgentRosterEntry, AgentUpdatePatch, ApiClient, NewMemberInput } from '../../lib/api.js';
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
  readonly onEdit: (entry: AgentRosterEntry) => void;
  /** Delete a runtime-added member; absent → no delete affordance (base member). */
  readonly onDelete?: (entry: AgentRosterEntry) => void;
}

function MemberCard(props: MemberCardProps): ReactElement {
  const { entry, status, statusValue, onEdit, onDelete } = props;
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
      <div className="member-actions">
        <button
          type="button"
          className="member-edit-btn"
          data-testid="member-edit-open"
          data-agent={entry.id}
          onClick={() => onEdit(entry)}
        >
          编辑成员
        </button>
        {entry.removable === true && onDelete !== undefined && (
          <button
            type="button"
            className="member-del-btn"
            data-testid="member-delete"
            data-agent={entry.id}
            onClick={() => onDelete(entry)}
          >
            删除
          </button>
        )}
      </div>
    </div>
  );
}

/** Split a comma/、-separated 擅长领域 string into trimmed, non-empty tags. */
function parseStrengths(raw: string): string[] {
  return raw
    .split(/[,、]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

interface MemberEditModalProps {
  readonly entry: AgentRosterEntry;
  readonly client: ApiClient;
  readonly onClose: () => void;
  readonly onSaved: () => Promise<void>;
}

/**
 * 编辑成员 modal — edits a member's overlay fields (名称/昵称/角色描述/擅长领域/
 * Background Color) and PATCHes them to /api/agents/:id. On success it refetches
 * the roster (so the cards + status bar reflect the edit live) and closes; on
 * failure it shows an inline error and stays open.
 */
function MemberEditModal(props: MemberEditModalProps): ReactElement {
  const { entry, client, onClose, onSaved } = props;
  const [displayName, setDisplayName] = useState(entry.displayName);
  const [name, setName] = useState(entry.name);
  const [roleDescription, setRoleDescription] = useState('');
  const [strengthsText, setStrengthsText] = useState(entry.strengths.join('、'));
  const [primary, setPrimary] = useState(entry.color.primary);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    // Build the patch from the edited fields. roleDescription is only sent when
    // the operator filled it in (the roster payload does not carry it, so an
    // empty field means "leave the existing role"). Color keeps the existing
    // secondary; only the primary (Background Color) is editable here.
    const trimmedRole = roleDescription.trim();
    const patch: AgentUpdatePatch = {
      displayName,
      name,
      strengths: parseStrengths(strengthsText),
      color: { primary, secondary: entry.color.secondary },
      ...(trimmedRole.length > 0 ? { roleDescription: trimmedRole } : {}),
    };
    try {
      await client.updateAgent(entry.id, patch);
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="member-edit-overlay"
      data-testid="member-edit-modal"
      role="dialog"
      aria-modal="true"
      aria-label="编辑成员"
    >
      <div className="member-edit-card" style={{ '--ac': primary } as React.CSSProperties}>
        <div className="member-edit-head">
          <h3>编辑成员 · {shortName(entry)}</h3>
          <button
            type="button"
            className="set-close"
            onClick={onClose}
            aria-label="关闭编辑"
          >
            <IconClose />
          </button>
        </div>
        <label className="member-edit-field">
          <span>名称</span>
          <input
            data-testid="member-edit-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="member-edit-field">
          <span>昵称 / 显示后缀</span>
          <input
            data-testid="member-edit-displayName"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </label>
        <label className="member-edit-field">
          <span>角色描述</span>
          <textarea
            data-testid="member-edit-role"
            value={roleDescription}
            placeholder="留空则不修改当前角色"
            onChange={(e) => setRoleDescription(e.target.value)}
          />
        </label>
        <label className="member-edit-field">
          <span>擅长领域（逗号或顿号分隔）</span>
          <input
            data-testid="member-edit-strengths"
            value={strengthsText}
            onChange={(e) => setStrengthsText(e.target.value)}
          />
        </label>
        <label className="member-edit-field">
          <span>Background Color</span>
          <input
            type="color"
            data-testid="member-edit-color"
            value={primary}
            onChange={(e) => setPrimary(e.target.value)}
          />
        </label>
        {error !== null && (
          <div className="member-edit-error" data-testid="member-edit-error" role="alert">
            {error}
          </div>
        )}
        <div className="member-edit-actions">
          <button type="button" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button
            type="button"
            className="member-edit-save"
            data-testid="member-edit-save"
            disabled={saving}
            onClick={() => void save()}
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Friendly labels for the client/model providers we can build. */
const CLIENT_OPTIONS: readonly { readonly id: NewMemberInput['clientId']; readonly label: string }[] = [
  { id: 'anthropic', label: 'Claude (Anthropic)' },
  { id: 'openai', label: 'Codex (OpenAI)' },
  { id: 'google', label: 'Gemini (Google)' },
];

/** Split a space/comma/、-separated mention string into @-prefixed, deduped tokens. */
function parseMentions(raw: string): string[] {
  const tokens = raw
    .split(/[\s,、]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((t) => (t.startsWith('@') ? t : `@${t}`));
  return Array.from(new Set(tokens));
}

interface MemberCreateModalProps {
  readonly client: ApiClient;
  readonly onClose: () => void;
  readonly onSaved: () => Promise<void>;
}

/**
 * 添加成员 modal — collect a NEW member (id/名称/模型/@mention/身份/颜色) and POST it
 * to /api/agents. On success it refetches the roster (the new card + status bar
 * appear live) and closes; on failure it shows the server error and stays open.
 */
function MemberCreateModal(props: MemberCreateModalProps): ReactElement {
  const { client, onClose, onSaved } = props;
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [clientId, setClientId] = useState<NewMemberInput['clientId']>('anthropic');
  const [defaultModel, setDefaultModel] = useState('');
  const [mentionsText, setMentionsText] = useState('');
  const [roleDescription, setRoleDescription] = useState('');
  const [strengthsText, setStrengthsText] = useState('');
  const [primary, setPrimary] = useState('#b9744a');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mentions = parseMentions(mentionsText);
  // Minimal client-side guard; the server re-validates (slug id, ≥1 @mention, unique).
  const canSubmit =
    id.trim().length > 0 && name.trim().length > 0 && defaultModel.trim().length > 0 && mentions.length > 0;

  const save = async (): Promise<void> => {
    setSaving(true);
    setError(null);
    const input: NewMemberInput = {
      id: id.trim(),
      name: name.trim(),
      displayName: displayName.trim().length > 0 ? displayName.trim() : name.trim(),
      clientId,
      defaultModel: defaultModel.trim(),
      mentionPatterns: mentions,
      roleDescription: roleDescription.trim(),
      strengths: parseStrengths(strengthsText),
      color: { primary, secondary: primary },
    };
    try {
      await client.createAgent(input);
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '添加失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="member-edit-overlay"
      data-testid="member-create-modal"
      role="dialog"
      aria-modal="true"
      aria-label="添加成员"
    >
      <div className="member-edit-card" style={{ '--ac': primary } as React.CSSProperties}>
        <div className="member-edit-head">
          <h3>添加成员</h3>
          <button type="button" className="set-close" onClick={onClose} aria-label="关闭添加">
            <IconClose />
          </button>
        </div>
        <label className="member-edit-field">
          <span>ID（小写 slug，如 claude-review）</span>
          <input data-testid="member-create-id" value={id} onChange={(e) => setId(e.target.value)} />
        </label>
        <label className="member-edit-field">
          <span>名称</span>
          <input data-testid="member-create-name" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="member-edit-field">
          <span>昵称 / 显示后缀</span>
          <input
            data-testid="member-create-displayName"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </label>
        <label className="member-edit-field">
          <span>模型 / Provider</span>
          <select
            data-testid="member-create-client"
            value={clientId}
            onChange={(e) => setClientId(e.target.value as NewMemberInput['clientId'])}
          >
            {CLIENT_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="member-edit-field">
          <span>默认模型（如 claude-opus-4-6）</span>
          <input
            data-testid="member-create-model"
            value={defaultModel}
            onChange={(e) => setDefaultModel(e.target.value)}
          />
        </label>
        <label className="member-edit-field">
          <span>@mention（空格或逗号分隔，可多个）</span>
          <input
            data-testid="member-create-mentions"
            value={mentionsText}
            placeholder="@review @审查"
            onChange={(e) => setMentionsText(e.target.value)}
          />
        </label>
        <label className="member-edit-field">
          <span>角色描述 / 身份</span>
          <textarea
            data-testid="member-create-role"
            value={roleDescription}
            onChange={(e) => setRoleDescription(e.target.value)}
          />
        </label>
        <label className="member-edit-field">
          <span>擅长领域（逗号或顿号分隔）</span>
          <input
            data-testid="member-create-strengths"
            value={strengthsText}
            onChange={(e) => setStrengthsText(e.target.value)}
          />
        </label>
        <label className="member-edit-field">
          <span>Background Color</span>
          <input type="color" data-testid="member-create-color" value={primary} onChange={(e) => setPrimary(e.target.value)} />
        </label>
        {error !== null && (
          <div className="member-edit-error" data-testid="member-create-error" role="alert">
            {error}
          </div>
        )}
        <div className="member-edit-actions">
          <button type="button" onClick={onClose} disabled={saving}>
            取消
          </button>
          <button
            type="button"
            className="member-edit-save"
            data-testid="member-create-save"
            disabled={saving || !canSubmit}
            onClick={() => void save()}
          >
            {saving ? '添加中…' : '添加'}
          </button>
        </div>
      </div>
    </div>
  );
}

export interface SettingsOverlayProps {
  readonly onClose: () => void;
  /** API client for member edits (PATCH /api/agents/:id) + roster refetch. */
  readonly client: ApiClient;
  readonly health: HealthInfo;
  readonly socketConnected: boolean;
}

/** The full settings surface. */
export function SettingsOverlay(props: SettingsOverlayProps): ReactElement {
  const { onClose, client, health, socketConnected } = props;
  const roster = useAgentStore((s) => s.roster);
  const statusById = useAgentStore((s) => s.statusById);
  const setRoster = useAgentStore((s) => s.setRoster);
  const [nav, setNav] = useState<SettingsNavId>('members');
  // The member currently being edited (its id; null = no modal open).
  const [editingId, setEditingId] = useState<string | null>(null);
  // Whether the 添加成员 modal is open.
  const [creating, setCreating] = useState(false);

  useOverlayDismiss(true, onClose);

  // After a successful PATCH/POST/DELETE, refetch the roster so the cards + status
  // bar reflect the change live (the store seeds new statuses, preserving live ones).
  const refetchRoster = async (): Promise<void> => {
    const agents = await client.listAgents();
    setRoster(agents);
  };

  // Delete a runtime-added member (after a confirm), then refetch the roster.
  const deleteMember = async (entry: AgentRosterEntry): Promise<void> => {
    // eslint-disable-next-line no-alert -- a destructive action deserves a confirm
    if (!window.confirm(`删除成员「${shortName(entry)}」？此操作不可撤销。`)) return;
    try {
      await client.deleteAgent(entry.id);
      await refetchRoster();
    } catch {
      // A failed delete leaves the roster as-is; the card stays. (Best-effort.)
    }
  };

  const editingEntry =
    editingId === null ? undefined : roster.find((e) => e.id === editingId);
  const head = PANE_HEAD[nav];

  let pane: ReactElement;
  switch (nav) {
    case 'members':
      pane = (
        <div className="settings-members-pane" data-testid="settings-members-pane">
          <div className="member-pane-bar">
            <button
              type="button"
              className="member-add-btn"
              data-testid="member-create-open"
              onClick={() => setCreating(true)}
            >
              ＋ 添加成员
            </button>
          </div>
          <div className="set-grid2" data-testid="settings-members">
            {roster.map((entry) => {
              const statusValue = statusById[entry.id] ?? entry.status;
              return (
                <MemberCard
                  key={entry.id}
                  entry={entry}
                  status={statusPresentation(statusValue)}
                  statusValue={statusValue}
                  onEdit={(e) => setEditingId(e.id)}
                  onDelete={(e) => void deleteMember(e)}
                />
              );
            })}
            {roster.length === 0 && <div className="set-soon">未加载到 agent 名册。</div>}
          </div>
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
      {editingEntry !== undefined && (
        <MemberEditModal
          entry={editingEntry}
          client={client}
          onClose={() => setEditingId(null)}
          onSaved={refetchRoster}
        />
      )}
      {creating && (
        <MemberCreateModal
          client={client}
          onClose={() => setCreating(false)}
          onSaved={refetchRoster}
        />
      )}
    </div>
  );
}
