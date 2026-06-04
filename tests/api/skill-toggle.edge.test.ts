// tests/api/skill-toggle.edge.test.ts — M11 per-skill on/off EDGE + ADVERSARIAL (QA).
//
// Independent QA for the now-OPERABLE skill toggle (dev wrote the happy path in
// skill-toggle.test.ts; QA author did NOT write the product code). Covers the
// three layers the toggle spans:
//   1. SkillEnablementStore — the file-backed ENABLED set (persist / fail-open).
//   2. SkillService — list ⨯ enabled, setEnabled guard, and block() assembly
//      (manifest order, separators, and the adversarial "a bad skill must not
//      break the block" skip).
//   3. routes + injection — PUT validation (400/404), GET reflection, and the
//      ADVERSARIAL operability proof: enabling a skill whose content file throws
//      must NOT inject its (absent) text yet must NOT break the turn, while a
//      co-enabled valid skill IS injected into the spawned agent's systemPrompt.
//
// Hermetic: temp enablement store + a fake manifest/content. No real ~/.choco, no
// on-disk manifest/skill files. Distribution (across this file): happy ≤50%,
// edge ≥30%, adversarial ≥20%.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { SkillDefinition, SkillManifest } from '@choco/shared';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';
import { SkillService } from '@choco/api/skills/skill-service';
import { SkillEnablementStore } from '@choco/api/skills/skill-enablement-store';
import { FakeAgentService } from '../invocation/fake-agent-service.js';
import { replyScript, CLAUDE } from './helpers.js';

// Two real skills (id + routing metadata as the manifest carries them) so the
// block() ordering / separator assertions have something to interleave.
const TDD_SKILL: SkillDefinition = {
  id: 'tdd',
  description: '测试驱动开发：先写一个失败的测试，再写最小实现让它通过。',
  triggers: ['写新功能', '修 bug', 'tdd'],
  notFor: ['纯文档改动'],
  output: '红-绿-重构的工作流 + 通过的测试',
  sopStep: 'impl',
  group: 'dev-chain',
};
const INCIDENT_SKILL: SkillDefinition = {
  id: 'incident-response',
  description: '线上故障响应：先止血、再定位、最后复盘。',
  triggers: ['线上故障', '事故', 'P0'],
  notFor: ['日常迭代'],
  output: '止血措施 + 根因 + 复盘行动项',
  sopStep: null,
  group: 'ops',
};

// Manifest insertion order is tdd → incident-response; block() must follow it.
const FAKE_MANIFEST: SkillManifest = {
  skills: { tdd: TDD_SKILL, 'incident-response': INCIDENT_SKILL },
};
const TDD_CONTENT =
  'TDD 指南：\n1. 先写一个会失败的测试（RED）。\n2. 写最小实现让它变绿（GREEN）。\n3. 在测试保护下重构（REFACTOR）。';
const INCIDENT_CONTENT =
  '故障响应手册：\n1. 立即止血（回滚 / 降级 / 限流）。\n2. 保留现场，定位根因。\n3. 事后无指责复盘，落地行动项。';

/** A content reader that THROWS for one specific id (simulates a missing/unreadable skill file). */
function makeReadContent(missingId?: string): (id: string) => string {
  return (id: string): string => {
    if (id === missingId) throw new Error(`ENOENT: no markdown for ${id}`);
    if (id === 'tdd') return TDD_CONTENT;
    if (id === 'incident-response') return INCIDENT_CONTENT;
    throw new Error(`no content for ${id}`);
  };
}

function makeService(
  dir: string,
  opts: { missingId?: string } = {},
): { service: SkillService; store: SkillEnablementStore; path: string } {
  const path = join(dir, 'skill-enabled.json');
  const store = new SkillEnablementStore(path);
  const service = new SkillService({
    store,
    loadManifestFn: () => FAKE_MANIFEST,
    readContent: makeReadContent(opts.missingId),
  });
  return { service, store, path };
}

describe('SkillEnablementStore (edge: persistence + fail-open)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'choco-skill-store-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('[edge] getEnabled returns an empty set by default (skills off until opted in)', () => {
    const store = new SkillEnablementStore(join(dir, 'skill-enabled.json'));
    expect(store.getEnabled()).toEqual(new Set());
    expect(store.isEnabled('tdd')).toBe(false);
  });

  it('[edge] setEnabled true then false round-trips the membership', () => {
    const store = new SkillEnablementStore(join(dir, 'skill-enabled.json'));

    store.setEnabled('incident-response', true);
    expect(store.isEnabled('incident-response')).toBe(true);
    expect(store.getEnabled()).toEqual(new Set(['incident-response']));

    store.setEnabled('incident-response', false);
    expect(store.isEnabled('incident-response')).toBe(false);
    expect(store.getEnabled()).toEqual(new Set());
  });

  it('[edge] double-enable is idempotent (the id appears exactly once, no duplicate)', () => {
    const path = join(dir, 'skill-enabled.json');
    const store = new SkillEnablementStore(path);

    store.setEnabled('tdd', true);
    store.setEnabled('tdd', true);

    expect(store.getEnabled()).toEqual(new Set(['tdd']));
    // The persisted set holds the id once (a Set never duplicates), proving the
    // second enable did not append a second entry.
    const persisted = JSON.parse(readFileSync(path, 'utf-8')) as { enabled: string[] };
    expect(persisted.enabled).toEqual(['tdd']);
  });

  it('[edge] state persists across two store instances over the same file', () => {
    const path = join(dir, 'skill-enabled.json');
    new SkillEnablementStore(path).setEnabled('tdd', true);

    // A fresh instance over the same path reads the persisted set.
    const reopened = new SkillEnablementStore(path);
    expect(reopened.isEnabled('tdd')).toBe(true);
    expect(reopened.getEnabled()).toEqual(new Set(['tdd']));
  });

  it('[adversarial] a missing file reads as an empty set (fail-open, never throws)', () => {
    const store = new SkillEnablementStore(join(dir, 'does-not-exist', 'skill-enabled.json'));
    expect(() => store.getEnabled()).not.toThrow();
    expect(store.getEnabled()).toEqual(new Set());
  });

  it('[adversarial] a corrupt JSON file reads as an empty set (fail-open)', () => {
    const path = join(dir, 'skill-enabled.json');
    writeFileSync(path, '{ this is not valid json …', 'utf-8');
    expect(() => new SkillEnablementStore(path).getEnabled()).not.toThrow();
    expect(new SkillEnablementStore(path).getEnabled()).toEqual(new Set());
  });

  it('[adversarial] a non-array / non-string enabled payload is filtered to an empty set', () => {
    const path = join(dir, 'skill-enabled.json');
    // enabled is the wrong shape (an object, plus a numeric member) — nothing usable.
    writeFileSync(path, JSON.stringify({ enabled: { 0: 'tdd' } }), 'utf-8');
    expect(new SkillEnablementStore(path).getEnabled()).toEqual(new Set());

    writeFileSync(path, JSON.stringify({ enabled: [123, true, null] }), 'utf-8');
    expect(new SkillEnablementStore(path).getEnabled()).toEqual(new Set());
  });
});

describe('SkillService.setEnabled (edge: manifest guard)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'choco-skill-svc-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('[adversarial] setEnabled for an unknown id returns false AND does not persist', () => {
    const { service, store, path } = makeService(dir);

    expect(service.setEnabled('not-a-real-skill', true)).toBe(false);
    // The store was never written: no enabled set, and the file is absent.
    expect(store.getEnabled()).toEqual(new Set());
    expect(() => readFileSync(path, 'utf-8')).toThrow(); // file never created
  });

  it('[edge] setEnabled for a known id returns true and the list reflects it', () => {
    const { service } = makeService(dir);
    expect(service.setEnabled('incident-response', true)).toBe(true);
    const incident = service.list().find((s) => s.id === 'incident-response');
    expect(incident?.enabled).toBe(true);
    // The co-listed skill stays off (toggling one does not toggle the other).
    expect(service.list().find((s) => s.id === 'tdd')?.enabled).toBe(false);
  });
});

describe('SkillService.block (edge + adversarial: assembly order, separators, skip)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'choco-skill-block-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('[edge] block() is empty when no skill is enabled (nothing injected)', () => {
    const { service } = makeService(dir);
    expect(service.block()).toBe('');
  });

  it('[edge] with TWO enabled skills, block() carries both in MANIFEST order with the --- separator + header', () => {
    const { service, store } = makeService(dir);
    store.setEnabled('tdd', true);
    store.setEnabled('incident-response', true);

    const block = service.block();
    // Header present once.
    expect(block).toContain('## 启用的技能（Skills）');
    expect(block.match(/## 启用的技能（Skills）/g)).toHaveLength(1);
    // Both skill bodies present, each under its `### <id>` heading.
    expect(block).toContain('### tdd');
    expect(block).toContain(TDD_CONTENT);
    expect(block).toContain('### incident-response');
    expect(block).toContain(INCIDENT_CONTENT);
    // Manifest order: tdd (inserted first) precedes incident-response.
    expect(block.indexOf('### tdd')).toBeLessThan(block.indexOf('### incident-response'));
    // Exactly one --- separator joins the two parts.
    expect(block.match(/\n---\n/g)).toHaveLength(1);
  });

  it('[edge] block() follows manifest order even when the SECOND-listed skill is enabled alone', () => {
    const { service, store } = makeService(dir);
    store.setEnabled('incident-response', true);

    const block = service.block();
    expect(block).toContain('### incident-response');
    expect(block).toContain(INCIDENT_CONTENT);
    // The disabled first-listed skill must NOT leak in.
    expect(block).not.toContain('### tdd');
    expect(block).not.toContain(TDD_CONTENT);
    // A single enabled skill needs no separator.
    expect(block).not.toContain('\n---\n');
  });

  it('[adversarial] a skill whose readContent THROWS is SKIPPED but a co-enabled good skill still appears', () => {
    // tdd's content reader throws (its markdown is missing/unreadable).
    const { service, store } = makeService(dir, { missingId: 'tdd' });
    store.setEnabled('tdd', true);
    store.setEnabled('incident-response', true);

    const block = service.block();
    // The good skill survives the bad one — a broken skill never breaks the block.
    expect(block).toContain('### incident-response');
    expect(block).toContain(INCIDENT_CONTENT);
    // The throwing skill contributes nothing (no heading, no body).
    expect(block).not.toContain('### tdd');
    expect(block).not.toContain(TDD_CONTENT);
    // Only the surviving part remains → no dangling separator between parts.
    expect(block).not.toContain('\n---\n');
  });

  it('[adversarial] when the ONLY enabled skill throws, block() degrades to empty (never partial)', () => {
    const { service, store } = makeService(dir, { missingId: 'incident-response' });
    store.setEnabled('incident-response', true);
    expect(() => service.block()).not.toThrow();
    expect(service.block()).toBe('');
  });
});

describe('/api/skills routes (edge: validation) + skill injection (adversarial)', () => {
  let dir: string;
  let app: BuiltApp;
  let fakeClaude: FakeAgentService;

  function buildWith(opts: { missingId?: string } = {}): SkillEnablementStore {
    const { service, store } = makeService(dir, opts);
    fakeClaude = new FakeAgentService([
      replyScript(CLAUDE, '好的，我先从一个失败的测试开始。'),
      replyScript(CLAUDE, '收到，开始处理。'),
    ]);
    app = buildApp({
      db: new Database(':memory:'),
      agentServices: { 'claude-opus': fakeClaude },
      skillService: service,
    });
    return store;
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'choco-skill-routes-'));
  });
  afterEach(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('[edge] PUT with a non-boolean enabled ({enabled:"yes"}) → 400 invalid_params', async () => {
    buildWith();
    const res = await app.api.inject({
      method: 'PUT',
      url: '/api/skills/tdd/enabled',
      payload: { enabled: 'yes' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_params' });
  });

  it('[edge] PUT with an empty body ({}) → 400 invalid_params', async () => {
    buildWith();
    const res = await app.api.inject({ method: 'PUT', url: '/api/skills/tdd/enabled', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_params' });
  });

  it('[adversarial] PUT for an unknown id (valid body) → 404 skill_not_found', async () => {
    buildWith();
    const res = await app.api.inject({
      method: 'PUT',
      url: '/api/skills/ghost-skill/enabled',
      payload: { enabled: true },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'skill_not_found' });
  });

  it('[edge] GET reflects a PUT toggle, and sync includes each skill enabled state', async () => {
    buildWith();
    // Enable incident-response via the route.
    const put = await app.api.inject({
      method: 'PUT',
      url: '/api/skills/incident-response/enabled',
      payload: { enabled: true },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toEqual({ id: 'incident-response', enabled: true });

    const list = await app.api.inject({ method: 'GET', url: '/api/skills' });
    const skills = list.json().skills as { id: string; enabled: boolean }[];
    expect(skills.find((s) => s.id === 'incident-response')?.enabled).toBe(true);
    expect(skills.find((s) => s.id === 'tdd')?.enabled).toBe(false);

    // sync re-lists with the same enabled state attached.
    const sync = await app.api.inject({ method: 'POST', url: '/api/skills/sync' });
    const synced = sync.json().skills as { id: string; enabled: boolean }[];
    expect(synced.find((s) => s.id === 'incident-response')?.enabled).toBe(true);
    expect(synced.every((s) => typeof s.enabled === 'boolean')).toBe(true);
  });

  it('[adversarial] enabling a skill whose content file THROWS still completes the turn AND injects nothing for it, while a co-enabled valid skill IS injected', async () => {
    // tdd's markdown is unreadable; incident-response is fine. Both enabled.
    const store = buildWith({ missingId: 'tdd' });
    store.setEnabled('tdd', true);
    store.setEnabled('incident-response', true);

    // The turn must SUCCEED despite the broken skill (a bad skill never breaks an invocation).
    const turn = await app.api.inject({
      method: 'POST',
      url: '/api/threads/t-adv/messages',
      payload: { content: '@claude 线上出事故了，怎么办' },
    });
    expect(turn.statusCode).toBe(200);

    const injected = fakeClaude.calls[0]?.options?.systemPrompt ?? '';
    // The valid skill's guidance reached the agent…
    expect(injected).toContain(INCIDENT_CONTENT);
    // …but the broken skill contributed NOTHING (its absent text is not smuggled in).
    expect(injected).not.toContain(TDD_CONTENT);
  });
});
