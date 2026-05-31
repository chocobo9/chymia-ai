// M10 dev happy-path — callback-client auth headers + graceful degradation.
// QA owns edge/adversarial (token fuzzing, non-2xx bodies, malformed JSON, etc.).
//
// These are UNIT tests of the CallbackClient: a stub fetch captures the outgoing
// request so we can assert the frozen auth headers + env-driven config, and the
// no-env case proves graceful degradation (a clean error, never a throw).

import { describe, it, expect } from 'vitest';
import {
  CallbackClient,
  INVOCATION_ID_HEADER,
  CALLBACK_TOKEN_HEADER,
  NO_CONFIG_ERROR,
  readCallbackConfig,
} from '@clowder/mcp-server/callback-client';

/** A real invocation-shaped env (the CLI sets these for the subprocess). */
const liveEnv = {
  CLOWDER_API_URL: 'http://127.0.0.1:7700',
  CLOWDER_INVOCATION_ID: 'inv_01HXYZ_codex_thread42',
  CLOWDER_CALLBACK_TOKEN: 'cbt_9f3a1c7e2b8d4f60a1c2',
} satisfies NodeJS.ProcessEnv;

/** Build a fetch stub that records the last call and returns a fixed JSON body. */
function recordingFetch(body: unknown, status = 200): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; init: RequestInit }>;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe('readCallbackConfig (unit)', () => {
  it('reads all three CLOWDER_* vars from the env', () => {
    const config = readCallbackConfig(liveEnv);
    expect(config).not.toBeNull();
    expect(config?.apiUrl).toBe('http://127.0.0.1:7700');
    expect(config?.invocationId).toBe('inv_01HXYZ_codex_thread42');
    expect(config?.callbackToken).toBe('cbt_9f3a1c7e2b8d4f60a1c2');
  });

  it('returns null when any var is missing (graceful-degradation precondition)', () => {
    expect(readCallbackConfig({})).toBeNull();
    expect(
      readCallbackConfig({
        CLOWDER_API_URL: 'http://127.0.0.1:7700',
        CLOWDER_INVOCATION_ID: 'inv_x',
      }),
    ).toBeNull();
  });
});

describe('CallbackClient.post (unit, happy path)', () => {
  it('sends X-Invocation-Id + X-Callback-Token headers on every call', async () => {
    const { fetchImpl, calls } = recordingFetch({ items: [], meta: {} });
    const client = new CallbackClient({ fetchImpl, env: liveEnv });

    await client.post('evidence_search', { query: '数据库选型' });

    expect(calls).toHaveLength(1);
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers[INVOCATION_ID_HEADER]).toBe('inv_01HXYZ_codex_thread42');
    expect(headers[CALLBACK_TOKEN_HEADER]).toBe('cbt_9f3a1c7e2b8d4f60a1c2');
  });

  it('POSTs JSON to /api/callback/<name> with the body verbatim', async () => {
    const { fetchImpl, calls } = recordingFetch({ anchor: 'decision:db', upserted: true }, 201);
    const client = new CallbackClient({ fetchImpl, env: liveEnv });

    const result = await client.post('evidence_upsert', {
      anchor: 'decision:db',
      kind: 'decision',
      title: 'SQLite 选型',
      summary: '存储用 better-sqlite3 + FTS5。',
    });

    expect(calls[0]?.url).toBe('http://127.0.0.1:7700/api/callback/evidence_upsert');
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      anchor: 'decision:db',
      kind: 'decision',
      title: 'SQLite 选型',
      summary: '存储用 better-sqlite3 + FTS5。',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ anchor: 'decision:db', upserted: true });
    }
  });

  it('degrades gracefully when env vars are unset — returns a clean error, never throws', async () => {
    const { fetchImpl, calls } = recordingFetch({ items: [] });
    const client = new CallbackClient({ fetchImpl, env: {} });

    const result = await client.post('evidence_search', { query: '任何查询' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(NO_CONFIG_ERROR);
    }
    // No HTTP request should have been attempted without credentials.
    expect(calls).toHaveLength(0);
  });
});
