// tests/routing/helpers.ts
// M4 DEV happy-path test helpers: realistic agent configs, a recording invoke
// seam (no CLI), and AgentMessage builders. Deterministic — fixed clock, no timers.

import type {
  AgentConfig,
  AgentId,
  AgentMessage,
  InvocationContext,
} from '@clowder/shared';
import { createAgentId } from '@clowder/shared';
import type { AgentService } from '@clowder/api/providers/base';
import { AgentRegistryImpl } from '@clowder/api/routing/agent-registry';
import type {
  InvokeAgentArgs,
  InvokeAgentFn,
} from '@clowder/api/routing/agent-router';

export const FIXED_TS = 1_700_000_000_000;
export const fixedNow = (): number => FIXED_TS;

export const CLAUDE = createAgentId('claude-opus');
export const CODEX = createAgentId('codex-gpt');
export const GEMINI = createAgentId('gemini-pro');

/** A minimal-but-realistic AgentConfig for routing tests. */
function makeConfig(
  id: AgentId,
  name: string,
  mentionPatterns: readonly string[],
): AgentConfig {
  return {
    id,
    name,
    displayName: name,
    clientId: 'anthropic',
    defaultModel: 'model-x',
    mcpSupport: true,
    mentionPatterns,
    personality: 'pragmatic senior engineer',
    roleDescription: 'writes and reviews production code',
    color: { primary: '#6366f1', secondary: '#818cf8' },
  };
}

export const CLAUDE_CONFIG = makeConfig(CLAUDE, 'Claude', ['@claude', '@布偶']);
export const CODEX_CONFIG = makeConfig(CODEX, 'Codex', ['@codex']);
export const GEMINI_CONFIG = makeConfig(GEMINI, 'Gemini', ['@gemini']);

export const ALL_CONFIGS: readonly AgentConfig[] = [
  CLAUDE_CONFIG,
  CODEX_CONFIG,
  GEMINI_CONFIG,
];

/** A no-op AgentService stub (routing tests use the invoke seam, not services). */
const noopService: AgentService = {
  invoke(): AsyncIterable<AgentMessage> {
    return (async function* (): AsyncIterable<AgentMessage> {})();
  },
};

/** Build a registry over the standard three agents. */
export function makeRegistry(
  configs: readonly AgentConfig[] = ALL_CONFIGS,
): AgentRegistryImpl {
  const services: Record<string, AgentService> = {};
  for (const c of configs) {
    services[c.id as string] = noopService;
  }
  return new AgentRegistryImpl(configs, services);
}

/** One recorded invoke call (for asserting serial context passing, etc.). */
export interface RecordedInvoke {
  readonly agentId: AgentId;
  readonly prompt: string;
  readonly context: InvocationContext;
}

export interface RecordingInvoke {
  readonly invoke: InvokeAgentFn;
  readonly calls: RecordedInvoke[];
}

/**
 * A recording invoke seam: each agent yields a single `text` event with its
 * scripted reply (default empty), then a `done`. Records every call's
 * (agentId, prompt, context).
 */
export function makeRecordingInvoke(
  replies: Readonly<Record<string, string>> = {},
): RecordingInvoke {
  const calls: RecordedInvoke[] = [];
  const invoke: InvokeAgentFn = (args: InvokeAgentArgs): AsyncIterable<AgentMessage> => {
    calls.push({ agentId: args.agentId, prompt: args.prompt, context: args.context });
    const reply = replies[args.agentId as string] ?? '';
    return (async function* (): AsyncIterable<AgentMessage> {
      if (reply !== '') {
        yield { type: 'text', agentId: args.agentId, content: reply, timestamp: FIXED_TS };
      }
      yield { type: 'done', agentId: args.agentId, isFinal: true, timestamp: FIXED_TS };
    })();
  };
  return { invoke, calls };
}

/** Drain an async generator into an array. */
export async function drain(
  gen: AsyncGenerator<AgentMessage>,
): Promise<AgentMessage[]> {
  const out: AgentMessage[] = [];
  for await (const event of gen) {
    out.push(event);
  }
  return out;
}
