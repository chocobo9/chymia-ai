// tests/routing/agent-registry.edge.test.ts
// M4 QA — independent edge + adversarial gate for AgentRegistryImpl.
// Targets unknown lookups, case/whitespace-insensitive mention resolution,
// alias patterns, explicit default selection, and constructor invariants.

import { describe, test, expect } from 'vitest';
import type { AgentMessage } from '@clowder/shared';
import { createAgentId } from '@clowder/shared';
import type { AgentService } from '@clowder/api/providers/base';
import { AgentRegistryImpl } from '@clowder/api/routing/agent-registry';
import {
  CLAUDE,
  CODEX,
  GEMINI,
  CLAUDE_CONFIG,
  CODEX_CONFIG,
  GEMINI_CONFIG,
  ALL_CONFIGS,
  makeRegistry,
} from './helpers';

const noop: AgentService = {
  invoke: () => (async function* (): AsyncIterable<AgentMessage> {})(),
};

const allServices: Record<string, AgentService> = {
  [CLAUDE as string]: noop,
  [CODEX as string]: noop,
  [GEMINI as string]: noop,
};

describe('AgentRegistryImpl — edge', () => {
  test('(edge) get() of an unknown id returns undefined', () => {
    expect(makeRegistry().get(createAgentId('nobody'))).toBeUndefined();
  });

  test('(edge) resolveByMention is case-insensitive and trims surrounding space', () => {
    const registry = makeRegistry();
    expect(registry.resolveByMention('@CODEX')?.id).toBe(CODEX);
    expect(registry.resolveByMention('  @codex  ')?.id).toBe(CODEX);
  });

  test('(edge) getService() throws for an id with no bound service', () => {
    expect(() => makeRegistry().getService(createAgentId('nobody'))).toThrow(
      /no AgentService registered/,
    );
  });

  test('(edge) an explicit defaultAgentId is honoured over the first config', () => {
    const registry = new AgentRegistryImpl(ALL_CONFIGS, allServices, {
      defaultAgentId: CODEX,
    });
    expect(registry.getDefault().id).toBe(CODEX);
  });

  test('(edge) an alias pattern resolves to the same agent (@claude and @布偶)', () => {
    const registry = makeRegistry();
    expect(registry.resolveByMention('@claude')?.id).toBe(CLAUDE);
    expect(registry.resolveByMention('@布偶')?.id).toBe(CLAUDE);
  });
});

describe('AgentRegistryImpl — adversarial', () => {
  test('(adversarial) constructing with zero configs throws', () => {
    expect(() => new AgentRegistryImpl([], {})).toThrow(/at least one AgentConfig/);
  });

  test('(adversarial) a defaultAgentId not present among configs throws', () => {
    expect(
      () =>
        new AgentRegistryImpl(ALL_CONFIGS, allServices, {
          defaultAgentId: createAgentId('ghost'),
        }),
    ).toThrow(/defaultAgentId not found/);
  });

  test('(adversarial) a config without a bound service still resolves config but fails getService', () => {
    // gemini has a config but is intentionally missing from the services map.
    const partial: Record<string, AgentService> = {
      [CLAUDE as string]: noop,
      [CODEX as string]: noop,
    };
    const registry = new AgentRegistryImpl(
      [CLAUDE_CONFIG, CODEX_CONFIG, GEMINI_CONFIG],
      partial,
    );
    expect(registry.get(GEMINI)?.name).toBe('Gemini');
    expect(() => registry.getService(GEMINI)).toThrow(/no AgentService registered/);
    expect(registry.getService(CLAUDE)).toBe(noop);
  });
});
