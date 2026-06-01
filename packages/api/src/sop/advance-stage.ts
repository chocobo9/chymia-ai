// M12 SOP-Cycle-2 — advance a thread's SOP stage with an ADVISORY post-hoc eval.
//
// Source: this cycle's decision (Makima: "只提示不拦截"). Both the human setter
// (PATCH /api/threads/:id/sop-stage) and the agent self-advance callback
// (POST /api/callback/sop_advance_stage) route through this single helper so the
// post-hoc evaluation fires exactly ONCE per transition — when a stage is LEFT —
// rather than per-turn (which would fire command_pattern noise on every turn).
//
// Non-negotiable behaviour:
//   * The transition ALWAYS happens (updateSopStage) and ALWAYS succeeds.
//   * The evaluation is advisory + best-effort: it runs ONLY when a real
//     (non-null) stage is being left, and is wrapped in a try/catch so a throw
//     from the adapter, evaluateTrace, the logger, or the broadcast NEVER
//     propagates / never fails the caller's request.
//   * Violations are surfaced as a logger `warn` + a `sop_violation` socket
//     broadcast. They are NOT fed back into the agent's prompt (notify only).

import type { AgentId } from '@clowder/shared';
import { createAgentId } from '@clowder/shared';
import type { AppServices } from '@clowder/api/infrastructure/app-services';
import { buildSopTraceContext } from './sop-trace-adapter.js';

/** Sentinel agentId for the SopTraceInput when no advancing/owning agent is known. */
const UNKNOWN_ADVANCER: AgentId = createAgentId('unknown');

/**
 * Update a thread's SOP stage and, if a real stage is being LEFT, run an advisory
 * post-hoc evaluation of that outgoing stage against the thread's accumulated
 * tool-event trace. The transition itself always succeeds; the eval is
 * best-effort and never throws to the caller.
 *
 * @param services    The wired AppServices (threadStore / toolEventLog / sopService / socket / logger).
 * @param threadId    The thread whose stage is changing.
 * @param newStageId  The stage to move to (`null` clears the stage).
 * @param advancedBy  The agent advancing the stage (callback path), if any.
 */
export async function advanceStageWithEval(
  services: AppServices,
  threadId: string,
  newStageId: string | null,
  advancedBy?: AgentId,
): Promise<void> {
  const { threadStore } = services;

  // Capture the stage being LEFT before the transition overwrites it.
  const existing = await threadStore.get(threadId);
  const oldStageId = existing?.sopStageId;

  // The transition — ALWAYS happens (advisory eval must never gate it).
  await threadStore.updateSopStage(threadId, newStageId);

  // Eval fires ONLY when a real stage is being left (first-set / null → no eval).
  if (oldStageId === undefined) return;

  await evaluateLeavingStage(services, { threadId, oldStageId, advancedBy });
}

/** Arguments for the advisory eval of the stage being left. */
interface EvaluateLeavingStageArgs {
  readonly threadId: string;
  readonly oldStageId: string;
  readonly advancedBy?: AgentId;
}

/**
 * Best-effort advisory evaluation of the OUTGOING stage. Wrapped end-to-end in a
 * try/catch: a failure of the adapter, evaluateTrace, the logger, or the
 * broadcast is itself logged (warn) and swallowed — it must NEVER fail the
 * transition that already happened.
 */
async function evaluateLeavingStage(
  services: AppServices,
  args: EvaluateLeavingStageArgs,
): Promise<void> {
  const { toolEventLog, sopService, socket, logger } = services;
  const { threadId, oldStageId, advancedBy } = args;

  try {
    const events = await toolEventLog.readByThread(threadId);
    const context = buildSopTraceContext(events, advancedBy);
    const result = sopService.evaluateTrace(oldStageId, {
      agentId: advancedBy ?? UNKNOWN_ADVANCER,
      threadId,
      responseContent: '',
      context,
    });

    // Advisory: only NON-skipped, real violations matter. `skipped` predicates
    // (git/reviewer/env not observable from a chat thread) are NOT violations.
    if (result.violations.length === 0) return;

    for (const violation of result.violations) {
      logger({
        level: 'warn',
        message: `SOP advisory: ${oldStageId} — ${violation.text} (rule=${violation.ruleId}, severity=${violation.severity})`,
        threadId,
        ...(advancedBy !== undefined ? { agentId: advancedBy } : {}),
      });
    }

    await socket.broadcastSopViolation(threadId, {
      threadId,
      stageId: oldStageId,
      violations: result.violations,
    });
  } catch (err) {
    // Best-effort: the transition already succeeded. Log (never silently swallow)
    // and return — an advisory eval failure must not surface to the caller.
    const reason = err instanceof Error ? err.message : String(err);
    logger({
      level: 'warn',
      message: `SOP advisory eval failed for stage "${oldStageId}": ${reason}`,
      threadId,
      ...(advancedBy !== undefined ? { agentId: advancedBy } : {}),
    });
  }
}
