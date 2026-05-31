// tests/invocation/invocation-registry.edge.test.ts
// M3 QA (independent) — edge + adversarial coverage for InvocationRegistry.
//
// Author: QA subagent (did NOT write the InvocationRegistry product code nor the
// dev happy-path tests). Per CLAUDE.md §0.5.3.
//
// Determinism: an injected idFactory mints predictable ids; an injected clock
// (`nowRef.value`) drives TTL expiry — no wall-clock timers. Real userId / agent
// ids (createAgentId) / threadId / client message ids are used throughout.

import { describe, it, expect } from 'vitest';
import { createAgentId } from '@clowder/shared';
import {
  InvocationRegistry,
  INVOCATION_TTL_MS,
} from '@clowder/api/invocation/invocation-registry';

const USER = 'user-makima';
const THREAD = 'thread-todo-api';

/** Deterministic id source: id-1, id-2, ... (so token vs id are distinguishable). */
function makeSeqIdFactory(): () => string {
  let n = 0;
  return (): string => {
    n += 1;
    return `id-${String(n)}`;
  };
}

/** Mutable clock cell so a single registry can observe time advancing. */
interface Clock {
  value: number;
}

describe('InvocationRegistry — edge: claimClientMessageId idempotency', () => {
  it('first claim true, repeat false, and distinct ids are independent', () => {
    const reg = new InvocationRegistry({
      idFactory: makeSeqIdFactory(),
      now: () => 10_000,
    });
    const rec = reg.create({
      userId: USER,
      agentId: createAgentId('claude-opus'),
      threadId: THREAD,
    });

    // Real client message ids (uuid-like), not placeholders.
    const msgA = 'climsg-2f8c-write-api';
    const msgB = 'climsg-91ad-review-api';

    expect(reg.claimClientMessageId(rec.invocationId, msgA)).toBe(true);
    expect(reg.claimClientMessageId(rec.invocationId, msgA)).toBe(false);
    // A different message id is independent of msgA's claim.
    expect(reg.claimClientMessageId(rec.invocationId, msgB)).toBe(true);
    expect(reg.claimClientMessageId(rec.invocationId, msgB)).toBe(false);
  });

  it('claims are scoped per invocation, not shared across invocations', () => {
    // Edge: two live invocations for DIFFERENT (thread,agent) keep separate claim sets.
    const reg = new InvocationRegistry({
      idFactory: makeSeqIdFactory(),
      now: () => 5_000,
    });
    const recA = reg.create({
      userId: USER,
      agentId: createAgentId('claude-opus'),
      threadId: 'thread-alpha',
    });
    const recB = reg.create({
      userId: USER,
      agentId: createAgentId('codex'),
      threadId: 'thread-beta',
    });
    const shared = 'climsg-shared-7c21';

    expect(reg.claimClientMessageId(recA.invocationId, shared)).toBe(true);
    // Same client message id against a different invocation is a fresh claim.
    expect(reg.claimClientMessageId(recB.invocationId, shared)).toBe(true);
    // ...and each is now idempotent on its own.
    expect(reg.claimClientMessageId(recA.invocationId, shared)).toBe(false);
    expect(reg.claimClientMessageId(recB.invocationId, shared)).toBe(false);
  });

  it('adversarial: claiming against an unknown invocation returns false (no throw)', () => {
    const reg = new InvocationRegistry({
      idFactory: makeSeqIdFactory(),
      now: () => 1,
    });
    expect(
      reg.claimClientMessageId('id-does-not-exist', 'climsg-orphan-44'),
    ).toBe(false);
  });
});

describe('InvocationRegistry — edge/adversarial: verify rejection order', () => {
  it('adversarial: returns unknown_invocation for a fabricated id that was never created', () => {
    const reg = new InvocationRegistry({
      idFactory: makeSeqIdFactory(),
      now: () => 1_000,
    });
    const result = reg.verify('id-never', 'token-never');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unknown_invocation');
    }
  });

  it('adversarial: forged/wrong token on a real invocation → invalid_token', () => {
    const reg = new InvocationRegistry({
      idFactory: makeSeqIdFactory(),
      now: () => 1_000,
    });
    const rec = reg.create({
      userId: USER,
      agentId: createAgentId('claude-opus'),
      threadId: THREAD,
    });
    const result = reg.verify(rec.invocationId, 'forged-token-attacker');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid_token');
    }
  });

  it('edge: an expired invocation (clock advanced past ttl) → expired', () => {
    const clock: Clock = { value: 1_000 };
    const reg = new InvocationRegistry({
      idFactory: makeSeqIdFactory(),
      now: () => clock.value,
    });
    const rec = reg.create({
      userId: USER,
      agentId: createAgentId('codex'),
      threadId: THREAD,
    });
    // Advance the injected clock strictly past expiresAt.
    clock.value = 1_000 + INVOCATION_TTL_MS + 1;
    const result = reg.verify(rec.invocationId, rec.callbackToken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('expired');
    }
  });

  it('edge: exactly at expiresAt is still valid (boundary, > not >=)', () => {
    const clock: Clock = { value: 2_000 };
    const reg = new InvocationRegistry({
      idFactory: makeSeqIdFactory(),
      now: () => clock.value,
    });
    const rec = reg.create({
      userId: USER,
      agentId: createAgentId('gemini'),
      threadId: THREAD,
    });
    // now == expiresAt: code checks `now() > expiresAt`, so this must still pass.
    clock.value = rec.expiresAt;
    const result = reg.verify(rec.invocationId, rec.callbackToken);
    expect(result.ok).toBe(true);
  });

  it('edge: a superseded (stale) invocation → stale_invocation', () => {
    const reg = new InvocationRegistry({
      idFactory: makeSeqIdFactory(),
      now: () => 3_000,
    });
    const agentId = createAgentId('claude-opus');
    const older = reg.create({ userId: USER, agentId, threadId: THREAD });
    // A newer create for the SAME (thread, agent) supersedes the older one.
    const newer = reg.create({ userId: USER, agentId, threadId: THREAD });

    const oldResult = reg.verify(older.invocationId, older.callbackToken);
    expect(oldResult.ok).toBe(false);
    if (!oldResult.ok) {
      expect(oldResult.reason).toBe('stale_invocation');
    }
    // The newer one is fully valid.
    expect(reg.verify(newer.invocationId, newer.callbackToken).ok).toBe(true);
  });

  it('success returns the live record for a valid current invocation', () => {
    const reg = new InvocationRegistry({
      idFactory: makeSeqIdFactory(),
      now: () => 4_000,
    });
    const rec = reg.create({
      userId: USER,
      agentId: createAgentId('codex'),
      threadId: THREAD,
    });
    const result = reg.verify(rec.invocationId, rec.callbackToken);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.record.invocationId).toBe(rec.invocationId);
      expect(result.record.userId).toBe(USER);
    }
  });

  it('adversarial: order check — a valid token on an EXPIRED invocation still reports expired (not invalid_token, not stale)', () => {
    // Adversarial ordering proof: expiry must outrank staleness, and a CORRECT
    // token must not short-circuit the expiry check.
    const clock: Clock = { value: 1_000 };
    const reg = new InvocationRegistry({
      idFactory: makeSeqIdFactory(),
      now: () => clock.value,
    });
    const agentId = createAgentId('claude-opus');
    const rec = reg.create({ userId: USER, agentId, threadId: THREAD });
    // Push past expiry. (No newer invocation, so rec is still "latest"; expiry
    // is what must be reported.)
    clock.value = 1_000 + INVOCATION_TTL_MS + 5_000;

    const result = reg.verify(rec.invocationId, rec.callbackToken);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('expired');
    }
  });

  it('adversarial: wrong token outranks expiry — invalid_token reported even when also expired', () => {
    // Order proof at the top of the chain: invalid_token is checked before expiry.
    const clock: Clock = { value: 1_000 };
    const reg = new InvocationRegistry({
      idFactory: makeSeqIdFactory(),
      now: () => clock.value,
    });
    const rec = reg.create({
      userId: USER,
      agentId: createAgentId('gemini'),
      threadId: THREAD,
    });
    clock.value = 1_000 + INVOCATION_TTL_MS + 1;
    const result = reg.verify(rec.invocationId, 'totally-wrong-token');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('invalid_token');
    }
  });
});

describe('InvocationRegistry — edge: isLatest transitions', () => {
  it('isLatest flips false on the older record when a newer one supersedes it', () => {
    const reg = new InvocationRegistry({
      idFactory: makeSeqIdFactory(),
      now: () => 6_000,
    });
    const agentId = createAgentId('codex');
    const older = reg.create({ userId: USER, agentId, threadId: THREAD });
    expect(reg.isLatest(older.invocationId)).toBe(true);

    const newer = reg.create({ userId: USER, agentId, threadId: THREAD });
    expect(reg.isLatest(older.invocationId)).toBe(false);
    expect(reg.isLatest(newer.invocationId)).toBe(true);
  });

  it('isLatest is independent across different (thread,agent) keys', () => {
    // Edge: superseding claude on thread-A must not affect codex on thread-A,
    // nor claude on thread-B.
    const reg = new InvocationRegistry({
      idFactory: makeSeqIdFactory(),
      now: () => 7_000,
    });
    const claude = createAgentId('claude-opus');
    const codex = createAgentId('codex');

    const claudeA1 = reg.create({ userId: USER, agentId: claude, threadId: 'thread-A' });
    const codexA = reg.create({ userId: USER, agentId: codex, threadId: 'thread-A' });
    const claudeB = reg.create({ userId: USER, agentId: claude, threadId: 'thread-B' });

    // Supersede only claude on thread-A.
    reg.create({ userId: USER, agentId: claude, threadId: 'thread-A' });

    expect(reg.isLatest(claudeA1.invocationId)).toBe(false);
    expect(reg.isLatest(codexA.invocationId)).toBe(true);
    expect(reg.isLatest(claudeB.invocationId)).toBe(true);
  });

  it('adversarial: isLatest returns false for an unknown id (no throw)', () => {
    const reg = new InvocationRegistry({
      idFactory: makeSeqIdFactory(),
      now: () => 8_000,
    });
    expect(reg.isLatest('id-phantom')).toBe(false);
  });
});
