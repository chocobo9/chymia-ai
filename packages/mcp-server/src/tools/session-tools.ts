// M10 session-tools — list_session_chain + read_session_digest + read_session_events.
//
// Source: clowder-design-supplement.md 补充 E (session = first-class archived
// artifact: 可列 / 可翻 / 可取证) + the FROZEN M8 contract (.harness/progress.md):
//   list_session_chain {}            → POST /api/callback/list_session_chain → 200 {sessions}  (the record's thread only)
//   read_session_digest {sessionId}  → POST /api/callback/read_session_digest → 200 {sessionId,digest}; cross-thread → 404
//   read_session_events {sessionId}  → POST /api/callback/read_session_events → 200 {sessionId,events}; cross-thread → 404
//
// list_session_chain takes NO body fields — the thread comes from the verified
// record server-side (`.strict()` on {} rejects any smuggled threadId). The two
// read tools take only a sessionId; the thread-ownership check is server-side.

import { z } from 'zod';
import type { CallbackClient } from '../callback-client.js';
import { toToolResult } from '../tool-result.js';
import type { ToolDef } from './tool-def.js';

/** Empty input shape — list_session_chain takes no parameters. */
const listSessionChainInputSchema = {} as const;

const sessionIdInputSchema = {
  sessionId: z.string().min(1).describe('The id of the session (from list_session_chain) to inspect.'),
} as const;

/** Build the session tool group from the shared callback client. */
export function buildSessionTools(client: CallbackClient): ToolDef[] {
  return [
    {
      name: 'list_session_chain',
      description:
        "List this thread's session chain (each agent session in order, with sequence, status, and digest summary).",
      inputSchema: listSessionChainInputSchema,
      handler: async () => {
        // No body fields — identity (thread) is the verified record's.
        return toToolResult(await client.post('list_session_chain', {}));
      },
    },
    {
      name: 'read_session_digest',
      description: 'Read the digest (message/tool/file/error summary) of one archived session in this thread.',
      inputSchema: sessionIdInputSchema,
      handler: async (args) => {
        const input = z.object(sessionIdInputSchema).parse(args);
        return toToolResult(await client.post('read_session_digest', { sessionId: input.sessionId }));
      },
    },
    {
      name: 'read_session_events',
      description: "Read the full transcript (messages + tool events) of one archived session in this thread.",
      inputSchema: sessionIdInputSchema,
      handler: async (args) => {
        const input = z.object(sessionIdInputSchema).parse(args);
        return toToolResult(await client.post('read_session_events', { sessionId: input.sessionId }));
      },
    },
  ];
}
