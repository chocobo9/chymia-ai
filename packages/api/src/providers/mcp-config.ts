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

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

/**
 * Codex's per-invocation MCP injection flag. codex `exec` takes repeated
 * `--config <key>=<tomlValue>` overrides (NOT a `.mcp.json` path) — so the codex
 * producer emits a flag LIST, not the claude JSON. Aligned to Clowder
 * CodexAgentService.buildCatCafeMcpConfigArgs.
 */
const CODEX_CONFIG_FLAG = '--config';

/**
 * callbackEnv key under which app-factory stashes the JSON-serialized codex
 * `--config` arg list (consumed by codex-service.buildArgs). DISTINCT from claude's
 * `MCP_CONFIG_JSON` (claude-service) so the two providers never cross-read each
 * other's incompatible payloads. The consumer (codex-service) re-declares this
 * literal locally — keep both in sync (the mcp-config-wire wiring test guards it).
 */
export const MCP_CODEX_CONFIG_ARGS_KEY = 'MCP_CODEX_CONFIG_ARGS';

/** Gemini reads MCP servers from `<workspace>/.gemini/settings.json` (no spawn flag). */
const GEMINI_SETTINGS_DIR = '.gemini';
const GEMINI_SETTINGS_FILE = 'settings.json';

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

// ── Codex producer (per-invocation `--config` TOML overrides) ────────────────

/** Quote a string as a TOML basic string. JSON's escaping (`\` → `\\`, `"` → `\"`)
 * is a valid subset for our values (Windows paths, ids) — no extra TOML lib. */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

/** Serialize a string[] as a TOML inline array of basic strings. */
function tomlStringArray(values: readonly string[]): string {
  return `[${values.map((v) => tomlString(v)).join(',')}]`;
}

/**
 * Build codex's per-invocation MCP `--config` flag list. codex `exec` has no
 * `--mcp-config` equivalent — the server is declared via repeated `--config
 * mcp_servers.<name>.<field>=<tomlValue>` overrides. Aligned to Clowder
 * CodexAgentService.buildCatCafeMcpConfigArgs: command/args/enabled/approval +
 * the callback env keys. The launch (`node <bundle>` | `node <tsx> <src>`) reuses
 * the SAME resolver as the claude/gemini producers.
 *
 * (Clowder also pushes a `cat-cafe.command="echo" ... enabled=false` dummy to
 * disable a DEPRECATED legacy server — we have no such legacy entry under the
 * fresh `choco` name, so that step is intentionally omitted.)
 */
export function buildCodexMcpConfigArgs(opts: ClaudeMcpConfigOptions): string[] {
  const serverEntryPath = resolveServerEntryPath(opts.serverEntryPath);
  const tsxCliPath = resolveTsxCliPath(opts.tsxCliPath);
  const { command, args } = resolveLaunch(serverEntryPath, tsxCliPath);
  const prefix = `mcp_servers.${MCP_SERVER_NAME}`;
  return [
    CODEX_CONFIG_FLAG, `${prefix}.command=${tomlString(command)}`,
    CODEX_CONFIG_FLAG, `${prefix}.args=${tomlStringArray(args)}`,
    CODEX_CONFIG_FLAG, `${prefix}.enabled=true`,
    CODEX_CONFIG_FLAG, `${prefix}.default_tools_approval_mode=${tomlString('approve')}`,
    CODEX_CONFIG_FLAG, `${prefix}.env.${CALLBACK_ENV_KEYS.apiUrl}=${tomlString(opts.apiBaseUrl)}`,
    CODEX_CONFIG_FLAG, `${prefix}.env.${CALLBACK_ENV_KEYS.invocationId}=${tomlString(opts.invocationId)}`,
    CODEX_CONFIG_FLAG, `${prefix}.env.${CALLBACK_ENV_KEYS.callbackToken}=${tomlString(opts.callbackToken)}`,
  ];
}

// ── Gemini producer (pre-written `<workspace>/.gemini/settings.json`) ─────────

/** One server entry in `.gemini/settings.json`'s `mcpServers` map. */
export interface GeminiMcpSettingsServer {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Record<string, string>;
}

/** Build the `choco` server entry for gemini's settings.json (same launch +
 * embedded callback env as the claude/codex producers). */
export function buildGeminiMcpSettingsServer(opts: ClaudeMcpConfigOptions): GeminiMcpSettingsServer {
  const serverEntryPath = resolveServerEntryPath(opts.serverEntryPath);
  const tsxCliPath = resolveTsxCliPath(opts.tsxCliPath);
  const { command, args } = resolveLaunch(serverEntryPath, tsxCliPath);
  return {
    command,
    args,
    env: {
      [CALLBACK_ENV_KEYS.apiUrl]: opts.apiBaseUrl,
      [CALLBACK_ENV_KEYS.invocationId]: opts.invocationId,
      [CALLBACK_ENV_KEYS.callbackToken]: opts.callbackToken,
    },
  };
}

/**
 * Write `<workspaceRoot>/.gemini/settings.json` so the spawned gemini CLI (cwd =
 * workspaceRoot) reads OUR `choco` MCP server — gemini has NO per-invocation MCP
 * flag, so this pre-write is the only delivery path. MERGE-PRESERVING: any
 * existing user `mcpServers` and other settings keys are kept; only the `choco`
 * entry is set/overwritten. Aligned to Clowder mcp-config-adapters.writeGeminiMcpConfig.
 * Best-effort read (missing / malformed file → start fresh, never throw).
 */
export function writeGeminiMcpSettings(workspaceRoot: string, opts: ClaudeMcpConfigOptions): void {
  const dir = join(workspaceRoot, GEMINI_SETTINGS_DIR);
  const filePath = join(dir, GEMINI_SETTINGS_FILE);

  let existing: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown;
    if (parsed !== null && typeof parsed === 'object') {
      existing = parsed as Record<string, unknown>;
    }
  } catch {
    // missing or malformed → fresh object (preserve only what we can parse)
  }

  const existingServers: Record<string, unknown> =
    existing.mcpServers !== null && typeof existing.mcpServers === 'object'
      ? { ...(existing.mcpServers as Record<string, unknown>) }
      : {};
  existingServers[MCP_SERVER_NAME] = buildGeminiMcpSettingsServer(opts);

  const next = { ...existing, mcpServers: existingServers };
  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`, 'utf-8');
}
