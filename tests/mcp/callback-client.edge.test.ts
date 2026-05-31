// M10 QA — callback-client edge + adversarial (independently authored, ≠ dev).
//
// The callback-client is the MCP→API HTTP seam. The frozen contract requires it
// to NEVER throw: missing/partial config, every non-2xx status, a non-JSON or
// empty body, and an unreachable API must ALL come back as a structured
// CallbackResult (ok:false on error) so the stdio server stays alive and the tool
// handler can surface a clean isError. These tests fuzz exactly those failure
// surfaces + assert the auth headers carry the EXACT env values on every call.

import { describe, it, expect } from 'vitest';
import {
  CallbackClient,
  INVOCATION_ID_HEADER,
  CALLBACK_TOKEN_HEADER,
  NO_CONFIG_ERROR,
  readCallbackConfig,
  buildAuthHeaders,
} from '@clowder/mcp-server/callback-client';

/** A real invocation-shaped env (the CLI sets these for the subprocess). */
const liveEnv = {
  CLOWDER_API_URL: 'http://127.0.0.1:7700',
  CLOWDER_INVOCATION_ID: 'inv_01HXYZ_codex_thread42',
  CLOWDER_CALLBACK_TOKEN: 'cbt_9f3a1c7e2b8d4f60a1c2',
} satisfies NodeJS.ProcessEnv;

/** A fetch stub returning a fixed status + body, recording the outgoing request. */
function fetchReturning(
  status: number,
  body: string,
  headers: Record<string, string> = {},
): { fetchImpl: typeof fetch; calls: Array<{ url: string; init: RequestInit }> } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(body, { status, headers });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

/** A fetch stub that REJECTS (simulates connection refused / DNS failure). */
function fetchThrowing(err: unknown): typeof fetch {
  return (async () => {
    throw err;
  }) as unknown as typeof fetch;
}

// --- error surfacing: every non-2xx becomes ok:false, never a throw ----------
// Edge: the API's documented non-2xx responses (the error-surfacing contract)
// must each round-trip into a clean ok:false result rather than a throw.
describe('CallbackClient.post — non-2xx surfacing (edge)', () => {
  it('surfaces 401 (stale/wrong token) as ok:false with the status, never throws', async () => {
    const { fetchImpl } = fetchReturning(401, JSON.stringify({ error: 'unauthorized', reason: 'invalid_token' }));
    const client = new CallbackClient({ fetchImpl, env: liveEnv });

    const result = await client.post('post_message', { content: '过期 token 重放' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(401);
      expect(result.error).toContain('401');
      expect(result.error).toContain('invalid_token');
    }
  });

  it('surfaces 403 (search_files traversal rejected) as ok:false, no throw', async () => {
    const { fetchImpl } = fetchReturning(403, JSON.stringify({ error: 'path_outside_root' }));
    const client = new CallbackClient({ fetchImpl, env: liveEnv });

    const result = await client.post('search_files', { query: 'secret', path: '../../etc' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.error).toContain('path_outside_root');
    }
  });

  it('surfaces 404 (cross-thread / unknown session) as ok:false', async () => {
    const { fetchImpl } = fetchReturning(404, JSON.stringify({ error: 'session_not_found' }));
    const client = new CallbackClient({ fetchImpl, env: liveEnv });

    const result = await client.post('read_session_digest', { sessionId: 'sess-from-other-thread' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
      expect(result.error).toContain('session_not_found');
    }
  });

  it('surfaces 400 (unknown targetAgent / invalid body) as ok:false', async () => {
    const { fetchImpl } = fetchReturning(400, JSON.stringify({ error: 'unknown_target_agents', agents: ['ghost-bot'] }));
    const client = new CallbackClient({ fetchImpl, env: liveEnv });

    const result = await client.post('post_message', { content: '路由给不存在的 agent', targetAgents: ['ghost-bot'] });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.error).toContain('unknown_target_agents');
    }
  });

  it('surfaces 413 (oversize file) as ok:false', async () => {
    const { fetchImpl } = fetchReturning(413, JSON.stringify({ error: 'file_too_large', maxBytes: 262144 }));
    const client = new CallbackClient({ fetchImpl, env: liveEnv });

    const result = await client.post('read_file', { path: 'huge.log' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(413);
      expect(result.error).toContain('file_too_large');
    }
  });

  it('surfaces 500 (server fault) as ok:false, never throws or swallows', async () => {
    const { fetchImpl } = fetchReturning(500, 'Internal Server Error');
    const client = new CallbackClient({ fetchImpl, env: liveEnv });

    const result = await client.post('evidence_search', { query: '触发服务器内部错误' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.error).toContain('500');
    }
  });
});

// --- malformed / unusual response bodies -------------------------------------
describe('CallbackClient.post — malformed response bodies (edge)', () => {
  it('a 2xx with a NON-JSON body surfaces ok:true carrying the raw text (no throw)', async () => {
    const { fetchImpl } = fetchReturning(200, 'this is not json <html>');
    const client = new CallbackClient({ fetchImpl, env: liveEnv });

    const result = await client.post('evidence_search', { query: '检索返回非 JSON' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toBe('this is not json <html>');
    }
  });

  it('a 2xx with an EMPTY body surfaces ok:true with {} (no JSON.parse crash)', async () => {
    // 200 with a zero-length body — the production path is `text.length === 0`.
    // (204 is a null-body status undici forbids constructing with a body, so we
    // exercise the empty-body branch via a 200 rather than a 204.)
    const { fetchImpl } = fetchReturning(200, '');
    const client = new CallbackClient({ fetchImpl, env: liveEnv });

    const result = await client.post('post_message', { content: '空响应体' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({});
    }
  });

  it('a non-2xx with a non-JSON (HTML error page) body still surfaces ok:false cleanly', async () => {
    const { fetchImpl } = fetchReturning(502, '<html><body>Bad Gateway</body></html>');
    const client = new CallbackClient({ fetchImpl, env: liveEnv });

    const result = await client.post('read_file', { path: 'README.md' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(502);
      expect(result.error).toContain('Bad Gateway');
    }
  });
});

// --- unreachable API / network faults ----------------------------------------
describe('CallbackClient.post — network faults (adversarial)', () => {
  it('a connection-refused fetch rejection becomes ok:false, never propagates the throw', async () => {
    const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:7700'), { code: 'ECONNREFUSED' });
    const client = new CallbackClient({ fetchImpl: fetchThrowing(refused), env: liveEnv });

    const result = await client.post('post_message', { content: 'API 不可达' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Callback request failed');
      expect(result.error).toContain('ECONNREFUSED');
      expect(result.status).toBeUndefined();
    }
  });

  it('a non-Error thrown value (string) is coerced to a clean message, not re-thrown', async () => {
    const client = new CallbackClient({ fetchImpl: fetchThrowing('socket hang up'), env: liveEnv });

    const result = await client.post('evidence_search', { query: 'fetch 抛出非 Error' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('socket hang up');
    }
  });
});

// --- auth headers: exact env values, every call ------------------------------
describe('CallbackClient.post — auth headers carry exact env values (edge)', () => {
  it('sends the EXACT invocationId + token from env (not a default/placeholder)', async () => {
    const { fetchImpl, calls } = fetchReturning(200, '{}');
    const client = new CallbackClient({ fetchImpl, env: liveEnv });

    await client.post('list_session_chain', {});

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers[INVOCATION_ID_HEADER]).toBe('inv_01HXYZ_codex_thread42');
    expect(headers[CALLBACK_TOKEN_HEADER]).toBe('cbt_9f3a1c7e2b8d4f60a1c2');
    expect(headers['content-type']).toBe('application/json');
  });

  it('re-reads config per call, so a token rotated in env mid-session is used on the NEXT call', async () => {
    const mutableEnv: NodeJS.ProcessEnv = { ...liveEnv };
    const { fetchImpl, calls } = fetchReturning(200, '{}');
    const client = new CallbackClient({ fetchImpl, env: mutableEnv });

    await client.post('list_session_chain', {});
    mutableEnv.CLOWDER_CALLBACK_TOKEN = 'cbt_rotated_2222';
    await client.post('list_session_chain', {});

    const h0 = calls[0]?.init.headers as Record<string, string>;
    const h1 = calls[1]?.init.headers as Record<string, string>;
    expect(h0[CALLBACK_TOKEN_HEADER]).toBe('cbt_9f3a1c7e2b8d4f60a1c2');
    expect(h1[CALLBACK_TOKEN_HEADER]).toBe('cbt_rotated_2222');
  });

  it('buildAuthHeaders maps config to the two lowercased canonical header names', () => {
    const headers = buildAuthHeaders({
      apiUrl: 'http://127.0.0.1:7700',
      invocationId: 'inv-abc',
      callbackToken: 'tok-xyz',
    });
    expect(headers).toEqual({
      'x-invocation-id': 'inv-abc',
      'x-callback-token': 'tok-xyz',
    });
  });

  it('normalizes a trailing slash on the API url so the path never doubles', async () => {
    const { fetchImpl, calls } = fetchReturning(200, '{}');
    const client = new CallbackClient({
      fetchImpl,
      env: { ...liveEnv, CLOWDER_API_URL: 'http://127.0.0.1:7700/' },
    });

    await client.post('read_file', { path: 'a.txt' });

    expect(calls[0]?.url).toBe('http://127.0.0.1:7700/api/callback/read_file');
  });
});

// --- partial / blank env: no malformed request is ever sent ------------------
describe('readCallbackConfig + post — partial env graceful degradation (adversarial)', () => {
  it('returns null when only the API url is set (1 of 3)', () => {
    expect(readCallbackConfig({ CLOWDER_API_URL: 'http://127.0.0.1:7700' })).toBeNull();
  });

  it('returns null when the token is missing (2 of 3 set)', () => {
    expect(
      readCallbackConfig({
        CLOWDER_API_URL: 'http://127.0.0.1:7700',
        CLOWDER_INVOCATION_ID: 'inv_x',
      }),
    ).toBeNull();
  });

  it('treats a whitespace-only var as missing (no blank-credentialed request)', () => {
    expect(
      readCallbackConfig({
        CLOWDER_API_URL: 'http://127.0.0.1:7700',
        CLOWDER_INVOCATION_ID: '   ',
        CLOWDER_CALLBACK_TOKEN: 'cbt_real',
      }),
    ).toBeNull();
  });

  it('with partial env, post() returns the no-config error and sends NO HTTP request', async () => {
    const { fetchImpl, calls } = fetchReturning(200, '{}');
    const client = new CallbackClient({
      fetchImpl,
      env: { CLOWDER_API_URL: 'http://127.0.0.1:7700', CLOWDER_INVOCATION_ID: 'inv_only' },
    });

    const result = await client.post('post_message', { content: '只配了两个变量' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe(NO_CONFIG_ERROR);
    }
    // Crucial: no unauthenticated/malformed request leaked out.
    expect(calls).toHaveLength(0);
  });

  it('trims surrounding whitespace on a real value so the header carries the clean token', async () => {
    const { fetchImpl, calls } = fetchReturning(200, '{}');
    const client = new CallbackClient({
      fetchImpl,
      env: {
        CLOWDER_API_URL: '  http://127.0.0.1:7700  ',
        CLOWDER_INVOCATION_ID: ' inv_trim ',
        CLOWDER_CALLBACK_TOKEN: ' cbt_trim ',
      },
    });

    await client.post('list_session_chain', {});

    expect(calls[0]?.url).toBe('http://127.0.0.1:7700/api/callback/list_session_chain');
    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers[INVOCATION_ID_HEADER]).toBe('inv_trim');
    expect(headers[CALLBACK_TOKEN_HEADER]).toBe('cbt_trim');
  });
});
