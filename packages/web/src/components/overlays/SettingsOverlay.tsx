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
//   • Skill 管理 / 规则与SOP / MCP 管理 — LIVE (read-only): the real skill manifest
//     (GET /api/skills), the loaded SOP definition (GET /api/sop), and the MCP tool
//     catalog (GET /api/mcp/tools). Browse-only; editing/management is unbuilt.
//   • 账户与密钥 / 能力市场 / 通知 — HONEST PLACEHOLDER: no backend yet, each shows a
//     clearly-marked "未接入" note. We never fabricate accounts / usage numbers.
//
// Visual ported from directions.css `.set-*`.

import { useEffect, useState, type ReactElement } from 'react';
import type {
  SkillDefinition,
  SopDefinition,
  AccountSummary,
  ClientId,
  ProviderAuthStatus,
} from '@choco/shared';
import { useAgentStore } from '../../stores/agent-store.js';
import type {
  AgentRosterEntry,
  AgentUpdatePatch,
  ApiClient,
  McpToolEntry,
  NewMemberInput,
} from '../../lib/api.js';
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

/** Sentinel category = "all skills" (no group filter). */
const ALL_SKILL_CATEGORIES = '全部';

/**
 * Skill 管理 — the loaded skill manifest (M11), Clowder-style: a 同步 bar (re-reads
 * the local manifest from disk) + a 分类 filter (by the manifest `group`) + the
 * skill cards. Read-only browse (editing/preview is a separate, unbuilt concern).
 */
function SkillPane({ client }: { readonly client: ApiClient }): ReactElement {
  const [skills, setSkills] = useState<readonly SkillDefinition[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [activeCat, setActiveCat] = useState(ALL_SKILL_CATEGORIES);

  useEffect(() => {
    let cancelled = false;
    void client.listSkills().then(
      (s) => !cancelled && setSkills(s),
      (e) => !cancelled && setError(e instanceof Error ? e.message : '加载失败'),
    );
    return () => {
      cancelled = true;
    };
  }, [client]);

  const sync = async (): Promise<void> => {
    setSyncing(true);
    setError(null);
    try {
      setSkills(await client.syncSkills());
    } catch (e) {
      setError(e instanceof Error ? e.message : '同步失败');
    } finally {
      setSyncing(false);
    }
  };

  if (skills === null) {
    return <div className="set-soon">{error !== null ? `加载失败：${error}` : '加载中…'}</div>;
  }

  const groups = Array.from(
    new Set(skills.map((s) => s.group).filter((g): g is string => g !== undefined)),
  ).sort();
  const categories = [ALL_SKILL_CATEGORIES, ...groups];
  const countIn = (c: string): number =>
    c === ALL_SKILL_CATEGORIES ? skills.length : skills.filter((s) => s.group === c).length;
  const filtered =
    activeCat === ALL_SKILL_CATEGORIES ? skills : skills.filter((s) => s.group === activeCat);

  return (
    <div className="set-pane-body" data-testid="settings-skill">
      <div className="skill-bar">
        <span className="set-row-s">{skills.length} 个 skill · 本地清单</span>
        <button
          type="button"
          className="skill-sync"
          data-testid="skill-sync"
          disabled={syncing}
          onClick={() => void sync()}
          title="重新从磁盘加载 manifest / skill 文件（本地清单，非远程市场）"
        >
          {syncing ? '同步中…' : '↻ 同步'}
        </button>
      </div>
      {error !== null && <div className="member-edit-error">同步失败：{error}</div>}

      <div className="skill-cats" data-testid="skill-categories" role="tablist">
        {categories.map((c) => (
          <button
            key={c}
            type="button"
            role="tab"
            aria-selected={activeCat === c}
            className={`skill-cat${activeCat === c ? ' on' : ''}`}
            data-testid={`skill-cat-${c}`}
            onClick={() => setActiveCat(c)}
          >
            {c} ({countIn(c)})
          </button>
        ))}
      </div>

      {filtered.length === 0 && <div className="set-soon">该分类下没有 skill。</div>}
      {filtered.map((s) => (
        <div key={s.id} className="set-card" data-testid="skill-row" data-skill={s.id} data-group={s.group}>
          <div className="set-card-t">
            {s.id}
            {s.group !== undefined && <span className="schip skill-group">{s.group}</span>}
          </div>
          <div className="set-row-s">{s.description}</div>
          <div className="si-chips">
            {s.triggers.slice(0, 6).map((t) => (
              <span key={t} className="schip">
                {t}
              </span>
            ))}
          </div>
          {s.sopStep !== null && <div className="set-mono dim">SOP 阶段 · {s.sopStep}</div>}
        </div>
      ))}
    </div>
  );
}

/** A severity badge for a SOP rule/pitfall (blocker = 阻断, warn = 警告). */
function SevBadge({ severity }: { readonly severity: 'blocker' | 'warn' }): ReactElement {
  return <span className={`sop-sev sop-sev--${severity}`}>{severity === 'blocker' ? '阻断' : '警告'}</span>;
}

/** A labelled list of SOP rules (硬规则 / 常见坑) with severity + text. */
function SopRuleList({
  title,
  rules,
  testid,
}: {
  readonly title: string;
  readonly rules: SopDefinition['stages'][number]['hardRules'];
  readonly testid: string;
}): ReactElement | null {
  if (rules.length === 0) return null;
  return (
    <div className="sop-rules">
      <div className="sop-rules-h">{title}</div>
      {rules.map((r) => (
        <div key={r.id} className="sop-rule" data-testid={testid}>
          <SevBadge severity={r.severity} />
          <span className="sop-rule-t">{r.text}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * 规则与 SOP (M12) — the loaded SOP, Clowder-style: a consumption note (the SOP is a
 * hint 告示牌, NOT a hard gate) + each stage's ACTUAL hard rules + pitfalls with their
 * text and severity (not just counts). Read-only.
 */
function SopPane({ client }: { readonly client: ApiClient }): ReactElement {
  const [sop, setSop] = useState<SopDefinition | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void client.getSop().then(
      (d) => !cancelled && setSop(d),
      (e) => !cancelled && setError(e instanceof Error ? e.message : '加载失败'),
    );
    return () => {
      cancelled = true;
    };
  }, [client]);
  if (sop === null) {
    return <div className="set-soon">{error !== null ? `加载失败：${error}` : '加载中…'}</div>;
  }
  return (
    <div className="set-pane-body" data-testid="settings-rules">
      <div className="set-card">
        <div className="set-card-t">
          {sop.label} <span className="set-mono dim">{sop.domain}</span>
        </div>
        {sop.description !== undefined && (
          <div className="set-row-s" data-testid="sop-consumption">{sop.description}</div>
        )}
        <div className="si-chips">
          <span className="schip">{sop.stages.length} 阶段</span>
        </div>
      </div>
      {sop.stages.map((st) => (
        <div key={st.id} className="set-card" data-testid="sop-stage" data-stage={st.id}>
          <div className="set-card-t">
            {st.label} <span className="set-mono dim">{st.id}</span>
            {st.suggestedSkill !== undefined && (
              <span className="schip skill-group">skill · {st.suggestedSkill}</span>
            )}
          </div>
          <SopRuleList title="硬规则" rules={st.hardRules} testid="sop-rule" />
          <SopRuleList title="常见坑" rules={st.pitfalls} testid="sop-pitfall" />
        </div>
      ))}
    </div>
  );
}

/**
 * MCP 管理 (M10) — Clowder-style server-centric: the tools the agents can call are
 * grouped UNDER their MCP server. We ship ONE built-in stdio server (choco mcp-server);
 * external MCP install/config is honestly noted as not-yet-backed.
 */
function McpPane({ client }: { readonly client: ApiClient }): ReactElement {
  const [tools, setTools] = useState<readonly McpToolEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void client.listMcpTools().then(
      (t) => !cancelled && setTools(t),
      (e) => !cancelled && setError(e instanceof Error ? e.message : '加载失败'),
    );
    return () => {
      cancelled = true;
    };
  }, [client]);
  if (tools === null) {
    return <div className="set-soon">{error !== null ? `加载失败：${error}` : '加载中…'}</div>;
  }
  return (
    <div className="set-pane-body" data-testid="settings-mcp">
      <div className="set-card mcp-server" data-testid="mcp-server" data-server="builtin">
        <div className="set-card-t">
          内置 MCP 服务 <span className="schip">{tools.length} 工具</span>
        </div>
        <div className="set-row-s set-mono dim">stdio · node（choco mcp-server）</div>
        <div className="mcp-tools">
          {tools.map((t) => (
            <div key={t.name} className="mcp-tool" data-testid="mcp-tool" data-tool={t.name}>
              <span className="set-mono mcp-tool-n">{t.name}</span>
              <span className="set-row-s">{t.description}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="set-soon">仅内置 MCP 服务；外部 MCP 的安装 / 配置尚未接入后端。</div>
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

/** Provider labels for the account pane (clientId → human name). */
const ACCOUNT_PROVIDER_LABEL: Readonly<Record<ClientId, string>> = {
  anthropic: 'Claude (Anthropic)',
  openai: 'Codex (OpenAI)',
  google: 'Gemini (Google)',
};

/** One account card: shows the masked state + inline key-update + delete. */
function AccountCard(props: {
  readonly account: AccountSummary;
  readonly onSaveKey: (id: string, apiKey: string) => Promise<void>;
  readonly onDelete: (id: string) => Promise<void>;
}): ReactElement {
  const { account, onSaveKey, onDelete } = props;
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  return (
    <div className="set-card" data-testid="account-row" data-account={account.id} data-client={account.clientId}>
      <div className="set-card-t">
        {account.displayName}
        <span className="schip">{ACCOUNT_PROVIDER_LABEL[account.clientId]}</span>
        <span className="schip">{account.authType === 'api_key' ? 'API Key' : 'OAuth'}</span>
        <span
          className="schip"
          data-testid="account-haskey"
          data-haskey={account.hasApiKey ? 'true' : 'false'}
          style={{ color: account.hasApiKey ? 'var(--st-idle)' : 'var(--ink-3)' }}
        >
          {account.hasApiKey ? '✓ 已配置密钥' : '无密钥'}
        </span>
      </div>
      {account.baseUrl !== undefined && account.baseUrl.length > 0 && (
        <div className="set-mono dim" data-testid="account-baseurl">{account.baseUrl}</div>
      )}
      {account.models !== undefined && account.models.length > 0 && (
        <div className="si-chips">
          {account.models.map((m) => (
            <span key={m} className="schip">{m}</span>
          ))}
        </div>
      )}
      <div className="acct-row">
        <input
          className="acct-input"
          type="password"
          autoComplete="off"
          placeholder={account.hasApiKey ? '输入新密钥以替换' : '粘贴 API key，如 sk-…'}
          data-testid="account-key-input"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        <button
          type="button"
          className="acct-btn"
          data-testid="account-key-save"
          disabled={saving || key.trim().length === 0}
          onClick={() => {
            setSaving(true);
            void onSaveKey(account.id, key.trim()).finally(() => {
              setSaving(false);
              setKey('');
            });
          }}
        >
          {saving ? '保存中…' : '保存密钥'}
        </button>
        <button
          type="button"
          className="acct-btn acct-btn--danger"
          data-testid="account-delete"
          onClick={() => void onDelete(account.id)}
        >
          删除
        </button>
      </div>
    </div>
  );
}

/** Human status line for one provider's OAuth/login state. */
function authStatusLabel(p: ProviderAuthStatus): string {
  if (!p.available) return `未安装 ${p.cli}`;
  if (p.loggedIn === true) return p.detail !== undefined ? `✓ 已登录 · ${p.detail}` : '✓ 已登录';
  if (p.loggedIn === false) return '未登录';
  return p.detail ?? '状态未知';
}

/**
 * 订阅 / OAuth 登录 — the login half of 账户与密钥. Each provider authenticates via its
 * OWN CLI (claude 订阅、codex、gemini Google OAuth); we surface its login status and
 * trigger `login`/`logout`. The browser flow is the CLI's; the user finishes it
 * there, then 刷新. gemini has no CLI login (OAuth is implicit) — we say so honestly.
 */
function ProviderAuthSection({ client }: { readonly client: ApiClient }): ReactElement {
  const [providers, setProviders] = useState<readonly ProviderAuthStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<ClientId | null>(null);

  const load = (): void => {
    void client.getAuthStatus().then(
      (p) => setProviders(p),
      (e) => setError(e instanceof Error ? e.message : '加载失败'),
    );
  };
  useEffect(() => {
    let cancelled = false;
    void client.getAuthStatus().then(
      (p) => !cancelled && setProviders(p),
      (e) => !cancelled && setError(e instanceof Error ? e.message : '加载失败'),
    );
    return () => {
      cancelled = true;
    };
  }, [client]);

  const act = async (id: ClientId, fn: () => Promise<void>): Promise<void> => {
    setBusyId(id);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败');
    } finally {
      setBusyId(null);
      load();
    }
  };

  return (
    <div className="set-card" data-testid="provider-auth">
      <div className="set-card-t">订阅 / OAuth 登录</div>
      <div className="set-row-s">
        用 provider 自己的账号登录（claude 订阅 / codex / gemini）。登录在浏览器里完成，完成后点「刷新」看状态。
        这是 API key 之外的另一条路：已登录就不必再填 key。
      </div>
      {error !== null && <div className="member-edit-error">{error}</div>}
      {providers === null && <div className="set-soon">加载登录状态…</div>}
      {providers?.map((p) => (
        <div
          className="acct-auth-row"
          data-testid="provider-auth-row"
          data-client={p.clientId}
          data-loggedin={String(p.loggedIn)}
          key={p.clientId}
        >
          <span className="acct-auth-name">{ACCOUNT_PROVIDER_LABEL[p.clientId]}</span>
          <span
            className="acct-auth-status"
            style={{ color: p.loggedIn === true ? 'var(--st-idle)' : 'var(--ink-3)' }}
          >
            {authStatusLabel(p)}
          </span>
          {p.available && p.supportsLogin && p.loggedIn === true && (
            <button
              type="button"
              className="acct-btn acct-btn--danger"
              data-testid="provider-logout"
              disabled={busyId === p.clientId}
              onClick={() => void act(p.clientId, () => client.providerLogout(p.clientId))}
            >
              {busyId === p.clientId ? '…' : '登出'}
            </button>
          )}
          {p.available && p.supportsLogin && p.loggedIn !== true && (
            <button
              type="button"
              className="acct-btn"
              data-testid="provider-login"
              disabled={busyId === p.clientId}
              onClick={() => void act(p.clientId, () => client.providerLogin(p.clientId))}
            >
              {busyId === p.clientId ? '启动中…' : '登录'}
            </button>
          )}
        </div>
      ))}
      <button
        type="button"
        className="acct-btn"
        data-testid="provider-auth-refresh"
        onClick={load}
        style={{ marginTop: '8px' }}
      >
        ↻ 刷新状态
      </button>
    </div>
  );
}

/**
 * 账户与密钥 — provider accounts (Anthropic/OpenAI/Google) with optional BYOK keys.
 * The key is write-only: the list shows `hasApiKey` only, never the key. A saved
 * key is injected into that provider's CLI spawn env on the next turn.
 */
function AccountsPane({ client }: { readonly client: ApiClient }): ReactElement {
  const [accounts, setAccounts] = useState<readonly AccountSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [clientId, setClientId] = useState<ClientId>('openai');
  const [displayName, setDisplayName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');

  useEffect(() => {
    let cancelled = false;
    void client.listAccounts().then(
      (a) => !cancelled && setAccounts(a),
      (e) => !cancelled && setError(e instanceof Error ? e.message : '加载失败'),
    );
    return () => {
      cancelled = true;
    };
  }, [client]);

  const reload = async (): Promise<void> => {
    try {
      setAccounts(await client.listAccounts());
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败');
    }
  };

  const create = async (): Promise<void> => {
    if (displayName.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await client.createAccount({
        clientId,
        displayName: displayName.trim(),
        ...(apiKey.length > 0 ? { apiKey } : {}),
        ...(baseUrl.trim().length > 0 ? { baseUrl: baseUrl.trim() } : {}),
      });
      setDisplayName('');
      setApiKey('');
      setBaseUrl('');
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : '创建失败');
    } finally {
      setBusy(false);
    }
  };

  const saveKey = async (id: string, key: string): Promise<void> => {
    try {
      await client.updateAccount(id, { apiKey: key });
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : '保存失败');
    }
  };

  const remove = async (id: string): Promise<void> => {
    // eslint-disable-next-line no-alert -- deleting a credential deserves a confirm
    if (!window.confirm(`删除账户「${id}」及其密钥？此操作不可撤销。`)) return;
    try {
      await client.deleteAccount(id);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败');
    }
  };

  return (
    <div className="set-pane-body" data-testid="settings-accounts">
      <ProviderAuthSection client={client} />
      <div className="set-card" data-testid="account-create-form">
        <div className="set-card-t">添加账户（API Key）</div>
        <div className="set-row-s">
          为某个 provider 配置 API key（BYOK）。密钥只写不读：保存后只显示「已配置」，下一轮该
          agent 的 CLI 会带上它。不填密钥 = 仍用该 CLI 自己的登录。
        </div>
        <div className="acct-form">
          <select
            className="acct-input"
            data-testid="account-clientid"
            value={clientId}
            onChange={(e) => setClientId(e.target.value as ClientId)}
          >
            {(['anthropic', 'openai', 'google'] as const).map((c) => (
              <option key={c} value={c}>
                {ACCOUNT_PROVIDER_LABEL[c]}
              </option>
            ))}
          </select>
          <input
            className="acct-input"
            placeholder="账户显示名，如 my-openai"
            data-testid="account-displayname"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
          <input
            className="acct-input"
            placeholder="Base URL（可选，自建/代理端点）"
            data-testid="account-baseurl-input"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
          />
          <input
            className="acct-input"
            type="password"
            autoComplete="off"
            placeholder="API key（可选），如 sk-…"
            data-testid="account-apikey"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
          />
          <button
            type="button"
            className="member-add-btn"
            data-testid="account-create-submit"
            disabled={busy || displayName.trim().length === 0}
            onClick={() => void create()}
          >
            {busy ? '创建中…' : '＋ 创建账户'}
          </button>
        </div>
      </div>

      {error !== null && <div className="member-edit-error">{error}</div>}

      {accounts === null && <div className="set-soon">加载中…</div>}
      {accounts !== null && accounts.length === 0 && (
        <div className="set-soon" data-testid="accounts-empty">
          还没有配置任何 provider 账户。agent 当前各自使用 CLI 的环境鉴权。
        </div>
      )}
      {accounts?.map((a) => (
        <AccountCard key={a.id} account={a} onSaveKey={saveKey} onDelete={remove} />
      ))}
    </div>
  );
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
      pane = <AccountsPane client={client} />;
      break;
    case 'skill':
      pane = <SkillPane client={client} />;
      break;
    case 'mcp':
      pane = <McpPane client={client} />;
      break;
    case 'market':
      pane = <SoonCard note="能力市场尚未接入。" />;
      break;
    case 'notif':
      pane = <SoonCard note="通知偏好尚未接入持久化后端。" />;
      break;
    case 'rules':
      pane = <SopPane client={client} />;
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
