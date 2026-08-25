// M-MEMBER dev happy-path suite. QA owns edge + adversarial coverage.
//
// Covers the runtime member-edit overlay:
//   • applyAgentOverride — pure/immutable merge (no override → same ref; partial
//     override → new config with ONLY those fields changed, base untouched).
//   • JsonAgentOverrideStore — set→get round-trip, disk persistence (a fresh
//     store reads it back), and field-wise merge across two partial sets.
//   • App level — PATCH /api/agents/:id then GET /api/agents reflects the edit,
//     AND the next turn's system prompt (the resolveConfig path) carries it.
//
// Real inputs only: real agent ids + real role/personality/strengths text.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createAgentId } from '@choco/shared';
import type { AgentConfig } from '@choco/shared';
import {
  applyAgentOverride,
  JsonAgentOverrideStore,
  type AgentOverride,
} from '@choco/api/config/agent-overrides';
import { buildApp } from '@choco/api/app-factory';
import { FakeAgentService } from '../invocation/fake-agent-service.js';
import { replyScript, CLAUDE } from './helpers.js';

/** A realistic base AgentConfig (mirrors the claude-opus roster entry shape). */
function baseConfig(): AgentConfig {
  return {
    id: createAgentId('claude-opus'),
    name: 'Claude',
    displayName: 'Claude',
    clientId: 'anthropic',
    defaultModel: 'claude-opus-4-6',
    mcpSupport: true,
    mentionPatterns: ['@claude', '@claude-opus'],
    personality: '严谨、克制，先问清楚再动手。',
    roleDescription: '架构评审与系统设计负责人。',
    strengths: ['系统设计', '代码评审'],
    color: { primary: '#b9744a', secondary: '#99572f' },
  };
}

describe('applyAgentOverride (happy path)', () => {
  it('returns the base unchanged when there is no override', () => {
    const base = baseConfig();
    const result = applyAgentOverride(base, undefined);
    expect(result).toBe(base);
  });

  it('applies ONLY the present override fields, leaving the base untouched', () => {
    const base = baseConfig();
    const override: AgentOverride = {
      roleDescription: '改为：API 网关与限流策略负责人。',
      strengths: ['限流设计', 'API 网关'],
    };

    const result = applyAgentOverride(base, override);

    // Only the overridden fields changed.
    expect(result.roleDescription).toBe('改为：API 网关与限流策略负责人。');
    expect(result.strengths).toEqual(['限流设计', 'API 网关']);
    // Everything else is carried from the base.
    expect(result.displayName).toBe('Claude');
    expect(result.name).toBe('Claude');
    expect(result.personality).toBe('严谨、克制，先问清楚再动手。');
    expect(result.clientId).toBe('anthropic');
    expect(result.color).toEqual({ primary: '#b9744a', secondary: '#99572f' });

    // Immutability: a NEW object, base not mutated.
    expect(result).not.toBe(base);
    expect(base.roleDescription).toBe('架构评审与系统设计负责人。');
    expect(base.strengths).toEqual(['系统设计', '代码评审']);
  });
});

describe('JsonAgentOverrideStore (happy path)', () => {
  it('round-trips set → get for one agent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'choco-overrides-'));
    const store = new JsonAgentOverrideStore(join(dir, 'agent-overrides.json'));

    store.set('claude-opus', { roleDescription: '负责数据一致性与迁移评审。' });

    expect(store.get('claude-opus')).toEqual({
      roleDescription: '负责数据一致性与迁移评审。',
    });
  });

  it('persists to disk so a fresh store loads the saved overrides', () => {
    const dir = mkdtempSync(join(tmpdir(), 'choco-overrides-'));
    const filePath = join(dir, 'nested', 'agent-overrides.json');

    const writer = new JsonAgentOverrideStore(filePath);
    writer.set('codex-gpt', {
      displayName: 'Codex (GPT-5)',
      strengths: ['性能调优', '并发安全'],
    });

    // The file exists and is valid JSON containing the override.
    const onDisk = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
    expect(onDisk['codex-gpt']).toEqual({
      displayName: 'Codex (GPT-5)',
      strengths: ['性能调优', '并发安全'],
    });

    // A fresh store reads the persisted map back.
    const reader = new JsonAgentOverrideStore(filePath);
    expect(reader.get('codex-gpt')).toEqual({
      displayName: 'Codex (GPT-5)',
      strengths: ['性能调优', '并发安全'],
    });
  });

  it('merges field-wise so two partial sets accumulate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'choco-overrides-'));
    const store = new JsonAgentOverrideStore(join(dir, 'agent-overrides.json'));

    store.set('gemini-pro', { roleDescription: '负责前端架构与可访问性。' });
    store.set('gemini-pro', { personality: '直接、注重落地，少废话。' });

    // The second partial set did NOT drop the first edit.
    expect(store.get('gemini-pro')).toEqual({
      roleDescription: '负责前端架构与可访问性。',
      personality: '直接、注重落地，少废话。',
    });
  });
});

describe('member-edit overlay end-to-end (happy path)', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
  });

  it('PATCH /api/agents/:id persists, GET reflects it, and the next turn system prompt carries it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'choco-overrides-'));
    const store = new JsonAgentOverrideStore(join(dir, 'agent-overrides.json'));
    const fake = new FakeAgentService([replyScript(CLAUDE, '收到，开始评审限流方案。')]);

    const app = buildApp({
      db: new Database(':memory:'),
      agentServices: { 'claude-opus': fake },
      agentOverrideStore: store,
    });
    cleanups.push(app.close);

    // 1. Edit the member's role + strengths.
    const patched = await app.api.inject({
      method: 'PATCH',
      url: '/api/agents/claude-opus',
      payload: {
        roleDescription: 'API 网关与限流策略负责人。',
        strengths: ['限流设计', 'API 网关'],
      },
    });
    expect(patched.statusCode).toBe(200);
    const patchedBody = patched.json<{
      agent: { id: string; strengths: string[] };
    }>();
    expect(patchedBody.agent.id).toBe('claude-opus');
    expect(patchedBody.agent.strengths).toEqual(['限流设计', 'API 网关']);

    // 2. GET /api/agents reflects the edited strengths (overlay layered on roster).
    const listed = await app.api.inject({ method: 'GET', url: '/api/agents' });
    expect(listed.statusCode).toBe(200);
    const claude = listed
      .json<{ agents: Array<{ id: string; strengths: string[] }> }>()
      .agents.find((a) => a.id === 'claude-opus');
    expect(claude?.strengths).toEqual(['限流设计', 'API 网关']);

    // 3. The NEXT turn's system prompt carries the edited role — i.e. the wrapped
    //    resolveConfig path picked up the overlay (no restart). Drive a real turn
    //    and inspect the systemPrompt the provider was invoked with.
    const turn = await app.api.inject({
      method: 'POST',
      url: '/api/threads/thread-member-edit/messages',
      payload: { content: '@claude 评审一下限流方案' },
    });
    expect(turn.statusCode).toBe(200);

    expect(fake.calls).toHaveLength(1);
    const systemPrompt = fake.calls[0]?.options?.systemPrompt ?? '';
    expect(systemPrompt).toContain('API 网关与限流策略负责人。');
    expect(systemPrompt).toContain('限流设计');
  });
});
