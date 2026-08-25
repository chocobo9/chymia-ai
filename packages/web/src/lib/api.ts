// M9 HTTP API client — thin typed wrapper over the M8 REST surface (§C1).
//
// Frozen routes (do NOT re-derive):
//   GET    /api/threads                       → { threads: Thread[] }
//   POST   /api/threads                       → Thread (201)
//   GET    /api/threads/:id                   → Thread
//   PATCH  /api/threads/:id                   → Thread (rename, { title })
//   DELETE /api/threads/:id                   → { deleted, id }
//   GET    /api/threads/:id/messages          → { messages: StoredMessage[] }
//   POST   /api/threads/:id/messages          → { userMessage, replies }  (SYNCHRONOUS)
//   GET    /api/agents                        → { agents: AgentListEntry[] }
//   GET    /api/agents/:id/status             → { id, status }
//   POST   /api/evidence/search               → EvidenceSearchResult
//
// CRITICAL (G8): POST /messages resolves only AFTER the agent finishes. The UI
// renders incrementally from `agent_event` socket frames during the turn; this
// client's POST result is used only to reconcile the final persisted state.

import type {
  AgentColor,
  ClientId,
  AgentStatus,
  StoredMessage,
  Thread,
  EvidenceSearchOptions,
  EvidenceSearchResult,
  SessionRecord,
  SessionDigest,
  SessionEvent,
  AuditEvent,
  SkillDefinition,
  SopDefinition,
  RulesPayload,
  AccountSummary,
  AuthType,
  ProviderAuthStatus,
  WeChatSettingsView,
  TaskItem,
  TaskStatus,
  TaskProgressSnapshot,
} from '@choco/shared';

/** One MCP tool's catalog entry (GET /api/mcp/tools). */
export interface McpToolEntry {
  readonly name: string;
  readonly description: string;
}

/** One entry in a workspace directory listing (GET /api/workspace/tree). */
export interface WorkspaceTreeEntry {
  readonly name: string;
  readonly type: 'directory' | 'file';
  /** Workspace-root-relative path (forward slashes). */
  readonly path: string;
}

export interface WorkspaceInfo {
  readonly root: string;
  readonly trusted: boolean;
  readonly rootSource: string;
  readonly gitAvailable: boolean;
  readonly branch: string;
}

export interface WorkspaceFilePreview {
  readonly path: string;
  readonly content: string;
  readonly sha256: string;
  readonly size: number;
  readonly mime: string;
  readonly truncated: boolean;
  readonly binary: boolean;
}

export interface WorkspaceSearchResult {
  readonly path: string;
  readonly line: number;
  readonly content: string;
  readonly contextBefore: readonly string[];
  readonly contextAfter: readonly string[];
  readonly matchType: 'filename' | 'content';
}

export type WorkspaceSearchType = 'filename' | 'content' | 'all';

/** A commit row (GET /api/workspace/git-log). */
export interface GitCommitEntry {
  readonly hash: string;
  readonly short: string;
  readonly author: string;
  readonly date: string;
  readonly subject: string;
}

/** A working-tree status entry (status code + path). */
export interface GitStatusEntry {
  readonly status: string;
  readonly path: string;
}

/** One file's change summary under a commit (GET /api/workspace/git-show). */
export interface GitShowFile {
  readonly path: string;
  readonly summary: string;
}

/** A commit's changed-file list (GET /api/workspace/git-show). */
export interface GitShowResult {
  readonly hash: string;
  readonly files: readonly GitShowFile[];
  readonly gitAvailable: boolean;
}

/** Working-tree status (GET /api/workspace/git-status). */
export interface GitStatusView {
  readonly branch: string;
  readonly staged: readonly GitStatusEntry[];
  readonly unstaged: readonly GitStatusEntry[];
  readonly untracked: readonly GitStatusEntry[];
  /** False when the workspace is not a git repo / git is unavailable (honest, not faked). */
  readonly gitAvailable: boolean;
}

/** Changed files + unified diff (GET /api/workspace/diff). */
export interface WorkspaceDiffView {
  readonly changedFiles: readonly GitStatusEntry[];
  readonly diff: string;
  readonly gitAvailable: boolean;
}

/** A session-chain row enriched with its digest (sealed → stored; active → live). */
export interface SessionChainEntry extends Omit<SessionRecord, 'digest'> {
  readonly digest: SessionDigest | null;
}

/** A skill in the catalog plus its on/off state (GET /api/skills). */
export interface SkillListEntry extends SkillDefinition {
  readonly enabled: boolean;
}

/**
 * TrustStatus — GET/POST /api/trust payload. `workspace` is the directory agents
 * run their CLIs in (null when none is configured); `trusted` gates whether the
 * providers' trust env is set (gemini's headless auto-approve).
 */
export interface TrustStatus {
  readonly workspace: string | null;
  readonly trusted: boolean;
}

/** Body for POST /api/accounts (create a provider account, optional BYOK key). */
export interface CreateAccountBody {
  readonly clientId: ClientId;
  readonly authType?: AuthType;
  readonly displayName: string;
  readonly baseUrl?: string;
  readonly models?: readonly string[];
  readonly apiKey?: string;
}

/**
 * 飞书 region/gateway domain — 'feishu' = 飞书 China (open.feishu.cn),
 * 'lark' = Lark International (open.larksuite.com). Mirrors the backend union
 * (config/feishu-config-store.ts); the web layer keeps its own DTO copy, as it
 * does for the other Feishu view/patch types here.
 */
export type FeishuDomain = 'feishu' | 'lark';

/** GET /api/adapters/feishu/config payload — masked (no app_secret). */
export interface FeishuConfigView {
  readonly appId: string;
  readonly enabled: boolean;
  readonly hasAppSecret: boolean;
  readonly domain: FeishuDomain;
  readonly ready: boolean;
}

/** GET /api/adapters/feishu/status payload. */
export interface FeishuConnStatus {
  readonly connected: boolean;
  readonly ready: boolean;
}

/** Body for PUT /api/adapters/feishu/config (empty appSecret clears it). */
export interface FeishuConfigPatch {
  readonly appId?: string;
  readonly appSecret?: string;
  readonly enabled?: boolean;
  readonly domain?: FeishuDomain;
}

/** POST /api/adapters/weixin/login/start payload — the QR to render + poll. */
export interface WeixinQr {
  readonly qrUrl: string;
  readonly qrPayload: string;
}

/** GET /api/adapters/weixin/login/status payload. */
export interface WeixinLoginStatus {
  readonly status: 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'error';
  readonly message?: string;
}

/** GET /api/adapters/weixin/status payload. */
export interface WeixinConnStatus {
  readonly connected: boolean;
  readonly hasToken: boolean;
}

/** Body for PUT /api/adapters/wechat/config (empty secret string clears it). */
export interface WeChatConfigPatch {
  readonly corpId?: string;
  readonly agentId?: string;
  readonly token?: string;
  readonly apiBase?: string;
  readonly enabled?: boolean;
  readonly secret?: string;
  readonly encodingAesKey?: string;
}

/** Body for PATCH /api/accounts/:id (empty apiKey string clears the stored key). */
export interface UpdateAccountBody {
  readonly displayName?: string;
  readonly authType?: AuthType;
  readonly baseUrl?: string;
  readonly models?: readonly string[];
  readonly apiKey?: string;
}
import { webConfig } from './config.js';

/**
 * AgentRosterEntry — the per-agent payload returned by GET /api/agents (§C6).
 * Mirrors the M8 agent-routes AgentListEntry shape exactly.
 */
export interface AgentRosterEntry {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly clientId: ClientId;
  readonly color: AgentColor;
  readonly mentionPatterns: readonly string[];
  readonly strengths: readonly string[];
  readonly status: AgentStatus;
  /** True for a runtime-ADDED member (deletable); absent/false for a base member. */
  readonly removable?: boolean;
}

/** Body for POST /api/agents — a NEW member to add at runtime (成员增删). */
export interface NewMemberInput {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly clientId: ClientId;
  readonly defaultModel: string;
  readonly mcpSupport?: boolean;
  readonly mentionPatterns: readonly string[];
  readonly personality?: string;
  readonly roleDescription?: string;
  readonly strengths?: readonly string[];
  readonly color: AgentColor;
}

/**
 * AgentUpdatePatch — the editable member fields for PATCH /api/agents/:id
 * (M-MEMBER). All optional (only what changed is sent). Mirrors the backend
 * AgentOverride shape; clientId/mentionPatterns/defaultModel/mcpSupport are
 * intentionally NOT editable (the registry + providers are built once at boot).
 */
export interface AgentUpdatePatch {
  readonly displayName?: string;
  readonly name?: string;
  readonly roleDescription?: string;
  readonly personality?: string;
  readonly strengths?: readonly string[];
  readonly color?: AgentColor;
}

/** Body for POST /api/threads. */
export interface CreateThreadInput {
  readonly title?: string;
  readonly projectPath?: string;
  readonly thinkingMode?: Thread['thinkingMode'];
}

/** Body for POST /api/threads/:id/messages. */
export interface SendMessageInput {
  readonly content: string;
  readonly userId?: string;
}

/** Synchronous result of POST /api/threads/:id/messages (resolves post-turn). */
export interface SendMessageResult {
  readonly userMessage: StoredMessage;
  readonly replies: readonly StoredMessage[];
}

/** Payload returned by GET /health (mirrors the M8 health-routes shape). */
export interface HealthPayload {
  readonly status: 'ok';
  /** Process uptime in milliseconds. */
  readonly uptimeMs: number;
  /** Wall-clock time the health check was served (epoch ms). */
  readonly timestamp: number;
}

/** Raised when an API call returns a non-2xx status. */
export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** The injectable fetch surface (lets tests pass a fake without globals). */
export type FetchFn = (input: string, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  readonly baseUrl?: string;
  readonly fetchFn?: FetchFn;
}

async function parseJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(res.status, text.length > 0 ? text : `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

/**
 * ApiClient — all HTTP calls the web app makes. Constructed with an optional
 * baseUrl + fetch (defaults: webConfig.apiUrl + the global fetch), so it is
 * trivially testable by injecting a fake fetch.
 */
export class ApiClient {
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = options.baseUrl ?? webConfig.apiUrl;
    this.fetchFn = options.fetchFn ?? ((input, init) => fetch(input, init));
  }

  private url(path: string): string {
    return `${this.baseUrl}${path}`;
  }

  private jsonInit(method: string, body?: unknown): RequestInit {
    // A bodyless mutation (seal / reopen / deleteThread) must NOT declare a JSON
    // content-type: Fastify's body parser then rejects it 400 with
    // FST_ERR_CTP_EMPTY_JSON_BODY ("Body cannot be empty when content-type is set
    // to 'application/json'"). Only attach the header + serialized body when a body
    // is actually present.
    if (body === undefined) {
      return { method };
    }
    return {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    };
  }

  async listThreads(): Promise<readonly Thread[]> {
    const res = await this.fetchFn(this.url('/api/threads'));
    const data = await parseJson<{ threads: Thread[] }>(res);
    return data.threads;
  }

  async createThread(input: CreateThreadInput = {}): Promise<Thread> {
    const res = await this.fetchFn(this.url('/api/threads'), this.jsonInit('POST', input));
    return parseJson<Thread>(res);
  }

  async getThread(id: string): Promise<Thread> {
    const res = await this.fetchFn(this.url(`/api/threads/${id}`));
    return parseJson<Thread>(res);
  }

  async deleteThread(id: string): Promise<void> {
    const res = await this.fetchFn(this.url(`/api/threads/${id}`), this.jsonInit('DELETE'));
    await parseJson<{ deleted: boolean; id: string }>(res);
  }

  /** PATCH /api/threads/:id — inline rename; returns the updated thread. */
  async renameThread(id: string, title: string): Promise<Thread> {
    const res = await this.fetchFn(
      this.url(`/api/threads/${id}`),
      this.jsonInit('PATCH', { title }),
    );
    return parseJson<Thread>(res);
  }

  async getMessages(threadId: string, limit?: number): Promise<readonly StoredMessage[]> {
    const query = limit === undefined ? '' : `?limit=${limit}`;
    const res = await this.fetchFn(this.url(`/api/threads/${threadId}/messages${query}`));
    const data = await parseJson<{ messages: StoredMessage[] }>(res);
    return data.messages;
  }

  async sendMessage(threadId: string, input: SendMessageInput): Promise<SendMessageResult> {
    const res = await this.fetchFn(
      this.url(`/api/threads/${threadId}/messages`),
      this.jsonInit('POST', input),
    );
    return parseJson<SendMessageResult>(res);
  }

  async listAgents(): Promise<readonly AgentRosterEntry[]> {
    const res = await this.fetchFn(this.url('/api/agents'));
    const data = await parseJson<{ agents: AgentRosterEntry[] }>(res);
    return data.agents;
  }

  /**
   * PATCH /api/agents/:id — edit a member (M-MEMBER). Sends the changed fields,
   * returns the updated AgentRosterEntry (the backend responds with the merged
   * { agent }, the same AgentListEntry shape GET /api/agents returns).
   */
  async updateAgent(id: string, patch: AgentUpdatePatch): Promise<AgentRosterEntry> {
    const res = await this.fetchFn(
      this.url(`/api/agents/${id}`),
      this.jsonInit('PATCH', patch),
    );
    const data = await parseJson<{ agent: AgentRosterEntry }>(res);
    return data.agent;
  }

  /** POST /api/agents — add a new member at runtime (成员增删). Returns the created entry. */
  async createAgent(input: NewMemberInput): Promise<AgentRosterEntry> {
    const res = await this.fetchFn(this.url('/api/agents'), this.jsonInit('POST', input));
    const data = await parseJson<{ agent: AgentRosterEntry }>(res);
    return data.agent;
  }

  /** DELETE /api/agents/:id — remove a runtime-added member. */
  async deleteAgent(id: string): Promise<void> {
    const res = await this.fetchFn(this.url(`/api/agents/${id}`), this.jsonInit('DELETE'));
    await parseJson<{ deleted: boolean; id: string }>(res);
  }

  async searchEvidence(
    query: string,
    options: EvidenceSearchOptions = {},
  ): Promise<EvidenceSearchResult> {
    const res = await this.fetchFn(
      this.url('/api/evidence/search'),
      this.jsonInit('POST', { query, ...options }),
    );
    return parseJson<EvidenceSearchResult>(res);
  }

  /** GET /health — liveness probe used by the connection strip (degraded vs ok). */
  async health(): Promise<HealthPayload> {
    const res = await this.fetchFn(this.url('/health'));
    return parseJson<HealthPayload>(res);
  }

  /**
   * POST /api/workspace/reveal — open a workspace file the agent wrote, either
   * with its default app ('open') or revealed in the OS file manager ('reveal').
   * Sandboxed server-side to the workspace root. Resolves on success; throws
   * ApiError on a non-2xx (e.g. 403 outside-root, 404 missing).
   */
  async revealFile(path: string, action: 'open' | 'reveal'): Promise<void> {
    const res = await this.fetchFn(
      this.url('/api/workspace/reveal'),
      this.jsonInit('POST', { path, action }),
    );
    await parseJson<{ ok: boolean }>(res);
  }

  /**
   * GET /api/workspace/file — fetch a workspace file's text content for the in-app
   * preview (e.g. an agent-written HTML viz). Sandboxed + size-capped server-side.
   * Returns the content string; throws ApiError on non-2xx (403/404/413).
   */
  async getWorkspaceFile(path: string): Promise<WorkspaceFilePreview> {
    const res = await this.fetchFn(this.url(`/api/workspace/file?path=${encodeURIComponent(path)}`));
    return parseJson<WorkspaceFilePreview>(res);
  }

  async uploadWorkspaceFile(input: {
    readonly directory?: string;
    readonly filename: string;
    readonly contentBase64: string;
    readonly overwrite?: boolean;
  }): Promise<{ readonly ok: boolean; readonly path: string; readonly size: number; readonly sha256: string }> {
    const res = await this.fetchFn(this.url('/api/workspace/upload'), this.jsonInit('POST', input));
    return parseJson<{ ok: boolean; path: string; size: number; sha256: string }>(res);
  }

  /** GET /api/threads/:id/sessions — the thread's session chain (each with a digest). */
  async getSessions(threadId: string): Promise<readonly SessionChainEntry[]> {
    const res = await this.fetchFn(this.url(`/api/threads/${threadId}/sessions`));
    const data = await parseJson<{ sessions: SessionChainEntry[] }>(res);
    return data.sessions;
  }

  /** GET /api/sessions/:id/transcript — a session's merged messages + tool events. */
  async getSessionTranscript(sessionId: string): Promise<readonly SessionEvent[]> {
    const res = await this.fetchFn(this.url(`/api/sessions/${sessionId}/transcript`));
    const data = await parseJson<{ events: SessionEvent[] }>(res);
    return data.events;
  }

  /** POST /api/sessions/:id/seal — force-close a LIVE session; returns its new status. */
  async sealSession(sessionId: string): Promise<{ status: string }> {
    const res = await this.fetchFn(this.url(`/api/sessions/${sessionId}/seal`), this.jsonInit('POST'));
    return parseJson<{ status: string }>(res);
  }

  /**
   * POST /api/sessions/:id/reopen — reopen a SEALED session as the live one (the
   * next turn for that agent resumes it). Seals the current active first server-side.
   */
  async reopenSession(sessionId: string): Promise<{ status: string }> {
    const res = await this.fetchFn(this.url(`/api/sessions/${sessionId}/reopen`), this.jsonInit('POST'));
    return parseJson<{ status: string }>(res);
  }

  /**
   * GET /api/trust — the workspace-trust status (VSCode-style). `workspace` is the
   * directory agents run their CLIs in; `trusted` gates gemini's headless
   * auto-approve. `workspace: null` (no workspace configured) ⇒ trusted:true,
   * nothing to gate. The startup TrustGate reads this to decide whether to prompt.
   */
  async getTrust(): Promise<TrustStatus> {
    const res = await this.fetchFn(this.url('/api/trust'));
    return parseJson<TrustStatus>(res);
  }

  /**
   * POST /api/trust — grant (`trust:true`) or decline (`trust:false`) trust for the
   * workspace. Granting persists it (remembered) AND applies the providers' trust
   * env on the live server so the next agent spawn picks it up — no restart.
   */
  async setTrust(trust: boolean): Promise<TrustStatus> {
    const res = await this.fetchFn(this.url('/api/trust'), this.jsonInit('POST', { trust }));
    return parseJson<TrustStatus>(res);
  }

  /** GET /api/accounts — provider accounts, MASKED (hasApiKey only, never the key). */
  async listAccounts(): Promise<readonly AccountSummary[]> {
    const res = await this.fetchFn(this.url('/api/accounts'));
    const data = await parseJson<{ accounts: AccountSummary[] }>(res);
    return data.accounts;
  }

  /** POST /api/accounts — create a provider account (+ optional BYOK apiKey). */
  async createAccount(input: CreateAccountBody): Promise<AccountSummary> {
    const res = await this.fetchFn(this.url('/api/accounts'), this.jsonInit('POST', input));
    const data = await parseJson<{ account: AccountSummary }>(res);
    return data.account;
  }

  /** PATCH /api/accounts/:id — update metadata and/or the apiKey. */
  async updateAccount(id: string, input: UpdateAccountBody): Promise<AccountSummary> {
    const res = await this.fetchFn(this.url(`/api/accounts/${id}`), this.jsonInit('PATCH', input));
    const data = await parseJson<{ account: AccountSummary }>(res);
    return data.account;
  }

  /** DELETE /api/accounts/:id — remove the account and its stored secret. */
  async deleteAccount(id: string): Promise<void> {
    await this.fetchFn(this.url(`/api/accounts/${id}`), this.jsonInit('DELETE'));
  }

  /** GET /api/auth — each provider CLI's OAuth/subscription login status. */
  async getAuthStatus(): Promise<readonly ProviderAuthStatus[]> {
    const res = await this.fetchFn(this.url('/api/auth'));
    const data = await parseJson<{ providers: ProviderAuthStatus[] }>(res);
    return data.providers;
  }

  /** POST /api/auth/:clientId/login — trigger the provider CLI's browser login. */
  async providerLogin(clientId: ClientId): Promise<void> {
    const res = await this.fetchFn(this.url(`/api/auth/${clientId}/login`), this.jsonInit('POST'));
    if (res.ok) return;
    const body = (await res.json().catch(() => ({}))) as { reason?: string };
    throw new Error(body.reason ?? `登录启动失败 (HTTP ${res.status})`);
  }

  /** POST /api/auth/:clientId/logout — trigger the provider CLI's logout. */
  async providerLogout(clientId: ClientId): Promise<void> {
    const res = await this.fetchFn(this.url(`/api/auth/${clientId}/logout`), this.jsonInit('POST'));
    if (res.ok) return;
    const body = (await res.json().catch(() => ({}))) as { reason?: string };
    throw new Error(body.reason ?? `登出失败 (HTTP ${res.status})`);
  }

  /** GET /api/adapters/wechat/config — masked WeCom adapter config (no secret). */
  async getWeChatConfig(): Promise<WeChatSettingsView> {
    const res = await this.fetchFn(this.url('/api/adapters/wechat/config'));
    const data = await parseJson<{ config: WeChatSettingsView }>(res);
    return data.config;
  }

  /** PUT /api/adapters/wechat/config — set the WeCom config (secret write-only). */
  async setWeChatConfig(patch: WeChatConfigPatch): Promise<WeChatSettingsView> {
    const res = await this.fetchFn(
      this.url('/api/adapters/wechat/config'),
      this.jsonInit('PUT', patch),
    );
    const data = await parseJson<{ config: WeChatSettingsView }>(res);
    return data.config;
  }

  /** POST /api/adapters/weixin/login/start — fetch a QR to scan for personal WeChat. */
  async weixinLoginStart(): Promise<WeixinQr> {
    const res = await this.fetchFn(this.url('/api/adapters/weixin/login/start'), this.jsonInit('POST'));
    return parseJson<WeixinQr>(res);
  }

  /** GET /api/adapters/weixin/login/status — poll a QR's scan/login status. */
  async weixinLoginStatus(qrPayload: string): Promise<WeixinLoginStatus> {
    const res = await this.fetchFn(
      this.url(`/api/adapters/weixin/login/status?qrPayload=${encodeURIComponent(qrPayload)}`),
    );
    return parseJson<WeixinLoginStatus>(res);
  }

  /** GET /api/adapters/weixin/status — current connection state. */
  async weixinStatus(): Promise<WeixinConnStatus> {
    const res = await this.fetchFn(this.url('/api/adapters/weixin/status'));
    return parseJson<WeixinConnStatus>(res);
  }

  /** POST /api/adapters/weixin/logout — disconnect + forget the session. */
  async weixinLogout(): Promise<void> {
    await this.fetchFn(this.url('/api/adapters/weixin/logout'), this.jsonInit('POST'));
  }

  /** GET /api/adapters/feishu/config — masked Feishu config (no app_secret). */
  async getFeishuConfig(): Promise<FeishuConfigView> {
    const res = await this.fetchFn(this.url('/api/adapters/feishu/config'));
    const data = await parseJson<{ config: FeishuConfigView }>(res);
    return data.config;
  }

  /** PUT /api/adapters/feishu/config — set config (app_secret write-only); connects. */
  async setFeishuConfig(patch: FeishuConfigPatch): Promise<{ config: FeishuConfigView; status: FeishuConnStatus }> {
    const res = await this.fetchFn(this.url('/api/adapters/feishu/config'), this.jsonInit('PUT', patch));
    return parseJson<{ config: FeishuConfigView; status: FeishuConnStatus }>(res);
  }

  /** GET /api/adapters/feishu/status — current connection state. */
  async feishuStatus(): Promise<FeishuConnStatus> {
    const res = await this.fetchFn(this.url('/api/adapters/feishu/status'));
    return parseJson<FeishuConnStatus>(res);
  }

  /** GET /api/audit/thread/:id — the thread's emitted audit events (新 thread 真实事件，
   *  老 thread 由路由回退到派生，data.derived=true)。 */
  async getAudit(threadId: string): Promise<readonly AuditEvent[]> {
    const res = await this.fetchFn(this.url(`/api/audit/thread/${threadId}`));
    const data = await parseJson<{ events: AuditEvent[] }>(res);
    return data.events;
  }

  /** GET /api/skills — the skill catalog with each skill's on/off state (M11). */
  async listSkills(): Promise<readonly SkillListEntry[]> {
    const res = await this.fetchFn(this.url('/api/skills'));
    const data = await parseJson<{ skills: SkillListEntry[] }>(res);
    return data.skills;
  }

  /** POST /api/skills/sync — re-read the local skill manifest from disk. */
  async syncSkills(): Promise<readonly SkillListEntry[]> {
    const res = await this.fetchFn(this.url('/api/skills/sync'), this.jsonInit('POST'));
    const data = await parseJson<{ skills: SkillListEntry[] }>(res);
    return data.skills;
  }

  /** PUT /api/skills/:id/enabled — turn a skill on/off (injected into the agent prompt). */
  async setSkillEnabled(id: string, enabled: boolean): Promise<void> {
    const res = await this.fetchFn(this.url(`/api/skills/${id}/enabled`), this.jsonInit('PUT', { enabled }));
    if (!res.ok) throw new Error(`切换失败 (HTTP ${res.status})`);
  }

  /** GET /api/sop — the loaded SOP definition (M12 stages), read-only. */
  async getSop(): Promise<SopDefinition> {
    const res = await this.fetchFn(this.url('/api/sop'));
    const data = await parseJson<{ sop: SopDefinition }>(res);
    return data.sop;
  }

  /** GET /api/rules — Clowder-style rule sources, provider guides, L0 prompt chain, and SOP. */
  async getRules(): Promise<RulesPayload> {
    const res = await this.fetchFn(this.url('/api/rules'));
    return parseJson<RulesPayload>(res);
  }

  /** GET /api/mcp/tools — the MCP tool catalog (M10), read-only. */
  async listMcpTools(): Promise<readonly McpToolEntry[]> {
    const res = await this.fetchFn(this.url('/api/mcp/tools'));
    const data = await parseJson<{ tools: McpToolEntry[] }>(res);
    return data.tools;
  }

  /** GET /api/tasks?threadId — the thread's task lines (任务线 / 任务). */
  async listTasks(threadId: string): Promise<readonly TaskItem[]> {
    const res = await this.fetchFn(this.url(`/api/tasks?threadId=${encodeURIComponent(threadId)}`));
    const data = await parseJson<{ tasks: TaskItem[] }>(res);
    return data.tasks;
  }

  /** POST /api/tasks — create a task line on a thread (createdBy 'user'). */
  async createTask(input: { threadId: string; title: string; why?: string }): Promise<TaskItem> {
    const res = await this.fetchFn(
      this.url('/api/tasks'),
      this.jsonInit('POST', { ...input, createdBy: 'user' }),
    );
    return parseJson<TaskItem>(res);
  }

  /** PATCH /api/tasks/:id — update a task's status/title/why; returns the updated task. */
  async updateTask(
    id: string,
    patch: { status?: TaskStatus; title?: string; why?: string },
  ): Promise<TaskItem> {
    const res = await this.fetchFn(this.url(`/api/tasks/${id}`), this.jsonInit('PATCH', patch));
    return parseJson<TaskItem>(res);
  }

  /** DELETE /api/tasks/:id — remove a task line (204). */
  async deleteTask(id: string): Promise<void> {
    const res = await this.fetchFn(this.url(`/api/tasks/${id}`), this.jsonInit('DELETE'));
    if (!res.ok) throw new ApiError(res.status, `删除失败 (HTTP ${res.status})`);
  }

  /** GET /api/workspace/tree?path= — one directory level (开发 tab file tree, lazy-expanded). */
  async getWorkspaceTree(path?: string): Promise<readonly WorkspaceTreeEntry[]> {
    const q = path !== undefined && path.length > 0 ? `?path=${encodeURIComponent(path)}` : '';
    const res = await this.fetchFn(this.url(`/api/workspace/tree${q}`));
    const data = await parseJson<{ entries: WorkspaceTreeEntry[] }>(res);
    return data.entries;
  }

  async getWorkspaceInfo(): Promise<WorkspaceInfo> {
    const res = await this.fetchFn(this.url('/api/workspace/info'));
    return parseJson<WorkspaceInfo>(res);
  }

  async searchWorkspace(
    query: string,
    type: WorkspaceSearchType = 'all',
  ): Promise<readonly WorkspaceSearchResult[]> {
    const res = await this.fetchFn(
      this.url('/api/workspace/search'),
      this.jsonInit('POST', { query, type }),
    );
    const data = await parseJson<{ results: WorkspaceSearchResult[] }>(res);
    return data.results;
  }

  /** GET /api/workspace/git-log — recent commits (开发 tab Git view). */
  async getGitLog(limit?: number): Promise<readonly GitCommitEntry[]> {
    const q = limit !== undefined ? `?limit=${limit}` : '';
    const res = await this.fetchFn(this.url(`/api/workspace/git-log${q}`));
    const data = await parseJson<{ commits: GitCommitEntry[] }>(res);
    return data.commits;
  }

  /** GET /api/workspace/git-status — working-tree status + branch (开发 tab Git view). */
  async getGitStatus(): Promise<GitStatusView> {
    const res = await this.fetchFn(this.url('/api/workspace/git-status'));
    return parseJson<GitStatusView>(res);
  }

  /** GET /api/workspace/git-show?hash= — one commit's changed-file summary (Git log 下钻). */
  async getGitShow(hash: string): Promise<GitShowResult> {
    const res = await this.fetchFn(this.url(`/api/workspace/git-show?hash=${encodeURIComponent(hash)}`));
    return parseJson<GitShowResult>(res);
  }

  /** The GET /api/workspace/file/raw URL for a media file — for an <img>/<video>
   * `src` (not fetched here; the browser streams it directly). */
  workspaceRawUrl(path: string): string {
    return this.url(`/api/workspace/file/raw?path=${encodeURIComponent(path)}`);
  }

  /** GET /api/workspace/diff — changed files + unified diff (开发 tab 变更 view). */
  async getWorkspaceDiff(path?: string): Promise<WorkspaceDiffView> {
    const q = path !== undefined && path.length > 0 ? `?path=${encodeURIComponent(path)}` : '';
    const res = await this.fetchFn(this.url(`/api/workspace/diff${q}`));
    return parseJson<WorkspaceDiffView>(res);
  }

  /** GET /api/audit/thread/:threadId — per-thread audit events, newest-first (审计 tab). */
  async getAuditEvents(threadId: string): Promise<{ readonly events: readonly AuditEvent[] }> {
    const res = await this.fetchFn(this.url(`/api/audit/thread/${encodeURIComponent(threadId)}`));
    return parseJson<{ events: AuditEvent[] }>(res);
  }

  /** GET /api/tasks/progress?threadId= — a thread's live per-agent task-progress snapshots. */
  async getTaskProgress(threadId: string): Promise<readonly TaskProgressSnapshot[]> {
    const res = await this.fetchFn(this.url(`/api/tasks/progress?threadId=${encodeURIComponent(threadId)}`));
    const data = await parseJson<{ snapshots: TaskProgressSnapshot[] }>(res);
    return data.snapshots;
  }
}

/** Shared default client bound to the resolved web config. */
export const apiClient = new ApiClient();
