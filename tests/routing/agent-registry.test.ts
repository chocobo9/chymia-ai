// tests/routing/agent-registry.test.ts
// M4 DEV happy-path: AgentRegistryImpl lookups, mention resolution, default.

import { describe, test, expect } from 'vitest';
import { makeRegistry, CLAUDE, CODEX } from './helpers';

describe('AgentRegistryImpl — happy path (unit)', () => {
  test('getAll / get return the registered configs', () => {
    const registry = makeRegistry();
    expect(registry.getAll()).toHaveLength(3);
    expect(registry.get(CLAUDE)?.name).toBe('Claude');
  });

  test('resolveByMention matches a configured pattern (incl. Chinese)', () => {
    const registry = makeRegistry();
    expect(registry.resolveByMention('@codex')?.id).toBe(CODEX);
    expect(registry.resolveByMention('@claude')?.id).toBe(CLAUDE);
    expect(registry.resolveByMention('@nobody')).toBeUndefined();
  });

  test('getDefault returns the first config when no default configured', () => {
    const registry = makeRegistry();
    expect(registry.getDefault().id).toBe(CLAUDE);
  });

  test('getMentionEntries flattens every pattern across agents', () => {
    const registry = makeRegistry();
    const entries = registry.getMentionEntries();
    // claude has 2 patterns, codex 1, gemini 1.
    expect(entries).toHaveLength(4);
    expect(entries.filter((e) => e.agentId === CLAUDE)).toHaveLength(2);
  });
});
