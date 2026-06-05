// M8 app-factory — the whole DI wiring as a single callable factory.
//
// Source: clowder-design-supplement.md §D (constructor injection, no global
// singletons). buildApp() constructs every concrete service, wires the
// InvokeAgentFn seam (M7 system prompt + history context → M3 invokeSingleAgent),
// builds the AgentRouter (M4), mounts the Fastify app + Socket.io server, and
// registers all routes. Tests call buildApp({ agentServices, db }) to inject a
// Fake provider + temp db; index.ts only calls buildApp().api.listen().
//
// NOTE on the supplement-D listing: it is the IDEALIZED Clowder shape and lists
// constructors that don't exist as written here (threadStore param of AgentRouter,
// SkillLoader, FastifyApi). We trust the real frozen constructors instead:
//   - AgentRouter takes { registry, invoke, history } — agent invocation is the
//     INJECTED InvokeAgentFn seam, so M2/M3/M7 wiring lives in THIS factory.
//   - SqliteThreadStore is M8's approved store (progress.md deviation).

import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { Server as SocketIoServer } from 'socket.io';
import type { AgentMessage, AgentConfig, AgentId, IncomingPlatformMessage, StoredMessage } from '@choco/shared';

import type { AgentService } from '@choco/api/providers/base';
import { MCP_CONFIG_ENV_KEY } from '@choco/api/providers/claude/claude-service';
import { buildClaudeMcpConfig } from '@choco/api/providers/mcp-config';
import { AgentRegistryImpl } from '@choco/api/routing/agent-registry';
import {
  AgentRouter,
  type InvokeAgentArgs,
  type InvokeAgentFn,
  type RouteLogger,
} from '@choco/api/routing/agent-router';
import { InvocationRegistry } from '@choco/api/invocation/invocation-registry';
import { SessionStore } from '@choco/api/invocation/session-store';
import { SessionMutex } from '@choco/api/invocation/session-mutex';
import { invokeSingleAgent } from '@choco/api/invocation/invoke-single-agent';
import type { InvokeSingleAgentParams } from '@choco/api/invocation/invoke-single-agent';
import { SqliteMessageStore } from '@choco/api/stores/sqlite-message-store';
import { SqliteThreadStore } from '@choco/api/stores/sqlite-thread-store';
import { SqliteToolEventLog } from '@choco/api/stores/sqlite-tool-event-log';
import { SqliteEventAuditLog } from '@choco/api/stores/sqlite-event-audit-log';
import { SqliteEvidenceStore } from '@choco/api/evidence/sqlite-evidence-store';
import { SqlitePlatformMappingStore } from '@choco/api/stores/platform-mapping-store';
import { buildSystemPrompt } from '@choco/api/context/system-prompt-builder';
import { buildHierarchicalContext } from '@choco/api/context/hierarchical-context';
import { SopServiceImpl, type SopService } from '@choco/api/sop/sop-service';
import type { EvidenceRecaller } from '@choco/api/context/evidence-recall';
import type { ResolveAgentConfig } from '@choco/api/context/context-assembler';
import { loadAgentConfigs } from '@choco/api/config/agent-config-loader';
import {
  applyAgentOverride,
  NullAgentOverrideStore,
  type AgentOverrideStore,
} from '@choco/api/config/agent-overrides';
import {
  NullRuntimeRosterStore,
  type RuntimeRosterStore,
} from '@choco/api/config/runtime-roster';
import { SocketManager } from '@choco/api/infrastructure/socket-manager';
import type { AppServices } from '@choco/api/infrastructure/app-services';
import { registerThreadRoutes } from '@choco/api/routes/thread-routes';
import { registerMessageRoutes } from '@choco/api/routes/message-routes';
import { handleThreadMessage } from '@choco/api/routes/message-handler';
import { registerAgentRoutes } from '@choco/api/routes/agent-routes';
import { registerEvidenceRoutes } from '@choco/api/routes/evidence-routes';
import { registerSessionRoutes } from '@choco/api/routes/session-routes';
import { registerTrustRoutes } from '@choco/api/routes/trust-routes';
import { registerAccountRoutes } from '@choco/api/routes/account-routes';
import { registerAuthRoutes } from '@choco/api/routes/auth-routes';
import { registerWeChatRoutes } from '@choco/api/routes/wechat-routes';
import { AccountStore } from '@choco/api/config/account-store';
import { resolveAccountEnv } from '@choco/api/config/account-resolver';
import { defaultAuthCliRunner, type AuthCliRunner } from '@choco/api/config/provider-auth';
import { WeChatConfigStore } from '@choco/api/config/wechat-config-store';
import { registerWeixinRoutes } from '@choco/api/routes/weixin-routes';
import { WeixinManager } from '@choco/api/runtime/weixin-manager';
import type { WeixinTokenStore } from '@choco/api/config/weixin-token-store';
import { registerFeishuRoutes } from '@choco/api/routes/feishu-routes';
import { FeishuManager, type FeishuAdapterLike } from '@choco/api/runtime/feishu-manager';
import type { FeishuConfigStore } from '@choco/api/config/feishu-config-store';
import type { FeishuAdapterDeps } from '@choco/adapters/feishu';
import { SkillService } from '@choco/api/skills/skill-service';
import { SkillEnablementStore } from '@choco/api/skills/skill-enablement-store';
import { registerAuditRoutes } from '@choco/api/routes/audit-routes';
import { registerCatalogRoutes } from '@choco/api/routes/catalog-routes';
import { registerCallbackRoutes } from '@choco/api/routes/callback-routes';
import { registerWorkspaceRoutes } from '@choco/api/routes/workspace-routes';
import type { OsOpener } from '@choco/api/infrastructure/os-open';
import { registerHealthRoutes } from '@choco/api/routes/health-routes';
import {
  checkWorkspaceMatch,
  checkInvocationProductive,
} from '@choco/api/infrastructure/invariants';

/** Env var names the CLI/MCP server reads to call back into this API (§C3). */
export const CALLBACK_ENV_KEYS = {
  apiUrl: 'CHOCO_API_URL',
  invocationId: 'CHOCO_INVOCATION_ID',
  callbackToken: 'CHOCO_CALLBACK_TOKEN',
} as const;

/** Overrides accepted by {@link buildApp}. All optional — production passes none. */
export interface BuildAppOverrides {
  /** Inject AgentService instances (e.g. a Fake provider) keyed by agent id. */
  readonly agentServices?: Record<string, AgentService>;
  /** Inject a Database (e.g. ':memory:' or a temp file) instead of opening one. */
  readonly db?: DatabaseType;
  /** Override the agents.yaml roster path. */
  readonly agentsConfigPath?: string;
  /**
   * M-MEMBER mutable RUNTIME OVERLAY over the static roster — holds per-agent
   * edits (roleDescription/personality/strengths/displayName/name/color) that
   * take effect on the NEXT turn's system prompt without a restart. OMITTED (the
   * default, incl. tests with injected fakes) ⇒ a {@link NullAgentOverrideStore}
   * (no persistence, no overrides), so the static roster flows through unchanged.
   * main.ts injects a {@link JsonAgentOverrideStore} so web edits persist.
   */
  readonly agentOverrideStore?: AgentOverrideStore;
  /**
   * 成员增删 — the persisted store of runtime-ADDED members, merged over the static
   * agents.yaml roster at boot. OMITTED ⇒ {@link NullRuntimeRosterStore} (no added
   * members), so the base roster flows through unchanged. main.ts injects a
   * {@link JsonRuntimeRosterStore} (and replays it into the registry after build).
   */
  readonly runtimeRoster?: RuntimeRosterStore;
  /**
   * Factory the POST /api/agents route uses to build a NEW member's provider
   * service. OMITTED ⇒ a no-op (registration-only) service, so route tests can add
   * members without real CLIs. main.ts injects the real provider factory.
   */
  readonly buildMemberService?: (config: AgentConfig) => AgentService;
  /**
   * M-ACCOUNT provider-account store. OMITTED ⇒ a real {@link AccountStore} over
   * the global ~/.choco files. Tests inject one pointed at a temp dir so they
   * never read/write the real credentials.
   */
  readonly accountStore?: AccountStore;
  /**
   * Provider-auth CLI runner seam (OAuth/login routes). OMITTED ⇒ the real
   * cross-spawn runner. Tests inject a fake so login/logout/status assert the
   * dispatched commands WITHOUT spawning a real CLI or a browser.
   */
  readonly authRunner?: AuthCliRunner;
  /**
   * M13 WeCom adapter config store. OMITTED ⇒ a real store over ~/.choco/wechat.json.
   * Tests inject one at a temp path.
   */
  readonly wechatConfigStore?: WeChatConfigStore;
  /**
   * M14b personal-WeChat (iLink) seams. OMITTED ⇒ global fetch + the global token
   * store (inert until autoStart()/login). Tests inject a fake fetch + a temp token
   * store so login/poll/send never hit the network or the real ~/.choco.
   */
  readonly weixinFetchFn?: typeof globalThis.fetch;
  readonly weixinTokenStore?: WeixinTokenStore;
  /**
   * M-FEISHU seams. OMITTED ⇒ the global ~/.choco store + the real WS adapter
   * (inert until autoStart()/applyConfig). Tests inject a temp store + a fake
   * adapter factory so applying config never opens a real WebSocket.
   */
  readonly feishuStore?: FeishuConfigStore;
  readonly feishuAdapterFactory?: (deps: FeishuAdapterDeps) => FeishuAdapterLike;
  /**
   * M11 skill governance service. OMITTED ⇒ a real service over the global enabled
   * store + on-disk manifest. Tests inject one with a temp store + fake manifest.
   */
  readonly skillService?: SkillService;
  /** Sandbox root for read_file callbacks. Defaults to the repo cwd. */
  readonly fileRoot?: string;
  /**
   * OS-open seam for the workspace reveal/open route. OMITTED ⇒ the real
   * execFile-based opener (open / explorer / xdg-open). Tests inject a fake so a
   * reveal asserts the dispatched (path, action) WITHOUT launching a file manager.
   */
  readonly osOpener?: OsOpener;
  /** Max bytes the workspace file-preview route returns. OMITTED ⇒ the route default. */
  readonly maxPreviewBytes?: number;
  /**
   * Default local workspace directory agents operate in (their CLI `cwd`) when a
   * thread has no `projectPath`. Externalized via `CHOCO_WORKSPACE` by the
   * composition root (main.ts). DELIBERATELY has NO default here: when both this
   * and `thread.projectPath` are absent, the resolved `workingDirectory` stays
   * `undefined` (the pre-existing behavior — providers then spawn with no cwd),
   * so existing tests that pass neither see no regression. Do NOT reuse
   * `fileRoot`'s `process.cwd()` default for this.
   */
  readonly defaultWorkspace?: string;
  /** Base URL the MCP server uses to reach this API (forwarded as callbackEnv). */
  readonly apiBaseUrl?: string;
  /** Default agent id for the registry fallback. Defaults to the first config. */
  readonly defaultAgentId?: AgentId;
  /**
   * §A Availability map keyed by agent id — whether each rostered agent is
   * routable (its provider CLI is installed on this system). The composition root
   * (main.ts) derives this by probing CLI presence at boot and passes it here.
   * OMITTED (the default, incl. tests with injected fakes) ⇒ ALL agents available
   * (AgentRegistryImpl defaults absent ids to true), so the existing suite and
   * injected fakes are unaffected. NOT hardcoded in agents.yaml (that would be
   * wrong on a machine that HAS codex/gemini) — derived from CLI presence at boot.
   */
  readonly agentAvailability?: Readonly<Record<string, boolean>>;
  /** Injectable clock (deterministic tests). Defaults to Date.now. */
  readonly now?: () => number;
  /**
   * Structured logger ({@link RouteLogger} seam) for non-fatal route notes.
   * Production passes none → defaults to {@link NOOP_LOGGER} (silent, matching
   * the AgentRouter's own silent default). Tests inject a capturing logger to
   * assert best-effort failures (e.g. a tool-event-feed append) are logged.
   */
  readonly logger?: RouteLogger;
  /**
   * Path to the SOP definition (M12 告示牌) the SopService loads. Defaults to the
   * repo `sop/development.yaml` resolved relative to {@link APP_FACTORY_DIR}
   * ({@link DEFAULT_SOP_DEFINITION_PATH}) — externalized, never a hardcoded
   * absolute path (CLAUDE.md §2.1). Tests may point this at a fixture.
   */
  readonly sopDefinitionPath?: string;
}

/**
 * Replies collected for one platform-ingress message — what an adapter sends
 * back to the platform conversation (the platform user is not on the websocket).
 */
export interface PlatformIngressResult {
  /** Internal threadId the platform conversation resolved to (A10 resolveThread). */
  readonly threadId: string;
  /** Internal userId the platform user resolved to (A10 resolveUser). */
  readonly userId: string;
  /** One persisted StoredMessage per agent that replied (in agent stream order). */
  readonly replies: StoredMessage[];
}

/** The wired application surface returned by {@link buildApp}. */
export interface BuiltApp {
  readonly api: FastifyInstance;
  readonly router: AgentRouter;
  readonly stores: {
    readonly messageStore: SqliteMessageStore;
    readonly threadStore: SqliteThreadStore;
    readonly toolEventLog: SqliteToolEventLog;
    readonly evidenceStore: SqliteEvidenceStore;
  };
  readonly io: SocketIoServer;
  readonly registry: AgentRegistryImpl;
  readonly invocations: InvocationRegistry;
  readonly socket: SocketManager;
  /**
   * A10 platform-mapping store — SHARED by the M13 (WeChat) + M14 (Telegram)
   * adapters to resolve platform ids ↔ internal thread/user ids identically.
   */
  readonly platformMappingStore: SqlitePlatformMappingStore;
  /** The session archive store (补充 E) — Cycle 2 callbacks/MCP tools wrap it. */
  readonly sessionStore: SessionStore;
  /**
   * Platform ingress (G3): the entry an adapter calls for ONE inbound platform
   * message. Resolves the platform channelId/userId → internal thread/user id
   * (A10), then drives the SAME pipeline as the HTTP POST /messages route
   * (handleThreadMessage) and RETURNS the collected agent replies so the adapter
   * can sendMessage them back to the platform. M13 (webhook) and M14 (long-poll)
   * call this identically.
   */
  readonly submitPlatformMessage: (
    incoming: IncomingPlatformMessage,
    opts?: { readonly onTextDelta?: (agentId: AgentId, text: string) => void },
  ) => Promise<PlatformIngressResult>;
  /**
   * M14b personal-WeChat (iLink) manager — owns the QR login + long-poll adapter.
   * The composition root calls `weixinManager.autoStart()` after listen to
   * reconnect a persisted session.
   */
  readonly weixinManager: WeixinManager;
  /**
   * M-FEISHU 飞书 manager — owns the long-connection adapter. The composition root
   * calls `feishuManager.autoStart()` after listen to reconnect a persisted config.
   */
  readonly feishuManager: FeishuManager;
  /** Close DB + HTTP + Socket.io (test/shutdown teardown). */
  readonly close: () => Promise<void>;
}

/** Default in-process DB path when no Database is injected. */
const DEFAULT_DB_PATH = 'choco.db';

/**
 * Silent default logger — used when no {@link RouteLogger} is injected. Matches
 * the AgentRouter's own behavior (silent when omitted), so wiring this default
 * does not change observable behavior; it only gives routes a non-undefined sink
 * to log best-effort failures through (instead of swallowing them silently).
 */
const NOOP_LOGGER: RouteLogger = () => {};

/**
 * Build the entire application from configuration + optional overrides.
 * Pure construction — opens no network listener (callers do `api.listen`).
 */
export function buildApp(overrides: BuildAppOverrides = {}): BuiltApp {
  const now = overrides.now ?? Date.now;
  const db: DatabaseType = overrides.db ?? new Database(DEFAULT_DB_PATH);
  const logger: RouteLogger = overrides.logger ?? NOOP_LOGGER;

  // --- Stores (DI Database; idempotent migrations run in each store ctor) ----
  const messageStore = new SqliteMessageStore(db);
  const threadStore = new SqliteThreadStore(db, { now });
  const toolEventLog = new SqliteToolEventLog(db);
  // 审计事件日志（对齐 Clowder EventAuditLog）— DI Database + clock; 幂等迁移 005 在 ctor 跑。
  const eventAuditLog = new SqliteEventAuditLog(db, { now });
  const evidenceStore = new SqliteEvidenceStore(db);
  // A10 platform-mapping store (idempotent migration 004 runs in its ctor). Shared
  // by M13/M14 adapters via submitPlatformMessage below.
  const platformMappingStore = new SqlitePlatformMappingStore(db, { now });
  // Session archive (补充 E): transcript composition reads the message store +
  // tool-event log, so they are injected as the SessionStore's reader ports.
  const sessionStore = new SessionStore(db, {
    messageReader: messageStore,
    toolEventReader: toolEventLog,
    now,
  });
  const sessionMutex = new SessionMutex();
  const invocations = new InvocationRegistry({ now });
  // M-ACCOUNT: global provider-account store (~/.choco). Default reads the real
  // global files; tests inject one pointed at a temp dir.
  const accountStore = overrides.accountStore ?? new AccountStore();
  // Provider-auth (OAuth/login) CLI runner. Default spawns the real CLIs; tests
  // inject a fake so the login/logout/status routes never spawn a real login.
  const authRunner = overrides.authRunner ?? defaultAuthCliRunner;
  // M11 skill governance — per-skill on/off + the enabled-skill prompt block the
  // invoke seam injects into the system prompt. Default off (opt-in). Tests inject
  // a service over a temp store + fake manifest/content.
  const skillService =
    overrides.skillService ?? new SkillService({ store: new SkillEnablementStore() });
  // M13 WeCom adapter config store (~/.choco/wechat.json). Tests inject one at a
  // temp path so they never read/write the real config.
  const wechatConfigStore = overrides.wechatConfigStore ?? new WeChatConfigStore();

  // --- Agent roster + registry (services injected; fakes win in tests) -------
  // 成员增删: the roster is agents.yaml (base) PLUS any runtime-added members,
  // merged at boot. POST/DELETE /api/agents then mutate this registry in place.
  const runtimeRoster = overrides.runtimeRoster ?? new NullRuntimeRosterStore();
  const buildMemberService = overrides.buildMemberService ?? defaultMemberService;
  const runtimeConfigs = runtimeRoster.all();
  const configs: AgentConfig[] = [...loadAgentConfigs(overrides.agentsConfigPath), ...runtimeConfigs];
  const services: Record<string, AgentService> = { ...resolveAgentServices(overrides.agentServices) };
  // Build a provider for each runtime member that was not injected as a fake.
  for (const cfg of runtimeConfigs) {
    if (services[cfg.id as string] === undefined) {
      services[cfg.id as string] = buildMemberService(cfg);
    }
  }
  const registry = new AgentRegistryImpl(configs, services, {
    ...(overrides.defaultAgentId !== undefined
      ? { defaultAgentId: overrides.defaultAgentId }
      : {}),
    ...(overrides.agentAvailability !== undefined
      ? { availability: overrides.agentAvailability }
      : {}),
  });

  // M-MEMBER: the mutable overlay store. Default = no persistence/no overrides,
  // so injected-fake tests and the prior behavior are unaffected.
  const agentOverrideStore = overrides.agentOverrideStore ?? new NullAgentOverrideStore();

  // Wrap the resolver so EVERY config read (system prompt, roster, teammate
  // table) reflects the live overlay — this is the seam that makes a member edit
  // take effect on the NEXT turn without a restart. The static registry still
  // backs routing/spawn (clientId/mentionPatterns/defaultModel/mcpSupport), which
  // the overlay never touches.
  const resolveConfig: ResolveAgentConfig = (id) => {
    const base = registry.get(id);
    return base === undefined
      ? undefined
      : applyAgentOverride(base, agentOverrideStore.get(id as string));
  };
  const apiBaseUrl = overrides.apiBaseUrl ?? `http://127.0.0.1`;

  // M12 SOP 告示牌 producer/consumer wiring: load the definition once and share
  // the service across the invoke seam (reads thread.sopStageId → prompt hint),
  // the thread-routes PATCH setter, and the sop_advance_stage callback.
  const sopService: SopService = new SopServiceImpl(
    overrides.sopDefinitionPath ?? DEFAULT_SOP_DEFINITION_PATH,
  );

  // --- The InvokeAgentFn seam: the load-bearing M4↔(M7,M3) integration -------
  const invoke = buildInvokeAgentFn({
    registry,
    messageStore,
    threadStore,
    evidenceStore,
    sessionStore,
    sessionMutex,
    invocations,
    eventAuditLog,
    resolveConfig,
    apiBaseUrl,
    now,
    logger,
    sopService,
    accountStore,
    skillBlock: () => skillService.block(),
    ...(overrides.defaultWorkspace !== undefined
      ? { defaultWorkspace: overrides.defaultWorkspace }
      : {}),
  });

  const router = new AgentRouter({ registry, invoke, history: messageStore, logger, now });

  // --- HTTP + Socket.io ------------------------------------------------------
  const api = Fastify({ logger: false });
  const io = new SocketIoServer(api.server, {
    cors: { origin: true },
  });
  const socket = new SocketManager(io);

  const appServices: AppServices = {
    router,
    registry,
    invocations,
    messageStore,
    threadStore,
    toolEventLog,
    eventAuditLog,
    evidenceStore,
    platformMappingStore,
    sessionStore,
    socket,
    logger,
    now,
    sopService,
    agentOverrides: agentOverrideStore,
    runtimeRoster,
    buildMemberService,
    accountStore,
    authRunner,
    skillService,
    wechatConfigStore,
    ...(overrides.defaultWorkspace !== undefined
      ? { defaultWorkspace: overrides.defaultWorkspace }
      : {}),
  };

  const fileRoot = overrides.fileRoot ?? process.cwd();

  // CORS must be registered before routes; Socket.io has its own cors above.
  void api.register(cors, { origin: true });
  registerThreadRoutes(api, appServices);
  registerSessionRoutes(api, appServices);
  registerTrustRoutes(api, appServices);
  registerAccountRoutes(api, appServices);
  registerAuthRoutes(api, appServices);
  registerWeChatRoutes(api, appServices);
  registerAuditRoutes(api, appServices);
  registerMessageRoutes(api, appServices);
  registerAgentRoutes(api, appServices);
  registerCatalogRoutes(api, appServices);
  registerEvidenceRoutes(api, appServices);
  registerCallbackRoutes(api, appServices, { fileRoot });
  // Browser-initiated open/reveal of a workspace file (diff-block affordances),
  // sandboxed to the same fileRoot as read_file.
  registerWorkspaceRoutes(api, appServices, {
    fileRoot,
    ...(overrides.osOpener !== undefined ? { opener: overrides.osOpener } : {}),
    ...(overrides.maxPreviewBytes !== undefined ? { maxPreviewBytes: overrides.maxPreviewBytes } : {}),
  });
  // Operability: liveness probe. Harmless to tests (pure in-memory read).
  registerHealthRoutes(api, { now });

  // G3 platform ingress: resolve A10 ids then drive the shared message pipeline,
  // returning the collected replies for the adapter to send back to the platform.
  const submitPlatformMessage = async (
    incoming: IncomingPlatformMessage,
    opts?: { readonly onTextDelta?: (agentId: AgentId, text: string) => void },
  ): Promise<PlatformIngressResult> => {
    const threadId = await platformMappingStore.resolveThread(
      incoming.adapterName,
      incoming.channelId,
    );
    const userId = await platformMappingStore.resolveUser(
      incoming.adapterName,
      incoming.platformUserId,
    );
    // Platform users are off-web → mirror their inbound message to live web clients
    // (broadcastInbound). Phase 2: forward per-agent text deltas to the adapter's
    // optional sink so it can drive a 飞书 streaming card; omitted → unchanged.
    const { replies } = await handleThreadMessage(appServices, {
      threadId,
      userId,
      content: incoming.text,
      broadcastInbound: true,
      ...(opts?.onTextDelta !== undefined ? { onTextDelta: opts.onTextDelta } : {}),
    });
    return { threadId, userId, replies };
  };

  // M14b personal-WeChat (iLink) manager — owns the QR login + long-poll adapter.
  // Constructed here (needs submitPlatformMessage); its routes are registered now
  // (before listen). Tests inject one with a fake fetch + temp token store; it
  // never polls until autoStart()/login (main.ts calls autoStart).
  const weixinManager = new WeixinManager({
    submitPlatformMessage,
    ...(overrides.weixinFetchFn !== undefined ? { fetchFn: overrides.weixinFetchFn } : {}),
    ...(overrides.weixinTokenStore !== undefined ? { tokenStore: overrides.weixinTokenStore } : {}),
  });
  registerWeixinRoutes(api, weixinManager);

  // M-FEISHU 飞书 manager — owns the long-connection adapter. Inert until
  // autoStart()/applyConfig. Tests inject a temp store + a fake adapter factory so
  // applying config never opens a real WebSocket.
  const feishuManager = new FeishuManager({
    submitPlatformMessage,
    ...(overrides.feishuStore !== undefined ? { store: overrides.feishuStore } : {}),
    ...(overrides.feishuAdapterFactory !== undefined
      ? { adapterFactory: overrides.feishuAdapterFactory }
      : {}),
  });
  registerFeishuRoutes(api, feishuManager);

  const close = async (): Promise<void> => {
    io.close();
    await api.close();
    db.close();
  };

  return {
    api,
    router,
    stores: { messageStore, threadStore, toolEventLog, evidenceStore },
    io,
    registry,
    invocations,
    socket,
    platformMappingStore,
    sessionStore,
    submitPlatformMessage,
    weixinManager,
    feishuManager,
    close,
  };
}

/** Dependencies of the InvokeAgentFn closure. */
interface InvokeDeps {
  readonly registry: AgentRegistryImpl;
  readonly messageStore: SqliteMessageStore;
  readonly threadStore: SqliteThreadStore;
  readonly evidenceStore: SqliteEvidenceStore;
  readonly sessionStore: SessionStore;
  readonly sessionMutex: SessionMutex;
  readonly invocations: InvocationRegistry;
  /** 审计事件日志——invoke 缝 emit invoked/responded/error（best-effort，绝不打断回合）。 */
  readonly eventAuditLog: SqliteEventAuditLog;
  readonly resolveConfig: ResolveAgentConfig;
  readonly apiBaseUrl: string;
  readonly now: () => number;
  /**
   * M-ACCOUNT provider-account store. At spawn time the agent's clientId resolves
   * to its api_key account (if any) → provider env vars merged into the CLI env.
   */
  readonly accountStore: AccountStore;
  /** M11: the ENABLED-skill system-prompt block, recomputed per invocation. */
  readonly skillBlock: () => string;
  /**
   * Structured logger seam for invariant probes ({@link RouteLogger}). Defaults
   * to the silent NOOP_LOGGER in buildApp, so probes are silent in tests unless
   * a capturing logger is injected; main.ts injects the real file logger.
   */
  readonly logger: RouteLogger;
  /**
   * M12 SOP service — reads `thread.sopStageId` → a prompt hint (告示牌). Used
   * best-effort: a read failure is logged and skipped, never thrown (SOP must
   * never break a turn).
   */
  readonly sopService: SopService;
  /**
   * Fallback CLI working directory when a thread has no `projectPath`. Optional:
   * when omitted (and the thread has no projectPath) the invocation passes NO
   * workingDirectory, preserving the prior behavior.
   */
  readonly defaultWorkspace?: string;
}

/**
 * Build the InvokeAgentFn that M4's AgentRouter calls for one agent turn:
 *   1. build the system prompt from args.context (M7 buildSystemPrompt)
 *   2. assemble the conversation-history context (M7 buildHierarchicalContext)
 *      and compose the effective prompt
 *   3. mint an InvocationRecord (so MCP callbacks authenticate) + callbackEnv
 *   4. drive M3 invokeSingleAgent with the resolved AgentService, yielding events
 */
function buildInvokeAgentFn(deps: InvokeDeps): InvokeAgentFn {
  const recaller: EvidenceRecaller = {
    search: (query, options) => deps.evidenceStore.search(query, options),
  };

  return async function* invoke(args: InvokeAgentArgs): AsyncIterable<AgentMessage> {
    const { agentId, threadId, prompt, context } = args;

    // History context (smart window engages past the cold-mention thresholds).
    const history = await deps.messageStore.getByThread(threadId);
    const thread = await deps.threadStore.get(threadId);

    // M12 SOP 告示牌 (consumer): resolve the thread's stage to a prompt hint,
    // best-effort. A missing/unknown stage → empty hint → treated as undefined
    // (no SOP line). A read failure is logged and skipped — SOP must never break
    // a turn. The context is enriched IMMUTABLY (spread) before the system prompt.
    let sopStageHint: string | undefined;
    try {
      sopStageHint = thread?.sopStageId
        ? deps.sopService.getStageHint(thread.sopStageId) || undefined
        : undefined;
    } catch (err) {
      deps.logger({
        level: 'warn',
        message: `sop hint resolution failed: ${err instanceof Error ? err.message : String(err)}`,
        threadId,
        agentId,
      });
    }
    const effectiveContext =
      sopStageHint !== undefined ? { ...context, sopStageHint } : context;
    // M11: append the ENABLED-skill guidance so a toggled-on skill actually reaches
    // the agent (empty when none enabled → unchanged prompt).
    const baseSystemPrompt = buildSystemPrompt(effectiveContext, deps.resolveConfig);
    const skillBlock = deps.skillBlock();
    const systemPrompt =
      baseSystemPrompt.length > 0 && skillBlock.length > 0
        ? `${baseSystemPrompt}\n\n${skillBlock}`
        : baseSystemPrompt;

    const hierarchical = await buildHierarchicalContext({
      messages: history,
      threadTitle: thread?.title ?? '',
      currentUserMessage: prompt,
      evidenceStore: recaller,
      threadId,
      resolveConfig: deps.resolveConfig,
    });

    const effectivePrompt =
      hierarchical.contextText.length > 0
        ? `${hierarchical.contextText}\n\n---\n\n${prompt}`
        : prompt;

    // Mint the invocation record so MCP callbacks for this turn authenticate.
    const record = deps.invocations.create({
      userId: 'user',
      agentId,
      threadId,
    });
    const callbackEnv: Record<string, string> = {
      [CALLBACK_ENV_KEYS.apiUrl]: deps.apiBaseUrl,
      [CALLBACK_ENV_KEYS.invocationId]: record.invocationId,
      [CALLBACK_ENV_KEYS.callbackToken]: record.callbackToken,
    };

    // MCP PRODUCER (§C3): tell claude where OUR M10 MCP server is, so the 8-tool
    // subsystem is reachable. Gated to the claude client ONLY — codex/gemini use
    // different config formats (feeding them this JSON would be malformed), and
    // only when the agent's config declares mcpSupport. The value is an inline
    // JSON string (POSIX) or a temp-file path (win32); the claude provider passes
    // it to `--mcp-config <value>`.
    const cfg = deps.resolveConfig(agentId);
    if (cfg?.mcpSupport === true && cfg.clientId === 'anthropic') {
      callbackEnv[MCP_CONFIG_ENV_KEY] = buildClaudeMcpConfig({
        apiBaseUrl: deps.apiBaseUrl,
        invocationId: record.invocationId,
        callbackToken: record.callbackToken,
      });
    }

    // M-ACCOUNT: inject the provider API key for this agent's clientId (if the
    // user configured an api_key account). Merged into the spawn env so the real
    // claude/codex/gemini CLI reads ANTHROPIC_API_KEY / OPENAI_API_KEY /
    // GEMINI_API_KEY. No account (or an oauth account) → nothing injected → the
    // CLI uses its own ambient login (opt-in, never hijacks a subscription).
    if (cfg !== undefined) {
      Object.assign(callbackEnv, resolveAccountEnv(deps.accountStore, cfg.clientId));
    }

    const agentService: AgentService = deps.registry.getService(agentId);

    // Resolve the CLI working directory for this turn: the thread's own
    // projectPath wins, else the injected defaultWorkspace, else undefined.
    // When undefined we OMIT the field (matching the `...(x !== undefined)` idiom
    // below) so providers spawn with no explicit cwd — the pre-wire behavior, so
    // threads without a projectPath and no defaultWorkspace don't regress.
    const workingDirectory = thread?.projectPath ?? deps.defaultWorkspace;

    // Capture this turn's active session id (补充 E E3.3) so each emitted event
    // can be stamped with it — the route layer then tags the persisted agent
    // reply + tool events with session_id, grouping them into the session
    // transcript. `onSessionId` fires on resume and/or session_init; latest wins.
    // Declared before invokeOptions so its onSessionId closure can bind it.
    let activeSessionId: string | undefined;

    // Build the InvokeOptions handed to invokeSingleAgent. The cwd field is
    // OMITTED (left undefined) when there's no workspace — matching the prior
    // no-cwd behavior — so `invokeOptions.workingDirectory` is the GENUINE value
    // that flows to the provider spawn, not a re-derivation.
    const invokeOptions: InvokeSingleAgentParams = {
      agentService,
      sessionStore: deps.sessionStore,
      sessionMutex: deps.sessionMutex,
      agentId,
      threadId,
      prompt: effectivePrompt,
      ...(systemPrompt.length > 0 ? { systemPrompt } : {}),
      ...(workingDirectory !== undefined ? { workingDirectory } : {}),
      callbackEnv,
      now: deps.now,
      onSessionId: (sessionId) => {
        activeSessionId = sessionId;
      },
      ...(args.signal !== undefined ? { signal: args.signal } : {}),
    };

    // Operability invariant 1: the cwd ACTUALLY forwarded to the provider
    // (invokeOptions.workingDirectory — undefined when the field was dropped)
    // must match the workspace this turn was INDEPENDENTLY expected to run in
    // (recomputed from the thread's projectPath, else the configured
    // defaultWorkspace). Comparing the spawned field against a fresh expectation
    // — NOT a value against itself — lets this fire on the real workspace-wire
    // bug shape: projectPath dropped ⇒ undefined cwd while a workspace WAS
    // configured ⇒ silent server-cwd fallback. Silent in tests (NOOP_LOGGER).
    const expectedWorkspace = thread?.projectPath ?? deps.defaultWorkspace;
    checkWorkspaceMatch(
      deps.logger,
      { threadId, agentId },
      invokeOptions.workingDirectory,
      expectedWorkspace,
    );

    // Audit-to-log: invocation start. Logs the agent + thread + invocationId so
    // a turn is traceable in the structured log (info; silent in tests).
    const startedAt = deps.now();
    deps.logger({
      level: 'info',
      message: `invocation start (invocationId=${record.invocationId})`,
      threadId,
      agentId,
    });

    // 审计日志：emit 最佳努力，绝不能让 audit 写失败打断一个回合（Clowder 也隔离它）。
    const emitAudit = (type: string, data: Record<string, unknown>): void => {
      void deps.eventAuditLog.append({ type, threadId, data }).catch((err: unknown) => {
        deps.logger({
          level: 'warn',
          message: `audit append failed (${type}): ${err instanceof Error ? err.message : String(err)}`,
          threadId,
          agentId,
        });
      });
    };
    emitAudit('invoked', {
      agentId,
      invocationId: record.invocationId,
      mode: context.mode,
      ...(context.chainIndex !== undefined ? { chainIndex: context.chainIndex } : {}),
      ...(context.chainTotal !== undefined ? { chainTotal: context.chainTotal } : {}),
    });

    // Tally this turn's output for invariant 4 (productive-invocation probe).
    let textLength = 0;
    let toolCallCount = 0;
    let errorCount = 0;
    // The last error frame's message, carried into the `error` audit event (if any).
    let lastErrorMessage: string | undefined;

    // Stamp this turn's invocationId (§4.2) AND session_id (补充 E) onto every
    // emitted event so downstream sinks — the M5 ToolEventLog live-feed + the
    // reply persist in message-routes — can correlate a tool_use to its
    // invocation and group it into its session. We enrich events as they flow
    // out, preserving any id a provider already set.
    try {
      for await (const event of invokeSingleAgent(invokeOptions)) {
        // Operability tally for invariant 4 (productive-invocation probe).
        if (event.type === 'text' && event.content !== undefined) {
          textLength += event.content.length;
        } else if (event.type === 'tool_use') {
          toolCallCount += 1;
        } else if (event.type === 'error') {
          errorCount += 1;
          if (event.content !== undefined) lastErrorMessage = event.content;
        }

        const withInvocation =
          event.invocationId === undefined
            ? { ...event, invocationId: record.invocationId }
            : event;
        yield activeSessionId !== undefined && withInvocation.sessionId === undefined
          ? { ...withInvocation, sessionId: activeSessionId }
          : withInvocation;
      }
    } finally {
      // Audit-to-log: invocation end with durationMs + an output summary so the
      // turn's cost/shape is visible in the structured log (info; silent in tests).
      deps.logger({
        level: 'info',
        message:
          `invocation end (invocationId=${record.invocationId} ` +
          `durationMs=${deps.now() - startedAt} textChars=${textLength} ` +
          `toolCalls=${toolCallCount} errors=${errorCount})`,
        threadId,
        agentId,
      });
      // 审计日志：回合收尾 emit responded（正常产出）或 error（有错误帧）。与上面
      // 的 to-log 不同——这条进的是可查询的审计事件日志，审计 tab 读它。
      const durationMs = deps.now() - startedAt;
      if (errorCount > 0) {
        emitAudit('error', {
          agentId,
          invocationId: record.invocationId,
          durationMs,
          errorCount,
          ...(lastErrorMessage !== undefined ? { error: lastErrorMessage } : {}),
        });
      } else {
        emitAudit('responded', {
          agentId,
          invocationId: record.invocationId,
          durationMs,
          textChars: textLength,
          toolCalls: toolCallCount,
        });
      }
      // Operability invariant 4: flag a silent dead turn (no output, no error) or
      // an error spike. Runs in `finally` so an aborted/short-circuited stream is
      // still judged. Silent in tests (NOOP_LOGGER) unless a logger is injected.
      checkInvocationProductive(
        deps.logger,
        { threadId, agentId },
        { textLength, toolCallCount, errorCount },
      );
    }
  };
}

/**
 * Resolve the id→AgentService map for the registry. Injected services (test
 * fakes) are passed through; a config WITHOUT an injected service is still
 * registered as a config (a route can list it) but is unrunnable until a real
 * provider is wired — that omission surfaces as registry.getService() throwing,
 * which is the correct "unrunnable agent" signal rather than a silent stub.
 */
function resolveAgentServices(
  injected: Record<string, AgentService> | undefined,
): Record<string, AgentService> {
  const out: Record<string, AgentService> = {};
  if (injected !== undefined) {
    for (const [id, svc] of Object.entries(injected)) {
      out[id] = svc;
    }
  }
  return out;
}

/**
 * Default {@link BuildAppOverrides.buildMemberService} — a no-op provider for a
 * runtime-added member: it yields a single `done`, so a route test can add a
 * member and route to it without a real CLI. main.ts injects the real factory
 * (buildMemberService from runtime/agent-services) for an actually-spawning member.
 */
function defaultMemberService(config: AgentConfig): AgentService {
  const agentId = config.id;
  return {
    invoke(): AsyncIterable<AgentMessage> {
      return (async function* (): AsyncIterable<AgentMessage> {
        yield { type: 'done', agentId, isFinal: true, timestamp: 0 };
      })();
    },
  };
}

/** The directory this factory lives in (for resolving package-relative paths). */
export const APP_FACTORY_DIR: string = resolve(dirname(fileURLToPath(import.meta.url)));

/**
 * Default SOP definition path: the repo `sop/development.yaml`. APP_FACTORY_DIR
 * is `packages/api/src`, so the repo root is three levels up. Externalized
 * (overridable via {@link BuildAppOverrides.sopDefinitionPath}); no hardcoded
 * absolute path lives in source (CLAUDE.md §2.1).
 */
export const DEFAULT_SOP_DEFINITION_PATH: string = resolve(
  APP_FACTORY_DIR,
  '..',
  '..',
  '..',
  'sop',
  'development.yaml',
);
