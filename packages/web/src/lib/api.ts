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
  AuditEntry,
} from '@choco/shared';

/** A session-chain row enriched with its digest (sealed → stored; active → live). */
export interface SessionChainEntry extends Omit<SessionRecord, 'digest'> {
  readonly digest: SessionDigest | null;
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
  async getWorkspaceFile(path: string): Promise<string> {
    const res = await this.fetchFn(this.url(`/api/workspace/file?path=${encodeURIComponent(path)}`));
    const data = await parseJson<{ path: string; content: string }>(res);
    return data.content;
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

  /** GET /api/audit/thread/:id — the per-thread audit timeline (replies/tools/seals). */
  async getAudit(threadId: string): Promise<readonly AuditEntry[]> {
    const res = await this.fetchFn(this.url(`/api/audit/thread/${threadId}`));
    const data = await parseJson<{ entries: AuditEntry[] }>(res);
    return data.entries;
  }
}

/** Shared default client bound to the resolved web config. */
export const apiClient = new ApiClient();
