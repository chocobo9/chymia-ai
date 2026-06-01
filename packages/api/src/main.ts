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

import { buildApp } from '@clowder/api/app-factory';
import {
  buildAgentServicesFromRoster,
  resolvePermissionMode,
} from '@clowder/api/runtime/agent-services';
import {
  createFileLogger,
  routeLoggerFrom,
  type StructuredLogger,
} from '@clowder/api/infrastructure/logger';

/** Default listen port when PORT is unset. */
const DEFAULT_PORT = 3000;
/** Default bind host when HOST is unset. */
const DEFAULT_HOST = '0.0.0.0';

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

/** Resolve the listen port from PORT, falling back to {@link DEFAULT_PORT}. */
function resolvePort(): number {
  const parsed = Number.parseInt(process.env['PORT'] ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PORT;
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
  logger.info({ workspace, permissionMode, host, port }, 'api booting');

  const { api } = buildApp({
    agentServices: buildAgentServicesFromRoster({ permissionMode }),
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

  await api.listen({ port, host });
  logger.info({ host, port, url: `http://${host}:${port}` }, 'api listening');
}

void main();
