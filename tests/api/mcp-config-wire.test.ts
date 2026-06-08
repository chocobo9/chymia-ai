// Dev happy-path: the MCP config PRODUCER wire. Three layers:
//   1. buildClaudeMcpConfigObject (pure) — shape, abs paths, embedded env block.
//   2. buildClaudeMcpConfig (platform wrapper) — win32 returns a temp-file path
//      whose content is the JSON; posix returns the inline JSON string.
//   3. buildApp wiring — driving a real turn sets callbackEnv['MCP_CONFIG_JSON']
//      IFF the agent is claude (clientId 'anthropic' + mcpSupport), and forwards
//      the configured apiBaseUrl into CHOCO_API_URL.
//   4. claude buildArgs — given MCP_CONFIG_JSON it emits `--mcp-config <value>`.
//
// QA (≠ me) owns edge/adversarial (malformed env, missing config, non-anthropic
// MUST NOT leak, win32/posix cross-branch, env-override paths, the real e2e).
// Real inputs only (real agent ids, real @mention, real callback ids).

import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { buildApp, type BuildAppOverrides, type BuiltApp } from '@choco/api/app-factory';
import {
  buildClaudeMcpConfig,
  buildClaudeMcpConfigObject,
  defaultMcpBundlePath,
  MCP_CODEX_CONFIG_ARGS_KEY,
  type ClaudeMcpConfigObject,
} from '@choco/api/providers/mcp-config';
import { buildArgs, MCP_CONFIG_ENV_KEY } from '@choco/api/providers/claude/claude-service';
import { FakeAgentService } from '../invocation/fake-agent-service.js';
import { replyScript, CLAUDE, CODEX, GEMINI } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

// Real per-invocation callback identity (the shape the InvocationRegistry mints).
const CONFIG_OPTS = {
  apiBaseUrl: 'http://127.0.0.1:3100',
  invocationId: 'inv-7f3a9c20-claude-opus',
  callbackToken: 'tok-b41e6d88-secret',
} as const;

describe('buildClaudeMcpConfigObject (pure builder)', () => {
  it('produces a single clowder server launched via node + tsx-cli + entry', () => {
    const cfg: ClaudeMcpConfigObject = buildClaudeMcpConfigObject(CONFIG_OPTS);

    const server = cfg.mcpServers['choco'];
    expect(server).toBeDefined();
    expect(server?.command).toBe('node');
    expect(server?.args).toHaveLength(2);
    // node + tsx CLI + the M10 server entry (resolved to abs repo paths).
    expect(server?.args[0]?.replace(/\\/g, '/')).toMatch(/node_modules\/tsx\/dist\/cli\.mjs$/);
    expect(server?.args[1]?.replace(/\\/g, '/')).toMatch(/packages\/mcp-server\/src\/index\.ts$/);
  });

  it('embeds the three callback env vars under their canonical keys', () => {
    const cfg = buildClaudeMcpConfigObject(CONFIG_OPTS);
    const env = cfg.mcpServers['choco']?.env;

    expect(env?.['CHOCO_API_URL']).toBe(CONFIG_OPTS.apiBaseUrl);
    expect(env?.['CHOCO_INVOCATION_ID']).toBe(CONFIG_OPTS.invocationId);
    expect(env?.['CHOCO_CALLBACK_TOKEN']).toBe(CONFIG_OPTS.callbackToken);
  });

  it('respects the CHOCO_MCP_SERVER_PATH env override', () => {
    const override = 'D:/custom/mcp/entry.ts';
    const prev = process.env['CHOCO_MCP_SERVER_PATH'];
    process.env['CHOCO_MCP_SERVER_PATH'] = override;
    try {
      const cfg = buildClaudeMcpConfigObject(CONFIG_OPTS);
      expect(cfg.mcpServers['choco']?.args[1]).toBe(override);
    } finally {
      if (prev === undefined) delete process.env['CHOCO_MCP_SERVER_PATH'];
      else process.env['CHOCO_MCP_SERVER_PATH'] = prev;
    }
  });

  it('respects an explicit serverEntryPath override over env/default', () => {
    const cfg = buildClaudeMcpConfigObject({
      ...CONFIG_OPTS,
      serverEntryPath: 'D:/explicit/entry.ts',
      tsxCliPath: 'D:/explicit/tsx.mjs',
    });
    expect(cfg.mcpServers['choco']?.args).toEqual([
      'D:/explicit/tsx.mjs',
      'D:/explicit/entry.ts',
    ]);
  });

  it('launches a PREBUILT .js bundle entry via `node <bundle>` — no tsx (cold-start fast path)', () => {
    // A prebuilt bundle path (ends in .js) must NOT be wrapped in tsx: the whole
    // point of the fast path is to skip the per-invocation TS compile.
    const cfg = buildClaudeMcpConfigObject({
      ...CONFIG_OPTS,
      serverEntryPath: 'D:/repo/packages/mcp-server/dist/index.js',
      tsxCliPath: 'D:/explicit/tsx.mjs',
    });
    expect(cfg.mcpServers['choco']?.command).toBe('node');
    expect(cfg.mcpServers['choco']?.args).toEqual(['D:/repo/packages/mcp-server/dist/index.js']);
  });

  it('launches a .js bundle via the CHOCO_MCP_SERVER_PATH env override too (single node arg)', () => {
    const override = 'D:/built/mcp/index.js';
    const prev = process.env['CHOCO_MCP_SERVER_PATH'];
    process.env['CHOCO_MCP_SERVER_PATH'] = override;
    try {
      const cfg = buildClaudeMcpConfigObject(CONFIG_OPTS);
      expect(cfg.mcpServers['choco']?.args).toEqual([override]);
    } finally {
      if (prev === undefined) delete process.env['CHOCO_MCP_SERVER_PATH'];
      else process.env['CHOCO_MCP_SERVER_PATH'] = prev;
    }
  });

  it('defaultMcpBundlePath resolves to the absolute packages/mcp-server/dist/index.js', () => {
    const bundle = defaultMcpBundlePath();
    expect(isAbsolute(bundle)).toBe(true);
    expect(bundle).not.toContain('undefined');
    expect(bundle.replace(/\\/g, '/')).toMatch(/packages\/mcp-server\/dist\/index\.js$/);
  });
});

describe('buildClaudeMcpConfig (platform wrapper)', () => {
  it('returns a value that resolves to the config object on this platform', () => {
    const value = buildClaudeMcpConfig(CONFIG_OPTS);
    const expected = buildClaudeMcpConfigObject(CONFIG_OPTS);

    // win32: value is a temp-file PATH whose content is the JSON.
    // posix:  value is the inline JSON string.
    const parsed = (
      process.platform === 'win32'
        ? (JSON.parse(readFileSync(value, 'utf-8')) as unknown)
        : (JSON.parse(value) as unknown)
    ) as ClaudeMcpConfigObject;

    expect(parsed).toEqual(expected);
    if (process.platform === 'win32') {
      // The returned value is a path, NOT the JSON itself.
      expect(value.replace(/\\/g, '/')).toMatch(/mcp-config\.json$/);
    } else {
      expect(value.startsWith('{')).toBe(true);
    }
  });
});

// ── buildApp wiring ───────────────────────────────────────────────────────

/** Build an inject-only app with the given fakes + overrides. */
function appWith(
  agentServices: Record<string, FakeAgentService>,
  overrides: Omit<BuildAppOverrides, 'db' | 'agentServices'> = {},
): BuiltApp {
  const db = new Database(':memory:');
  return buildApp({ db, agentServices, ...overrides });
}

/** Drive one @mention message through the route so the fake provider is invoked. */
async function postMention(app: BuiltApp, threadId: string, mention: string): Promise<void> {
  await app.api.inject({
    method: 'POST',
    url: `/api/threads/${threadId}/messages`,
    payload: { content: `${mention} 把 evidence 记一下`, userId: 'user-makima' },
  });
}

describe('MCP producer wiring via buildApp', () => {
  it('sets MCP_CONFIG_JSON in claude callbackEnv (anthropic + mcpSupport)', async () => {
    const fake = new FakeAgentService([replyScript(CLAUDE, '收到，调用 evidence_upsert。')]);
    const app = appWith({ 'claude-opus': fake });
    cleanups.push(app.close);

    await postMention(app, 'thread-claude-mcp', '@claude');

    expect(fake.calls).toHaveLength(1);
    const value = fake.calls[0]?.options?.callbackEnv?.[MCP_CONFIG_ENV_KEY];
    expect(value).toBeDefined();
    const parsed = (
      process.platform === 'win32'
        ? (JSON.parse(readFileSync(value as string, 'utf-8')) as unknown)
        : (JSON.parse(value as string) as unknown)
    ) as ClaudeMcpConfigObject;
    expect(parsed.mcpServers['choco']?.command).toBe('node');
  });

  it('does NOT set MCP_CONFIG_JSON for a non-anthropic agent (codex)', async () => {
    const fake = new FakeAgentService([replyScript(CODEX, '收到，快速实现。')]);
    const app = appWith({ 'codex-gpt': fake });
    cleanups.push(app.close);

    await postMention(app, 'thread-codex-mcp', '@codex');

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.options?.callbackEnv?.[MCP_CONFIG_ENV_KEY]).toBeUndefined();
  });

  it('forwards the configured apiBaseUrl into CHOCO_API_URL', async () => {
    const apiBaseUrl = 'http://127.0.0.1:3100';
    const fake = new FakeAgentService([replyScript(CLAUDE, '在指定 base 上回调。')]);
    const app = appWith({ 'claude-opus': fake }, { apiBaseUrl });
    cleanups.push(app.close);

    await postMention(app, 'thread-apibase', '@claude');

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.options?.callbackEnv?.['CHOCO_API_URL']).toBe(apiBaseUrl);
  });
});

describe('MCP producer wiring — codex (per-invocation --config) + gemini (settings.json)', () => {
  it('sets MCP_CODEX_CONFIG_ARGS for codex (openai + mcpSupport), NOT the claude JSON', async () => {
    const fake = new FakeAgentService([replyScript(CODEX, '收到，调用 evidence_upsert。')]);
    const app = appWith({ 'codex-gpt': fake });
    cleanups.push(app.close);

    await postMention(app, 'thread-codex-mcp-args', '@codex');

    expect(fake.calls).toHaveLength(1);
    const env = fake.calls[0]?.options?.callbackEnv;
    // codex gets its OWN serialized --config list...
    const raw = env?.[MCP_CODEX_CONFIG_ARGS_KEY];
    expect(raw).toBeDefined();
    const codexArgs = JSON.parse(raw as string) as string[];
    expect(codexArgs).toContain('--config');
    expect(codexArgs).toContain('mcp_servers.choco.command="node"');
    // ...and NEVER the claude `--mcp-config` JSON (formats are not interchangeable).
    expect(env?.[MCP_CONFIG_ENV_KEY]).toBeUndefined();
  });

  it('writes <workspace>/.gemini/settings.json with the choco server (google + mcpSupport)', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'choco-gem-wire-'));
    cleanups.push(async () => rmSync(workspace, { recursive: true, force: true }));

    const fake = new FakeAgentService([replyScript(GEMINI, '我给两个替代方案。')]);
    // defaultWorkspace flows into the per-turn workingDirectory the producer writes into.
    const app = appWith({ 'gemini-pro': fake }, { defaultWorkspace: workspace });
    cleanups.push(app.close);

    await postMention(app, 'thread-gemini-mcp-file', '@gemini');

    expect(fake.calls).toHaveLength(1);
    const settings = JSON.parse(readFileSync(join(workspace, '.gemini', 'settings.json'), 'utf-8'));
    expect(settings.mcpServers.choco.command).toBe('node');
    expect(settings.mcpServers.choco.env['CHOCO_API_URL']).toBeDefined();
    // gemini gets MCP via the file, NOT via callbackEnv MCP_CONFIG_JSON.
    expect(fake.calls[0]?.options?.callbackEnv?.[MCP_CONFIG_ENV_KEY]).toBeUndefined();
  });
});

describe('claude buildArgs MCP hook', () => {
  it('emits --mcp-config <value> when callbackEnv carries MCP_CONFIG_JSON', () => {
    const mcpValue = 'D:/tmp/choco-mcp/mcp-config.json';
    const args = buildArgs(
      '@claude 记录 evidence',
      { callbackEnv: { [MCP_CONFIG_ENV_KEY]: mcpValue } },
      'claude-opus-4-6',
      'bypassPermissions',
    );

    const flagIndex = args.indexOf('--mcp-config');
    expect(flagIndex).toBeGreaterThanOrEqual(0);
    expect(args[flagIndex + 1]).toBe(mcpValue);
  });
});
