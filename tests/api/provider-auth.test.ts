// tests/api/provider-auth.test.ts — M-ACCOUNT OAuth/login dev happy-path.
//
// The login half of 账户与密钥. Status detection (verified against the real CLIs):
//   anthropic → `claude auth status` JSON,
//   openai    → ~/.codex/auth.json presence (keys auth_mode/OPENAI_API_KEY/tokens),
//   google    → ~/.gemini/oauth_creds.json presence (+ google_accounts.json email).
// A FAKE AuthCliRunner makes this deterministic (canned status + auth files +
// recorded login/logout) — gating the dispatch + parse without a real CLI, a
// browser, or the real home dir. Edge/adversarial are the QA instance's.

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import type { ClientId } from '@choco/shared';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';
import {
  getAllProviderAuth,
  getProviderAuthStatus,
  triggerProviderLogin,
  triggerProviderLogout,
  type AuthCliRunner,
  type AuthFileResult,
  type CliCaptureResult,
} from '@choco/api/config/provider-auth';
import { FakeAgentService } from '../invocation/fake-agent-service.js';

/** A scriptable runner: canned captures + auth files + recorded detached spawns. */
class FakeRunner implements AuthCliRunner {
  readonly detached: { command: string; args: string[] }[] = [];
  constructor(
    private readonly captureImpl: (command: string, args: readonly string[]) => CliCaptureResult,
    private readonly fileImpl: (path: string) => AuthFileResult = () => ({ exists: false }),
  ) {}
  capture(command: string, args: readonly string[]): Promise<CliCaptureResult> {
    return Promise.resolve(this.captureImpl(command, args));
  }
  spawnDetached(command: string, args: readonly string[]): { started: boolean } {
    this.detached.push({ command, args: [...args] });
    return { started: true };
  }
  readAuthFile(path: string): AuthFileResult {
    return this.fileImpl(path);
  }
}

/** claude logged in (real JSON shape); codex/agy --version present. */
function defaultCaptures(command: string, args: readonly string[]): CliCaptureResult {
  const key = `${command} ${args.join(' ')}`;
  if (key === 'claude auth status') {
    return {
      stdout: JSON.stringify({ loggedIn: true, email: 'me@example.com', subscriptionType: 'max' }),
      code: 0,
      spawnError: false,
    };
  }
  if (key === 'codex --version' || key === 'agy --version') {
    return { stdout: '1.0.0', code: 0, spawnError: false };
  }
  if (key === 'claude auth logout' || key === 'codex logout') {
    return { stdout: 'Logged out', code: 0, spawnError: false };
  }
  return { stdout: '', code: null, spawnError: true };
}

/** codex auth.json + gemini oauth_creds present → both logged in. */
function defaultFiles(path: string): AuthFileResult {
  if (path.includes('.codex')) {
    return { exists: true, json: { auth_mode: 'subscription', tokens: { id_token: 'x' } } };
  }
  if (path.includes('google_accounts')) {
    return { exists: true, json: { active: 'me@example.com' } };
  }
  if (path.includes('oauth_creds')) {
    return { exists: true, json: { access_token: 'x' } };
  }
  return { exists: false };
}

describe('provider-auth status (dev happy path)', () => {
  it('reads each provider login: claude JSON, codex auth-file, gemini creds-file', async () => {
    const runner = new FakeRunner(defaultCaptures, defaultFiles);
    const byId = new Map((await getAllProviderAuth(runner)).map((p) => [p.clientId, p]));

    const claude = byId.get('anthropic')!;
    expect(claude.available).toBe(true);
    expect(claude.loggedIn).toBe(true);
    expect(claude.detail).toBe('me@example.com · max');
    expect(claude.supportsLogin).toBe(true);

    const codex = byId.get('openai')!;
    expect(codex.available).toBe(true);
    expect(codex.loggedIn).toBe(true); // ~/.codex/auth.json present
    expect(codex.supportsLogin).toBe(true);

    const gemini = byId.get('google')!;
    expect(gemini.available).toBe(true);
    expect(gemini.loggedIn).toBe(true); // ~/.gemini/oauth_creds.json present
    expect(gemini.detail).toBe('me@example.com');
    expect(gemini.supportsLogin).toBe(false); // no CLI login command
  });

  it('reports NOT logged in for codex when its auth file is absent but the CLI is installed', async () => {
    const runner = new FakeRunner(defaultCaptures, () => ({ exists: false }));
    const codex = await getProviderAuthStatus(runner, 'openai');
    expect(codex.available).toBe(true); // codex --version ok
    expect(codex.loggedIn).toBe(false); // no auth.json
  });

  it('[regression] probes agy, not the removed gemini CLI, when google creds are absent', async () => {
    const seen: string[] = [];
    const runner = new FakeRunner((command, args) => {
      seen.push(`${command} ${args.join(' ')}`);
      return command === 'agy' && args.join(' ') === '--version'
        ? { stdout: '1.0.6', code: 0, spawnError: false }
        : { stdout: '', code: null, spawnError: true };
    }, () => ({ exists: false }));

    const google = await getProviderAuthStatus(runner, 'google');

    expect(google.available).toBe(true);
    expect(google.loggedIn).toBe(false);
    expect(seen).toContain('agy --version');
    expect(seen).not.toContain('gemini --version');
  });
});

describe('provider-auth login/logout (dev happy path)', () => {
  it('dispatches the right CLI login/logout, refusing where unsupported', async () => {
    const runner = new FakeRunner(defaultCaptures, defaultFiles);
    expect(triggerProviderLogin(runner, 'anthropic')).toEqual({ ok: true });
    expect(runner.detached).toContainEqual({ command: 'claude', args: ['auth', 'login'] });
    expect(triggerProviderLogin(runner, 'openai')).toEqual({ ok: true });
    expect(runner.detached).toContainEqual({ command: 'codex', args: ['login'] });

    const gem = triggerProviderLogin(runner, 'google'); // no CLI login
    expect(gem.ok).toBe(false);
    expect(gem.reason).toBeTruthy();

    expect(await triggerProviderLogout(runner, 'anthropic')).toEqual({ ok: true });
  });
});

describe('/api/auth routes (dev happy path)', () => {
  function injectApp(runner: AuthCliRunner): BuiltApp {
    const db = new Database(':memory:');
    return buildApp({ db, agentServices: { 'claude-opus': new FakeAgentService([]) }, authRunner: runner });
  }

  it('GET lists provider auth; POST login/logout dispatch; bad provider → 400', async () => {
    const runner = new FakeRunner(defaultCaptures, defaultFiles);
    const app = injectApp(runner);

    const status = await app.api.inject({ method: 'GET', url: '/api/auth' });
    expect(status.statusCode).toBe(200);
    expect(status.json().providers).toHaveLength(3);

    const login = await app.api.inject({ method: 'POST', url: '/api/auth/openai/login' });
    expect(login.statusCode).toBe(200);
    expect(runner.detached).toContainEqual({ command: 'codex', args: ['login'] });

    const gem = await app.api.inject({ method: 'POST', url: '/api/auth/google/login' });
    expect(gem.statusCode).toBe(409);

    const bad = await app.api.inject({ method: 'POST', url: '/api/auth/mistral/login' });
    expect(bad.statusCode).toBe(400);

    await app.close();
  });
});

const _ids: readonly ClientId[] = ['anthropic', 'openai', 'google'];
void _ids;
