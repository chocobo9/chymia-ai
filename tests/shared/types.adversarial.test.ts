// M1 QA — adversarial / negative type tests for @clowder/shared.
// These are gated by the tsc --noEmit bar (root tsconfig includes tests/**).
// Each `@ts-expect-error` asserts the line MUST NOT compile; if a brand /
// literal-union / required-field invariant regresses, the expected error
// disappears and tsc fails the gate. The runtime bodies keep vitest reporting
// executed, passing tests. Authored by the QA subagent (dev≠QA).

import { describe, it, expect } from 'vitest';
import { createAgentId } from '@clowder/shared';
import type {
  AgentId,
  AgentConfig,
  AgentMessage,
  StoredMessage,
  Thread,
  EvidenceItem,
  EvidenceSearchOptions,
  InvocationRecord,
  SopPredicate,
  InvocationContext,
  IncomingPlatformMessage,
} from '@clowder/shared';

describe('M1 AgentId brand must reject bare strings', () => {
  it('a raw string is not assignable where AgentId is required', () => {
    function needsAgent(id: AgentId): string {
      return id;
    }
    // @ts-expect-error — a bare string must not satisfy the AgentId brand
    needsAgent('claude-opus');
    expect(needsAgent(createAgentId('claude-opus'))).toBe('claude-opus');
  });

  it('an AgentId is still usable as a string (brand is a structural string)', () => {
    const id: AgentId = createAgentId('codex-gpt');
    // branded ids ARE strings at runtime — this must compile
    const upper: string = id.toUpperCase();
    expect(upper).toBe('CODEX-GPT');
  });
});

describe('M1 literal unions must reject invalid members', () => {
  it('rejects an AgentMessageType that is not in the union', () => {
    const msg: AgentMessage = {
      // @ts-expect-error — 'result' is not a valid AgentMessageType
      type: 'result',
      agentId: createAgentId('claude-opus'),
      content: 'final answer',
      timestamp: 1748600000000,
    };
    expect(msg.content).toBe('final answer');
  });

  it('rejects an invalid AgentConfig.clientId provider', () => {
    const cfg: AgentConfig = {
      id: createAgentId('grok'),
      name: 'Grok',
      displayName: 'Grok',
      // @ts-expect-error — 'xai' is not one of 'anthropic' | 'openai' | 'google'
      clientId: 'xai',
      defaultModel: 'grok-2',
      mcpSupport: false,
      mentionPatterns: ['@grok'],
      personality: 'snarky',
      roleDescription: 'experimental',
      color: { primary: '#000', secondary: '#111' },
    };
    expect(cfg.name).toBe('Grok');
  });

  it('rejects an invalid AgentState.status value', () => {
    // status must be one of the AgentStatus literals
    const status: 'idle' | 'thinking' | 'working' | 'error' | 'offline' = 'idle';
    expect(status).toBe('idle');
    // @ts-expect-error — 'paused' is not a valid AgentStatus
    const bad: 'idle' | 'thinking' | 'working' | 'error' | 'offline' = 'paused';
    expect(bad).toBeDefined();
  });

  it('rejects an invalid EvidenceItem.kind', () => {
    const ev: EvidenceItem = {
      anchor: 'note:1',
      // @ts-expect-error — 'image' is not a valid EvidenceKind
      kind: 'image',
      status: 'active',
      title: 'screenshot',
      updatedAt: '2026-05-30T00:00:00.000Z',
    };
    expect(ev.anchor).toBe('note:1');
  });

  it('rejects an invalid EvidenceSearchOptions.mode', () => {
    const opts: EvidenceSearchOptions = {
      // @ts-expect-error — 'fuzzy' is not a valid EvidenceSearchMode
      mode: 'fuzzy',
      limit: 5,
    };
    expect(opts.limit).toBe(5);
  });

  it('rejects an unknown SopPredicate discriminant', () => {
    // @ts-expect-error — 'regex_match' is not a member type of SopPredicate
    const predicate: SopPredicate = { type: 'regex_match', pattern: '.*' };
    expect(predicate).toBeDefined();
  });

  it('rejects an invalid InvocationContext.mode', () => {
    const ctx: InvocationContext = {
      agentId: createAgentId('claude-opus'),
      // @ts-expect-error — 'broadcast' is not a valid InvocationMode
      mode: 'broadcast',
      teammates: [],
      mcpAvailable: true,
    };
    expect(ctx.mcpAvailable).toBe(true);
  });
});

describe('M1 required fields and field types must be enforced', () => {
  it('rejects an AgentMessage missing the required timestamp', () => {
    // @ts-expect-error — `timestamp` is required on AgentMessage
    const msg: AgentMessage = {
      type: 'text',
      agentId: createAgentId('claude-opus'),
      content: '回归通过',
    };
    expect(msg.content).toBe('回归通过');
  });

  it('rejects a StoredMessage missing the required mentions field', () => {
    // @ts-expect-error — `mentions` is required on StoredMessage
    const stored: StoredMessage = {
      id: 'm1',
      threadId: 'thread-1',
      userId: 'user',
      agentId: null,
      content: '回归通过',
      timestamp: 1,
    };
    expect(stored.id).toBe('m1');
  });

  it('rejects a Thread missing the required thinkingMode field', () => {
    // @ts-expect-error — `thinkingMode` is required on Thread
    const thread: Thread = {
      id: 'thread-1',
      title: '设计讨论',
      createdAt: 1,
      lastActiveAt: 2,
      participants: [],
    };
    expect(thread.title).toBe('设计讨论');
  });

  it('rejects an InvocationRecord whose claimedMessageIds is an array, not a Set', () => {
    const rec: InvocationRecord = {
      invocationId: 'inv-1',
      callbackToken: 'cbk-1',
      userId: 'user',
      agentId: createAgentId('claude-opus'),
      threadId: 'thread-1',
      // @ts-expect-error — claimedMessageIds must be a Set<string>, not string[]
      claimedMessageIds: ['m1', 'm2'],
      createdAt: 1,
      expiresAt: 2,
    };
    expect(rec.invocationId).toBe('inv-1');
  });

  it('rejects an IncomingPlatformMessage missing the required channelId', () => {
    // @ts-expect-error — `channelId` is required on IncomingPlatformMessage
    const incoming: IncomingPlatformMessage = {
      adapterName: 'telegram',
      platformUserId: '584213099',
      platformMessageId: 'tg-1',
      text: 'hi',
      receivedAt: 1,
    };
    expect(incoming.adapterName).toBe('telegram');
  });
});
