// M8 QA — callback-auth edge + adversarial coverage (independently authored).
//
// Attacks the authenticateCallback precedence ladder (unknown → invalid_token →
// expired → stale_invocation), header-shape edge cases (array headers, empty
// strings, casing), and the privilege-confusion guarantee that the verified
// InvocationRecord — never the request body — decides identity.
//
// Real inputs only: real UUID-shaped invocation ids minted by the registry, real
// roster agent ids, real Chinese agent-message content.

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createAgentId } from '@choco/shared';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';
import { InvocationRegistry } from '@choco/api/invocation/invocation-registry';
import {
  authenticateCallback,
  INVOCATION_ID_HEADER,
  CALLBACK_TOKEN_HEADER,
} from '@choco/api/routes/callback-auth';

const CLAUDE = createAgentId('claude-opus');
const CODEX = createAgentId('codex-gpt');

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

describe('authenticateCallback — failure precedence (edge)', () => {
  it('reports unknown_invocation for an id that was never minted', () => {
    const registry = new InvocationRegistry();
    const result = authenticateCallback(
      {
        [INVOCATION_ID_HEADER]: 'inv-that-never-existed',
        [CALLBACK_TOKEN_HEADER]: 'some-token',
      },
      registry,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unknown_invocation');
  });

  it('prefers invalid_token over expired when BOTH are wrong (specificity ladder)', () => {
    let clock = 1_000_000;
    const registry = new InvocationRegistry({ now: () => clock });
    const record = registry.create({
      userId: 'user',
      agentId: CLAUDE,
      threadId: 'thread-precedence',
      ttlMs: 1000,
    });
    clock += 10_000; // also expired

    const result = authenticateCallback(
      {
        [INVOCATION_ID_HEADER]: record.invocationId,
        [CALLBACK_TOKEN_HEADER]: 'wrong-token-and-also-expired',
      },
      registry,
    );
    expect(result.ok).toBe(false);
    // Token check runs before the expiry check → invalid_token wins.
    if (!result.ok) expect(result.reason).toBe('invalid_token');
  });

  it('reports stale_invocation when a newer invocation supersedes this one', () => {
    const registry = new InvocationRegistry();
    const first = registry.create({ userId: 'user', agentId: CLAUDE, threadId: 'thread-stale' });
    // A second invocation for the SAME (thread, agent) supersedes the first.
    registry.create({ userId: 'user', agentId: CLAUDE, threadId: 'thread-stale' });

    const result = authenticateCallback(
      {
        [INVOCATION_ID_HEADER]: first.invocationId,
        [CALLBACK_TOKEN_HEADER]: first.callbackToken,
      },
      registry,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('stale_invocation');
  });

  it('a different agent on the same thread does NOT make an invocation stale', () => {
    const registry = new InvocationRegistry();
    const claudeRec = registry.create({ userId: 'user', agentId: CLAUDE, threadId: 'thread-multi' });
    // Codex invocation on the same thread keys on a DIFFERENT (thread,agent) pair.
    registry.create({ userId: 'user', agentId: CODEX, threadId: 'thread-multi' });

    const result = authenticateCallback(
      {
        [INVOCATION_ID_HEADER]: claudeRec.invocationId,
        [CALLBACK_TOKEN_HEADER]: claudeRec.callbackToken,
      },
      registry,
    );
    expect(result.ok).toBe(true);
  });
});

describe('authenticateCallback — header-shape edge cases (edge)', () => {
  it('treats an empty-string token header as missing credentials, not invalid_token', () => {
    const registry = new InvocationRegistry();
    const record = registry.create({ userId: 'user', agentId: CLAUDE, threadId: 'thread-empty' });
    const result = authenticateCallback(
      {
        [INVOCATION_ID_HEADER]: record.invocationId,
        [CALLBACK_TOKEN_HEADER]: '',
      },
      registry,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('missing_credentials');
  });

  it('collapses a duplicated (array) header to its first value', () => {
    const registry = new InvocationRegistry();
    const record = registry.create({ userId: 'user', agentId: CLAUDE, threadId: 'thread-array' });
    const result = authenticateCallback(
      {
        [INVOCATION_ID_HEADER]: [record.invocationId, 'a-second-bogus-id'],
        [CALLBACK_TOKEN_HEADER]: record.callbackToken,
      },
      registry,
    );
    expect(result.ok).toBe(true);
  });
});

describe('callback identity is taken from the verified record, not the body (adversarial)', () => {
  /** Mint a live invocation bound to (CLAUDE, victimThread) and return the app. */
  async function appWithClaudeInvocation(): Promise<{
    app: BuiltApp;
    invocationId: string;
    callbackToken: string;
    victimThread: string;
  }> {
    const db = new Database(':memory:');
    const app = buildApp({ db });
    const victimThread = 'thread-victim';
    await app.stores.threadStore.ensureThread(victimThread, '受害线程');
    const rec = app.invocations.create({ userId: 'user', agentId: CLAUDE, threadId: victimThread });
    return { app, invocationId: rec.invocationId, callbackToken: rec.callbackToken, victimThread };
  }

  it('post_message persists to the record threadId even when the body tries to override threadId/agentId', async () => {
    const { app, invocationId, callbackToken, victimThread } = await appWithClaudeInvocation();
    cleanups.push(app.close);

    const otherThread = 'thread-attacker-target';
    await app.stores.threadStore.ensureThread(otherThread, '攻击者目标线程');

    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/post_message',
      headers: { [INVOCATION_ID_HEADER]: invocationId, [CALLBACK_TOKEN_HEADER]: callbackToken },
      // Attacker re-supplies identity in the body — must be ignored (.strict() also rejects unknown keys).
      payload: { content: '伪装成另一个 agent 写入别的线程', threadId: otherThread, agentId: 'gemini-pro' },
    });

    // .strict() schema rejects the extra threadId/agentId keys outright (400),
    // OR (if a schema relaxed) identity must still come from the record. Either
    // way the message must NEVER land in the attacker's thread under gemini-pro.
    const otherMsgs = await app.stores.messageStore.getByThread(otherThread);
    expect(otherMsgs).toHaveLength(0);
    if (res.statusCode === 201) {
      const victimMsgs = await app.stores.messageStore.getByThread(victimThread);
      expect(victimMsgs.every((m) => m.agentId === 'claude-opus' || m.agentId === null)).toBe(true);
    } else {
      expect(res.statusCode).toBe(400);
    }
  });

  it('read_file callback is rejected 401 once the invocation is superseded (stale token cannot keep reading)', async () => {
    const { app, invocationId, callbackToken, victimThread } = await appWithClaudeInvocation();
    cleanups.push(app.close);

    // A newer invocation for the same (thread, agent) supersedes the first token.
    app.invocations.create({ userId: 'user', agentId: CLAUDE, threadId: victimThread });

    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/read_file',
      headers: { [INVOCATION_ID_HEADER]: invocationId, [CALLBACK_TOKEN_HEADER]: callbackToken },
      payload: { path: 'package.json' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ reason: string }>().reason).toBe('stale_invocation');
  });
});
