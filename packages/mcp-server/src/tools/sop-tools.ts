// M10 sop-tools — sop_advance_stage.
//
// Source: clowder-architecture-design.md §5.6 (SOP 告示牌) + the M8 callback
// contract: POST /api/callback/sop_advance_stage with `{ stageId }` → 200
// { stageId } / unknown stage → 400. This is the agent "提议转阶段" path: the
// agent proposes its OWN thread's next SOP stage; the effect shows on the
// agent's NEXT invocation's prompt hint.
//
// Identity (threadId) is the verified record's server-side — we send ONLY the
// stageId, never a threadId (`.strict()` server-side would reject it, and it
// would be an identity-smuggle vector).

import { z } from 'zod';
import type { CallbackClient } from '../callback-client.js';
import { toToolResult } from '../tool-result.js';
import type { ToolDef } from './tool-def.js';

const sopAdvanceStageInputSchema = {
  stageId: z
    .string()
    .min(1)
    .describe(
      'The SOP stage id to advance this thread to (e.g. impl, quality_gate, ' +
        'review, merge). Must be a known stage of the active SOP definition; ' +
        'an unknown stage is rejected by the server.',
    ),
} as const;

/** Build the SOP tool group from the shared callback client. */
export function buildSopTools(client: CallbackClient): ToolDef[] {
  return [
    {
      name: 'sop_advance_stage',
      description:
        "Propose advancing the current thread to a SOP stage (告示牌, not a gate). " +
        'The new stage hint appears on the next invocation in this thread.',
      inputSchema: sopAdvanceStageInputSchema,
      handler: async (args) => {
        const input = z.object(sopAdvanceStageInputSchema).parse(args);
        return toToolResult(await client.post('sop_advance_stage', { stageId: input.stageId }));
      },
    },
  ];
}
