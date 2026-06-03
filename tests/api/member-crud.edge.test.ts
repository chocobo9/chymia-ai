// 成员增删 (member add/delete) — backend gate. Ported from Clowder's runtime cat
// catalog (createRuntimeCat / deleteRuntimeCat): a persisted runtime roster layered
// over agents.yaml, hot-registered so a new member is immediately routable.
//
// Gates: the runtime-roster store (schema/normalize/persist/fail-open), and the
// POST/DELETE /api/agents routes (create → routable, id/mention clash → 409, base
// member protected, unknown → 404). dev=QA NOTE: authored in the same interactive
// session as the product code (not the §0.5.3 hand-off split) — called out honestly.
//
// Distribution: happy ≤50%, edge ≥30%, adversarial ≥20%. Real ids/identities only.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { AgentService } from '@choco/api/providers/base';
import {
  NewMemberSchema,
  newMemberToConfig,
  JsonRuntimeRosterStore,
} from '@choco/api/config/runtime-roster';
import { buildApp } from '@choco/api/app-factory';
import { FakeAgentService } from '../invocation/fake-agent-service.js';
import { replyScript, CLAUDE } from './helpers.js';

/** A realistic new-member payload: a second Claude identity — the security reviewer. */
function reviewerInput(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'claude-review',
    name: '审查布偶',
    displayName: 'Claude (Reviewer)',
    clientId: 'anthropic',
    defaultModel: 'claude-opus-4-6',
    mentionPatterns: ['@review', '@审查'],
    roleDescription: '安全审查员 · 把关测试覆盖与威胁建模。',
    personality: '保守、对边界条件敏感，先证伪再放行。',
    strengths: ['威胁建模', '测试设计'],
    color: { primary: '#dc2626', secondary: '#f87171' },
    ...over,
  };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function tempRosterPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'choco-roster-')), 'runtime-agents.json');
}

/** Build an app whose new members spawn a recorded fake (so we can assert routing). */
function buildWithRoster(rosterPath: string): {
  app: ReturnType<typeof buildApp>;
  memberFakes: Map<string, FakeAgentService>;
} {
  const memberFakes = new Map<string, FakeAgentService>();
  const app = buildApp({
    db: new Database(':memory:'),
    agentServices: { 'claude-opus': new FakeAgentService([replyScript(CLAUDE, '收到。')]) },
    runtimeRoster: new JsonRuntimeRosterStore(rosterPath),
    buildMemberService: (config): AgentService => {
      const fake = new FakeAgentService([replyScript(config.id, '审查员已上线，开始把关。')]);
      memberFakes.set(config.id as string, fake);
      return fake;
    },
  });
  cleanups.push(app.close);
  return { app, memberFakes };
}

describe('runtime-roster store + schema (unit)', () => {
  it('newMemberToConfig normalizes mentions (@-prefixes + dedups), preserving identity', () => {
    const parsed = NewMemberSchema.parse(reviewerInput({ mentionPatterns: ['review', '@review', '审查'] }));
    const config = newMemberToConfig(parsed);
    expect(config.mentionPatterns).toEqual(['@review', '@审查']); // @-prefixed, deduped
    expect(config.clientId).toBe('anthropic');
    expect(config.roleDescription).toContain('安全审查员');
  });

  it('[edge] the schema rejects an empty mention list and a non-slug id', () => {
    expect(NewMemberSchema.safeParse(reviewerInput({ mentionPatterns: [] })).success).toBe(false);
    expect(NewMemberSchema.safeParse(reviewerInput({ id: 'Claude Review!' })).success).toBe(false);
  });

  it('[edge] JsonRuntimeRosterStore persists adds/removes and reloads from disk', () => {
    const path = tempRosterPath();
    const store = new JsonRuntimeRosterStore(path);
    store.add(newMemberToConfig(NewMemberSchema.parse(reviewerInput())));
    expect(store.has('claude-review')).toBe(true);

    const reloaded = new JsonRuntimeRosterStore(path); // fresh instance reads the file
    expect(reloaded.all().map((c) => c.id as string)).toEqual(['claude-review']);
    expect(reloaded.remove('claude-review')).toBe(true);
    expect(new JsonRuntimeRosterStore(path).all()).toHaveLength(0);
  });

  it('[adv] a malformed roster file is fail-open (empty roster, never throws at boot)', () => {
    const path = tempRosterPath();
    writeFileSync(path, '{ this is not json', 'utf8');
    expect(new JsonRuntimeRosterStore(path).all()).toEqual([]);
  });
});

describe('POST/DELETE /api/agents — 成员增删 routes', () => {
  it('POST adds a member that appears in GET (removable) and is HOT-ROUTABLE', async () => {
    const { app, memberFakes } = buildWithRoster(tempRosterPath());

    const created = await app.api.inject({ method: 'POST', url: '/api/agents', payload: reviewerInput() });
    expect(created.statusCode).toBe(201);
    expect(created.json<{ agent: { id: string; removable: boolean } }>().agent).toMatchObject({
      id: 'claude-review',
      removable: true,
    });

    // GET reflects it; base claude is NOT removable.
    const list = await app.api.inject({ method: 'GET', url: '/api/agents' });
    const agents = list.json<{ agents: { id: string; removable?: boolean }[] }>().agents;
    expect(agents.find((a) => a.id === 'claude-review')?.removable).toBe(true);
    expect(agents.find((a) => a.id === 'claude-opus')?.removable).toBe(false);

    // Routing to its @mention invokes the new member — no restart.
    const turn = await app.api.inject({
      method: 'POST',
      url: '/api/threads/thread-review/messages',
      payload: { content: '@review 帮我把关这个改动' },
    });
    expect(turn.statusCode).toBe(200);
    expect(memberFakes.get('claude-review')?.calls.length ?? 0).toBe(1);
  });

  it('DELETE removes a runtime-added member (gone from GET)', async () => {
    const { app } = buildWithRoster(tempRosterPath());
    await app.api.inject({ method: 'POST', url: '/api/agents', payload: reviewerInput() });

    const del = await app.api.inject({ method: 'DELETE', url: '/api/agents/claude-review' });
    expect(del.statusCode).toBe(200);
    const list = await app.api.inject({ method: 'GET', url: '/api/agents' });
    expect(list.json<{ agents: { id: string }[] }>().agents.some((a) => a.id === 'claude-review')).toBe(false);
  });

  it('[edge] POST with a duplicate id → 409 id_taken', async () => {
    const { app } = buildWithRoster(tempRosterPath());
    const res = await app.api.inject({ method: 'POST', url: '/api/agents', payload: reviewerInput({ id: 'claude-opus' }) });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe('id_taken');
  });

  it('[edge] POST whose @mention collides with an existing member → 409 mention_taken', async () => {
    const { app } = buildWithRoster(tempRosterPath());
    // @claude already belongs to the base claude-opus.
    const res = await app.api.inject({ method: 'POST', url: '/api/agents', payload: reviewerInput({ mentionPatterns: ['@claude'] }) });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe('mention_taken');
  });

  it('[edge] POST with an invalid body (no mentions) → 400', async () => {
    const { app } = buildWithRoster(tempRosterPath());
    const res = await app.api.inject({ method: 'POST', url: '/api/agents', payload: reviewerInput({ mentionPatterns: [] }) });
    expect(res.statusCode).toBe(400);
  });

  it('[adv] DELETE a BASE (agents.yaml) member is rejected → 409 base_member_protected', async () => {
    const { app } = buildWithRoster(tempRosterPath());
    const res = await app.api.inject({ method: 'DELETE', url: '/api/agents/claude-opus' });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: string }>().error).toBe('base_member_protected');
  });

  it('[adv] DELETE an unknown id → 404 (not a silent success)', async () => {
    const { app } = buildWithRoster(tempRosterPath());
    const res = await app.api.inject({ method: 'DELETE', url: '/api/agents/ghost-agent' });
    expect(res.statusCode).toBe(404);
  });
});
