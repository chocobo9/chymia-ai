// tests/api/skill-toggle.test.ts — M11 per-skill on/off dev happy-path.
//
// The toggle is OPERABLE, not cosmetic: enabling a skill injects its markdown into
// the agent's system prompt; disabling removes it. Covers the SkillService (list /
// toggle / block), the routes, and the OPERABILITY proof (an enabled skill's text
// reaches the spawned agent's systemPrompt). Hermetic: temp enablement store + a
// fake manifest/content (no real ~/.choco, no on-disk manifest). Edge → QA.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { SkillDefinition, SkillManifest } from '@choco/shared';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';
import { SkillService } from '@choco/api/skills/skill-service';
import { SkillEnablementStore } from '@choco/api/skills/skill-enablement-store';
import { FakeAgentService } from '../invocation/fake-agent-service.js';
import { replyScript, CLAUDE } from './helpers.js';

const TDD_SKILL: SkillDefinition = {
  id: 'tdd',
  description: '测试驱动开发',
  triggers: ['测试', 'tdd'],
  notFor: [],
  output: '红-绿-重构的工作流',
  group: 'dev-chain',
};
const FAKE_MANIFEST: SkillManifest = { skills: { tdd: TDD_SKILL } };
const TDD_CONTENT = 'TDD 指南：先写一个失败的测试，再写最小实现让它通过。';

function makeService(dir: string): { service: SkillService; store: SkillEnablementStore } {
  const store = new SkillEnablementStore(join(dir, 'skill-enabled.json'));
  const service = new SkillService({
    store,
    loadManifestFn: () => FAKE_MANIFEST,
    readContent: (id) => {
      if (id === 'tdd') return TDD_CONTENT;
      throw new Error(`no content for ${id}`);
    },
  });
  return { service, store };
}

describe('SkillService (dev happy path)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'choco-skill-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('lists with enabled state, toggles, and builds the prompt block only for enabled skills', () => {
    const { service } = makeService(dir);

    expect(service.list()).toEqual([{ ...TDD_SKILL, enabled: false }]);
    expect(service.block()).toBe(''); // default off → nothing injected

    expect(service.setEnabled('tdd', true)).toBe(true);
    expect(service.list()[0]!.enabled).toBe(true);
    const block = service.block();
    expect(block).toContain('启用的技能');
    expect(block).toContain(TDD_CONTENT);

    expect(service.setEnabled('tdd', false)).toBe(true);
    expect(service.block()).toBe('');

    expect(service.setEnabled('does-not-exist', true)).toBe(false); // not in manifest
  });
});

describe('OPERABILITY: an enabled skill reaches the agent system prompt (dev happy path)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'choco-skill-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('injects the enabled skill into the spawned agent prompt; omits it when off', async () => {
    const { service, store } = makeService(dir);
    const fakeClaude = new FakeAgentService([replyScript(CLAUDE, '好的。'), replyScript(CLAUDE, '收到。')]);
    const db = new Database(':memory:');
    const app: BuiltApp = buildApp({ db, agentServices: { 'claude-opus': fakeClaude }, skillService: service });

    // Off by default → the skill text is NOT in the system prompt.
    await app.api.inject({ method: 'POST', url: '/api/threads/t1/messages', payload: { content: '@claude 在吗' } });
    expect(fakeClaude.calls[0]?.options?.systemPrompt ?? '').not.toContain(TDD_CONTENT);

    // Enable it → the NEXT turn's system prompt carries the skill guidance.
    store.setEnabled('tdd', true);
    await app.api.inject({ method: 'POST', url: '/api/threads/t1/messages', payload: { content: '@claude 写个函数' } });
    expect(fakeClaude.calls[1]?.options?.systemPrompt ?? '').toContain(TDD_CONTENT);

    await app.close();
  });
});

describe('/api/skills routes (dev happy path)', () => {
  let dir: string;
  let app: BuiltApp;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'choco-skill-'));
    const { service } = makeService(dir);
    app = buildApp({ db: new Database(':memory:'), agentServices: { 'claude-opus': new FakeAgentService([]) }, skillService: service });
  });
  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('GET lists with enabled; PUT toggles; unknown id → 404; bad body → 400', async () => {
    const list = await app.api.inject({ method: 'GET', url: '/api/skills' });
    expect(list.json().skills).toEqual([{ ...TDD_SKILL, enabled: false }]);

    const on = await app.api.inject({ method: 'PUT', url: '/api/skills/tdd/enabled', payload: { enabled: true } });
    expect(on.statusCode).toBe(200);
    const after = await app.api.inject({ method: 'GET', url: '/api/skills' });
    expect(after.json().skills[0].enabled).toBe(true);

    const missing = await app.api.inject({ method: 'PUT', url: '/api/skills/nope/enabled', payload: { enabled: true } });
    expect(missing.statusCode).toBe(404);

    const bad = await app.api.inject({ method: 'PUT', url: '/api/skills/tdd/enabled', payload: { enabled: 'yes' } });
    expect(bad.statusCode).toBe(400);
  });
});
