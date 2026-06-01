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
import type { AgentMessage, AgentId, IncomingPlatformMessage, StoredMessage } from '@clowder/shared';

import type { AgentService } from '@clowder/api/providers/base';
import { MCP_CONFIG_ENV_KEY } from '@clowder/api/providers/claude/claude-service';
import { buildClaudeMcpConfig } from '@clowder/api/providers/mcp-config';
import { AgentRegistryImpl } from '@clowder/api/routing/agent-registry';
import {
  AgentRouter,
  type InvokeAgentArgs,
  type InvokeAgentFn,
  type RouteLogger,
} from '@clowder/api/routing/agent-router';
import { InvocationRegistry } from '@clowder/api/invocation/invocation-registry';
import { SessionStore } from '@clowder/api/invocation/session-store';
import { SessionMutex } from '@clowder/api/invocation/session-mutex';
import { invokeSingleAgent } from '@clowder/api/invocation/invoke-single-agent';
import type { InvokeSingleAgentParams } from '@clowder/api/invocation/invoke-single-agent';
import { SqliteMessageStore } from '@clowder/api/stores/sqlite-message-store';
import { SqliteThreadStore } from '@clowder/api/stores/sqlite-thread-store';
import { SqliteToolEventLog } from '@clowder/api/stores/sqlite-tool-event-log';
import { SqliteEvidenceStore } from '@clowder/api/evidence/sqlite-evidence-store';
import { SqlitePlatformMappingStore } from '@clowder/api/stores/platform-mapping-store';
import { buildSystemPrompt } from '@clowder/api/context/system-prompt-builder';
import { buildHierarchicalContext } from '@clowder/api/context/hierarchical-context';
import { SopServiceImpl, type SopService } from '@clowder/api/sop/sop-service';
import type { EvidenceRecaller } from '@clowder/api/context/evidence-recall';
import type { ResolveAgentConfig } from '@clowder/api/context/context-assembler';
import { loadAgentConfigs } from '@clowder/api/config/agent-config-loader';
import { SocketManager } from '@clowder/api/infrastructure/socket-manager';
import type { AppServices } from '@clowder/api/infrastructure/app-services';
import { registerThreadRoutes } from '@clowder/api/routes/thread-routes';
import { registerMessageRoutes } from '@clowder/api/routes/message-routes';
import { handleThreadMessage } from '@clowder/api/routes/message-handler';
import { registerAgentRoutes } from '@clowder/api/routes/agent-routes';
import { registerEvidenceRoutes } from '@clowder/api/routes/evidence-routes';
import { registerCallbackRoutes } from '@clowder/api/routes/callback-routes';
import { registerHealthRoutes } from '@clowder/api/routes/health-routes';
import {
  checkWorkspaceMatch,
  checkInvocationProductive,
} from '@clowder/api/infrastructure/invariants';

/** Env var names the CLI/MCP server reads to call back into this API (§C3). */
export const CALLBACK_ENV_KEYS = {
  apiUrl: 'CLOWDER_API_URL',
  invocationId: 'CLOWDER_INVOCATION_ID',
  callbackToken: 'CLOWDER_CALLBACK_TOKEN',
} as const;

/** Overrides accepted by {@link buildApp}. All optional — production passes none. */
export interface BuildAppOverrides {
  /** Inject AgentService instances (e.g. a Fake provider) keyed by agent id. */
  readonly agentServices?: Record<string, AgentService>;
  /** Inject a Database (e.g. ':memory:' or a temp file) instead of opening one. */
  readonly db?: DatabaseType;
  /** Override the agents.yaml roster path. */
  readonly agentsConfigPath?: string;
  /** Sandbox root for read_file callbacks. Defaults to the repo cwd. */
  readonly fileRoot?: string;
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
  ) => Promise<PlatformIngressResult>;
  /** Close DB + HTTP + Socket.io (test/shutdown teardown). */
  readonly close: () => Promise<void>;
}

/** Default in-process DB path when no Database is injected. */
const DEFAULT_DB_PATH = 'clowder.db';

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

  // --- Agent roster + registry (services injected; fakes win in tests) -------
  const configs = loadAgentConfigs(overrides.agentsConfigPath);
  const services = resolveAgentServices(overrides.agentServices);
  const registry = new AgentRegistryImpl(configs, services, {
    ...(overrides.defaultAgentId !== undefined
      ? { defaultAgentId: overrides.defaultAgentId }
      : {}),
  });

  const resolveConfig: ResolveAgentConfig = (id) => registry.get(id);
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
    resolveConfig,
    apiBaseUrl,
    now,
    logger,
    sopService,
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
    evidenceStore,
    platformMappingStore,
    sessionStore,
    socket,
    logger,
    now,
    sopService,
    ...(overrides.defaultWorkspace !== undefined
      ? { defaultWorkspace: overrides.defaultWorkspace }
      : {}),
  };

  const fileRoot = overrides.fileRoot ?? process.cwd();

  // CORS must be registered before routes; Socket.io has its own cors above.
  void api.register(cors, { origin: true });
  registerThreadRoutes(api, appServices);
  registerMessageRoutes(api, appServices);
  registerAgentRoutes(api, appServices);
  registerEvidenceRoutes(api, appServices);
  registerCallbackRoutes(api, appServices, { fileRoot });
  // Operability: liveness probe. Harmless to tests (pure in-memory read).
  registerHealthRoutes(api, { now });

  // G3 platform ingress: resolve A10 ids then drive the shared message pipeline,
  // returning the collected replies for the adapter to send back to the platform.
  const submitPlatformMessage = async (
    incoming: IncomingPlatformMessage,
  ): Promise<PlatformIngressResult> => {
    const threadId = await platformMappingStore.resolveThread(
      incoming.adapterName,
      incoming.channelId,
    );
    const userId = await platformMappingStore.resolveUser(
      incoming.adapterName,
      incoming.platformUserId,
    );
    const { replies } = await handleThreadMessage(appServices, {
      threadId,
      userId,
      content: incoming.text,
    });
    return { threadId, userId, replies };
  };

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
  readonly resolveConfig: ResolveAgentConfig;
  readonly apiBaseUrl: string;
  readonly now: () => number;
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
    const systemPrompt = buildSystemPrompt(effectiveContext, deps.resolveConfig);

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

    // Tally this turn's output for invariant 4 (productive-invocation probe).
    let textLength = 0;
    let toolCallCount = 0;
    let errorCount = 0;

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
