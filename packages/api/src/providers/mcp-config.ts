// M-wire: the MCP config PRODUCER — builds the value that goes into the
// callbackEnv MCP_CONFIG_JSON key so the REAL claude CLI launches OUR M10 MCP
// server (the 8-tool subsystem) for an invocation.
//
// Source: clowder-design-supplement.md §C3 (MCP run model — the agent CLI spawns
// the MCP server as a stdio subprocess; the server name is `clowder`). Claude's
// CLI consumes this via `--mcp-config <value>` (claude-service buildArgs).
//
// The descriptor launches the server with `node <tsx-cli> <server-entry>` — NOT
// `npx` (npx is unreliable to spawn on Windows; node + the tsx CLI launches the
// .ts entry directly, proven by the H4 MCP hunt). The three callback env vars
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

import { APP_FACTORY_DIR, CALLBACK_ENV_KEYS } from '@clowder/api/app-factory';

/**
 * Repo-relative path (from {@link APP_FACTORY_DIR} = `packages/api/src`, three
 * levels up to the repo root) of the M10 MCP server entry. Overridable via the
 * `CLOWDER_MCP_SERVER_PATH` env var (config-as-data, CLAUDE.md §3.3) — never a
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
 * `node`. Overridable via `CLOWDER_TSX_CLI_PATH`.
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

/** Env-var names that override the resolved entry / tsx paths (config-as-data). */
const MCP_SERVER_PATH_ENV = 'CLOWDER_MCP_SERVER_PATH';
const TSX_CLI_PATH_ENV = 'CLOWDER_TSX_CLI_PATH';

/** MCP server name advertised under `mcpServers` (design supplement §C3). */
const MCP_SERVER_NAME = 'clowder';

/** Launch command for the MCP server subprocess (node, not npx — see header). */
const MCP_LAUNCH_COMMAND = 'node';

/** Prefix + suffix for the win32 temp config file. */
const WIN_TEMP_PREFIX = 'choco-mcp-';
const WIN_CONFIG_FILENAME = 'mcp-config.json';

/** Inputs to {@link buildClaudeMcpConfig}. The three ids come from the minted record. */
export interface ClaudeMcpConfigOptions {
  /** Base URL the spawned MCP server calls back to (CLOWDER_API_URL). */
  readonly apiBaseUrl: string;
  /** This turn's invocation id (CLOWDER_INVOCATION_ID). */
  readonly invocationId: string;
  /** This turn's callback token (CLOWDER_CALLBACK_TOKEN). */
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
 * Build the `--mcp-config` object (pure — no I/O, no platform branch). The
 * spawned server descriptor launches `node <tsx-cli> <entry>` with the three
 * callback env vars embedded under their canonical CALLBACK_ENV_KEYS names.
 */
export function buildClaudeMcpConfigObject(
  opts: ClaudeMcpConfigOptions,
): ClaudeMcpConfigObject {
  const serverEntryPath = resolveServerEntryPath(opts.serverEntryPath);
  const tsxCliPath = resolveTsxCliPath(opts.tsxCliPath);
  const descriptor: McpServerDescriptor = {
    command: MCP_LAUNCH_COMMAND,
    args: [tsxCliPath, serverEntryPath],
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
