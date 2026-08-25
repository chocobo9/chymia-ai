// tests/api/thread-routing-policy-route.test.ts
// P0-1 gap #2 — PATCH /api/threads/:id routingPolicy (F042) over the real HTTP route.
//
// Aligned-To: reference/clowder-ai-main/.../routes/threads.ts
//   (PATCH routingPolicy → threadStore.updateRoutingPolicy; null clears)
//
// inject-only Fastify; the route + SqliteThreadStore round-trip are real. The
// fake provider is never invoked here (PATCH touches only the store), so there is
// no CLI path to exercise.

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { Thread } from '@choco/shared';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';
import { FakeAgentService } from '../invocation/fake-agent-service.js';

function injectApp(): BuiltApp {
  const db = new Database(':memory:');
  return buildApp({ db, agentServices: { 'claude-opus': new FakeAgentService([]) } });
}

async function createThread(app: BuiltApp): Promise<Thread> {
  const res = await app.api.inject({
    method: 'POST',
    url: '/api/threads',
    payload: { title: 'routing policy thread' },
  });
  expect(res.statusCode).toBe(201);
  return res.json<Thread>();
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

describe('PATCH /api/threads/:id routingPolicy (F042)', () => {
  it('sets a routing policy and a subsequent GET reflects it', async () => {
    const app = injectApp();
    cleanups.push(app.close);
    const thread = await createThread(app);

    const res = await app.api.inject({
      method: 'PATCH',
      url: `/api/threads/${thread.id}`,
      payload: {
        routingPolicy: { v: 1, scopes: { review: { avoidCats: ['codex-gpt'], reason: 'budget' } } },
      },
    });
    expect(res.statusCode).toBe(200);

    const fetched = await app.api.inject({ method: 'GET', url: `/api/threads/${thread.id}` });
    const policy = fetched.json<Thread>().routingPolicy;
    expect(policy?.scopes?.review?.avoidCats).toEqual(['codex-gpt']);
    expect(policy?.scopes?.review?.reason).toBe('budget');
  });

  it('null clears a previously-set routing policy', async () => {
    const app = injectApp();
    cleanups.push(app.close);
    const thread = await createThread(app);
    await app.api.inject({
      method: 'PATCH',
      url: `/api/threads/${thread.id}`,
      payload: { routingPolicy: { v: 1, scopes: { review: { avoidCats: ['codex-gpt'] } } } },
    });

    const cleared = await app.api.inject({
      method: 'PATCH',
      url: `/api/threads/${thread.id}`,
      payload: { routingPolicy: null },
    });
    expect(cleared.statusCode).toBe(200);

    const fetched = await app.api.inject({ method: 'GET', url: `/api/threads/${thread.id}` });
    expect(fetched.json<Thread>().routingPolicy).toBeUndefined();
  });

  it('title and routingPolicy can be patched together', async () => {
    const app = injectApp();
    cleanups.push(app.close);
    const thread = await createThread(app);

    const res = await app.api.inject({
      method: 'PATCH',
      url: `/api/threads/${thread.id}`,
      payload: {
        title: '改名了',
        routingPolicy: { v: 1, scopes: { architecture: { preferCats: ['gemini-pro'] } } },
      },
    });
    expect(res.statusCode).toBe(200);
    const t = res.json<Thread>();
    expect(t.title).toBe('改名了');
    expect(t.routingPolicy?.scopes?.architecture?.preferCats).toEqual(['gemini-pro']);
  });

  it('rejects an empty body (at least one of title / routingPolicy required)', async () => {
    const app = injectApp();
    cleanups.push(app.close);
    const thread = await createThread(app);

    const res = await app.api.inject({
      method: 'PATCH',
      url: `/api/threads/${thread.id}`,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an unknown routing scope (strict schema)', async () => {
    const app = injectApp();
    cleanups.push(app.close);
    const thread = await createThread(app);

    const res = await app.api.inject({
      method: 'PATCH',
      url: `/api/threads/${thread.id}`,
      payload: { routingPolicy: { v: 1, scopes: { bogus: { avoidCats: ['codex-gpt'] } } } },
    });
    expect(res.statusCode).toBe(400);
  });
});
