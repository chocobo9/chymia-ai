// packages/api/src/invocation/invocation-registry.ts
// M3: InvocationRegistry — in-memory registry of live invocations + callback auth.
//
// Re-authored from clowder-architecture-design.md §4.6 (InvocationRecord,
// AuthFailureReason, VerifyResult) and §6.2 (create → mark latest; verify the
// four failure classes; per-client-message idempotency).
//
// Imports the FROZEN M1 shapes from @clowder/shared (InvocationRecord etc.) —
// does NOT redefine them. State is purely in memory; nothing is created at
// import time. `idFactory` and `now` are injectable for deterministic tests.

import { randomUUID } from 'node:crypto';
import type {
  AgentId,
  InvocationRecord,
  VerifyResult,
} from '@clowder/shared';

/**
 * Invocation TTL: how long after creation a record stays valid for callbacks.
 * Source: clowder-architecture-design.md §4.6 ("TTL 2 小时").
 */
export const INVOCATION_TTL_MS = 2 * 60 * 60 * 1000;

/** Generates the UUIDs for invocationId / callbackToken (injectable for tests). */
export type IdFactory = () => string;

/** Clock used for createdAt / expiresAt / expiry checks (injectable for tests). */
export type NowFn = () => number;

/** Parameters accepted by {@link InvocationRegistry.create}. */
export interface CreateInvocationParams {
  readonly userId: string;
  readonly agentId: AgentId;
  readonly threadId: string;
  readonly parentInvocationId?: string;
  readonly a2aTriggerMessageId?: string;
  /** Override the default {@link INVOCATION_TTL_MS}. */
  readonly ttlMs?: number;
}

/** Options for constructing an {@link InvocationRegistry}. */
export interface InvocationRegistryOptions {
  /** UUID source for invocationId + callbackToken. Defaults to crypto.randomUUID. */
  readonly idFactory?: IdFactory;
  /** Clock. Defaults to Date.now. */
  readonly now?: NowFn;
}

/**
 * Build the "latest" map key for a (thread, agent) pair.
 * One agent has at most one live (latest) invocation per thread; a newer create
 * supersedes the older, which then verifies as `stale_invocation`.
 */
function latestKey(threadId: string, agentId: AgentId): string {
  return `${threadId}:${agentId as string}`;
}

/**
 * InvocationRegistry — tracks live invocations and gates MCP callbacks.
 * Implements clowder-architecture-design.md §4.6 + §6.2.
 *
 * Responsibilities:
 * - create(): mint invocationId + callbackToken, store the record, mark it the
 *   latest invocation for its (thread, agent).
 * - verify(): authenticate a callback against the four failure classes.
 * - isLatest(): is this invocation still the live one for its (thread, agent)?
 * - claimClientMessageId(): per-invocation idempotency / dedup of client messages.
 */
export class InvocationRegistry {
  private readonly invocations = new Map<string, InvocationRecord>();
  private readonly latestByThreadAgent = new Map<string, string>();
  private readonly idFactory: IdFactory;
  private readonly now: NowFn;

  constructor(options?: InvocationRegistryOptions) {
    this.idFactory = options?.idFactory ?? randomUUID;
    this.now = options?.now ?? Date.now;
  }

  /**
   * Create a new invocation record, register it, and mark it the latest for its
   * (thread, agent). Returns the full record (caller forwards callbackToken to
   * the agent's MCP env). `claimedMessageIds` starts empty.
   */
  create(params: CreateInvocationParams): InvocationRecord {
    const createdAt = this.now();
    const ttlMs = params.ttlMs ?? INVOCATION_TTL_MS;
    const record: InvocationRecord = {
      invocationId: this.idFactory(),
      callbackToken: this.idFactory(),
      userId: params.userId,
      agentId: params.agentId,
      threadId: params.threadId,
      ...(params.parentInvocationId !== undefined
        ? { parentInvocationId: params.parentInvocationId }
        : {}),
      ...(params.a2aTriggerMessageId !== undefined
        ? { a2aTriggerMessageId: params.a2aTriggerMessageId }
        : {}),
      claimedMessageIds: new Set<string>(),
      createdAt,
      expiresAt: createdAt + ttlMs,
    };

    this.invocations.set(record.invocationId, record);
    this.latestByThreadAgent.set(
      latestKey(params.threadId, params.agentId),
      record.invocationId,
    );
    return record;
  }

  /**
   * Verify a callback's (invocationId, callbackToken) pair.
   *
   * Checks are ordered most-specific-first so the failure reason is precise
   * (clowder-architecture-design.md §4.6 AuthFailureReason):
   *   1. unknown_invocation — no record for this id
   *   2. invalid_token      — record exists but token mismatches
   *   3. expired            — past expiresAt
   *   4. stale_invocation   — superseded by a newer invocation for the (thread, agent)
   * On success returns the live record.
   */
  verify(invocationId: string, callbackToken: string): VerifyResult {
    const record = this.invocations.get(invocationId);
    if (record === undefined) {
      return { ok: false, reason: 'unknown_invocation' };
    }
    if (record.callbackToken !== callbackToken) {
      return { ok: false, reason: 'invalid_token' };
    }
    if (this.now() > record.expiresAt) {
      return { ok: false, reason: 'expired' };
    }
    if (!this.isLatestRecord(record)) {
      return { ok: false, reason: 'stale_invocation' };
    }
    return { ok: true, record };
  }

  /**
   * Whether `invocationId` is still the latest invocation for its (thread, agent).
   * Returns false for unknown ids and for superseded invocations.
   */
  isLatest(invocationId: string): boolean {
    const record = this.invocations.get(invocationId);
    if (record === undefined) {
      return false;
    }
    return this.isLatestRecord(record);
  }

  /**
   * Idempotency / dedup: attempt to claim a client message id for an invocation.
   * Returns true if this is the first claim (caller should process the message),
   * false if already claimed (caller should skip) or the invocation is unknown.
   */
  claimClientMessageId(invocationId: string, clientMessageId: string): boolean {
    const record = this.invocations.get(invocationId);
    if (record === undefined) {
      return false;
    }
    if (record.claimedMessageIds.has(clientMessageId)) {
      return false;
    }
    record.claimedMessageIds.add(clientMessageId);
    return true;
  }

  /** Look up a record by id, or undefined if unknown. */
  get(invocationId: string): InvocationRecord | undefined {
    return this.invocations.get(invocationId);
  }

  private isLatestRecord(record: InvocationRecord): boolean {
    const key = latestKey(record.threadId, record.agentId);
    return this.latestByThreadAgent.get(key) === record.invocationId;
  }
}
