// @vitest-environment jsdom
//
// Regression — bodyless mutations must NOT declare a JSON content-type.
//
// The bug: jsonInit() always set `content-type: application/json`, even for the
// bodyless POST/DELETE calls (sealSession / reopenSession / deleteThread). The
// browser then sent that header with an EMPTY body, which Fastify's body parser
// rejects 400 FST_ERR_CTP_EMPTY_JSON_BODY ("Body cannot be empty when content-type
// is set to 'application/json'"). The mocked-fetch unit tests never caught it (no
// real parser); in the live app 封存 / 恢复 / 删除会话 silently no-op'd.
//
// These gate the request SHAPE the client builds: bodyless → no content-type, no
// body; bodied → content-type + serialized JSON. Distribution: happy ≤50%, edge
// ≥30%, adversarial ≥20%.

import '@testing-library/jest-dom';
import { describe, it, expect } from 'vitest';
import { ApiClient, type FetchFn } from '../../packages/web/src/lib/api.js';

const BASE = 'http://127.0.0.1:3000';

function recordingFetch(body: unknown, status = 200): {
  fetchFn: FetchFn;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn: FetchFn = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
    );
  };
  return { fetchFn, calls };
}

/** The content-type the client put on a request (case-insensitive), or undefined. */
function contentTypeOf(init?: RequestInit): string | undefined {
  const headers = init?.headers as Record<string, string> | undefined;
  if (headers === undefined) return undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === 'content-type');
  return key === undefined ? undefined : headers[key];
}

describe('ApiClient request shape — bodyless mutations carry no JSON content-type', () => {
  it('[happy] a BODIED POST still sends content-type: application/json + the JSON body', async () => {
    const { fetchFn, calls } = recordingFetch({ id: 'thread_new' }, 201);
    const client = new ApiClient({ baseUrl: BASE, fetchFn });

    await client.createThread({ thinkingMode: 'debug' });

    expect(calls[0].init?.method).toBe('POST');
    expect(contentTypeOf(calls[0].init)).toBe('application/json');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ thinkingMode: 'debug' });
  });

  it('[edge] sealSession POSTs with NO content-type and NO body', async () => {
    const { fetchFn, calls } = recordingFetch({ status: 'sealed' });
    const client = new ApiClient({ baseUrl: BASE, fetchFn });

    await client.sealSession('sess-abc');

    expect(calls[0].url).toBe(`${BASE}/api/sessions/sess-abc/seal`);
    expect(calls[0].init?.method).toBe('POST');
    expect(contentTypeOf(calls[0].init)).toBeUndefined();
    expect(calls[0].init?.body).toBeUndefined();
  });

  it('[edge] reopenSession POSTs with NO content-type and NO body', async () => {
    const { fetchFn, calls } = recordingFetch({ status: 'active' });
    const client = new ApiClient({ baseUrl: BASE, fetchFn });

    await client.reopenSession('sess-abc');

    expect(calls[0].url).toBe(`${BASE}/api/sessions/sess-abc/reopen`);
    expect(calls[0].init?.method).toBe('POST');
    expect(contentTypeOf(calls[0].init)).toBeUndefined();
    expect(calls[0].init?.body).toBeUndefined();
  });

  it('[edge] deleteThread DELETEs with NO content-type and NO body', async () => {
    const { fetchFn, calls } = recordingFetch({ deleted: true, id: 't' });
    const client = new ApiClient({ baseUrl: BASE, fetchFn });

    await client.deleteThread('t');

    expect(calls[0].init?.method).toBe('DELETE');
    expect(contentTypeOf(calls[0].init)).toBeUndefined();
    expect(calls[0].init?.body).toBeUndefined();
  });

  it('[adversarial] NO bodyless mutation may emit content-type: application/json (the 400 trigger)', async () => {
    // Each of these declaring a JSON content-type with an empty body is exactly what
    // made Fastify answer 400 FST_ERR_CTP_EMPTY_JSON_BODY in the live app.
    for (const exercise of [
      (c: ApiClient): Promise<unknown> => c.sealSession('s'),
      (c: ApiClient): Promise<unknown> => c.reopenSession('s'),
      (c: ApiClient): Promise<unknown> => c.deleteThread('t'),
    ]) {
      const { fetchFn, calls } = recordingFetch({ ok: true });
      const client = new ApiClient({ baseUrl: BASE, fetchFn });
      await exercise(client);
      expect(contentTypeOf(calls[0].init)).not.toBe('application/json');
    }
  });
});
