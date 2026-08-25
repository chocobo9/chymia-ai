// tests/api/relay-cat-not-routable.test.ts
// gap #4 fix regression — the relay cat must NOT join everyday routing.
//
// Bug (reported from the live app): the backup model (claude-opus-relay) was a
// normal roster member, so @all / fallback / the UI roster all picked it up and it
// replied to ordinary messages. The fix forces it unavailable (a system backup,
// only ever pushed by route-serial on form A). These lock that in: @all expansion,
// the no-mention fallback, and GET /api/agents must all exclude the relay cat — while
// the real roster (claude/codex/gemini) is unaffected.

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createAgentId } from '@choco/shared';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';
import { FakeAgentService } from '../invocation/fake-agent-service.js';

const RELAY = 'claude-opus-relay';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

function app(): BuiltApp {
  const db = new Database(':memory:');
  const built = buildApp({
    db,
    agentServices: {
      'claude-opus': new FakeAgentService([]),
      'codex-gpt': new FakeAgentService([]),
      'gemini-pro': new FakeAgentService([]),
      'claude-opus-relay': new FakeAgentService([]),
    },
  });
  cleanups.push(built.close);
  return built;
}

describe('relay cat is not a routable roster member (gap #4 fix)', () => {
  it('@all broadcast expands to the real roster but NOT the relay cat', async () => {
    const { router } = app();
    const { targets } = await router.resolveRouting('@all 大家好', 't1');
    const ids = targets.map((t) => t as string);
    expect(ids).not.toContain(RELAY);
    expect(ids).toContain('claude-opus'); // @all still hits the real roster
    expect(ids.length).toBeGreaterThan(0);
  });

  it('GET /api/agents does NOT list the relay cat', async () => {
    const built = app();
    const res = await built.api.inject({ method: 'GET', url: '/api/agents' });
    expect(res.statusCode).toBe(200);
    const ids = (res.json() as { agents: { id: string }[] }).agents.map((a) => a.id);
    expect(ids).not.toContain(RELAY);
    expect(ids).toContain('claude-opus'); // real roster still listed
  });

  it('no-mention fallback never picks the relay cat, even if it somehow is a participant', async () => {
    const built = app();
    await built.stores.threadStore.ensureThread('t2', 'x');
    await built.stores.threadStore.addParticipants('t2', [createAgentId(RELAY)]);

    const { targets } = await built.router.resolveRouting('继续', 't2');
    const ids = targets.map((t) => t as string);
    expect(ids).not.toContain(RELAY); // relay forced unavailable → not a routable fallback
  });
});
