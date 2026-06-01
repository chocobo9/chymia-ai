// M13 WeChat adapter — TokenManager EDGE + ADVERSARIAL suite (QA role).
//
// Authored by the independent QA (NOT the dev), per CLAUDE §0.5.3. Attacks the
// access_token fetch/cache/refresh seam: concurrent-getToken coalescing (single
// fetch for N parallel callers), the 120s refresh-margin boundary driven by an
// injected clock, forceRefresh bypass, and error surfacing (errcode body, HTTP
// non-200, missing access_token) — every failure must surface, never crash silently.
//
// Realistic WeCom corpId/secret/token shapes. Injected FetchFn + clock — no network.

import { describe, it, expect } from 'vitest';
import { TokenManager, type FetchFn } from '@clowder/adapters/wechat/token-manager';

const API_BASE = 'https://qyapi.weixin.qq.com/cgi-bin';
const CORP_ID = 'ww1a2b3c4d5e6f7g8';
const SECRET = 'Xy7Qa9Bc3Df1Gh5Jk2Lm8Np4Qr6St0Uv';

/** Real WeCom gettoken JSON body. */
function tokenBody(access_token: string, expires_in = 7200): string {
  return JSON.stringify({ access_token, expires_in });
}

function jsonResponse(body: string, status = 200, statusText = 'OK'): Response {
  return new Response(body, {
    status,
    statusText,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('TokenManager — concurrent coalescing (ADVERSARIAL)', () => {
  it('coalesces N parallel getToken() callers into a SINGLE network fetch', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The fetch parks until we release it, guaranteeing all 8 callers arrive
    // while the first refresh is still in flight (the race window).
    const fetchFn: FetchFn = async () => {
      calls += 1;
      await gate;
      return jsonResponse(tokenBody('tok-coalesced-7200'));
    };
    const manager = new TokenManager({ corpId: CORP_ID, secret: SECRET, apiBase: API_BASE, fetchFn });

    const inFlight = Promise.all(Array.from({ length: 8 }, () => manager.getToken()));
    // Let the microtask queue drain so all 8 calls reach getToken before release.
    await Promise.resolve();
    release();
    const tokens = await inFlight;

    expect(calls).toBe(1); // one fetch served all 8 concurrent callers
    expect(tokens).toEqual(Array.from({ length: 8 }, () => 'tok-coalesced-7200'));
  });

  it('refetches on the NEXT call after an in-flight refresh settles (in-flight is cleared)', async () => {
    let calls = 0;
    const fetchFn: FetchFn = async () => {
      calls += 1;
      return jsonResponse(tokenBody(`tok-${calls}`));
    };
    let clock = 1_700_000_000_000;
    const manager = new TokenManager({
      corpId: CORP_ID,
      secret: SECRET,
      apiBase: API_BASE,
      fetchFn,
      now: () => clock,
    });

    const first = await manager.getToken(); // calls=1, cached
    clock += 7_200_000; // blow past TTL
    const second = await manager.getToken(); // in-flight was cleared → calls=2

    expect(first).toBe('tok-1');
    expect(second).toBe('tok-2');
    expect(calls).toBe(2);
  });
});

describe('TokenManager — refresh margin boundary (EDGE, clock-driven)', () => {
  it('refreshes EARLY, within the 120s margin before real expiry (does not serve a near-dead token)', async () => {
    let calls = 0;
    const fetchFn: FetchFn = async () => {
      calls += 1;
      return jsonResponse(tokenBody(`tok-margin-${calls}`, 7200));
    };
    let clock = 1_700_000_000_000;
    const manager = new TokenManager({
      corpId: CORP_ID,
      secret: SECRET,
      apiBase: API_BASE,
      fetchFn,
      now: () => clock,
    });

    const first = await manager.getToken();
    // expiresAt = now + 7200_000 - 120_000. Advance to 90s BEFORE real expiry,
    // i.e. INSIDE the 120s margin → must refresh rather than serve the stale token.
    clock += 7_200_000 - 90_000;
    const second = await manager.getToken();

    expect(first).toBe('tok-margin-1');
    expect(second).toBe('tok-margin-2'); // refreshed inside the margin
    expect(calls).toBe(2);
  });

  it('still serves the cached token JUST before entering the margin (no premature refresh)', async () => {
    let calls = 0;
    const fetchFn: FetchFn = async () => {
      calls += 1;
      return jsonResponse(tokenBody(`tok-fresh-${calls}`, 7200));
    };
    let clock = 1_700_000_000_000;
    const manager = new TokenManager({
      corpId: CORP_ID,
      secret: SECRET,
      apiBase: API_BASE,
      fetchFn,
      now: () => clock,
    });

    await manager.getToken();
    // Advance to 150s before real expiry — still 30s OUTSIDE the 120s margin → cached.
    clock += 7_200_000 - 150_000;
    const second = await manager.getToken();

    expect(second).toBe('tok-fresh-1'); // same cached token
    expect(calls).toBe(1);
  });

  it('uses the WeCom default TTL when expires_in is absent, then caches accordingly', async () => {
    let calls = 0;
    const fetchFn: FetchFn = async () => {
      calls += 1;
      // Omit expires_in entirely → manager falls back to 7200s default.
      return jsonResponse(JSON.stringify({ access_token: `tok-default-${calls}` }));
    };
    let clock = 1_700_000_000_000;
    const manager = new TokenManager({
      corpId: CORP_ID,
      secret: SECRET,
      apiBase: API_BASE,
      fetchFn,
      now: () => clock,
    });

    await manager.getToken();
    clock += 60_000; // 1 min later — well inside a 7200s default TTL
    const second = await manager.getToken();
    expect(second).toBe('tok-default-1');
    expect(calls).toBe(1);
  });
});

describe('TokenManager — forceRefresh (EDGE)', () => {
  it('forceRefresh() drops a still-valid cached token so the next call refetches', async () => {
    let calls = 0;
    const fetchFn: FetchFn = async () => {
      calls += 1;
      return jsonResponse(tokenBody(`tok-rotation-${calls}`));
    };
    let clock = 1_700_000_000_000;
    const manager = new TokenManager({
      corpId: CORP_ID,
      secret: SECRET,
      apiBase: API_BASE,
      fetchFn,
      now: () => clock,
    });

    const before = await manager.getToken();
    clock += 1000; // still well within TTL — cache would normally serve `before`
    manager.forceRefresh();
    const after = await manager.getToken();

    expect(before).toBe('tok-rotation-1');
    expect(after).toBe('tok-rotation-2'); // forceRefresh bypassed the live cache
    expect(calls).toBe(2);
  });
});

describe('TokenManager — error surfacing (ADVERSARIAL — must NOT crash silently)', () => {
  it('throws (surfaces) when WeCom returns a non-zero errcode (e.g. 40001 invalid credential)', async () => {
    const fetchFn: FetchFn = async () =>
      jsonResponse(JSON.stringify({ errcode: 40001, errmsg: 'invalid credential' }));
    const manager = new TokenManager({ corpId: CORP_ID, secret: SECRET, apiBase: API_BASE, fetchFn });

    await expect(manager.getToken()).rejects.toThrow(/40001/);
  });

  it('throws when the gettoken HTTP status is not OK (e.g. 500)', async () => {
    const fetchFn: FetchFn = async () =>
      jsonResponse('upstream boom', 500, 'Internal Server Error');
    const manager = new TokenManager({ corpId: CORP_ID, secret: SECRET, apiBase: API_BASE, fetchFn });

    await expect(manager.getToken()).rejects.toThrow(/HTTP 500/);
  });

  it('throws when the 200 body is missing access_token (malformed upstream success)', async () => {
    const fetchFn: FetchFn = async () =>
      jsonResponse(JSON.stringify({ errcode: 0, errmsg: 'ok' })); // no access_token
    const manager = new TokenManager({ corpId: CORP_ID, secret: SECRET, apiBase: API_BASE, fetchFn });

    await expect(manager.getToken()).rejects.toThrow(/missing access_token/);
  });

  it('does NOT cache a failed refresh: a subsequent call retries the fetch', async () => {
    let calls = 0;
    const fetchFn: FetchFn = async () => {
      calls += 1;
      if (calls === 1) {
        return jsonResponse(JSON.stringify({ errcode: 40013, errmsg: 'invalid corpid' }));
      }
      return jsonResponse(tokenBody('tok-recovered'));
    };
    const manager = new TokenManager({ corpId: CORP_ID, secret: SECRET, apiBase: API_BASE, fetchFn });

    await expect(manager.getToken()).rejects.toThrow(/40013/);
    // The error must not have poisoned the cache or left a stuck in-flight promise.
    const recovered = await manager.getToken();
    expect(recovered).toBe('tok-recovered');
    expect(calls).toBe(2);
  });

  it('rejects construction with empty corpId/secret/apiBase (fail-fast on misconfig)', () => {
    expect(() => new TokenManager({ corpId: '', secret: SECRET, apiBase: API_BASE })).toThrow();
    expect(() => new TokenManager({ corpId: CORP_ID, secret: '', apiBase: API_BASE })).toThrow();
    expect(() => new TokenManager({ corpId: CORP_ID, secret: SECRET, apiBase: '' })).toThrow();
  });
});
