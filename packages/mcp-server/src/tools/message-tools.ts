// M10 message-tools — post_message.
//
// Source: clowder-architecture-design.md §5.7 + the FROZEN M8 contract
// (.harness/progress.md): post_message body is `{content, clientMessageId?,
// targetAgents?}` → 201 {messageId, routedReplies?} / 200 {deduped:true} /
// unknown target → 400. Identity (author) comes from the verified record
// server-side, so we send ONLY content + optional targetAgents/clientMessageId
// — never threadId/agentId (`.strict()` would reject them, and they would be a
// spoofing vector).

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CallbackClient } from '../callback-client.js';
import { toToolResult } from '../tool-result.js';
import type { ToolDef } from './tool-def.js';

const postMessageInputSchema = {
  content: z.string().min(1).describe('The message content to post into the current thread.'),
  targetAgents: z
    .array(z.string().min(1))
    .nonempty()
    .optional()
    .describe(
      'Optional explicit teammates to route this message to (A2A fan-out). ' +
        'Each must be a known agent id; an unknown id is rejected by the server.',
    ),
} as const;

/** Build the message tool group from the shared callback client. */
export function buildMessageTools(client: CallbackClient): ToolDef[] {
  return [
    {
      name: 'post_message',
      description:
        'Post a message into the current thread (optionally routing it to specific teammates via targetAgents).',
      inputSchema: postMessageInputSchema,
      handler: async (args) => {
        const input = z.object(postMessageInputSchema).parse(args);
        // Always send a clientMessageId so a transient retry of this MCP call
        // dedupes server-side (frozen contract: repeat id → 200 {deduped}).
        const body: Record<string, unknown> = {
          content: input.content,
          clientMessageId: randomUUID(),
        };
        if (input.targetAgents !== undefined) {
          body.targetAgents = input.targetAgents;
        }
        return toToolResult(await client.post('post_message', body));
      },
    },
  ];
}
