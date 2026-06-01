// Operability — runtime invariant probes (the "silent-bug catchers").
//
// These turn "no error, but WRONG" into observable WARN alerts. Each probe is a
// small pure check + a logger.warn(...) on violation, emitting through the
// EXISTING {@link RouteLogger} seam. Because the seam defaults to a no-op in
// buildApp (NOOP_LOGGER) and only becomes the real file logger at the edge
// (main.ts), probes are SILENT during tests unless a capturing logger is
// injected — so they add observability in production without spamming the suite.
//
// Each probe returns `true` when it FIRED a warning (violation seen), `false`
// otherwise — so callers/tests can branch on it and QA can assert firing without
// reaching into the logger. The checks themselves are deterministic and pure;
// only the warn side-effect goes through the injected logger.
//
// Probes implemented (mapped to the bugs they would have caught):
//   1. checkWorkspaceMatch  — agent's resolved workingDirectory === resolved
//      workspace (would've caught the prior workspace-wire bug).
//   2. checkReplyNotDuplicated — an agent reply is not a verbatim self-doubling
//      (would've caught the prior reply-doubling bug).
//   3. checkToolWritePathInside — a tool file-write path resolves INSIDE the
//      workspace (flags path-escape / traversal writes).
//   4. checkInvocationProductive — an invocation produced output and did not
//      spike errors (flags silent zero-output / error-burst turns).

import { resolve, relative, isAbsolute } from 'node:path';
import type { AgentId } from '@clowder/shared';
import type { RouteLogger } from '@clowder/api/routing/agent-router';

/** Common identity carried on every probe warning for correlation. */
export interface ProbeContext {
  readonly threadId: string;
  readonly agentId?: AgentId;
}

/** Emit a probe warning through the {@link RouteLogger} seam and signal fired. */
function fire(logger: RouteLogger, ctx: ProbeContext, message: string): true {
  logger({
    level: 'warn',
    message,
    threadId: ctx.threadId,
    ...(ctx.agentId !== undefined ? { agentId: ctx.agentId } : {}),
  });
  return true;
}

/**
 * INVARIANT 1 — the agent's resolved CLI working directory must equal the
 * resolved workspace it was supposed to run in. A mismatch means the workspace
 * wiring drifted (the prior bug: agents silently ran in the wrong cwd). When the
 * expected workspace is undefined (no projectPath, no defaultWorkspace) the
 * provider intentionally spawns with no cwd — that is the documented pre-wire
 * behavior, so we do NOT warn on the both-undefined case.
 *
 * Paths are compared via `relative()` (empty result ⇒ same directory) rather than
 * a raw `===` on `resolve()` outputs. This makes the comparison case-insensitive
 * on win32 — matching probe 3 ({@link checkToolWritePathInside}) — so on the
 * project's case-insensitive Windows FS `C:\…` vs `c:\…` is correctly treated as
 * the SAME directory and does not false-warn. `./x` vs an absolute form of the
 * same dir also normalize equal. Returns true iff a warning fired.
 */
export function checkWorkspaceMatch(
  logger: RouteLogger,
  ctx: ProbeContext,
  resolvedWorkingDirectory: string | undefined,
  expectedWorkspace: string | undefined,
): boolean {
  if (expectedWorkspace === undefined) {
    return false; // no expectation to violate (pre-wire no-cwd behavior)
  }
  const expected = resolve(expectedWorkspace);
  if (resolvedWorkingDirectory === undefined) {
    return fire(
      logger,
      ctx,
      `invariant: workingDirectory is unset but workspace was expected to be "${expected}"`,
    );
  }
  const actual = resolve(resolvedWorkingDirectory);
  // `relative()` is case-insensitive on win32; an empty result means the two
  // paths denote the same directory (so case-only/`.`/round-trip differences
  // are not drift). Any non-empty relative path is genuine drift.
  if (relative(expected, actual) !== '') {
    return fire(
      logger,
      ctx,
      `invariant: workingDirectory "${actual}" != expected workspace "${expected}"`,
    );
  }
  return false;
}

/**
 * Smallest reply length (chars) worth duplication-checking. Below this a
 * "duplicate" is almost certainly a legitimately repeated short token (e.g. "ok
 * ok") and not the structural doubling bug we hunt, so we skip to avoid noise.
 */
const MIN_DUP_CHECK_LENGTH = 16;

/**
 * INVARIANT 2 — an agent reply must not be an exact verbatim self-duplication
 * (the whole text repeated back-to-back). The prior bug doubled replies; this
 * catches the structural `X + X` shape: trimmed text of even length whose first
 * half equals its second half. Substring repetition inside normal prose does NOT
 * trip it — only a clean halves-equal split does. Returns true iff a warning fired.
 */
export function checkReplyNotDuplicated(
  logger: RouteLogger,
  ctx: ProbeContext,
  replyText: string,
): boolean {
  const text = replyText.trim();
  if (text.length < MIN_DUP_CHECK_LENGTH || text.length % 2 !== 0) {
    return false;
  }
  const half = text.length / 2;
  const first = text.slice(0, half);
  const second = text.slice(half);
  if (first === second) {
    return fire(
      logger,
      ctx,
      `invariant: agent reply appears self-duplicated (${half}-char block repeated verbatim)`,
    );
  }
  return false;
}

/**
 * INVARIANT 3 — a tool file-write path must resolve INSIDE the workspace. An
 * absolute path outside the workspace, or one that climbs out via `..`, is a
 * sandbox escape and is flagged. When no workspace is configured we cannot judge
 * containment, so we do not warn (nothing to contain against). Returns true iff
 * a warning fired.
 */
export function checkToolWritePathInside(
  logger: RouteLogger,
  ctx: ProbeContext,
  writePath: string,
  workspace: string | undefined,
  toolName: string,
): boolean {
  if (workspace === undefined) {
    return false;
  }
  const root = resolve(workspace);
  const target = isAbsolute(writePath) ? resolve(writePath) : resolve(root, writePath);
  const rel = relative(root, target);
  const escapes = rel.startsWith('..') || isAbsolute(rel);
  if (escapes) {
    return fire(
      logger,
      ctx,
      `invariant: tool "${toolName}" write path "${target}" resolves OUTSIDE workspace "${root}"`,
    );
  }
  return false;
}

/** The post-invocation summary an invocation produced, fed to invariant 4. */
export interface InvocationOutcome {
  /** Total characters of text the agent emitted this turn. */
  readonly textLength: number;
  /** Count of tool calls the agent made this turn. */
  readonly toolCallCount: number;
  /** Count of `error` events emitted this turn. */
  readonly errorCount: number;
}

/**
 * Error-count at/above which a turn is treated as an error SPIKE (not a single
 * recoverable hiccup). Two+ errors in one turn is the threshold — a turn that
 * keeps erroring is a degraded turn worth surfacing even if it "completes".
 */
const ERROR_SPIKE_THRESHOLD = 2;

/**
 * INVARIANT 4 — an invocation should be productive: it must emit SOME output
 * (text or a tool call) and must not spike errors. A turn that finishes with no
 * text, no tool calls, and no error is a silent dead turn (the user got nothing
 * back with no signal why); a turn with an error spike is degraded. Both are
 * flagged. Returns true iff a warning fired.
 */
export function checkInvocationProductive(
  logger: RouteLogger,
  ctx: ProbeContext,
  outcome: InvocationOutcome,
): boolean {
  if (outcome.errorCount >= ERROR_SPIKE_THRESHOLD) {
    return fire(
      logger,
      ctx,
      `invariant: invocation produced an error spike (${outcome.errorCount} error events)`,
    );
  }
  const producedNothing =
    outcome.textLength === 0 && outcome.toolCallCount === 0 && outcome.errorCount === 0;
  if (producedNothing) {
    return fire(
      logger,
      ctx,
      'invariant: invocation produced 0 output (no text, no tool calls, no error)',
    );
  }
  return false;
}
