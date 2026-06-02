// M-MEMBER QA GATING suite (backend) — edge + adversarial coverage.
//
// dev≠QA (CLAUDE.md §0.5.3): authored by a DIFFERENT instance than the one that
// wrote packages/api/src/config/agent-overrides.ts + the PATCH route. NO product
// code is modified here — only tests. The dev's happy-path suite lives in
// agent-overrides.test.ts; this file adds the EDGE + ADVERSARIAL gate.
//
// What it gates:
//   • applyAgentOverride — undefined/empty/partial merges, immutability, and the
//     fact that NON-editable routing fields can never enter through the overlay
//     (the schema's .strict() rejects them).
//   • JsonAgentOverrideStore — fail-open on missing/malformed/wrong-shape files,
//     field-wise accumulation across sets, fresh-store reload, per-agent isolation.
//   • PATCH /api/agents/:id — 404 / 400 surfaces, GET reflection scoped to ONE
//     agent, the edited role reaching the NEXT turn's system prompt (the behavioral
//     guarantee), and overrides NOT bleeding into @mention routing.
//
// Distribution (gating mandate happy ≤50% / edge ≥30% / adv ≥20%): each `it` is
// tagged [edge] or [adv] in its title. This file is intentionally all edge/adv —
// the dev file carries the happy path.
//
// Real inputs only: real agent ids (claude-opus / codex-gpt / gemini-pro), real
// role/personality/strengths text (e.g. "审查员 · 安全与测试") — never foo/test123.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import Database from 'better-sqlite3';
import { createAgentId } from '@choco/shared';
import type { AgentConfig } from '@choco/shared';
import {
  applyAgentOverride,
  AgentOverrideSchema,
  JsonAgentOverrideStore,
  type AgentOverride,
} from '@choco/api/config/agent-overrides';
import { buildApp } from '@choco/api/app-factory';
import { FakeAgentService } from '../invocation/fake-agent-service.js';
import { replyScript, CLAUDE } from './helpers.js';

/** A realistic base AgentConfig (mirrors the claude-opus agents.yaml entry). */
function baseConfig(): AgentConfig {
  return {
    id: createAgentId('claude-opus'),
    name: '布偶猫',
    displayName: 'Claude (Opus)',
    clientId: 'anthropic',
    defaultModel: 'claude-opus-4-6',
    mcpSupport: true,
    mentionPatterns: ['@claude', '@布偶', '@宪宪'],
    personality: '沉稳、系统化、注重长期可维护性；先想清楚再动手。',
    roleDescription: '首席架构师 / 核心开发，负责系统设计与代码实现。',
    strengths: ['架构设计', '代码实现', '重构'],
    restrictions: ['不做未经评审的破坏性数据操作'],
    color: { primary: '#6366f1', secondary: '#818cf8' },
  };
}

/** Make a fresh temp file path under a unique dir (no path collisions across tests). */
function tempOverridePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'choco-overrides-edge-'));
  return join(dir, 'agent-overrides.json');
}

/* ============================================================================
 * 1. applyAgentOverride — merge semantics, immutability, routing-field firewall.
 * ========================================================================== */
describe('applyAgentOverride (edge / adversarial)', () => {
  it('[edge] an empty-object override returns a base-equivalent config (no field changed)', () => {
    const base = baseConfig();
    const result = applyAgentOverride(base, {});
    // An empty override carries nothing to layer, so every field equals the base.
    expect(result).toEqual(base);
    // It is a NEW object (an override WAS present, so the spread branch ran), but
    // the base was not mutated.
    expect(result).not.toBe(base);
    expect(base.roleDescription).toBe('首席架构师 / 核心开发，负责系统设计与代码实现。');
  });

  it('[edge] a partial override (only strengths) leaves every other field at the base value', () => {
    const base = baseConfig();
    const result = applyAgentOverride(base, { strengths: ['安全审查', '渗透测试'] });

    expect(result.strengths).toEqual(['安全审查', '渗透测试']);
    // Untouched fields carry through verbatim.
    expect(result.roleDescription).toBe(base.roleDescription);
    expect(result.personality).toBe(base.personality);
    expect(result.displayName).toBe(base.displayName);
    expect(result.name).toBe(base.name);
    expect(result.color).toEqual(base.color);
    expect(result.restrictions).toEqual(base.restrictions);
  });

  it('[edge] does not mutate the base when a full override is applied (immutability)', () => {
    const base = baseConfig();
    const before = JSON.parse(JSON.stringify(base)) as AgentConfig;
    const override: AgentOverride = {
      displayName: 'Claude (Reviewer)',
      name: '审查布偶',
      roleDescription: '审查员 · 安全与测试，负责把关测试覆盖与威胁建模。',
      personality: '保守、对边界条件敏感，先证伪再放行。',
      strengths: ['威胁建模', '测试设计'],
      restrictions: ['不放行未达 80% 覆盖的改动'],
      color: { primary: '#dc2626', secondary: '#f87171' },
    };

    const result = applyAgentOverride(base, override);

    // Result reflects every overridden field…
    expect(result.roleDescription).toBe(override.roleDescription);
    expect(result.color).toEqual(override.color);
    // …while the base object is byte-for-byte unchanged.
    expect(base).toEqual(before);
    expect(result).not.toBe(base);
  });

  it('[adv] the overlay can NEVER carry a routing field — .strict() rejects clientId / defaultModel / mcpSupport / mentionPatterns', () => {
    // These are the four DELIBERATELY non-editable routing/spawn fields. The
    // overlay schema must refuse each so an operator can never desync routing by
    // smuggling one through a PATCH body.
    for (const smuggled of [
      { clientId: 'openai' },
      { defaultModel: 'gpt-4.1' },
      { mcpSupport: false },
      { mentionPatterns: ['@claude'] },
      { id: 'codex-gpt' },
    ]) {
      const parsed = AgentOverrideSchema.safeParse({
        roleDescription: '审查员 · 安全与测试',
        ...smuggled,
      });
      expect(parsed.success).toBe(false);
    }
  });

  it('[adv] applyAgentOverride never introduces a routing field even if one sneaks past typing', () => {
    // Defense in depth: even a cast-through object carrying clientId must not
    // change the base clientId — applyAgentOverride only copies the known
    // editable keys, so the base routing identity is preserved.
    const base = baseConfig();
    const sneaky = { roleDescription: '审查员 · 安全与测试', clientId: 'openai' } as AgentOverride;
    const result = applyAgentOverride(base, sneaky);
    expect(result.clientId).toBe('anthropic');
    expect(result.defaultModel).toBe('claude-opus-4-6');
    expect(result.mcpSupport).toBe(true);
    expect(result.mentionPatterns).toEqual(['@claude', '@布偶', '@宪宪']);
  });
});

/* ============================================================================
 * 2. AgentOverrideSchema — body validation surface (drives the PATCH 400 path).
 * ========================================================================== */
describe('AgentOverrideSchema (edge / adversarial)', () => {
  it('[edge] rejects strengths that is not an array', () => {
    const parsed = AgentOverrideSchema.safeParse({ strengths: '安全审查' });
    expect(parsed.success).toBe(false);
  });

  it('[edge] rejects an empty-string field (min(1) on each editable string)', () => {
    expect(AgentOverrideSchema.safeParse({ displayName: '' }).success).toBe(false);
    expect(AgentOverrideSchema.safeParse({ roleDescription: '' }).success).toBe(false);
    expect(AgentOverrideSchema.safeParse({ name: '' }).success).toBe(false);
  });

  it('[edge] rejects a strengths array that contains an empty string element', () => {
    const parsed = AgentOverrideSchema.safeParse({ strengths: ['安全审查', ''] });
    expect(parsed.success).toBe(false);
  });

  it('[adv] rejects a color missing secondary (both members required when color is edited)', () => {
    const parsed = AgentOverrideSchema.safeParse({ color: { primary: '#dc2626' } });
    expect(parsed.success).toBe(false);
  });

  it('[adv] rejects an unknown extra key (.strict)', () => {
    const parsed = AgentOverrideSchema.safeParse({
      roleDescription: '审查员 · 安全与测试',
      nickname: '小审',
    });
    expect(parsed.success).toBe(false);
  });

  it('[adv] accepts a very long role string (no upper bound — operator prose can be long)', () => {
    const longRole = '审查员 · 安全与测试，'.repeat(500);
    const parsed = AgentOverrideSchema.safeParse({ roleDescription: longRole });
    expect(parsed.success).toBe(true);
  });
});

/* ============================================================================
 * 3. JsonAgentOverrideStore — fail-open load, accumulation, reload, isolation.
 * ========================================================================== */
describe('JsonAgentOverrideStore (edge / adversarial)', () => {
  it('[edge] a missing file yields an empty overlay (no throw at construct)', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'choco-overrides-missing-')), 'does-not-exist.json');
    const store = new JsonAgentOverrideStore(path);
    expect(store.all()).toEqual({});
    expect(store.get('claude-opus')).toBeUndefined();
  });

  it('[adv] a MALFORMED json file fails open to an empty overlay (a corrupt file must not stop the API)', () => {
    const path = tempOverridePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{ this is : not valid json,,', 'utf8');
    expect(() => new JsonAgentOverrideStore(path)).not.toThrow();
    expect(new JsonAgentOverrideStore(path).all()).toEqual({});
  });

  it('[adv] a WRONG-SHAPE json file (schema-invalid) fails open to an empty overlay', () => {
    const path = tempOverridePath();
    mkdirSync(dirname(path), { recursive: true });
    // Valid JSON, but the override for claude-opus carries a forbidden field +
    // a wrong-typed strengths — the OverrideMapSchema.parse must reject it whole.
    writeFileSync(
      path,
      JSON.stringify({ 'claude-opus': { strengths: '不是数组', clientId: 'openai' } }),
      'utf8',
    );
    const store = new JsonAgentOverrideStore(path);
    expect(store.all()).toEqual({});
  });

  it('[edge] two partial sets on the SAME id accumulate field-wise (the second does not drop the first)', () => {
    const store = new JsonAgentOverrideStore(tempOverridePath());
    store.set('codex-gpt', { roleDescription: '实现型开发，负责把设计落到可运行代码。' });
    store.set('codex-gpt', { strengths: ['快速实现', '并发安全', '调试'] });

    expect(store.get('codex-gpt')).toEqual({
      roleDescription: '实现型开发，负责把设计落到可运行代码。',
      strengths: ['快速实现', '并发安全', '调试'],
    });
  });

  it('[edge] a second set OVERWRITES the same field but preserves the others', () => {
    const store = new JsonAgentOverrideStore(tempOverridePath());
    store.set('gemini-pro', {
      roleDescription: '研究与评审，多方案对比。',
      personality: '发散、好奇。',
    });
    store.set('gemini-pro', { roleDescription: '研究与评审，新增安全威胁面分析。' });

    expect(store.get('gemini-pro')).toEqual({
      roleDescription: '研究与评审，新增安全威胁面分析。',
      personality: '发散、好奇。',
    });
  });

  it('[edge] a fresh store on the same path LOADS the persisted edits (survives a restart)', () => {
    const path = tempOverridePath();
    const writer = new JsonAgentOverrideStore(path);
    writer.set('claude-opus', {
      displayName: 'Claude (Reviewer)',
      roleDescription: '审查员 · 安全与测试。',
    });

    const reader = new JsonAgentOverrideStore(path);
    expect(reader.get('claude-opus')).toEqual({
      displayName: 'Claude (Reviewer)',
      roleDescription: '审查员 · 安全与测试。',
    });
  });

  it('[adv] setting one agent leaves an unrelated agent untouched (per-agent isolation)', () => {
    const store = new JsonAgentOverrideStore(tempOverridePath());
    store.set('claude-opus', { roleDescription: '首席架构师，负责系统设计。' });
    store.set('gemini-pro', { roleDescription: '研究与评审。' });
    // Mutating codex never happened → codex stays undefined; the other two are intact.
    expect(store.get('codex-gpt')).toBeUndefined();
    expect(store.get('claude-opus')).toEqual({ roleDescription: '首席架构师，负责系统设计。' });
    expect(store.get('gemini-pro')).toEqual({ roleDescription: '研究与评审。' });
  });

  it('[adv] all() returns a COPY — mutating it cannot corrupt the held overlay map', () => {
    const store = new JsonAgentOverrideStore(tempOverridePath());
    store.set('claude-opus', { roleDescription: '首席架构师。' });
    const snapshot = store.all();
    // Tamper with the returned map…
    delete snapshot['claude-opus'];
    (snapshot as Record<string, AgentOverride>)['codex-gpt'] = { name: '注入' };
    // …the store's own state is unaffected.
    expect(store.get('claude-opus')).toEqual({ roleDescription: '首席架构师。' });
    expect(store.get('codex-gpt')).toBeUndefined();
  });

  it('[edge] persisted file is valid JSON that re-parses to the accumulated overlay', () => {
    const path = tempOverridePath();
    const store = new JsonAgentOverrideStore(path);
    store.set('claude-opus', { roleDescription: '审查员 · 安全与测试。' });
    store.set('claude-opus', { strengths: ['威胁建模', '测试设计'] });
    const onDisk = JSON.parse(readFileSync(path, 'utf8')) as Record<string, AgentOverride>;
    expect(onDisk['claude-opus']).toEqual({
      roleDescription: '审查员 · 安全与测试。',
      strengths: ['威胁建模', '测试设计'],
    });
  });
});

/* ============================================================================
 * 4. PATCH /api/agents/:id — route surfaces + the next-turn behavioral guarantee.
 * ========================================================================== */
describe('PATCH /api/agents/:id (edge / adversarial)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
  });

  /** Build an app with a persisted overlay store + a Fake claude provider. */
  function buildWithOverlay(script: ReturnType<typeof replyScript>): {
    app: ReturnType<typeof buildApp>;
    fake: FakeAgentService;
  } {
    const store = new JsonAgentOverrideStore(tempOverridePath());
    const fake = new FakeAgentService([script]);
    const app = buildApp({
      db: new Database(':memory:'),
      agentServices: { 'claude-opus': fake },
      agentOverrideStore: store,
    });
    cleanups.push(app.close);
    return { app, fake };
  }

  it('[edge] 404 for an unknown agent id', async () => {
    const { app } = buildWithOverlay(replyScript(CLAUDE, '收到。'));
    const res = await app.api.inject({
      method: 'PATCH',
      url: '/api/agents/nonexistent-agent',
      payload: { roleDescription: '审查员 · 安全与测试。' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json<{ error: string }>().error).toBe('agent_not_found');
  });

  it('[edge] 400 (invalid_body) when strengths is not an array', async () => {
    const { app } = buildWithOverlay(replyScript(CLAUDE, '收到。'));
    const res = await app.api.inject({
      method: 'PATCH',
      url: '/api/agents/claude-opus',
      payload: { strengths: '安全审查' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('invalid_body');
  });

  it('[edge] 400 (invalid_body) for an empty-string field', async () => {
    const { app } = buildWithOverlay(replyScript(CLAUDE, '收到。'));
    const res = await app.api.inject({
      method: 'PATCH',
      url: '/api/agents/claude-opus',
      payload: { displayName: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('invalid_body');
  });

  it('[adv] 400 (invalid_body) for an UNKNOWN field (.strict rejects it)', async () => {
    const { app } = buildWithOverlay(replyScript(CLAUDE, '收到。'));
    const res = await app.api.inject({
      method: 'PATCH',
      url: '/api/agents/claude-opus',
      payload: { roleDescription: '审查员 · 安全与测试。', nickname: '小审' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('invalid_body');
  });

  it('[adv] 400 (invalid_body) for a color missing secondary', async () => {
    const { app } = buildWithOverlay(replyScript(CLAUDE, '收到。'));
    const res = await app.api.inject({
      method: 'PATCH',
      url: '/api/agents/claude-opus',
      payload: { color: { primary: '#dc2626' } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('invalid_body');
  });

  it('[adv] a smuggled routing field (clientId) is rejected 400 — the overlay cannot desync routing', async () => {
    const { app } = buildWithOverlay(replyScript(CLAUDE, '收到。'));
    const res = await app.api.inject({
      method: 'PATCH',
      url: '/api/agents/claude-opus',
      payload: { displayName: 'Claude (Reviewer)', clientId: 'openai' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('invalid_body');
  });

  it('[adv] an empty-object PATCH {} is accepted as a 200 no-op and does not crash', async () => {
    const { app } = buildWithOverlay(replyScript(CLAUDE, '收到。'));
    const res = await app.api.inject({
      method: 'PATCH',
      url: '/api/agents/claude-opus',
      payload: {},
    });
    // The schema is fully-optional .partial(), so {} is valid → 200, returning the
    // unchanged merged entry (a defined, sane no-op rather than a crash or 400).
    expect(res.statusCode).toBe(200);
    const body = res.json<{ agent: { id: string; displayName: string } }>();
    expect(body.agent.id).toBe('claude-opus');
    expect(body.agent.displayName).toBe('Claude (Opus)');
  });

  it('[adv] a very long role string is accepted and reaches the next turn system prompt', async () => {
    const longRole = '审查员 · 安全与测试，负责把关测试覆盖与威胁建模；'.repeat(200);
    const { app, fake } = buildWithOverlay(replyScript(CLAUDE, '收到，开始审查。'));

    const patched = await app.api.inject({
      method: 'PATCH',
      url: '/api/agents/claude-opus',
      payload: { roleDescription: longRole },
    });
    expect(patched.statusCode).toBe(200);

    const turn = await app.api.inject({
      method: 'POST',
      url: '/api/threads/thread-long-role/messages',
      payload: { content: '@claude 审查这个改动' },
    });
    expect(turn.statusCode).toBe(200);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.options?.systemPrompt ?? '').toContain(longRole);
  });

  it('[edge] after a valid PATCH, GET /api/agents reflects the new field for ONLY that agent', async () => {
    const { app } = buildWithOverlay(replyScript(CLAUDE, '收到。'));

    const patched = await app.api.inject({
      method: 'PATCH',
      url: '/api/agents/claude-opus',
      payload: { displayName: 'Claude (Reviewer)', strengths: ['威胁建模', '测试设计'] },
    });
    expect(patched.statusCode).toBe(200);

    const listed = await app.api.inject({ method: 'GET', url: '/api/agents' });
    const agents = listed.json<{
      agents: Array<{ id: string; displayName: string; strengths: string[] }>;
    }>().agents;

    const claude = agents.find((a) => a.id === 'claude-opus');
    expect(claude?.displayName).toBe('Claude (Reviewer)');
    expect(claude?.strengths).toEqual(['威胁建模', '测试设计']);

    // The OTHER agents are untouched (overlay scoped to claude-opus only).
    const codex = agents.find((a) => a.id === 'codex-gpt');
    const gemini = agents.find((a) => a.id === 'gemini-pro');
    expect(codex?.displayName).toBe('Codex (GPT)');
    expect(codex?.strengths).toEqual(['快速实现', '脚本化', '调试']);
    expect(gemini?.displayName).toBe('Gemini (Pro)');
  });

  it('[adv] the edited roleDescription actually reaches the NEXT turn system prompt (THE behavioral guarantee)', async () => {
    const { app, fake } = buildWithOverlay(replyScript(CLAUDE, '收到，开始安全审查。'));

    // Edit claude-opus to a security-reviewer role.
    const patched = await app.api.inject({
      method: 'PATCH',
      url: '/api/agents/claude-opus',
      payload: {
        roleDescription: '审查员 · 安全与测试，负责威胁建模与测试覆盖把关。',
        strengths: ['威胁建模', '测试设计'],
      },
    });
    expect(patched.statusCode).toBe(200);

    // Drive a real turn AFTER the edit and inspect the system prompt the provider
    // was invoked with — the wrapped resolveConfig must have layered the overlay.
    const turn = await app.api.inject({
      method: 'POST',
      url: '/api/threads/thread-role-edit/messages',
      payload: { content: '@claude 审查这次提交的测试覆盖' },
    });
    expect(turn.statusCode).toBe(200);
    expect(fake.calls).toHaveLength(1);

    const systemPrompt = fake.calls[0]?.options?.systemPrompt ?? '';
    expect(systemPrompt).toContain('审查员 · 安全与测试，负责威胁建模与测试覆盖把关。');
    expect(systemPrompt).toContain('威胁建模');
    // The ORIGINAL role text is gone (it was replaced, not appended).
    expect(systemPrompt).not.toContain('首席架构师 / 核心开发，负责系统设计与代码实现。');
  });

  it('[adv] a renamed displayName does NOT break @mention routing — the original handle still resolves', async () => {
    const { app, fake } = buildWithOverlay(replyScript(CLAUDE, '收到。'));

    // Rename claude-opus's display name (an overlay-editable field).
    const patched = await app.api.inject({
      method: 'PATCH',
      url: '/api/agents/claude-opus',
      payload: { displayName: 'Claude (Reviewer)', name: '审查布偶' },
    });
    expect(patched.statusCode).toBe(200);

    // The static mentionPatterns are NOT editable, so @claude must still route to
    // claude-opus and drive its turn (proving the rename did not desync routing).
    const turn = await app.api.inject({
      method: 'POST',
      url: '/api/threads/thread-rename-route/messages',
      payload: { content: '@claude 看一下这个方案' },
    });
    expect(turn.statusCode).toBe(200);
    // The fake (bound to claude-opus) was invoked — the mention resolved correctly.
    expect(fake.calls).toHaveLength(1);
    // And the renamed display name shows up in the prompt identity line.
    expect(fake.calls[0]?.options?.systemPrompt ?? '').toContain('Claude (Reviewer)');
  });
});
