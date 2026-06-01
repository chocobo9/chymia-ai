// @vitest-environment jsdom
//
// M9 lib/api happy-path tests: the HTTP client shapes requests + parses the
// frozen M8 response envelopes. fetch is injected (no network, no globals).

import '@testing-library/jest-dom';
import { describe, it, expect } from 'vitest';
import { ApiClient, ApiError, type FetchFn } from '../../packages/web/src/lib/api.js';
import { ROSTER, makeThread, makeUserMessage, makeAgentReply } from './fixtures.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Capture the calls a fetch receives. */
function recordingFetch(
  body: unknown,
  status = 200,
): { fetchFn: FetchFn; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchFn: FetchFn = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(jsonResponse(body, status));
  };
  return { fetchFn, calls };
}

const BASE = 'http://127.0.0.1:3000';

describe('ApiClient (unit, happy path)', () => {
  it('listThreads GETs /api/threads and unwraps the threads array', async () => {
    const { fetchFn, calls } = recordingFetch({ threads: [makeThread()] });
    const client = new ApiClient({ baseUrl: BASE, fetchFn });

    const threads = await client.listThreads();

    expect(calls[0].url).toBe(`${BASE}/api/threads`);
    expect(threads).toHaveLength(1);
    expect(threads[0].title).toBe('TODO API 设计与实现');
  });

  it('createThread POSTs JSON and returns the created Thread', async () => {
    const created = makeThread({ id: 'thread_new', title: undefined });
    const { fetchFn, calls } = recordingFetch(created, 201);
    const client = new ApiClient({ baseUrl: BASE, fetchFn });

    const thread = await client.createThread({ thinkingMode: 'debug' });

    expect(calls[0].url).toBe(`${BASE}/api/threads`);
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ thinkingMode: 'debug' });
    expect(thread.id).toBe('thread_new');
  });

  it('getMessages GETs history and unwraps the messages array', async () => {
    const { fetchFn, calls } = recordingFetch({
      messages: [makeUserMessage(), makeAgentReply()],
    });
    const client = new ApiClient({ baseUrl: BASE, fetchFn });

    const messages = await client.getMessages('thread_todo_api', 50);

    expect(calls[0].url).toBe(`${BASE}/api/threads/thread_todo_api/messages?limit=50`);
    expect(messages).toHaveLength(2);
  });

  it('sendMessage POSTs content and returns { userMessage, replies } (G8 sync result)', async () => {
    const result = { userMessage: makeUserMessage(), replies: [makeAgentReply()] };
    const { fetchFn, calls } = recordingFetch(result);
    const client = new ApiClient({ baseUrl: BASE, fetchFn });

    const sent = await client.sendMessage('thread_todo_api', {
      content: '@codex review the code above',
    });

    expect(calls[0].url).toBe(`${BASE}/api/threads/thread_todo_api/messages`);
    expect(calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      content: '@codex review the code above',
    });
    expect(sent.replies).toHaveLength(1);
    expect(sent.userMessage.content).toContain('@claude');
  });

  it('listAgents GETs /api/agents and unwraps the roster', async () => {
    const { fetchFn } = recordingFetch({ agents: ROSTER });
    const client = new ApiClient({ baseUrl: BASE, fetchFn });

    const agents = await client.listAgents();
    expect(agents).toHaveLength(3);
    expect(agents[0].mentionPatterns).toContain('@claude');
  });

  it('throws ApiError carrying the status on a non-2xx response', async () => {
    const { fetchFn } = recordingFetch({ error: 'thread_not_found' }, 404);
    const client = new ApiClient({ baseUrl: BASE, fetchFn });

    await expect(client.getThread('missing')).rejects.toBeInstanceOf(ApiError);
    await expect(client.getThread('missing')).rejects.toMatchObject({ status: 404 });
  });
});
