// M13 WeChat adapter — token-manager happy-path suite (DEV role).
// QA owns edge + adversarial coverage (errcode, missing token, timeout, races).
//
// Verifies fetch+cache+refresh-by-expiry with an injected FetchFn + clock.

import { describe, it, expect } from 'vitest';
import { TokenManager, type FetchFn } from '@clowder/adapters/wechat/token-manager';

const API_BASE = 'https://qyapi.weixin.qq.com/cgi-bin';
const CORP_ID = 'ww1a2b3c4d5e6f7g8';
const SECRET = 'Xy7Qa9Bc3Df1Gh5Jk2Lm8Np4Qr6St0Uv';

/** A fake fetch that returns a JSON gettoken response and counts calls. */
function fakeFetch(
  responses: ReadonlyArray<{ access_token: string; expires_in: number }>,
): { fetchFn: FetchFn; calls: () => number } {
  let index = 0;
  let count = 0;
  const fetchFn: FetchFn = async () => {
    count += 1;
    const body = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { fetchFn, calls: () => count };
}

describe('TokenManager (happy path)', () => {
  it('fetches and returns the WeCom access_token', async () => {
    const { fetchFn } = fakeFetch([{ access_token: 'tok-aaa-7200', expires_in: 7200 }]);
    const manager = new TokenManager({ corpId: CORP_ID, secret: SECRET, apiBase: API_BASE, fetchFn });

    const token = await manager.getToken();

    expect(token).toBe('tok-aaa-7200');
  });

  it('caches the token within its TTL (no duplicate network calls)', async () => {
    const fake = fakeFetch([{ access_token: 'tok-cached', expires_in: 7200 }]);
    let clock = 1_700_000_000_000;
    const manager = new TokenManager({
      corpId: CORP_ID,
      secret: SECRET,
      apiBase: API_BASE,
      fetchFn: fake.fetchFn,
      now: () => clock,
    });

    const first = await manager.getToken();
    clock += 60_000; // 1 minute later, well within the 7200s TTL.
    const second = await manager.getToken();

    expect(first).toBe('tok-cached');
    expect(second).toBe('tok-cached');
    expect(fake.calls()).toBe(1);
  });

  it('refreshes after the cached token passes its expiry (minus margin)', async () => {
    const fake = fakeFetch([
      { access_token: 'tok-first', expires_in: 7200 },
      { access_token: 'tok-second', expires_in: 7200 },
    ]);
    let clock = 1_700_000_000_000;
    const manager = new TokenManager({
      corpId: CORP_ID,
      secret: SECRET,
      apiBase: API_BASE,
      fetchFn: fake.fetchFn,
      now: () => clock,
    });

    const first = await manager.getToken();
    // Advance past 7200s TTL so the cache is stale even with the 120s margin.
    clock += 7200_000;
    const second = await manager.getToken();

    expect(first).toBe('tok-first');
    expect(second).toBe('tok-second');
    expect(fake.calls()).toBe(2);
  });

  it('forces a network refresh after forceRefresh()', async () => {
    const fake = fakeFetch([
      { access_token: 'tok-before', expires_in: 7200 },
      { access_token: 'tok-after', expires_in: 7200 },
    ]);
    const manager = new TokenManager({
      corpId: CORP_ID,
      secret: SECRET,
      apiBase: API_BASE,
      fetchFn: fake.fetchFn,
    });

    const before = await manager.getToken();
    manager.forceRefresh();
    const after = await manager.getToken();

    expect(before).toBe('tok-before');
    expect(after).toBe('tok-after');
    expect(fake.calls()).toBe(2);
  });
});
