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
// This file uses the project logger seam (RouteLogger) — NOT console.log — for
// its boot note, per CLAUDE.md §2.1. Run it via: npx tsx packages/api/src/main.ts
// (the scripts/launch.mjs launcher does this for you alongside the web dev server).

import { buildApp } from '@clowder/api/app-factory';
import {
  buildAgentServicesFromRoster,
  resolvePermissionMode,
} from '@clowder/api/runtime/agent-services';

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
 * Emit a structured boot note to stderr. NOT console.log (CLAUDE.md §2.1) — this
 * is the composition root's own diagnostic channel (distinct from the in-app
 * RouteLogger, which carries a per-request threadId). Boot notes have no threadId.
 */
function bootLog(level: 'info' | 'warn', message: string): void {
  process.stderr.write(`[api] ${level}: ${message}\n`);
}

async function main(): Promise<void> {
  const { dir: workspace, isDefault: workspaceIsDefault } = resolveWorkspace();
  const port = resolvePort();
  const host = process.env['HOST'] ?? DEFAULT_HOST;
  const permissionMode = resolvePermissionMode(process.env['CHOCO_PERMISSION_MODE']);

  if (workspaceIsDefault) {
    bootLog(
      'warn',
      `CHOCO_WORKSPACE unset — agents will operate on ${workspace} (process cwd). ` +
        `Set CHOCO_WORKSPACE to a dedicated project directory.`,
    );
  }
  bootLog(
    'info',
    `workspace=${workspace} permissionMode=${permissionMode} host=${host} port=${port}`,
  );

  const { api } = buildApp({
    agentServices: buildAgentServicesFromRoster({ permissionMode }),
    fileRoot: workspace,
    defaultWorkspace: workspace,
  });

  await api.listen({ port, host });
  bootLog('info', `listening on http://${host}:${port}`);
}

void main();
