// QA edge/adversarial — the MCP config PRODUCER wire. Authored by a QA instance
// that did NOT write the product code (CLAUDE.md §0.5.3 dev≠QA). The dev's happy
// suite (mcp-config-wire.test.ts) covers the basic object shape, the win32 temp
// file, the anthropic-set / codex-absent gates, and the buildArgs hook. This file
// HUNTS the edges the dev is forbidden to gate:
//   - absolute-path guarantees + env-override PRECEDENCE (explicit > env > default)
//     incl. the blank-override fall-through (an empty override must NOT win)
//   - the win32 temp-file: under the OS tmpdir, named choco-mcp-*, content === object
//   - the posix INLINE-JSON branch, driven by stubbing process.platform
//   - tempfile UNIQUENESS across two calls (no collision on concurrent turns/repeats)
//   - a very long callback token + special chars in paths round-trip intact + valid JSON
//   - producer gating: anthropic+mcpSupport SET, non-anthropic ABSENT, anthropic
//     mcpSupport:false ABSENT (fixture roster), and NO shared-state pollution across turns
//   - apiBaseUrl (the port-fix) flows into BOTH callbackEnv.CHOCO_API_URL AND the
//     embedded MCP config env.CHOCO_API_URL
//   - buildArgs verbatim passthrough of --mcp-config <value>
//
// Real inputs only: real roster agent ids, real @mention triggers, real minted-shape
// invocation/callback ids. No placeholders.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import Database from 'better-sqlite3';
import { buildApp, type BuildAppOverrides, type BuiltApp } from '@choco/api/app-factory';
import {
  buildClaudeMcpConfig,
  buildClaudeMcpConfigObject,
  type ClaudeMcpConfigObject,
} from '@choco/api/providers/mcp-config';
import { buildArgs, MCP_CONFIG_ENV_KEY } from '@choco/api/providers/claude/claude-service';
import { FakeAgentService } from '../invocation/fake-agent-service.js';
import { replyScript, CLAUDE, CODEX, GEMINI } from './helpers.js';

// Real per-invocation callback identity (the shape InvocationRegistry mints).
const CONFIG_OPTS = {
  apiBaseUrl: 'http://127.0.0.1:3100',
  invocationId: 'inv-7f3a9c20-claude-opus',
  callbackToken: 'tok-b41e6d88-secret',
} as const;

// ── teardown: app closes + temp roster dirs + restore env + unstub platform ──
const cleanups: Array<() => Promise<void>> = [];
const tmpDirs: string[] = [];
const savedEnv = new Map<string, string | undefined>();

function setEnv(key: string, value: string | undefined): void {
  if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
  vi.unstubAllGlobals();
});

/** Write a roster YAML to a fresh temp dir and return its absolute path. */
function writeRoster(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'choco-mcpqa-roster-'));
  tmpDirs.push(dir);
  const path = join(dir, 'agents.yaml');
  writeFileSync(path, yaml, 'utf8');
  return path;
}

/** A full roster block for one agent, parameterized for the gating cases. */
function rosterAgent(
  id: string,
  clientId: string,
  model: string,
  mcpSupport: boolean,
  mention: string,
): string {
  return [
    `  - id: ${id}`,
    `    name: 测试猫`,
    `    displayName: ${id}`,
    `    clientId: ${clientId}`,
    `    defaultModel: ${model}`,
    `    mcpSupport: ${String(mcpSupport)}`,
    `    mentionPatterns: ['${mention}']`,
    `    personality: 务实、稳健，先想清楚再动手。`,
    `    roleDescription: 测试 MCP producer gating 用 agent。`,
    `    color:`,
    `      primary: '#6366f1'`,
    `      secondary: '#818cf8'`,
  ].join('\n');
}

/** Build an inject-only app over an in-memory db. */
function appWith(
  agentServices: Record<string, FakeAgentService>,
  overrides: Omit<BuildAppOverrides, 'db' | 'agentServices'> = {},
): BuiltApp {
  const db = new Database(':memory:');
  return buildApp({ db, agentServices, ...overrides });
}

/** Drive one @mention message through the HTTP route so the fake provider runs. */
async function postMention(app: BuiltApp, threadId: string, mention: string): Promise<void> {
  await app.api.inject({
    method: 'POST',
    url: `/api/threads/${threadId}/messages`,
    payload: { content: `${mention} 把这次评审结论记成 evidence`, userId: 'user-makima' },
  });
}

/** Parse a buildClaudeMcpConfig() return value back to the object, per platform. */
function parseConfigValue(value: string): ClaudeMcpConfigObject {
  const raw =
    process.platform === 'win32'
      ? (JSON.parse(readFileSync(value, 'utf-8')) as unknown)
      : (JSON.parse(value) as unknown);
  return raw as ClaudeMcpConfigObject;
}

// ════════════════════════════════════════════════════════════════════════════
// buildClaudeMcpConfigObject — absolute paths + override precedence (edge)
// ════════════════════════════════════════════════════════════════════════════

describe('buildClaudeMcpConfigObject — paths & override precedence', () => {
  it('(edge) resolves BOTH args to ABSOLUTE paths (default repo resolution)', () => {
    // Ensure no env override is leaking from another test/process.
    setEnv('CHOCO_MCP_SERVER_PATH', undefined);
    setEnv('CHOCO_TSX_CLI_PATH', undefined);

    const server = buildClaudeMcpConfigObject(CONFIG_OPTS).mcpServers['choco'];
    expect(server).toBeDefined();
    const [tsxCli, entry] = server?.args ?? [];
    expect(tsxCli).toBeDefined();
    expect(entry).toBeDefined();
    // CLAUDE.md: never a hardcoded absolute path in source — but the RESOLVED value
    // handed to claude MUST be absolute (claude spawns it as a child with its own cwd).
    expect(isAbsolute(tsxCli as string)).toBe(true);
    expect(isAbsolute(entry as string)).toBe(true);
    expect((tsxCli as string).replace(/\\/g, '/')).toMatch(/node_modules\/tsx\/dist\/cli\.mjs$/);
    expect((entry as string).replace(/\\/g, '/')).toMatch(/packages\/mcp-server\/src\/index\.ts$/);
  });

  it('(edge) explicit serverEntryPath/tsxCliPath BEAT the env override', () => {
    // Set env overrides; explicit args must still win (precedence: explicit > env).
    setEnv('CHOCO_MCP_SERVER_PATH', '/env/should/lose/entry.ts');
    setEnv('CHOCO_TSX_CLI_PATH', '/env/should/lose/cli.mjs');

    const server = buildClaudeMcpConfigObject({
      ...CONFIG_OPTS,
      serverEntryPath: '/explicit/wins/entry.ts',
      tsxCliPath: '/explicit/wins/cli.mjs',
    }).mcpServers['choco'];

    expect(server?.args).toEqual(['/explicit/wins/cli.mjs', '/explicit/wins/entry.ts']);
  });

  it('(edge) env override BEATS the repo default for both paths', () => {
    setEnv('CHOCO_MCP_SERVER_PATH', '/srv/mcp/custom-entry.ts');
    setEnv('CHOCO_TSX_CLI_PATH', '/srv/tsx/custom-cli.mjs');

    const server = buildClaudeMcpConfigObject(CONFIG_OPTS).mcpServers['choco'];
    expect(server?.args).toEqual(['/srv/tsx/custom-cli.mjs', '/srv/mcp/custom-entry.ts']);
  });

  it('(adversarial) a BLANK explicit override falls THROUGH (does not emit an empty path)', () => {
    setEnv('CHOCO_MCP_SERVER_PATH', undefined);
    setEnv('CHOCO_TSX_CLI_PATH', undefined);

    const server = buildClaudeMcpConfigObject({
      ...CONFIG_OPTS,
      serverEntryPath: '',
      tsxCliPath: '',
    }).mcpServers['choco'];

    const [tsxCli, entry] = server?.args ?? [];
    // Empty string must NOT become the path — it must fall back to the resolved default.
    expect(tsxCli).not.toBe('');
    expect(entry).not.toBe('');
    expect(isAbsolute(tsxCli as string)).toBe(true);
    expect(isAbsolute(entry as string)).toBe(true);
    expect((entry as string).replace(/\\/g, '/')).toMatch(/packages\/mcp-server\/src\/index\.ts$/);
  });

  it('(adversarial) a BLANK env override falls THROUGH to the repo default', () => {
    setEnv('CHOCO_MCP_SERVER_PATH', '');
    setEnv('CHOCO_TSX_CLI_PATH', '');

    const server = buildClaudeMcpConfigObject(CONFIG_OPTS).mcpServers['choco'];
    const [tsxCli, entry] = server?.args ?? [];
    expect(tsxCli).not.toBe('');
    expect(entry).not.toBe('');
    expect((entry as string).replace(/\\/g, '/')).toMatch(/packages\/mcp-server\/src\/index\.ts$/);
  });

  it('(edge) embeds EXACTLY the three CHOCO_* callback keys with the passed values', () => {
    const env = buildClaudeMcpConfigObject(CONFIG_OPTS).mcpServers['choco']?.env;
    expect(env).toBeDefined();
    expect(Object.keys(env ?? {}).sort()).toEqual([
      'CHOCO_API_URL',
      'CHOCO_CALLBACK_TOKEN',
      'CHOCO_INVOCATION_ID',
    ]);
    expect(env?.['CHOCO_API_URL']).toBe(CONFIG_OPTS.apiBaseUrl);
    expect(env?.['CHOCO_INVOCATION_ID']).toBe(CONFIG_OPTS.invocationId);
    expect(env?.['CHOCO_CALLBACK_TOKEN']).toBe(CONFIG_OPTS.callbackToken);
  });

  it('(adversarial) a very long callback token round-trips intact into the env block', () => {
    // A 4KB token (realistic for a signed/opaque token); must not be truncated.
    const longToken = `tok-${'a1B2c3D4'.repeat(512)}`; // 4 + 4096 chars
    const env = buildClaudeMcpConfigObject({ ...CONFIG_OPTS, callbackToken: longToken })
      .mcpServers['choco']?.env;
    expect(env?.['CHOCO_CALLBACK_TOKEN']).toBe(longToken);
    expect(env?.['CHOCO_CALLBACK_TOKEN']?.length).toBe(longToken.length);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// buildClaudeMcpConfig — platform wrapper (win32 tempfile + posix inline branch)
// ════════════════════════════════════════════════════════════════════════════

describe('buildClaudeMcpConfig — platform wrapper', () => {
  it('(edge) win32 returns a temp-file PATH under the OS tmpdir, named choco-mcp-*', () => {
    if (process.platform !== 'win32') {
      // Drive the win32 branch by stubbing platform (the file write is real).
      vi.stubGlobal('process', { ...process, platform: 'win32' });
    }
    const value = buildClaudeMcpConfig(CONFIG_OPTS);

    expect(isAbsolute(value)).toBe(true);
    // The temp dir is created via mkdtempSync(join(tmpdir(), 'choco-mcp-')) so the
    // PARENT dir is under the OS tmp dir and its basename starts with choco-mcp-.
    const tmpRoot = tmpdir().replace(/\\/g, '/');
    expect(value.replace(/\\/g, '/').startsWith(tmpRoot)).toBe(true);
    const tempDirName = dirname(value).split(/[\\/]/).pop();
    expect(tempDirName?.startsWith('choco-mcp-')).toBe(true);
    expect(value.replace(/\\/g, '/')).toMatch(/mcp-config\.json$/);

    // The file content parses to the SAME object the pure builder produces.
    expect(existsSync(value)).toBe(true);
    const parsed = JSON.parse(readFileSync(value, 'utf-8')) as ClaudeMcpConfigObject;
    expect(parsed).toEqual(buildClaudeMcpConfigObject(CONFIG_OPTS));
  });

  it('(edge) posix returns the INLINE JSON string (driven by stubbing platform)', () => {
    // Force the posix branch regardless of host so the inline path is covered here.
    vi.stubGlobal('process', { ...process, platform: 'linux' });
    const value = buildClaudeMcpConfig(CONFIG_OPTS);

    // posix: the value IS the JSON, not a path.
    expect(value.startsWith('{')).toBe(true);
    const parsed = JSON.parse(value) as ClaudeMcpConfigObject;
    expect(parsed).toEqual(buildClaudeMcpConfigObject(CONFIG_OPTS));
    expect(parsed.mcpServers['choco']?.command).toBe('node');
  });

  it('(adversarial) two calls produce DISTINCT temp files (no collision across turns)', () => {
    if (process.platform !== 'win32') {
      vi.stubGlobal('process', { ...process, platform: 'win32' });
    }
    const a = buildClaudeMcpConfig({ ...CONFIG_OPTS, invocationId: 'inv-aaaa-1111' });
    const b = buildClaudeMcpConfig({ ...CONFIG_OPTS, invocationId: 'inv-bbbb-2222' });

    expect(a).not.toBe(b); // distinct paths
    expect(dirname(a)).not.toBe(dirname(b)); // distinct temp dirs (mkdtempSync)
    // Each file still holds its OWN config — no cross-contamination.
    const pa = JSON.parse(readFileSync(a, 'utf-8')) as ClaudeMcpConfigObject;
    const pb = JSON.parse(readFileSync(b, 'utf-8')) as ClaudeMcpConfigObject;
    expect(pa.mcpServers['choco']?.env['CHOCO_INVOCATION_ID']).toBe('inv-aaaa-1111');
    expect(pb.mcpServers['choco']?.env['CHOCO_INVOCATION_ID']).toBe('inv-bbbb-2222');
  });

  it('(adversarial) special chars in an override path stay valid + parseable JSON', () => {
    // Windows paths with spaces + a posix path with a quote-ish char; both must
    // serialize to valid JSON (JSON.stringify escapes them) and round-trip exactly.
    vi.stubGlobal('process', { ...process, platform: 'linux' }); // inline JSON branch
    const weirdEntry = 'C:/Program Files/Choco AI/packages/mcp-server/src/index.ts';
    const weirdCli = '/opt/node modules/tsx/dist/cli.mjs';
    const value = buildClaudeMcpConfig({
      ...CONFIG_OPTS,
      serverEntryPath: weirdEntry,
      tsxCliPath: weirdCli,
    });
    const parsed = JSON.parse(value) as ClaudeMcpConfigObject; // must not throw
    expect(parsed.mcpServers['choco']?.args).toEqual([weirdCli, weirdEntry]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Producer gating via buildApp + FakeAgentService (recorded callbackEnv)
// ════════════════════════════════════════════════════════════════════════════

describe('MCP producer gating via buildApp', () => {
  it('(happy) anthropic agent with mcpSupport:true → MCP_CONFIG_JSON is SET', async () => {
    const fake = new FakeAgentService([replyScript(CLAUDE, '收到，调用 evidence_upsert 记录。')]);
    const app = appWith({ 'claude-opus': fake });
    cleanups.push(app.close);

    await postMention(app, 'thread-claude-gate', '@claude');

    expect(fake.calls).toHaveLength(1);
    const value = fake.calls[0]?.options?.callbackEnv?.[MCP_CONFIG_ENV_KEY];
    expect(value).toBeDefined();
    expect(parseConfigValue(value as string).mcpServers['choco']?.command).toBe('node');
  });

  it('(adversarial) non-anthropic agent (gemini) → MCP_CONFIG_JSON ABSENT (no claude JSON leak)', async () => {
    const fake = new FakeAgentService([replyScript(GEMINI, '我给两个替代方案对比。')]);
    const app = appWith({ 'gemini-pro': fake });
    cleanups.push(app.close);

    await postMention(app, 'thread-gemini-gate', '@gemini');

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.options?.callbackEnv?.[MCP_CONFIG_ENV_KEY]).toBeUndefined();
  });

  it('(adversarial) non-anthropic agent (codex) → MCP_CONFIG_JSON ABSENT', async () => {
    const fake = new FakeAgentService([replyScript(CODEX, '收到，快速落地。')]);
    const app = appWith({ 'codex-gpt': fake });
    cleanups.push(app.close);

    await postMention(app, 'thread-codex-gate', '@codex');

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.options?.callbackEnv?.[MCP_CONFIG_ENV_KEY]).toBeUndefined();
  });

  it('(edge) anthropic agent with mcpSupport:FALSE → MCP_CONFIG_JSON ABSENT (fixture roster)', async () => {
    // The shipped roster has every agent mcpSupport:true, so a fixture roster is
    // required to exercise the mcpSupport===true half of the AND gate.
    const rosterPath = writeRoster(
      ['agents:', rosterAgent('claude-nomcp', 'anthropic', 'claude-opus-4-6', false, '@claude')].join(
        '\n',
      ),
    );
    const fake = new FakeAgentService([
      replyScript(GEMINI /* agentId unused here; id mapping is by roster */, 'no mcp for me.'),
    ]);
    // Map the fake under the fixture roster's agent id.
    const app = appWith({ 'claude-nomcp': fake }, { agentsConfigPath: rosterPath });
    cleanups.push(app.close);

    await postMention(app, 'thread-claude-nomcp', '@claude');

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.options?.callbackEnv?.[MCP_CONFIG_ENV_KEY]).toBeUndefined();
    // Sanity: the OTHER two callback env keys are still present (gating only drops MCP).
    expect(fake.calls[0]?.options?.callbackEnv?.['CHOCO_INVOCATION_ID']).toBeDefined();
  });

  it('(adversarial) per-turn callbackEnv is isolated — a non-MCP turn is NOT polluted by a prior MCP turn', async () => {
    // Two agents in ONE app: claude (MCP) and codex (no MCP). Run claude FIRST, then
    // codex, then claude again. codex must never see MCP_CONFIG_JSON, and claude's
    // two turns must carry DISTINCT config values (fresh per-turn env, not shared).
    const claudeFake = new FakeAgentService([
      replyScript(CLAUDE, '第一轮：记录 evidence。'),
      replyScript(CLAUDE, '第二轮：再记录一次。'),
    ]);
    const codexFake = new FakeAgentService([replyScript(CODEX, '中间这轮我不该拿到 MCP 配置。')]);
    const app = appWith({ 'claude-opus': claudeFake, 'codex-gpt': codexFake });
    cleanups.push(app.close);

    await postMention(app, 'thread-iso', '@claude');
    await postMention(app, 'thread-iso', '@codex');
    await postMention(app, 'thread-iso', '@claude');

    expect(claudeFake.calls).toHaveLength(2);
    expect(codexFake.calls).toHaveLength(1);

    const claude1 = claudeFake.calls[0]?.options?.callbackEnv?.[MCP_CONFIG_ENV_KEY];
    const claude2 = claudeFake.calls[1]?.options?.callbackEnv?.[MCP_CONFIG_ENV_KEY];
    expect(claude1).toBeDefined();
    expect(claude2).toBeDefined();
    // codex (the turn BETWEEN the two MCP turns) must be clean.
    expect(codexFake.calls[0]?.options?.callbackEnv?.[MCP_CONFIG_ENV_KEY]).toBeUndefined();

    // Each claude turn mints a fresh invocation → distinct embedded invocationId.
    const inv1 = parseConfigValue(claude1 as string).mcpServers['choco']?.env[
      'CHOCO_INVOCATION_ID'
    ];
    const inv2 = parseConfigValue(claude2 as string).mcpServers['choco']?.env[
      'CHOCO_INVOCATION_ID'
    ];
    expect(inv1).toBeDefined();
    expect(inv2).toBeDefined();
    expect(inv1).not.toBe(inv2);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// apiBaseUrl (the port-fix) flows through to the MCP server's callback target
// ════════════════════════════════════════════════════════════════════════════

describe('apiBaseUrl port-fix flows into the MCP callback target', () => {
  it('(edge) configured apiBaseUrl appears in BOTH callbackEnv AND the embedded MCP env', async () => {
    const apiBaseUrl = 'http://127.0.0.1:3100';
    const fake = new FakeAgentService([replyScript(CLAUDE, '在指定 base 上回调。')]);
    const app = appWith({ 'claude-opus': fake }, { apiBaseUrl });
    cleanups.push(app.close);

    await postMention(app, 'thread-apibase-flow', '@claude');

    expect(fake.calls).toHaveLength(1);
    const callbackEnv = fake.calls[0]?.options?.callbackEnv;
    // 1. The turn-level callback env carries the configured base.
    expect(callbackEnv?.['CHOCO_API_URL']).toBe(apiBaseUrl);
    // 2. The SAME base is embedded in the MCP config the spawned server reads — so
    //    the MCP child calls back to the RIGHT port (the bug was port 80 with no port).
    const value = callbackEnv?.[MCP_CONFIG_ENV_KEY];
    expect(value).toBeDefined();
    const embedded = parseConfigValue(value as string).mcpServers['choco']?.env[
      'CHOCO_API_URL'
    ];
    expect(embedded).toBe(apiBaseUrl);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// claude buildArgs — verbatim --mcp-config passthrough (consumer side)
// ════════════════════════════════════════════════════════════════════════════

describe('claude buildArgs MCP consumer hook', () => {
  it('(edge) --mcp-config is immediately followed by the verbatim MCP_CONFIG_JSON value', () => {
    // A win32-style temp-file path value (what the producer hands the consumer).
    const mcpValue = join(tmpdir(), 'choco-mcp-abc123', 'mcp-config.json');
    const args = buildArgs(
      { callbackEnv: { [MCP_CONFIG_ENV_KEY]: mcpValue } },
      'claude-opus-4-6',
      'bypassPermissions',
    );

    const flagIndex = args.indexOf('--mcp-config');
    expect(flagIndex).toBeGreaterThanOrEqual(0);
    expect(args[flagIndex + 1]).toBe(mcpValue); // verbatim, immediately after the flag
  });

  it('(adversarial) NO --mcp-config flag when callbackEnv lacks MCP_CONFIG_JSON', () => {
    // A non-MCP turn (e.g. the gated-off case) must not sprout a --mcp-config flag.
    const args = buildArgs(
      { callbackEnv: { CHOCO_API_URL: 'http://127.0.0.1:3100' } },
      'claude-opus-4-6',
      'bypassPermissions',
    );
    expect(args).not.toContain('--mcp-config');
  });
});
