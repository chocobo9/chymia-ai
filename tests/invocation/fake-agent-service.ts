// tests/invocation/fake-agent-service.ts
// Dev test helper: a scriptable AgentService that yields a fixed AsyncIterable
// of AgentMessage events and records the InvokeOptions it was called with.
// No CLI is spawned — this drives invokeSingleAgent deterministically.

import type { AgentId, AgentMessage } from '@choco/shared';
import type { AgentService, InvokeOptions } from '@choco/api/providers/base';
import {
  createClaudeParserState,
  parseClaudeLine,
  type ParserState,
} from '@choco/api/providers/claude/claude-parser';

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

/**
 * A fidelity-faithful fake AgentService that drives the REAL Claude stream-json
 * parser over raw NDJSON lines, then appends a terminal `done`.
 *
 * Why this exists (#5 test-fidelity gap): the plain {@link FakeAgentService} emits
 * already-clean `AgentMessage`s, so it can never reproduce the real
 * "--include-partial-messages" shape (incremental text_deltas FOLLOWED BY a
 * consolidated `assistant` text block) that doubled the persisted reply in the live
 * demo. This fake feeds RAW lines through `parseClaudeLine`, so any future regression
 * that re-doubles the text at the parser layer surfaces through the SAME pipeline the
 * product uses (message-handler accumulation → persisted reply).
 */
export class RealClaudeParserAgentService implements AgentService {
  readonly calls: RecordedInvoke[] = [];

  constructor(
    private readonly agentId: AgentId,
    /** Raw Claude stream-json NDJSON lines to replay through the real parser. */
    private readonly rawLines: readonly string[],
    private readonly now: () => number,
  ) {}

  invoke(prompt: string, options?: InvokeOptions): AsyncIterable<AgentMessage> {
    this.calls.push({ prompt, options });
    const agentId = this.agentId;
    const rawLines = this.rawLines;
    const now = this.now;
    return (async function* (): AsyncIterable<AgentMessage> {
      let state: ParserState = createClaudeParserState();
      const deps = { agentId, now, model: 'claude-opus-4-6' };
      for (const line of rawLines) {
        const result = parseClaudeLine(line, state, deps);
        state = result.state;
        for (const msg of result.messages) {
          yield msg;
        }
      }
      // Terminal done, as the real ClaudeAgentService emits on clean exit.
      yield { type: 'done', agentId, isFinal: true, timestamp: now() };
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
