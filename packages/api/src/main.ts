// packages/api/src/main.ts
// Composition root — the RUNNABLE entry that wires REAL CLI providers and starts
// the server. index.ts is forbidden to `new` services (it only builds + listens
// with no overrides, for the inject-fakes test seam); this file is the production
// composition root that constructs the real provider roster and a workspace.
//
// ── Environment variables (all externalized — no hardcoded config, CLAUDE.md §2.1)
//   CHOCO_WORKSPACE        Local directory agents operate in (their CLI cwd) when a
//                          thread has no projectPath. Used for BOTH:
//                            - fileRoot         (read_file callback sandbox root)
//                            - defaultWorkspace (default agent working directory)
//                          Defaults to process.cwd() (logged) when unset.
//   CHOCO_PERMISSION_MODE  Claude CLI permission mode. Default 'acceptEdits'
//                          (resolvePermissionMode). Must be a valid Claude mode
//                          (acceptEdits | auto | bypassPermissions | default |
//                          dontAsk | plan) or boot fails fast.
//   PORT                   Listen port. Default 3000.
//   HOST                   Bind host.  Default 0.0.0.0.
//   CHOCO_CLAUDE_CMD       Override the claude CLI command/path (default 'claude').
//   CHOCO_CODEX_CMD        Override the codex  CLI command/path (default 'codex').
//   CHOCO_GEMINI_CMD       Override the gemini CLI command/path (default 'gemini').
//                          Use when a CLI is installed under a different name or is
//                          NOT on PATH — set an ABSOLUTE path and the boot
//                          availability probe resolves it directly (off-PATH OK).
//
// This file is the operability EDGE: it constructs the REAL structured file
// logger (createFileLogger — stdout + rolling file under LOG_DIR), installs the
// process crash handlers (uncaught/unhandled → log + exit non-zero), and injects
// the logger into buildApp via the existing RouteLogger seam so invocation audit
// + invariant-probe warnings land in the log file. buildApp's own default logger
// stays a no-op (tests write no files). NOT console.log, per CLAUDE.md §2.1. Run
// via: npx tsx packages/api/src/main.ts (scripts/launch.mjs does this for you and
// supervises/restarts this process on unexpected exit).
//
//   LOG_DIR    Directory rolling log files are written under. Default ./data/logs/api.
//   LOG_LEVEL  Minimum level emitted (trace…fatal). Default 'info'.
//   CHOCO_AGENT_OVERRIDES  JSON file the runtime member-edit overlay persists to
//                          (M-MEMBER). Default ./data/agent-overrides.json
//                          (relative to cwd). Edits made in Settings → 成员管理
//                          are written here and survive a restart.

import { existsSync, mkdirSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { ClientId } from '@choco/shared';
import { buildApp } from '@choco/api/app-factory';
import { defaultMcpBundlePath } from '@choco/api/providers/mcp-config';
import {
  WorkspaceTrustStore,
  applyWorkspaceTrustEnv,
  resolveTrustStorePath,
  isTrustFlagSet,
  TRUST_FLAG_ENV,
} from '@choco/api/runtime/workspace-trust';
import { JsonAgentOverrideStore } from '@choco/api/config/agent-overrides';
import { JsonRuntimeRosterStore } from '@choco/api/config/runtime-roster';
import { WeChatConfigStore } from '@choco/api/config/wechat-config-store';
import { wireWeChatAdapter } from '@choco/api/runtime/wechat-wiring';
import {
  buildAgentServicesFromRoster,
  buildMemberService,
  resolvePermissionMode,
} from '@choco/api/runtime/agent-services';
import { probeAgentAvailability } from '@choco/api/runtime/cli-availability';
import {
  createFileLogger,
  routeLoggerFrom,
  type StructuredLogger,
} from '@choco/api/infrastructure/logger';

/** Default listen port when PORT is unset. */
const DEFAULT_PORT = 3000;
/** Default bind host when HOST is unset. */
const DEFAULT_HOST = '0.0.0.0';
/** Default file the runtime member-edit overlay persists to (M-MEMBER). */
const DEFAULT_AGENT_OVERRIDES_PATH = 'data/agent-overrides.json';
/** Default file the runtime-ADDED members persist to (成员增删). */
const DEFAULT_RUNTIME_ROSTER_PATH = 'data/runtime-agents.json';

/** Resolve the runtime-roster file path from CHOCO_RUNTIME_ROSTER (→ absolute). */
function resolveRuntimeRosterPath(): string {
  const configured = process.env['CHOCO_RUNTIME_ROSTER'];
  const raw =
    configured !== undefined && configured.length > 0 ? configured : DEFAULT_RUNTIME_ROSTER_PATH;
  return resolvePath(process.cwd(), raw);
}

/**
 * Resolve the agent-overrides file path from CHOCO_AGENT_OVERRIDES, falling back
 * to {@link DEFAULT_AGENT_OVERRIDES_PATH} (relative to cwd → absolute).
 */
function resolveAgentOverridesPath(): string {
  const configured = process.env['CHOCO_AGENT_OVERRIDES'];
  const raw =
    configured !== undefined && configured.length > 0
      ? configured
      : DEFAULT_AGENT_OVERRIDES_PATH;
  return resolvePath(process.cwd(), raw);
}

/**
 * Resolve the workspace directory from CHOCO_WORKSPACE, falling back to the
 * process cwd. Returns the value AND whether it was a default (so the caller can
 * log the fallback clearly — operating agents on an unexpected directory is the
 * kind of thing that MUST be visible).
 */
function resolveWorkspace(): { readonly dir: string; readonly isDefault: boolean } {
  const configured = process.env['CHOCO_WORKSPACE'];
  if (configured !== undefined && configured.length > 0) {
    return { dir: configured, isDefault: false };
  }
  return { dir: process.cwd(), isDefault: true };
}

/**
 * Resolve per-client CLI command overrides from the CHOCO_{CLAUDE,CODEX,GEMINI}_CMD
 * env vars. Only non-empty values are forwarded; unset → the provider's default.
 */
function resolveCommandByClient(): Partial<Record<ClientId, string>> {
  const out: Partial<Record<ClientId, string>> = {};
  const map: ReadonlyArray<readonly [ClientId, string]> = [
    ['anthropic', 'CHOCO_CLAUDE_CMD'],
    ['openai', 'CHOCO_CODEX_CMD'],
    ['google', 'CHOCO_GEMINI_CMD'],
  ];
  for (const [client, envKey] of map) {
    const value = process.env[envKey];
    if (value !== undefined && value.length > 0) out[client] = value;
  }
  return out;
}

/** Resolve the listen port from PORT, falling back to {@link DEFAULT_PORT}. */
function resolvePort(): number {
  const parsed = Number.parseInt(process.env['PORT'] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PORT;
}

/** Env key the MCP config producer reads for the server entry (mcp-config.ts). */
const MCP_SERVER_PATH_ENV = 'CHOCO_MCP_SERVER_PATH';

/**
 * VSCode-style workspace-trust gate (enforcement half). The interactive consent
 * prompt runs earlier in the launcher (`scripts/ensure-trust.ts`) and PERSISTS to
 * the store; here we read that decision and, when trusted, set the providers'
 * trust env flags (so gemini's headless auto-approve works in this dir). An
 * already-trusted workspace proceeds silently; the `CHOCO_TRUST_WORKSPACE=1` flag
 * grants + remembers trust non-interactively; otherwise we run RESTRICTED (claude/
 * codex still work; gemini will refuse) and log how to trust.
 */
function ensureWorkspaceTrust(workspace: string, logger: StructuredLogger): void {
  const store = new WorkspaceTrustStore(resolveTrustStorePath());
  if (store.isTrusted(workspace)) {
    applyWorkspaceTrustEnv(process.env);
    logger.info({ workspace }, 'workspace trusted — agents may auto-approve tools here');
    return;
  }
  if (isTrustFlagSet(process.env[TRUST_FLAG_ENV])) {
    store.trust(workspace);
    applyWorkspaceTrustEnv(process.env);
    logger.info({ workspace }, `workspace trusted via ${TRUST_FLAG_ENV} — remembered`);
    return;
  }
  logger.warn(
    { workspace },
    `workspace NOT trusted — running restricted (gemini headless auto-approve disabled). ` +
      `Trust it once via an interactive \`pnpm app\` prompt, or set ${TRUST_FLAG_ENV}=1.`,
  );
}

/**
 * Cold-start fast path: when CHOCO_MCP_SERVER_PATH is not already set and the
 * prebuilt MCP bundle (packages/mcp-server/dist/index.js) exists, point the env at
 * it so every agent invocation launches the MCP server as `node <bundle>` instead
 * of re-compiling the TS graph through tsx on each spawn. No bundle (un-built dev
 * run) → leave it unset and the producer falls back to tsx. An explicit env value
 * always wins (never overridden here).
 */
function preferPrebuiltMcpBundle(logger: StructuredLogger): void {
  const existing = process.env[MCP_SERVER_PATH_ENV];
  if (existing !== undefined && existing.length > 0) {
    logger.info({ mcpServerPath: existing }, 'MCP server: using explicit CHOCO_MCP_SERVER_PATH');
    return;
  }
  const bundle = defaultMcpBundlePath();
  if (existsSync(bundle)) {
    process.env[MCP_SERVER_PATH_ENV] = bundle;
    logger.info({ bundle }, 'MCP server: launching prebuilt bundle via node (cold-start fast path)');
  } else {
    logger.warn(
      { bundle },
      'MCP server: no prebuilt bundle — falling back to tsx (slower cold start). ' +
        'Run `pnpm run build:mcp` to enable the node fast path.',
    );
  }
}

/**
 * Install process-level crash handlers that LOG the fault through the structured
 * logger (so it lands in the rolling log file, not just a vanished stderr line)
 * and exit non-zero so the launcher's supervisor restarts the API. Installed at
 * the EDGE only (this composition root), never inside buildApp — tests must not
 * register global process handlers.
 */
function installCrashHandlers(logger: StructuredLogger): void {
  const CRASH_EXIT_CODE = 1;
  process.on('uncaughtException', (err: Error) => {
    logger.error(
      { kind: 'uncaughtException', name: err.name, stack: err.stack },
      `uncaught exception: ${err.message}`,
    );
    process.exit(CRASH_EXIT_CODE);
  });
  process.on('unhandledRejection', (reason: unknown) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    logger.error(
      { kind: 'unhandledRejection', ...(stack !== undefined ? { stack } : {}) },
      `unhandled rejection: ${message}`,
    );
    process.exit(CRASH_EXIT_CODE);
  });
}

async function main(): Promise<void> {
  // EDGE wiring: construct the REAL file logger here (NEVER in buildApp, whose
  // default must stay a no-op so the test suite writes no log files).
  const logger = createFileLogger();
  installCrashHandlers(logger);

  // Cold-start: prefer the prebuilt MCP bundle (node) over per-invocation tsx.
  preferPrebuiltMcpBundle(logger);

  const { dir: workspace, isDefault: workspaceIsDefault } = resolveWorkspace();
  const port = resolvePort();
  const host = process.env['HOST'] ?? DEFAULT_HOST;
  const permissionMode = resolvePermissionMode(process.env['CHOCO_PERMISSION_MODE']);

  if (workspaceIsDefault) {
    logger.warn(
      { workspace },
      `CHOCO_WORKSPACE unset — agents will operate on ${workspace} (process cwd). ` +
        `Set CHOCO_WORKSPACE to a dedicated project directory.`,
    );
  }

  // The workspace is BOTH the agent CLI cwd (defaultWorkspace) AND the read_file
  // sandbox root (fileRoot). A configured-but-missing directory (e.g. launch.mjs's
  // default `<repo>/.workspace`, which it does not create) makes the agent CLI
  // spawn with a non-existent cwd → instant spawn failure (durationMs≈3-8,
  // textChars=0, errors=1) and a new conversation never gets a reply. Ensure it
  // exists before wiring services so EVERY launch path has a valid cwd/fileRoot.
  mkdirSync(workspace, { recursive: true });
  logger.info({ workspace }, 'workspace directory ensured');

  // VSCode-style trust gate: only auto-approve agent tools in a workspace the
  // user explicitly trusted (sets gemini's trust env when granted).
  ensureWorkspaceTrust(workspace, logger);

  logger.info({ workspace, permissionMode, host, port }, 'api booting');

  // §A: build the REAL provider roster, then DERIVE each agent's availability by
  // probing whether its CLI is installed on THIS system (claude resolves;
  // codex/gemini may not). The map flows into buildApp → AgentRegistry.isAvailable,
  // so the router routes only to available agents and surfaces a visible notice
  // for an explicit @mention of an unavailable one — never a silent spawn-fail.
  // Derived at boot (deployment-agnostic), NOT hardcoded in agents.yaml.
  const commandByClient = resolveCommandByClient();
  const agentServices = buildAgentServicesFromRoster({ permissionMode, commandByClient });

  // 成员增删: the persisted runtime-ADDED members + the factory that builds a NEW
  // member's provider (curried with the live permissionMode/commandByClient). Loaded
  // fail-open. buildApp merges these into the registry; the POST route hot-registers.
  const runtimeRosterPath = resolveRuntimeRosterPath();
  const runtimeRoster = new JsonRuntimeRosterStore(runtimeRosterPath);
  const buildMember = (config: Parameters<typeof buildMemberService>[0]): ReturnType<typeof buildMemberService> =>
    buildMemberService(config, { permissionMode, commandByClient });

  // Probe CLI availability for BASE + runtime members (so an added member whose CLI
  // isn't installed shows offline, same honest signal as the base roster).
  const runtimeServices: Record<string, ReturnType<typeof buildMemberService>> = {};
  for (const cfg of runtimeRoster.all()) runtimeServices[cfg.id as string] = buildMember(cfg);
  const agentAvailability = {
    ...probeAgentAvailability(agentServices),
    ...probeAgentAvailability(runtimeServices),
  };
  logger.info(
    { agentAvailability, commandOverrides: commandByClient, runtimeMembers: runtimeRoster.all().length },
    'agent CLI availability probed',
  );

  // M-MEMBER: the persisted runtime overlay for member edits. Loaded fail-open
  // (a missing/corrupt file → no overrides), so a bad file never blocks boot.
  const agentOverridesPath = resolveAgentOverridesPath();
  const agentOverrideStore = new JsonAgentOverrideStore(agentOverridesPath);
  logger.info({ agentOverridesPath }, 'agent overrides store loaded');

  const { api, submitPlatformMessage, weixinManager } = buildApp({
    agentServices,
    agentAvailability,
    agentOverrideStore,
    runtimeRoster,
    buildMemberService: buildMember,
    fileRoot: workspace,
    defaultWorkspace: workspace,
    // The base URL the spawned MCP server calls back to. buildApp defaults this
    // to `http://127.0.0.1` (NO port) → MCP callbacks would POST to port 80 and
    // fail; override with the resolved port. 127.0.0.1 (not HOST) because the MCP
    // child always reaches the API on localhost even when HOST binds 0.0.0.0.
    apiBaseUrl: `http://127.0.0.1:${port}`,
    // Inject the real logger via the EXISTING RouteLogger seam: route notes +
    // invocation audit + invariant probe warnings now land in the rolling file.
    logger: routeLoggerFrom(logger),
  });

  // M13: wire the WeChat (WeCom) adapter when configured + enabled (its webhook
  // mounts on `api`, so this MUST run before listen). Not configured → no-op.
  const wechatStore = new WeChatConfigStore();
  const wechatWired = await wireWeChatAdapter({
    api,
    submitPlatformMessage,
    store: wechatStore,
    logger,
    now: Date.now,
  });
  logger.info(
    { wired: wechatWired, webhook: '/api/adapters/wechat/webhook' },
    wechatWired
      ? 'WeChat adapter wired — webhook live'
      : 'WeChat adapter not configured/disabled — skipped (configure in 设置 → IM 对接)',
  );

  await api.listen({ port, host });
  logger.info({ host, port, url: `http://${host}:${port}` }, 'api listening');

  // M14b: reconnect a persisted personal-WeChat (iLink) session, if any. No-op
  // when not logged in; starts the long-poll adapter when a bot_token is stored.
  weixinManager.autoStart();
}

void main();
