// tests/api/provider-auth.edge.test.ts — OAuth/login half of 账户与密钥, the
// INDEPENDENT QA gate (dev≠QA): the dev shipped happy-path in provider-auth.test.ts;
// this file is the edge + adversarial gate for the same surface.
//
// Status detection is PER-PROVIDER (verified against the real CLIs, 2026-06):
//   anthropic → `claude auth status` JSON {loggedIn,email,subscriptionType}.
//   openai    → FILE-based: ~/.codex/auth.json (keys tokens / OPENAI_API_KEY ⇒ logged
//               in; auth_mode → detail). Absent ⇒ probe `codex --version`.
//   google    → FILE-based: ~/.gemini/oauth_creds.json present ⇒ logged in; the email
//               is the first '@'-ish value in ~/.gemini/google_accounts.json. Absent ⇒
//               probe `gemini --version`.
//
// We drive a FAKE AuthCliRunner so status PARSE + auth-file READ + command DISPATCH are
// deterministic without spawning a real CLI / browser / touching the real home dir.
// `readAuthFile` is injectable (default {exists:false}); the fake matches on path
// substrings ('.codex', 'oauth_creds', 'google_accounts'). Routes go through
// buildApp({ authRunner }) so the injected fake (not the cross-spawn default) handles
// every call — proving the route never spawns a real login.
//
// Distribution (this file): happy ≤50%, edge ≥30%, adversarial ≥20%.

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

/** A `command args…` → CliCaptureResult map. Anything unmapped → spawnError. */
type CaptureMap = (command: string, args: readonly string[]) => CliCaptureResult;
/** A path → AuthFileResult map (the fake matches on path SUBSTRINGS). */
type FileMap = (path: string) => AuthFileResult;

/**
 * A scriptable AuthCliRunner. `capture` is driven by an injected map; `readAuthFile`
 * by a second injected map (default: every file absent); every `spawnDetached` is
 * recorded so we can assert the EXACT command dispatched, and `startedResult` lets a
 * test simulate a CLI that fails to start (started:false).
 */
class FakeRunner implements AuthCliRunner {
  readonly detached: { command: string; args: string[] }[] = [];
  constructor(
    private readonly captureImpl: CaptureMap,
    private readonly fileImpl: FileMap = () => ({ exists: false }),
    private readonly startedResult = true,
  ) {}
  capture(command: string, args: readonly string[]): Promise<CliCaptureResult> {
    return Promise.resolve(this.captureImpl(command, args));
  }
  spawnDetached(command: string, args: readonly string[]): { started: boolean } {
    this.detached.push({ command, args: [...args] });
    return { started: this.startedResult };
  }
  readAuthFile(path: string): AuthFileResult {
    return this.fileImpl(path);
  }
}

/** Shorthand for a successful capture with given stdout. */
function ok(stdout: string): CliCaptureResult {
  return { stdout, code: 0, spawnError: false };
}
/** A spawn failure (ENOENT → CLI not installed). */
const SPAWN_ERROR: CliCaptureResult = { stdout: '', code: null, spawnError: true };

/** Default map: claude logged in; codex/gemini `--version` work; logout succeeds. */
function defaultCaptures(command: string, args: readonly string[]): CliCaptureResult {
  const key = `${command} ${args.join(' ')}`;
  if (key === 'claude auth status') {
    return ok(JSON.stringify({ loggedIn: true, email: 'me@example.com', subscriptionType: 'max' }));
  }
  if (key === 'codex --version' || key === 'gemini --version') return ok('1.0.0');
  if (key === 'claude auth logout' || key === 'codex logout') return ok('Logged out');
  return SPAWN_ERROR;
}

/** Default files: codex auth.json + gemini creds present → both logged in. */
function defaultFiles(path: string): AuthFileResult {
  if (path.includes('.codex')) {
    return { exists: true, json: { auth_mode: 'chatgpt', tokens: { id_token: 'x' } } };
  }
  if (path.includes('google_accounts')) {
    return { exists: true, json: { active: 'me@example.com' } };
  }
  if (path.includes('oauth_creds')) {
    return { exists: true, json: { access_token: 'x' } };
  }
  return { exists: false };
}

// ─────────────────────────── claude JSON parse (edge + adversarial) ───────────

describe('getProviderAuthStatus — claude JSON parse (edge + adversarial)', () => {
  it('[edge] claude status {loggedIn:false} → loggedIn false, no detail', async () => {
    const runner = new FakeRunner((c, a) =>
      `${c} ${a.join(' ')}` === 'claude auth status' ? ok(JSON.stringify({ loggedIn: false })) : SPAWN_ERROR,
    );
    const status = await getProviderAuthStatus(runner, 'anthropic');
    expect(status.available).toBe(true);
    expect(status.loggedIn).toBe(false);
    expect(status.detail).toBeUndefined();
  });

  it('[adversarial] malformed / non-JSON claude status → loggedIn false (parse fallback, no throw)', async () => {
    const runner = new FakeRunner((c, a) =>
      `${c} ${a.join(' ')}` === 'claude auth status'
        ? ok('claude: command produced a banner, not JSON {{{ broken')
        : SPAWN_ERROR,
    );
    const status = await getProviderAuthStatus(runner, 'anthropic');
    expect(status.available).toBe(true);
    expect(status.loggedIn).toBe(false);
    expect(status.detail).toBeUndefined();
  });

  it('[edge] claude status with email but no subscriptionType → detail is just the email', async () => {
    const runner = new FakeRunner((c, a) =>
      `${c} ${a.join(' ')}` === 'claude auth status'
        ? ok(JSON.stringify({ loggedIn: true, email: 'solo@anthropic.test' }))
        : SPAWN_ERROR,
    );
    const status = await getProviderAuthStatus(runner, 'anthropic');
    expect(status.loggedIn).toBe(true);
    expect(status.detail).toBe('solo@anthropic.test');
  });

  it('[adversarial] empty-string claude status → loggedIn false (JSON.parse("") throws → caught)', async () => {
    const runner = new FakeRunner((c, a) =>
      `${c} ${a.join(' ')}` === 'claude auth status' ? ok('') : SPAWN_ERROR,
    );
    const status = await getProviderAuthStatus(runner, 'anthropic');
    expect(status.loggedIn).toBe(false);
  });
});

// ─────────────────────────── codex auth FILE (edge + adversarial) ─────────────

describe('getProviderAuthStatus — codex auth.json file (edge + adversarial)', () => {
  it('[edge] auth.json present with tokens + auth_mode:chatgpt → loggedIn true, detail `已登录 · chatgpt`', async () => {
    const files: FileMap = (p) =>
      p.includes('.codex') ? { exists: true, json: { auth_mode: 'chatgpt', tokens: { id_token: 'x' } } } : { exists: false };
    const runner = new FakeRunner(defaultCaptures, files);
    const status = await getProviderAuthStatus(runner, 'openai');
    expect(status.available).toBe(true);
    expect(status.loggedIn).toBe(true);
    expect(status.detail).toBe('已登录 · chatgpt');
    expect(status.supportsLogin).toBe(true);
  });

  it('[edge] auth.json present via OPENAI_API_KEY, no auth_mode → loggedIn true, detail `已登录`', async () => {
    const files: FileMap = (p) =>
      p.includes('.codex') ? { exists: true, json: { OPENAI_API_KEY: 'sk-real-key' } } : { exists: false };
    const runner = new FakeRunner(defaultCaptures, files);
    const status = await getProviderAuthStatus(runner, 'openai');
    expect(status.loggedIn).toBe(true);
    expect(status.detail).toBe('已登录');
  });

  it('[edge] auth.json present but has NEITHER tokens NOR OPENAI_API_KEY → falls through to --version → loggedIn false (no false positive)', async () => {
    // A stale/partial auth.json must NOT be read as logged-in: with no token signal we
    // fall through to the `codex --version` probe, which here succeeds → available, not logged in.
    const files: FileMap = (p) =>
      p.includes('.codex') ? { exists: true, json: { auth_mode: 'chatgpt', last_login: '2026-06-01' } } : { exists: false };
    const runner = new FakeRunner(defaultCaptures, files);
    const status = await getProviderAuthStatus(runner, 'openai');
    expect(status.available).toBe(true);
    expect(status.loggedIn).toBe(false);
    expect(status.detail).toBeUndefined();
  });

  it('[edge] auth.json absent but codex installed (--version ok) → available true, loggedIn false', async () => {
    const runner = new FakeRunner(defaultCaptures, () => ({ exists: false }));
    const status = await getProviderAuthStatus(runner, 'openai');
    expect(status.available).toBe(true);
    expect(status.loggedIn).toBe(false);
  });

  it('[adversarial] auth.json absent + codex `--version` spawnError → available false, loggedIn null', async () => {
    const runner = new FakeRunner(() => SPAWN_ERROR, () => ({ exists: false }));
    const status = await getProviderAuthStatus(runner, 'openai');
    expect(status.available).toBe(false);
    expect(status.loggedIn).toBeNull();
  });

  it('[adversarial] auth.json exists:true but json:undefined (malformed-but-present) → no crash, falls through → loggedIn false', async () => {
    // The product default reader returns {exists:false} on parse failure; here we
    // simulate a reader that says "exists" with no usable json. tokens/OPENAI_API_KEY
    // read off undefined must not throw, and with no signal we fall through to --version.
    const files: FileMap = (p) => (p.includes('.codex') ? { exists: true } : { exists: false });
    const runner = new FakeRunner(defaultCaptures, files);
    const status = await getProviderAuthStatus(runner, 'openai');
    expect(status.available).toBe(true);
    expect(status.loggedIn).toBe(false);
  });

  it('[adversarial] garbage auth.json (exists:true, json:{} — no token signal) → getAllProviderAuth resolves, codex not-logged-in', async () => {
    // The product seam contracts readAuthFile to NEVER throw (its default catches parse
    // errors → {exists:false}). The supported "garbage file" path a malformed-but-present
    // file takes is {exists:true, json:{}}: no tokens / OPENAI_API_KEY → we must fall
    // through to --version, NOT crash and NOT false-positive. getAllProviderAuth resolves.
    const files: FileMap = (p) => (p.includes('.codex') ? { exists: true, json: {} } : { exists: false });
    const runner = new FakeRunner(defaultCaptures, files);
    const all = await getAllProviderAuth(runner);
    expect(all).toHaveLength(3);
    const codex = all.find((p) => p.clientId === 'openai');
    expect(codex?.available).toBe(true);
    expect(codex?.loggedIn).toBe(false);
  });
});

// ─────────────────────────── gemini creds FILE (edge + adversarial) ───────────

describe('getProviderAuthStatus — gemini oauth_creds file (edge + adversarial)', () => {
  it('[edge] creds present + google_accounts has an `@` value → that email is the detail, loggedIn true', async () => {
    const files: FileMap = (p) => {
      if (p.includes('oauth_creds')) return { exists: true, json: { access_token: 'x' } };
      if (p.includes('google_accounts')) return { exists: true, json: { active: 'pilot@gmail.test' } };
      return { exists: false };
    };
    const runner = new FakeRunner(defaultCaptures, files);
    const status = await getProviderAuthStatus(runner, 'google');
    expect(status.available).toBe(true);
    expect(status.loggedIn).toBe(true);
    expect(status.detail).toBe('pilot@gmail.test');
    expect(status.supportsLogin).toBe(false);
  });

  it('[edge] creds present + google_accounts has NO `@` (e.g. {active:"someid"}) → first string used as detail', async () => {
    const files: FileMap = (p) => {
      if (p.includes('oauth_creds')) return { exists: true, json: { access_token: 'x' } };
      if (p.includes('google_accounts')) return { exists: true, json: { active: 'someid-1234' } };
      return { exists: false };
    };
    const runner = new FakeRunner(defaultCaptures, files);
    const status = await getProviderAuthStatus(runner, 'google');
    expect(status.loggedIn).toBe(true);
    expect(status.detail).toBe('someid-1234');
  });

  it('[edge] creds present + google_accounts absent → detail falls back to `Google 账号已登录`', async () => {
    const files: FileMap = (p) =>
      p.includes('oauth_creds') ? { exists: true, json: { access_token: 'x' } } : { exists: false };
    const runner = new FakeRunner(defaultCaptures, files);
    const status = await getProviderAuthStatus(runner, 'google');
    expect(status.loggedIn).toBe(true);
    expect(status.detail).toBe('Google 账号已登录');
  });

  it('[edge] creds absent but gemini installed (--version ok) → available true, loggedIn false, note as detail', async () => {
    const runner = new FakeRunner(defaultCaptures, () => ({ exists: false }));
    const status = await getProviderAuthStatus(runner, 'google');
    expect(status.available).toBe(true);
    expect(status.loggedIn).toBe(false);
    expect(status.supportsLogin).toBe(false);
    expect(status.detail).toBeTruthy();
    expect(status.detail).toContain('OAuth');
  });

  it('[adversarial] creds absent + gemini `--version` spawnError → available false, loggedIn null', async () => {
    const runner = new FakeRunner(() => SPAWN_ERROR, () => ({ exists: false }));
    const status = await getProviderAuthStatus(runner, 'google');
    expect(status.available).toBe(false);
    expect(status.loggedIn).toBeNull();
    expect(status.supportsLogin).toBe(false);
  });

  it('[adversarial] creds present but google_accounts json:undefined → no crash, detail falls back', async () => {
    const files: FileMap = (p) => {
      if (p.includes('oauth_creds')) return { exists: true, json: { access_token: 'x' } };
      if (p.includes('google_accounts')) return { exists: true }; // present, no json
      return { exists: false };
    };
    const runner = new FakeRunner(defaultCaptures, files);
    const status = await getProviderAuthStatus(runner, 'google');
    expect(status.loggedIn).toBe(true);
    expect(status.detail).toBe('Google 账号已登录');
  });
});

// ─────────────────────────── getAllProviderAuth resilience (adversarial) ──────

describe('getAllProviderAuth — mixed + missing CLIs (adversarial)', () => {
  it('[adversarial] all three logged in via their own signals (claude JSON, codex file, gemini file)', async () => {
    const runner = new FakeRunner(defaultCaptures, defaultFiles);
    const byId = new Map((await getAllProviderAuth(runner)).map((p) => [p.clientId, p]));
    expect(byId.get('anthropic')?.loggedIn).toBe(true);
    expect(byId.get('openai')?.loggedIn).toBe(true);
    expect(byId.get('openai')?.detail).toBe('已登录 · chatgpt');
    expect(byId.get('google')?.loggedIn).toBe(true);
    expect(byId.get('google')?.detail).toBe('me@example.com');
  });

  it('[adversarial] one provider spawnErroring does not reject getAllProviderAuth; others still resolve', async () => {
    // claude missing (status spawnError); codex file absent but --version errors too;
    // gemini file absent but --version ok. getAllProviderAuth must resolve, never throw.
    const captures: CaptureMap = (c, a) => {
      const key = `${c} ${a.join(' ')}`;
      if (key === 'gemini --version') return ok('1.0.0');
      return SPAWN_ERROR; // claude status + codex --version both fail
    };
    const runner = new FakeRunner(captures, () => ({ exists: false }));
    const all = await getAllProviderAuth(runner);
    expect(all).toHaveLength(3);
    const byId = new Map(all.map((p) => [p.clientId, p]));

    expect(byId.get('anthropic')?.available).toBe(false);
    expect(byId.get('anthropic')?.loggedIn).toBeNull();
    expect(byId.get('openai')?.available).toBe(false);
    expect(byId.get('openai')?.loggedIn).toBeNull();
    expect(byId.get('google')?.available).toBe(true);
    expect(byId.get('google')?.loggedIn).toBe(false);
  });

  it('[adversarial] ALL probes failing (no files, all spawnError) still resolves an array of 3 (never rejects)', async () => {
    const runner = new FakeRunner(() => SPAWN_ERROR, () => ({ exists: false }));
    const all = await getAllProviderAuth(runner);
    expect(all).toHaveLength(3);
    expect(all.every((p) => p.available === false)).toBe(true);
    expect(all.every((p) => p.loggedIn === null)).toBe(true);
  });
});

// ─────────────────────────── trigger login / logout (edge + adversarial) ─────

describe('triggerProviderLogin (edge + adversarial)', () => {
  it('[edge] anthropic login → ok:true AND spawnDetached recorded `claude auth login`', () => {
    const runner = new FakeRunner(defaultCaptures);
    expect(triggerProviderLogin(runner, 'anthropic')).toEqual({ ok: true });
    expect(runner.detached).toContainEqual({ command: 'claude', args: ['auth', 'login'] });
  });

  it('[edge] openai login → ok:true AND spawnDetached recorded `codex login` (file-based provider, command unchanged)', () => {
    const runner = new FakeRunner(defaultCaptures);
    expect(triggerProviderLogin(runner, 'openai')).toEqual({ ok: true });
    expect(runner.detached).toContainEqual({ command: 'codex', args: ['login'] });
  });

  it('[adversarial] google login → ok:false with a non-empty reason and NO spawn attempted', () => {
    const runner = new FakeRunner(defaultCaptures);
    const result = triggerProviderLogin(runner, 'google');
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
    // gemini is not CLI-scriptable: we must not even try to spawn a login.
    expect(runner.detached).toHaveLength(0);
  });

  it('[adversarial] a runner whose spawnDetached returns started:false → login ok:false with a reason', () => {
    const runner = new FakeRunner(defaultCaptures, () => ({ exists: false }), false);
    const result = triggerProviderLogin(runner, 'anthropic');
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
    // It still TRIED to spawn (the failure is the start, not the dispatch).
    expect(runner.detached).toContainEqual({ command: 'claude', args: ['auth', 'login'] });
  });
});

describe('triggerProviderLogout (edge + adversarial)', () => {
  it('[edge] anthropic logout → ok:true (capture `claude auth logout` succeeded)', async () => {
    const runner = new FakeRunner(defaultCaptures);
    expect(await triggerProviderLogout(runner, 'anthropic')).toEqual({ ok: true });
  });

  it('[edge] openai logout → ok:true (capture `codex logout`, command unchanged for the file-based provider)', async () => {
    const runner = new FakeRunner(defaultCaptures);
    expect(await triggerProviderLogout(runner, 'openai')).toEqual({ ok: true });
  });

  it('[adversarial] logout spawnError (CLI missing) → ok:false with a reason', async () => {
    const runner = new FakeRunner(() => SPAWN_ERROR);
    const result = await triggerProviderLogout(runner, 'anthropic');
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it('[adversarial] google logout → ok:false (no scriptable logout)', async () => {
    const runner = new FakeRunner(defaultCaptures);
    const result = await triggerProviderLogout(runner, 'google');
    expect(result.ok).toBe(false);
    expect(result.reason).toBeTruthy();
  });
});

// ─────────────────────────── /api/auth routes (edge + adversarial) ───────────

describe('/api/auth routes — edge + adversarial', () => {
  function injectApp(runner: AuthCliRunner): BuiltApp {
    return buildApp({
      db: new Database(':memory:'),
      agentServices: { 'claude-opus': new FakeAgentService([]) },
      authRunner: runner,
    });
  }

  it('[edge] GET /api/auth → 200 with 3 providers, each carrying the documented shape', async () => {
    const runner = new FakeRunner(defaultCaptures, defaultFiles);
    const app = injectApp(runner);
    try {
      const res = await app.api.inject({ method: 'GET', url: '/api/auth' });
      expect(res.statusCode).toBe(200);
      const providers = res.json().providers as Array<Record<string, unknown>>;
      expect(providers).toHaveLength(3);
      for (const p of providers) {
        expect(typeof p.clientId).toBe('string');
        expect(typeof p.cli).toBe('string');
        expect(typeof p.available).toBe('boolean');
        expect(typeof p.supportsLogin).toBe('boolean');
        // loggedIn is boolean | null.
        expect(p.loggedIn === null || typeof p.loggedIn === 'boolean').toBe(true);
      }
    } finally {
      await app.close();
    }
  });

  it('[adversarial] GET /api/auth never rejects when one provider`s capture spawnErrors', async () => {
    // claude status spawnErrors; codex file present (logged in); gemini --version ok.
    const captures: CaptureMap = (c, a) => {
      const key = `${c} ${a.join(' ')}`;
      if (key === 'gemini --version') return ok('1.0.0');
      return SPAWN_ERROR; // claude status fails
    };
    const files: FileMap = (p) =>
      p.includes('.codex') ? { exists: true, json: { tokens: { id_token: 'x' } } } : { exists: false };
    const runner = new FakeRunner(captures, files);
    const app = injectApp(runner);
    try {
      const res = await app.api.inject({ method: 'GET', url: '/api/auth' });
      expect(res.statusCode).toBe(200);
      const byId = new Map(
        (res.json().providers as Array<Record<string, unknown>>).map((p) => [p.clientId, p]),
      );
      expect(byId.get('anthropic')?.available).toBe(false);
      expect(byId.get('openai')?.loggedIn).toBe(true);
      expect(byId.get('google')?.loggedIn).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('[adversarial] POST /api/auth/google/login → 409 login_unavailable with a reason', async () => {
    const runner = new FakeRunner(defaultCaptures);
    const app = injectApp(runner);
    try {
      const res = await app.api.inject({ method: 'POST', url: '/api/auth/google/login' });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('login_unavailable');
      expect(res.json().reason).toBeTruthy();
      // No real spawn happened: the INJECTED runner recorded zero detached calls
      // (gemini is refused before any spawn).
      expect(runner.detached).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('[adversarial] POST login when the injected runner reports started:false → 409 (not 200)', async () => {
    const runner = new FakeRunner(defaultCaptures, () => ({ exists: false }), false);
    const app = injectApp(runner);
    try {
      const res = await app.api.inject({ method: 'POST', url: '/api/auth/anthropic/login' });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('login_unavailable');
      // The route used the INJECTED runner: it recorded the attempted dispatch.
      expect(runner.detached).toContainEqual({ command: 'claude', args: ['auth', 'login'] });
    } finally {
      await app.close();
    }
  });

  it('[edge] POST /api/auth/openai/login (started:true) → 200 ok via the injected runner (codex login dispatched)', async () => {
    const runner = new FakeRunner(defaultCaptures);
    const app = injectApp(runner);
    try {
      const res = await app.api.inject({ method: 'POST', url: '/api/auth/openai/login' });
      expect(res.statusCode).toBe(200);
      expect(res.json().ok).toBe(true);
      expect(runner.detached).toContainEqual({ command: 'codex', args: ['login'] });
    } finally {
      await app.close();
    }
  });

  it('[adversarial] POST logout when the injected runner spawnErrors → 409 logout_unavailable', async () => {
    const runner = new FakeRunner(() => SPAWN_ERROR);
    const app = injectApp(runner);
    try {
      const res = await app.api.inject({ method: 'POST', url: '/api/auth/anthropic/logout' });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('logout_unavailable');
    } finally {
      await app.close();
    }
  });

  it('[adversarial] POST /api/auth/notreal/login → 400 invalid_params (unknown clientId rejected)', async () => {
    const runner = new FakeRunner(defaultCaptures);
    const app = injectApp(runner);
    try {
      const res = await app.api.inject({ method: 'POST', url: '/api/auth/notreal/login' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_params');
      // A rejected clientId never reaches the runner.
      expect(runner.detached).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it('[adversarial] POST /api/auth/notreal/logout → 400 invalid_params', async () => {
    const runner = new FakeRunner(defaultCaptures);
    const app = injectApp(runner);
    try {
      const res = await app.api.inject({ method: 'POST', url: '/api/auth/notreal/logout' });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('invalid_params');
    } finally {
      await app.close();
    }
  });
});

// Type-only guard: ClientId import is exercised by the runner signatures above.
const _ids: readonly ClientId[] = ['anthropic', 'openai', 'google'];
void _ids;
