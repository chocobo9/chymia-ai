// tests/routing/broadcast-mention.edge.test.ts
//
// F078 (MVP) — global broadcast mentions. A user message carrying @all / @全体
// routes to ALL available agents and fans out in PARALLEL (≥2 targets → ideate →
// parallel, via dispatch). Gates: boundary-safe token detection, the router
// expanding a broadcast to the available roster (offline members silently skipped,
// NOT reported unavailable), group-mention priority over individual @mentions, and
// the all-offline no-crash case.
//
// Distribution: happy ≤50%, edge ≥30%, adversarial ≥20%.

import { describe, it, expect } from 'vitest';
import type { AgentConfig } from '@choco/shared';
import type { AgentService } from '@choco/api/providers/base';
import { AgentRegistryImpl } from '@choco/api/routing/agent-registry';
import { AgentRouter, type InvokeAgentFn } from '@choco/api/routing/agent-router';
import { hasBroadcastMention } from '@choco/api/routing/mention-parser';
import {
  ALL_CONFIGS,
  CLAUDE,
  CODEX,
  GEMINI,
  fixedNow,
  makeRecordingInvoke,
  drain,
} from './helpers.js';

const noopService: AgentService = {
  invoke(): AsyncIterable<never> {
    return (async function* (): AsyncIterable<never> {})();
  },
};

function makeRegistry(
  availability?: Readonly<Record<string, boolean>>,
  configs: readonly AgentConfig[] = ALL_CONFIGS,
): AgentRegistryImpl {
  const services: Record<string, AgentService> = {};
  for (const c of configs) services[c.id as string] = noopService;
  return new AgentRegistryImpl(configs, services, availability !== undefined ? { availability } : undefined);
}

function makeRouter(opts: { invoke?: InvokeAgentFn; availability?: Readonly<Record<string, boolean>> } = {}): AgentRouter {
  const registry = makeRegistry(opts.availability);
  const invoke = opts.invoke ?? makeRecordingInvoke().invoke;
  return new AgentRouter({ registry, invoke, now: fixedNow });
}

describe('hasBroadcastMention — boundary-safe @all / @全体 detection', () => {
  it('[happy] matches @all and @全体 as whole tokens (anywhere in the text)', () => {
    expect(hasBroadcastMention('@all 你们都做个自我介绍')).toBe(true);
    expect(hasBroadcastMention('@全体 做个自我介绍')).toBe(true);
    expect(hasBroadcastMention('大家好呀 @all')).toBe(true); // token at end of text
  });

  it('[edge] rejects substring collisions and embedded handles', () => {
    expect(hasBroadcastMention('@allison 你好')).toBe(false); // @all + handle char 'i'
    expect(hasBroadcastMention('@allowance 预算')).toBe(false); // @all prefix of a longer handle
    expect(hasBroadcastMention('reach me at email@all.org')).toBe(false); // char before '@' is a handle char
    expect(hasBroadcastMention('no broadcast here')).toBe(false);
    expect(hasBroadcastMention('')).toBe(false);
  });

  it('[edge] matches mid-sentence with ASCII or CJK punctuation boundaries', () => {
    expect(hasBroadcastMention('请 @全体 都回复一下')).toBe(true);
    expect(hasBroadcastMention('麻烦 @all，谢谢')).toBe(true); // CJK comma terminates the token
  });
});

describe('AgentRouter — @all / @全体 broadcasts to ALL available agents (parallel)', () => {
  it('[happy] resolveTargets(@all) → every agent, in registry order', async () => {
    const router = makeRouter();
    expect(await router.resolveTargets('@all 介绍一下自己', 't1')).toEqual([CLAUDE, CODEX, GEMINI]);
  });

  it('[happy] route(@全体) fans out — EVERY available agent is actually invoked', async () => {
    const { invoke, calls } = makeRecordingInvoke();
    const router = makeRouter({ invoke });
    await drain(router.route('user-makima', '@全体 做自我介绍', 't1'));
    expect([...calls.map((c) => c.agentId)].sort()).toEqual([CLAUDE, CODEX, GEMINI].sort());
  });

  it('[edge] an OFFLINE agent is silently skipped — not routed, NOT reported unavailable', async () => {
    const router = makeRouter({ availability: { 'codex-gpt': false } });
    const routing = await router.resolveRouting('@all 来活了', 't1');
    expect(routing.targets).toEqual([CLAUDE, GEMINI]);
    expect(routing.unavailable).toEqual([]); // a broadcast never nags about offline members
  });

  it('[adversarial] a group mention WINS over an individual one in the same message', async () => {
    const router = makeRouter();
    // "@all @codex" must broadcast to everyone, not narrow to just codex.
    expect(await router.resolveTargets('@all @codex 都说说看法', 't1')).toEqual([CLAUDE, CODEX, GEMINI]);
  });

  it('[adversarial] @all with NOBODY available → empty target set, no phantom spawn', async () => {
    const router = makeRouter({
      availability: { 'claude-opus': false, 'codex-gpt': false, 'gemini-pro': false },
    });
    expect(await router.resolveTargets('@all 有人在吗', 't1')).toEqual([]);
  });
});
