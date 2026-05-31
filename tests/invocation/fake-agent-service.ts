// tests/invocation/fake-agent-service.ts
// Dev test helper: a scriptable AgentService that yields a fixed AsyncIterable
// of AgentMessage events and records the InvokeOptions it was called with.
// No CLI is spawned — this drives invokeSingleAgent deterministically.

import type { AgentId, AgentMessage } from '@clowder/shared';
import type { AgentService, InvokeOptions } from '@clowder/api/providers/base';

/** One recorded invocation: the prompt and the options it was called with. */
export interface RecordedInvoke {
  readonly prompt: string;
  readonly options: InvokeOptions | undefined;
}

/**
 * A fake AgentService whose `invoke` replays a list of scripts — one script per
 * call. Each script is an array of AgentMessage events yielded in order.
 * Records every (prompt, options) for assertions about session passing.
 */
export class FakeAgentService implements AgentService {
  readonly calls: RecordedInvoke[] = [];
  private callIndex = 0;

  constructor(private readonly scripts: readonly (readonly AgentMessage[])[]) {}

  invoke(prompt: string, options?: InvokeOptions): AsyncIterable<AgentMessage> {
    this.calls.push({ prompt, options });
    const script = this.scripts[this.callIndex] ?? [];
    this.callIndex += 1;
    return (async function* (): AsyncIterable<AgentMessage> {
      for (const event of script) {
        yield event;
      }
    })();
  }
}

/** Build a `session_init` event carrying a CLI session id in `content`. */
export function sessionInit(agentId: AgentId, sessionId: string, ts: number): AgentMessage {
  return { type: 'session_init', agentId, content: sessionId, timestamp: ts };
}

/** Build a streamed `text` event. */
export function textEvent(agentId: AgentId, content: string, ts: number): AgentMessage {
  return { type: 'text', agentId, content, timestamp: ts };
}

/** Build a terminal `done` event. */
export function doneEvent(agentId: AgentId, ts: number, isFinal = true): AgentMessage {
  return { type: 'done', agentId, isFinal, timestamp: ts };
}
