// tests/invocation/invocation-registry.test.ts
// M3 dev happy-path tests for InvocationRegistry (§4.6 / §6.2).
// Deterministic: injected idFactory + clock, no wall-clock, real agent ids.

import { describe, test, expect } from 'vitest';
import { createAgentId } from '@choco/shared';
import { InvocationRegistry } from '@choco/api/invocation/invocation-registry';

/** A deterministic id factory yielding a fixed sequence (invocationId, token, ...). */
function seqIdFactory(ids: readonly string[]): () => string {
  let i = 0;
  return () => {
    const id = ids[i] ?? `extra-${i}`;
    i += 1;
    return id;
  };
}

describe('InvocationRegistry — happy path (unit)', () => {
  test('create issues invocationId + callbackToken and registers the record', () => {
    // Arrange
    const now = (): number => 1_700_000_000_000;
    const registry = new InvocationRegistry({
      idFactory: seqIdFactory(['inv-claude-001', 'tok-claude-001']),
      now,
    });
    const agentId = createAgentId('claude-opus');

    // Act
    const record = registry.create({
      userId: 'user',
      agentId,
      threadId: 'thread-todo-api',
    });

    // Assert
    expect(record.invocationId).toBe('inv-claude-001');
    expect(record.callbackToken).toBe('tok-claude-001');
    expect(record.agentId).toBe(agentId);
    expect(record.threadId).toBe('thread-todo-api');
    expect(record.claimedMessageIds.size).toBe(0);
    expect(record.createdAt).toBe(1_700_000_000_000);
    expect(record.expiresAt).toBe(1_700_000_000_000 + 2 * 60 * 60 * 1000);
  });

  test('verify returns ok with the record for a fresh, latest invocation', () => {
    // Arrange
    const registry = new InvocationRegistry({
      idFactory: seqIdFactory(['inv-codex-001', 'tok-codex-001']),
      now: () => 1_700_000_000_000,
    });
    const record = registry.create({
      userId: 'user',
      agentId: createAgentId('codex'),
      threadId: 'thread-review',
    });

    // Act
    const result = registry.verify(record.invocationId, record.callbackToken);

    // Assert
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.invocationId).toBe('inv-codex-001');
    }
  });

  test('isLatest is true for the most recent invocation of a (thread, agent)', () => {
    // Arrange
    const registry = new InvocationRegistry({
      idFactory: seqIdFactory(['inv-gemini-001', 'tok-gemini-001']),
      now: () => 1_700_000_000_000,
    });
    const record = registry.create({
      userId: 'user',
      agentId: createAgentId('gemini'),
      threadId: 'thread-design',
    });

    // Act + Assert
    expect(registry.isLatest(record.invocationId)).toBe(true);
  });

  test('claimClientMessageId is idempotent: first claim true, repeat claim false', () => {
    // Arrange
    const registry = new InvocationRegistry({
      idFactory: seqIdFactory(['inv-claude-002', 'tok-claude-002']),
      now: () => 1_700_000_000_000,
    });
    const record = registry.create({
      userId: 'user',
      agentId: createAgentId('claude-opus'),
      threadId: 'thread-todo-api',
    });
    const clientMessageId = 'client-msg-7f3a';

    // Act
    const first = registry.claimClientMessageId(record.invocationId, clientMessageId);
    const second = registry.claimClientMessageId(record.invocationId, clientMessageId);

    // Assert
    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(record.claimedMessageIds.has(clientMessageId)).toBe(true);
  });
});
