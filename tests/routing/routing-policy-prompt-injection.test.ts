// tests/routing/routing-policy-prompt-injection.test.ts
// P0-3 (first cut) — thread routing policy injected into the agent's system prompt.
//
// Aligned-To: reference/clowder-ai-main/.../context/SystemPromptBuilder.ts (:740)
//   buildInvocationContext emits a `Routing: <scope> avoid @x prefer @y (reason)` line.
//
// Two halves:
//   1. buildInvocationContext (pure) emits the Routing line for a v1 policy, skips
//      expired rules, and stays silent without a policy.
//   2. wiring: AgentRouter.route reads thread.routingPolicy (real SqliteThreadStore)
//      and threads it into the invocation context the invoke seam receives.

import { describe, test, expect } from 'vitest';
import Database from 'better-sqlite3';
import type { AgentConfig, AgentId, InvocationContext, ThreadRoutingPolicyV1 } from '@choco/shared';
import { buildInvocationContext } from '@choco/api/context/system-prompt-builder';
import { AgentRouter } from '@choco/api/routing/agent-router';
import { SqliteThreadStore } from '@choco/api/stores/sqlite-thread-store';
import { SqliteMessageStore } from '@choco/api/stores/sqlite-message-store';
import { makeRegistry, makeRecordingInvoke, drain, fixedNow, CLAUDE, CODEX, GEMINI } from './helpers';

const registry = makeRegistry();
const resolveConfig = (id: AgentId): AgentConfig | undefined => registry.get(id);

function ctx(routingPolicy: ThreadRoutingPolicyV1 | undefined): InvocationContext {
  return {
    agentId: CLAUDE,
    mode: 'serial',
    teammates: [],
    mcpAvailable: false,
    ...(routingPolicy !== undefined ? { routingPolicy } : {}),
  };
}

describe('routing policy injection — buildInvocationContext (pure)', () => {
  test('emits a Routing line with avoid / prefer / reason', () => {
    const prompt = buildInvocationContext(
      ctx({ v: 1, scopes: { review: { avoidCats: [CODEX], preferCats: [GEMINI], reason: 'budget' } } }),
      resolveConfig,
    );
    expect(prompt).toContain('Routing:');
    expect(prompt).toContain('review');
    expect(prompt).toContain('avoid @codex');
    expect(prompt).toContain('prefer @gemini');
    expect(prompt).toContain('(budget)');
  });

  test('skips an expired rule', () => {
    const prompt = buildInvocationContext(
      ctx({ v: 1, scopes: { review: { avoidCats: [CODEX], expiresAt: 1 } } }),
      resolveConfig,
    );
    expect(prompt).not.toContain('Routing:');
  });

  test('no policy → no Routing line', () => {
    expect(buildInvocationContext(ctx(undefined), resolveConfig)).not.toContain('Routing:');
  });
});

describe('routing policy injection — wiring (AgentRouter.route → invocation context)', () => {
  function build(): { threadStore: SqliteThreadStore; messageStore: SqliteMessageStore } {
    const db = new Database(':memory:');
    return { threadStore: new SqliteThreadStore(db), messageStore: new SqliteMessageStore(db) };
  }

  test('route reads thread.routingPolicy and threads it into the invocation context', async () => {
    const { threadStore, messageStore } = build();
    await threadStore.ensureThread('t1', 'x');
    await threadStore.updateRoutingPolicy('t1', { v: 1, scopes: { review: { avoidCats: [CODEX] } } });
    const rec = makeRecordingInvoke({ [CLAUDE as string]: 'ok' });
    const router = new AgentRouter({
      registry: makeRegistry(),
      invoke: rec.invoke,
      history: messageStore,
      threadStore,
      now: fixedNow,
    });

    await drain(router.route('user', '@claude review this', 't1'));

    expect(rec.calls[0]?.context.routingPolicy?.scopes?.review?.avoidCats).toEqual([CODEX]);
  });

  test('no thread policy → invocation context has no routingPolicy', async () => {
    const { threadStore, messageStore } = build();
    await threadStore.ensureThread('t2', 'x');
    const rec = makeRecordingInvoke({ [CLAUDE as string]: 'ok' });
    const router = new AgentRouter({
      registry: makeRegistry(),
      invoke: rec.invoke,
      history: messageStore,
      threadStore,
      now: fixedNow,
    });

    await drain(router.route('user', '@claude hi', 't2'));

    expect(rec.calls[0]?.context.routingPolicy).toBeUndefined();
  });
});
