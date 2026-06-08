// P0-4 MCP/工具桥 (codex + gemini producers).
//
// codex: per-invocation `--config mcp_servers.choco.*` TOML overrides (codex `exec`
//   has no `--mcp-config`). gemini: a pre-written `<workspace>/.gemini/settings.json`
//   (no spawn flag). Both reach OUR `choco` stdio MCP server with the 3 callback
//   env vars embedded — the SAME launch resolver as the claude producer.
//
// Real inputs only (real callback ids, real fs for the gemini write).

import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildCodexMcpConfigArgs,
  buildGeminiMcpSettingsServer,
  writeGeminiMcpSettings,
  MCP_CODEX_CONFIG_ARGS_KEY,
} from '@choco/api/providers/mcp-config';
import { buildArgs as codexBuildArgs } from '@choco/api/providers/codex/codex-service';
import { buildArgs as geminiBuildArgs } from '@choco/api/providers/gemini/gemini-service';

const CONFIG_OPTS = {
  apiBaseUrl: 'http://127.0.0.1:3100',
  invocationId: 'inv-7f3a9c20-codex',
  callbackToken: 'tok-b41e6d88-secret',
} as const;

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/** Fold a `[--config, k=v, --config, k=v, ...]` flag list into a {k: v} map. */
function configMap(args: readonly string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (let i = 0; i < args.length; i += 2) {
    expect(args[i]).toBe('--config');
    const kv = args[i + 1] ?? '';
    const eq = kv.indexOf('=');
    map[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  return map;
}

describe('buildCodexMcpConfigArgs (codex per-invocation --config overrides)', () => {
  it('emits node command + tsx-wrapped .ts entry + enabled + auto-approve', () => {
    const m = configMap(buildCodexMcpConfigArgs(CONFIG_OPTS));
    expect(JSON.parse(m['mcp_servers.choco.command'] as string)).toBe('node');
    // .ts source entry → launched via `node <tsx-cli> <src>` (2 args, abs repo paths).
    const launchArgs = JSON.parse(m['mcp_servers.choco.args'] as string) as string[];
    expect(launchArgs).toHaveLength(2);
    expect(launchArgs[0].replace(/\\/g, '/')).toMatch(/node_modules\/tsx\/dist\/cli\.mjs$/);
    expect(launchArgs[1].replace(/\\/g, '/')).toMatch(/packages\/mcp-server\/src\/index\.ts$/);
    expect(m['mcp_servers.choco.enabled']).toBe('true'); // bare TOML boolean, not quoted
    expect(JSON.parse(m['mcp_servers.choco.default_tools_approval_mode'] as string)).toBe('approve');
  });

  it('embeds the three callback env vars under their canonical keys', () => {
    const m = configMap(buildCodexMcpConfigArgs(CONFIG_OPTS));
    expect(JSON.parse(m['mcp_servers.choco.env.CHOCO_API_URL'] as string)).toBe(CONFIG_OPTS.apiBaseUrl);
    expect(JSON.parse(m['mcp_servers.choco.env.CHOCO_INVOCATION_ID'] as string)).toBe(CONFIG_OPTS.invocationId);
    expect(JSON.parse(m['mcp_servers.choco.env.CHOCO_CALLBACK_TOKEN'] as string)).toBe(CONFIG_OPTS.callbackToken);
  });

  it('launches a PREBUILT .js bundle via `node <bundle>` (single arg, no tsx)', () => {
    const m = configMap(
      buildCodexMcpConfigArgs({ ...CONFIG_OPTS, serverEntryPath: 'D:/repo/packages/mcp-server/dist/index.js' }),
    );
    expect(JSON.parse(m['mcp_servers.choco.args'] as string)).toEqual(['D:/repo/packages/mcp-server/dist/index.js']);
  });

  it('round-trips Windows backslash paths through the TOML/JSON string escaping', () => {
    const winPath = 'C:\\built\\mcp\\index.js';
    const m = configMap(buildCodexMcpConfigArgs({ ...CONFIG_OPTS, serverEntryPath: winPath }));
    // JSON.parse of the TOML inline-array value must yield the ORIGINAL path
    // (backslashes intact) — proving the escaping is correct, not lossy.
    expect(JSON.parse(m['mcp_servers.choco.args'] as string)).toEqual([winPath]);
  });
});

describe('buildGeminiMcpSettingsServer (gemini settings.json server entry)', () => {
  it('produces the choco server with node launch + embedded callback env', () => {
    const server = buildGeminiMcpSettingsServer(CONFIG_OPTS);
    expect(server.command).toBe('node');
    expect(server.args.length).toBeGreaterThanOrEqual(1);
    expect(server.env['CHOCO_API_URL']).toBe(CONFIG_OPTS.apiBaseUrl);
    expect(server.env['CHOCO_INVOCATION_ID']).toBe(CONFIG_OPTS.invocationId);
    expect(server.env['CHOCO_CALLBACK_TOKEN']).toBe(CONFIG_OPTS.callbackToken);
  });
});

describe('writeGeminiMcpSettings (merge-preserving project-level write)', () => {
  function freshWorkspace(): string {
    const ws = mkdtempSync(join(tmpdir(), 'choco-gem-ws-'));
    tmpDirs.push(ws);
    return ws;
  }
  const settingsPath = (ws: string): string => join(ws, '.gemini', 'settings.json');

  it('creates .gemini/settings.json with the choco server when none exists', () => {
    const ws = freshWorkspace();
    writeGeminiMcpSettings(ws, CONFIG_OPTS);
    const parsed = JSON.parse(readFileSync(settingsPath(ws), 'utf-8'));
    expect(parsed.mcpServers.choco.command).toBe('node');
    expect(parsed.mcpServers.choco.env.CHOCO_INVOCATION_ID).toBe(CONFIG_OPTS.invocationId);
  });

  it('PRESERVES the user\'s existing servers AND non-MCP settings keys', () => {
    const ws = freshWorkspace();
    mkdirSync(join(ws, '.gemini'), { recursive: true });
    writeFileSync(
      settingsPath(ws),
      JSON.stringify({ theme: 'dark', mcpServers: { myTool: { command: 'my-bin', args: ['--x'] } } }),
      'utf-8',
    );

    writeGeminiMcpSettings(ws, CONFIG_OPTS);

    const parsed = JSON.parse(readFileSync(settingsPath(ws), 'utf-8'));
    expect(parsed.theme).toBe('dark'); // unrelated key untouched
    expect(parsed.mcpServers.myTool).toEqual({ command: 'my-bin', args: ['--x'] }); // user server intact
    expect(parsed.mcpServers.choco.command).toBe('node'); // ours merged in
  });

  it('overwrites a STALE choco entry (latest invocation wins)', () => {
    const ws = freshWorkspace();
    mkdirSync(join(ws, '.gemini'), { recursive: true });
    writeFileSync(
      settingsPath(ws),
      JSON.stringify({ mcpServers: { choco: { command: 'node', args: ['old'], env: { CHOCO_INVOCATION_ID: 'inv-stale' } } } }),
      'utf-8',
    );

    writeGeminiMcpSettings(ws, CONFIG_OPTS);

    const parsed = JSON.parse(readFileSync(settingsPath(ws), 'utf-8'));
    expect(parsed.mcpServers.choco.env.CHOCO_INVOCATION_ID).toBe(CONFIG_OPTS.invocationId);
  });

  it('does not throw on a malformed existing settings.json (best-effort, writes ours)', () => {
    const ws = freshWorkspace();
    mkdirSync(join(ws, '.gemini'), { recursive: true });
    writeFileSync(settingsPath(ws), '{ this is not json', 'utf-8');

    expect(() => writeGeminiMcpSettings(ws, CONFIG_OPTS)).not.toThrow();
    const parsed = JSON.parse(readFileSync(settingsPath(ws), 'utf-8'));
    expect(parsed.mcpServers.choco.command).toBe('node');
  });
});

describe('codex buildArgs MCP consumer hook', () => {
  it('splices the verbatim --config args (from callbackEnv) before the `-- -` stdin marker', () => {
    const mcpArgs = ['--config', 'mcp_servers.choco.command="node"', '--config', 'mcp_servers.choco.enabled=true'];
    const args = codexBuildArgs(
      { callbackEnv: { [MCP_CODEX_CONFIG_ARGS_KEY]: JSON.stringify(mcpArgs) } },
      'gpt-4.1',
    );
    expect(args).toContain('mcp_servers.choco.command="node"');
    expect(args).toContain('mcp_servers.choco.enabled=true');
    // argv ends with the `-- -` stdin marker (prompt via stdin); MCP overrides come before it.
    expect(args.slice(-2)).toEqual(['--', '-']);
    expect(args.indexOf('mcp_servers.choco.command="node"')).toBeLessThan(args.length - 2);
  });

  it('emits NO --config when callbackEnv carries no codex MCP args', () => {
    const args = codexBuildArgs({ callbackEnv: {} }, 'gpt-4.1');
    expect(args).not.toContain('--config');
  });
});

describe('gemini buildArgs no longer injects MCP via --config', () => {
  it('omits --config even when callbackEnv carries MCP-ish keys (gemini uses settings.json)', () => {
    const args = geminiBuildArgs(
      { callbackEnv: { MCP_CONFIG_JSON: '{"x":1}', [MCP_CODEX_CONFIG_ARGS_KEY]: '["--config","y"]' } },
      'gemini-2.5-pro',
    );
    expect(args).not.toContain('--config');
  });
});
