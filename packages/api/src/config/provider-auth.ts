// packages/api/src/config/provider-auth.ts
// OAuth / subscription-login surface — the OTHER half of 账户与密钥 (the API-key half
// is account-store). The agent CLIs own their own browser OAuth; here we surface
// each provider's login STATUS and can TRIGGER its native login/logout.
//
// Status detection per provider (verified against the real CLIs, 2026-06):
//   anthropic → `claude auth status` returns clean JSON {loggedIn,email,subscriptionType}.
//   openai    → codex has no reliable status subcommand; its login is the on-disk
//               file ~/.codex/auth.json (keys: auth_mode/OPENAI_API_KEY/tokens).
//               Presence = logged in (more robust than a guessed subcommand).
//   google    → gemini has no auth subcommand; login lives in
//               ~/.gemini/oauth_creds.json (+ google_accounts.json for the email).
// Login/logout triggers (CLI, opens browser): claude `auth login`/`auth logout`,
// codex `login`/`logout`. gemini has NO scriptable login (run `gemini` once in a
// terminal) — we say so honestly instead of a button that does nothing.
//
// Both the CLI runner and the file reader are injected (AuthCliRunner) so
// routes/tests drive this WITHOUT a real login or touching the real home dir.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import crossSpawn from 'cross-spawn';
import type { ClientId, ProviderAuthStatus } from '@choco/shared';

/** Result of capturing a one-shot CLI command (status / logout). */
export interface CliCaptureResult {
  readonly stdout: string;
  readonly code: number | null;
  /** True when the binary could not be spawned (ENOENT → CLI not installed). */
  readonly spawnError: boolean;
}

/** Result of reading a provider's on-disk auth file. */
export interface AuthFileResult {
  readonly exists: boolean;
  readonly json?: Record<string, unknown>;
}

/** The seam routes use to talk to the provider CLIs + read their auth files. */
export interface AuthCliRunner {
  /** Run a short command and capture stdout (status / logout). */
  capture(command: string, args: readonly string[], timeoutMs: number): Promise<CliCaptureResult>;
  /** Start a long/interactive command (login → opens the browser); returns at once. */
  spawnDetached(command: string, args: readonly string[]): { readonly started: boolean };
  /** Read + parse a provider's on-disk auth JSON (login signal). */
  readAuthFile(path: string): AuthFileResult;
}

/** Resolved login state for one provider (before the clientId/cli wrap). */
interface ResolvedStatus {
  readonly available: boolean;
  readonly loggedIn: boolean | null;
  readonly detail?: string;
}

/** Per-provider CLI auth wiring. `loginArgs` absent ⇒ login not CLI-scriptable. */
interface ProviderAuthSpec {
  readonly cli: string;
  readonly readStatus: (runner: AuthCliRunner) => Promise<ResolvedStatus>;
  readonly loginArgs?: readonly string[];
  readonly logoutArgs?: readonly string[];
  readonly note?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Timeout for a status/logout probe (short; a hung CLI must not block the route). */
const AUTH_PROBE_TIMEOUT_MS = 8000;

const GEMINI_NOTE =
  'Gemini 用 Google 账号 OAuth，无 CLI 登录子命令：在终端运行一次 `gemini` 完成浏览器登录，或在下方配置 API key。';

// Auth-file locations (provider-owned dirs under the user's home).
const codexAuthPath = (): string => join(homedir(), '.codex', 'auth.json');
const geminiCredsPath = (): string => join(homedir(), '.gemini', 'oauth_creds.json');
const geminiAccountsPath = (): string => join(homedir(), '.gemini', 'google_accounts.json');

/** `claude auth status` → JSON { loggedIn, email, subscriptionType, ... }. */
function parseClaudeStatus(stdout: string): { loggedIn: boolean; detail?: string } {
  try {
    const j = JSON.parse(stdout) as Record<string, unknown>;
    const loggedIn = j.loggedIn === true;
    const email = typeof j.email === 'string' ? j.email : undefined;
    const plan = typeof j.subscriptionType === 'string' ? j.subscriptionType : undefined;
    const detail =
      email !== undefined ? (plan !== undefined ? `${email} · ${plan}` : email) : undefined;
    return detail !== undefined ? { loggedIn, detail } : { loggedIn };
  } catch {
    return { loggedIn: false };
  }
}

/** First email-looking string value in a small JSON object (gemini account name). */
function firstEmailish(json: Record<string, unknown> | undefined): string | undefined {
  if (json === undefined) return undefined;
  for (const v of Object.values(json)) {
    if (typeof v === 'string' && v.includes('@')) return v;
  }
  for (const v of Object.values(json)) {
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

const PROVIDER_AUTH: Readonly<Record<ClientId, ProviderAuthSpec>> = {
  anthropic: {
    cli: 'claude',
    loginArgs: ['auth', 'login'],
    logoutArgs: ['auth', 'logout'],
    async readStatus(runner) {
      const res = await runner.capture('claude', ['auth', 'status'], AUTH_PROBE_TIMEOUT_MS);
      if (res.spawnError) return { available: false, loggedIn: null };
      const { loggedIn, detail } = parseClaudeStatus(res.stdout);
      return { available: true, loggedIn, ...(detail !== undefined ? { detail } : {}) };
    },
  },
  openai: {
    cli: 'codex',
    loginArgs: ['login'],
    logoutArgs: ['logout'],
    async readStatus(runner) {
      const f = runner.readAuthFile(codexAuthPath());
      if (f.exists && (f.json?.tokens !== undefined || f.json?.OPENAI_API_KEY !== undefined)) {
        const mode = typeof f.json?.auth_mode === 'string' ? f.json.auth_mode : undefined;
        return { available: true, loggedIn: true, detail: mode !== undefined ? `已登录 · ${mode}` : '已登录' };
      }
      const probe = await runner.capture('codex', ['--version'], AUTH_PROBE_TIMEOUT_MS);
      return { available: !probe.spawnError, loggedIn: probe.spawnError ? null : false };
    },
  },
  google: {
    cli: 'gemini',
    note: GEMINI_NOTE,
    async readStatus(runner) {
      const creds = runner.readAuthFile(geminiCredsPath());
      if (creds.exists) {
        const email = firstEmailish(runner.readAuthFile(geminiAccountsPath()).json);
        return { available: true, loggedIn: true, detail: email ?? 'Google 账号已登录' };
      }
      const probe = await runner.capture('gemini', ['--version'], AUTH_PROBE_TIMEOUT_MS);
      return {
        available: !probe.spawnError,
        loggedIn: probe.spawnError ? null : false,
        detail: GEMINI_NOTE,
      };
    },
  },
};

/** Default runner: cross-spawn (resolves win32 .cmd shims) + fs auth-file reads. */
export const defaultAuthCliRunner: AuthCliRunner = {
  capture(command, args, timeoutMs) {
    return new Promise<CliCaptureResult>((resolve) => {
      const child = crossSpawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let settled = false;
      const finish = (code: number | null, spawnError: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ stdout: out, code, spawnError });
      };
      const timer = setTimeout(() => {
        child.kill();
        finish(null, false);
      }, timeoutMs);
      child.stdout?.on('data', (d: Buffer) => {
        out += d.toString('utf8');
      });
      child.once('error', () => finish(null, true));
      child.once('close', (code) => finish(code, false));
    });
  },
  spawnDetached(command, args) {
    try {
      const child = crossSpawn(command, [...args], { stdio: 'ignore', detached: true });
      child.unref();
      return { started: true };
    } catch {
      return { started: false };
    }
  },
  readAuthFile(path) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'));
      return { exists: true, json: isRecord(parsed) ? parsed : {} };
    } catch {
      return { exists: false };
    }
  },
};

/** Read one provider's login status (best-effort; never throws). */
export async function getProviderAuthStatus(
  runner: AuthCliRunner,
  clientId: ClientId,
): Promise<ProviderAuthStatus> {
  const spec = PROVIDER_AUTH[clientId];
  const resolved = await spec.readStatus(runner);
  return {
    clientId,
    cli: spec.cli,
    available: resolved.available,
    loggedIn: resolved.loggedIn,
    supportsLogin: spec.loginArgs !== undefined,
    ...(resolved.detail !== undefined ? { detail: resolved.detail } : {}),
  };
}

/** Status for all three providers (concurrently). */
export async function getAllProviderAuth(runner: AuthCliRunner): Promise<ProviderAuthStatus[]> {
  const ids: readonly ClientId[] = ['anthropic', 'openai', 'google'];
  return Promise.all(ids.map((id) => getProviderAuthStatus(runner, id)));
}

/** Outcome of a login/logout trigger. */
export interface AuthActionResult {
  readonly ok: boolean;
  readonly reason?: string;
}

/**
 * Trigger the provider's native login (opens its browser OAuth). Detached so the
 * route returns immediately; the user completes it in the browser, then re-reads
 * status. Providers with no scriptable login (gemini) return ok:false + the note.
 */
export function triggerProviderLogin(runner: AuthCliRunner, clientId: ClientId): AuthActionResult {
  const spec = PROVIDER_AUTH[clientId];
  if (spec.loginArgs === undefined) {
    return { ok: false, reason: spec.note ?? '该 provider 不支持 CLI 登录' };
  }
  const { started } = runner.spawnDetached(spec.cli, spec.loginArgs);
  return started ? { ok: true } : { ok: false, reason: `${spec.cli} 未安装或无法启动` };
}

/** Trigger the provider's logout (short capture). */
export async function triggerProviderLogout(
  runner: AuthCliRunner,
  clientId: ClientId,
): Promise<AuthActionResult> {
  const spec = PROVIDER_AUTH[clientId];
  if (spec.logoutArgs === undefined) {
    return { ok: false, reason: spec.note ?? '该 provider 不支持 CLI 登出' };
  }
  const res = await runner.capture(spec.cli, spec.logoutArgs, AUTH_PROBE_TIMEOUT_MS);
  if (res.spawnError) return { ok: false, reason: `${spec.cli} 未安装` };
  return { ok: true };
}
