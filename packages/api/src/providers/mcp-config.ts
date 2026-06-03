// M-wire: the MCP config PRODUCER — builds the value that goes into the
// callbackEnv MCP_CONFIG_JSON key so the REAL claude CLI launches OUR M10 MCP
// server (the 8-tool subsystem) for an invocation.
//
// Source: clowder-design-supplement.md §C3 (MCP run model — the agent CLI spawns
// the MCP server as a stdio subprocess; the server name is `choco`). Claude's
// CLI consumes this via `--mcp-config <value>` (claude-service buildArgs).
//
// The descriptor launches the server one of two ways (see resolveLaunch): a
// PREBUILT bundle (`packages/mcp-server/dist/index.js`, via `node <bundle>`) when
// one exists — the cold-start fast path, no per-invocation TS compile — else the
// .ts source via `node <tsx-cli> <server-entry>` (dev fallback). NOT `npx` (npx is
// unreliable to spawn on Windows; node launches both forms directly). The three callback env vars
// are embedded explicitly in the descriptor's `env` block (robust — claude
// forwards them to the spawned server; we never rely solely on env inheritance).
// Key names are imported from CALLBACK_ENV_KEYS, never re-typed as literals.
//
// Windows handling: claude's CLI treats an inline `--mcp-config` JSON STRING as a
// FILE PATH on win32, so on win32 we write the JSON to a temp file and return the
// PATH; on POSIX we return the inline JSON string.
// Pattern from Clowder ClaudeAgentService (the win32 temp-file branch).

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { APP_FACTORY_DIR, CALLBACK_ENV_KEYS } from '@choco/api/app-factory';

/**
 * Repo-relative path (from {@link APP_FACTORY_DIR} = `packages/api/src`, three
 * levels up to the repo root) of the M10 MCP server entry. Overridable via the
 * `CHOCO_MCP_SERVER_PATH` env var (config-as-data, CLAUDE.md §3.3) — never a
 * hardcoded absolute path in source.
 */
const MCP_SERVER_ENTRY_RELATIVE: readonly string[] = [
  '..',
  '..',
  '..',
  'packages',
  'mcp-server',
  'src',
  'index.ts',
];

/**
 * Repo-relative path of the tsx CLI used to launch the .ts MCP entry under
 * `node`. Overridable via `CHOCO_TSX_CLI_PATH`.
 */
const TSX_CLI_RELATIVE: readonly string[] = [
  '..',
  '..',
  '..',
  'node_modules',
  'tsx',
  'dist',
  'cli.mjs',
];

/**
 * Repo-relative path of the PREBUILT MCP server bundle (`packages/mcp-server/
 * dist/index.js`, produced by `pnpm run build:mcp`). When this exists the server
 * launches as `node <bundle>` — eliminating the per-invocation tsx TS compile
 * that dominated cold-start latency. Resolved from {@link APP_FACTORY_DIR}.
 */
const MCP_SERVER_BUNDLE_RELATIVE: readonly string[] = [
  '..',
  '..',
  '..',
  'packages',
  'mcp-server',
  'dist',
  'index.js',
];

/** File extensions of a prebuilt JS bundle that runs directly under `node` (no tsx). */
const JS_BUNDLE_EXTS: readonly string[] = ['.js', '.mjs', '.cjs'];

/** Env-var names that override the resolved entry / tsx paths (config-as-data). */
const MCP_SERVER_PATH_ENV = 'CHOCO_MCP_SERVER_PATH';
const TSX_CLI_PATH_ENV = 'CHOCO_TSX_CLI_PATH';

/** MCP server name advertised under `mcpServers` (design supplement §C3). */
const MCP_SERVER_NAME = 'choco';

/** Launch command for the MCP server subprocess (node, not npx — see header). */
const MCP_LAUNCH_COMMAND = 'node';

/** Prefix + suffix for the win32 temp config file. */
const WIN_TEMP_PREFIX = 'choco-mcp-';
const WIN_CONFIG_FILENAME = 'mcp-config.json';

/** Inputs to {@link buildClaudeMcpConfig}. The three ids come from the minted record. */
export interface ClaudeMcpConfigOptions {
  /** Base URL the spawned MCP server calls back to (CHOCO_API_URL). */
  readonly apiBaseUrl: string;
  /** This turn's invocation id (CHOCO_INVOCATION_ID). */
  readonly invocationId: string;
  /** This turn's callback token (CHOCO_CALLBACK_TOKEN). */
  readonly callbackToken: string;
  /** Override the resolved MCP server entry path (else env/default). */
  readonly serverEntryPath?: string;
  /** Override the resolved tsx CLI path (else env/default). */
  readonly tsxCliPath?: string;
}

/** A single MCP server descriptor in the `mcpServers` map. */
interface McpServerDescriptor {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
}

/** The full `--mcp-config` object shape claude consumes. */
export interface ClaudeMcpConfigObject {
  readonly mcpServers: Record<string, McpServerDescriptor>;
}

/** Resolve the MCP server entry path: explicit override → env → repo default. */
function resolveServerEntryPath(explicit: string | undefined): string {
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }
  const fromEnv = process.env[MCP_SERVER_PATH_ENV];
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  return resolve(APP_FACTORY_DIR, ...MCP_SERVER_ENTRY_RELATIVE);
}

/** Resolve the tsx CLI path: explicit override → env → repo default. */
function resolveTsxCliPath(explicit: string | undefined): string {
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }
  const fromEnv = process.env[TSX_CLI_PATH_ENV];
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  return resolve(APP_FACTORY_DIR, ...TSX_CLI_RELATIVE);
}

/**
 * Absolute path of the default prebuilt MCP bundle (`packages/mcp-server/dist/
 * index.js`). The composition root (main.ts) probes this and, when present,
 * points `CHOCO_MCP_SERVER_PATH` at it so invocations take the `node <bundle>`
 * fast path; otherwise the .ts source + tsx dev fallback is used.
 */
export function defaultMcpBundlePath(): string {
  return resolve(APP_FACTORY_DIR, ...MCP_SERVER_BUNDLE_RELATIVE);
}

/** True when the resolved server entry is a prebuilt JS bundle (launch via `node <bundle>`). */
function isJsBundle(entryPath: string): boolean {
  const lower = entryPath.toLowerCase();
  return JS_BUNDLE_EXTS.some((ext) => lower.endsWith(ext));
}

/**
 * Resolve the launch command + args for the MCP server subprocess from the
 * resolved entry path:
 *   - a prebuilt JS bundle (e.g. dist/index.js) → `node <bundle>` — NO per-spawn
 *     tsx compile (the cold-start fix);
 *   - a .ts source entry → `node <tsx-cli> <src>` — the dev fallback (no build step).
 */
function resolveLaunch(
  serverEntryPath: string,
  tsxCliPath: string,
): { readonly command: string; readonly args: readonly string[] } {
  if (isJsBundle(serverEntryPath)) {
    return { command: MCP_LAUNCH_COMMAND, args: [serverEntryPath] };
  }
  return { command: MCP_LAUNCH_COMMAND, args: [tsxCliPath, serverEntryPath] };
}

/**
 * Build the `--mcp-config` object (pure — no I/O, no platform branch). The
 * spawned server descriptor launches `node <bundle>` when the resolved entry is a
 * prebuilt JS bundle, else `node <tsx-cli> <src.ts>` (see resolveLaunch), with the
 * three callback env vars embedded under their canonical CALLBACK_ENV_KEYS names.
 */
export function buildClaudeMcpConfigObject(
  opts: ClaudeMcpConfigOptions,
): ClaudeMcpConfigObject {
  const serverEntryPath = resolveServerEntryPath(opts.serverEntryPath);
  const tsxCliPath = resolveTsxCliPath(opts.tsxCliPath);
  const { command, args } = resolveLaunch(serverEntryPath, tsxCliPath);
  const descriptor: McpServerDescriptor = {
    command,
    args,
    env: {
      [CALLBACK_ENV_KEYS.apiUrl]: opts.apiBaseUrl,
      [CALLBACK_ENV_KEYS.invocationId]: opts.invocationId,
      [CALLBACK_ENV_KEYS.callbackToken]: opts.callbackToken,
    },
  };
  return { mcpServers: { [MCP_SERVER_NAME]: descriptor } };
}

/**
 * Whether to use the win32 temp-file behavior. Isolated so the platform branch
 * is the ONLY environmental coupling (the object builder above stays pure).
 */
function isWindows(): boolean {
  return process.platform === 'win32';
}

/**
 * Write the config JSON to a fresh temp file and return its path. On win32
 * claude's CLI reads `--mcp-config <value>` as a file path, not inline JSON.
 * Pattern from Clowder ClaudeAgentService.
 */
function writeConfigToTempFile(json: string): string {
  const dir = mkdtempSync(join(tmpdir(), WIN_TEMP_PREFIX));
  const filePath = join(dir, WIN_CONFIG_FILENAME);
  writeFileSync(filePath, json, 'utf-8');
  return filePath;
}

/**
 * Build the VALUE to put in `callbackEnv['MCP_CONFIG_JSON']`.
 *   - win32  → write the config JSON to a temp file, RETURN THE FILE PATH.
 *   - posix  → RETURN THE INLINE JSON STRING.
 * The claude provider passes this straight to `--mcp-config <value>`.
 */
export function buildClaudeMcpConfig(opts: ClaudeMcpConfigOptions): string {
  const json = JSON.stringify(buildClaudeMcpConfigObject(opts));
  return isWindows() ? writeConfigToTempFile(json) : json;
}
