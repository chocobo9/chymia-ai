// M12 SOP-Cycle-2 trace adapter — thread tool-events → SopTraceContext.
//
// Source: clowder-architecture-design.md §5.6 (SopTraceInput.context) + this
// cycle's decision (evaluate the OUTGOING stage when it is left). A thread's
// accumulated tool calls are the only post-hoc signal a chat thread can supply:
// we extract the command strings that command-runner tools executed and feed
// them to the command_pattern predicate. git/reviewer/env fields are NOT
// observable from a chat thread, so they are left undefined — the git_state /
// handle_check / env predicates then correctly report `skipped` (NOT a false
// violation), which is the intended advisory behaviour.
//
// CAVEAT: this evaluates the WHOLE thread's trace (we do not track per-stage
// windows). For an advisory "只提示不拦截" signal that is acceptable: a command
// run at any point in the thread satisfies a command_pattern rule. Noted here so
// a future cycle that wants per-stage precision knows the boundary.

import type { AgentId, StoredToolEvent } from '@choco/shared';
import type { SopTraceContext } from './predicates/predicate-types.js';

/**
 * Tool names that run a shell command (and therefore carry a `command` string in
 * their tool input). Kept as a named constant (no magic string in the body) so
 * the command-runner vocabulary is declared in one place. `Bash` is the command
 * tool the providers emit for shell execution; aliases are listed for forward
 * compatibility with other shell-ish tool names in the vocabulary.
 */
const COMMAND_TOOL_NAMES: ReadonlySet<string> = new Set(['Bash', 'Shell', 'Exec', 'Run']);

/** The tool-input key that holds the executed command string for a shell tool. */
const COMMAND_INPUT_KEY = 'command';

/**
 * Parse a `StoredToolEvent.toolInput` (a JSON string per A6) defensively and
 * return its `command` field when present. Malformed/absent input → undefined
 * (skip it; never throw — the adapter must stay best-effort).
 */
function extractCommand(toolInput: string | undefined): string | undefined {
  if (toolInput === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolInput);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const value = (parsed as Record<string, unknown>)[COMMAND_INPUT_KEY];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Build a {@link SopTraceContext} from a thread's tool events.
 *
 * - `commands`: the command strings extracted from command-runner tool events.
 * - `authorId`: the explicit `advancedBy` agent (the one advancing the stage) if
 *   supplied, else the most recent tool event's agentId, else undefined.
 * - `reviewerId` / `gitAhead` / `gitBehind` / `env`: undefined — not observable
 *   from a chat thread, so their predicates correctly `skip`.
 */
export function buildSopTraceContext(
  events: readonly StoredToolEvent[],
  advancedBy?: AgentId,
): SopTraceContext {
  const commands: string[] = [];
  for (const event of events) {
    if (!COMMAND_TOOL_NAMES.has(event.toolName)) continue;
    const command = extractCommand(event.toolInput);
    if (command !== undefined) commands.push(command);
  }

  const lastEvent = events.length > 0 ? events[events.length - 1] : undefined;
  const authorId =
    advancedBy !== undefined ? (advancedBy as string) : (lastEvent?.agentId as string | undefined);

  return {
    commands,
    ...(authorId !== undefined ? { authorId } : {}),
  };
}
