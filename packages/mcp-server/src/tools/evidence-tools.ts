// M10 evidence-tools — evidence_search + evidence_upsert.
//
// Source: clowder-architecture-design.md §5.7 (tool params) + the FROZEN M8
// callback contract (.harness/progress.md):
//   evidence_search {query, kind?}      → POST /api/callback/evidence_search → 200 EvidenceSearchResult{items,meta}
//   evidence_upsert {anchor,kind,title,summary} → POST /api/callback/evidence_upsert → 201 {anchor,upserted}
//
// We send ONLY the documented fields (server bodies are `.strict()`). The kind
// enum mirrors the EvidenceKind union the API validates against — sending an
// out-of-enum kind would be a 400 from the server, so we validate it here too.

import { z } from 'zod';
import type { CallbackClient } from '../callback-client.js';
import { toToolResult } from '../tool-result.js';
import type { ToolDef } from './tool-def.js';

/** Evidence kinds accepted by the API (matches @clowder/shared EvidenceKind). */
const EVIDENCE_KINDS = [
  'feature',
  'decision',
  'plan',
  'session',
  'lesson',
  'thread',
  'discussion',
  'research',
  'pack-knowledge',
] as const;

const evidenceSearchInputSchema = {
  query: z
    .string()
    .min(1)
    .describe('Search query over shared evidence (FTS5 + semantic hybrid; CJK supported).'),
  kind: z
    .enum(EVIDENCE_KINDS)
    .optional()
    .describe('Optional filter restricting results to one evidence kind.'),
} as const;

const evidenceUpsertInputSchema = {
  anchor: z
    .string()
    .min(1)
    .describe('Stable unique key for this evidence item (re-upserting the same anchor updates it).'),
  kind: z.enum(EVIDENCE_KINDS).describe('The kind of evidence being recorded.'),
  title: z.string().min(1).describe('Short human-readable title.'),
  summary: z.string().min(1).describe('The evidence body — the knowledge to persist for later recall.'),
} as const;

/** Build the evidence tool group from the shared callback client. */
export function buildEvidenceTools(client: CallbackClient): ToolDef[] {
  return [
    {
      name: 'evidence_search',
      description:
        'Search the shared team evidence/memory for relevant items before asking a teammate or making a decision.',
      inputSchema: evidenceSearchInputSchema,
      handler: async (args) => {
        const input = z.object(evidenceSearchInputSchema).parse(args);
        const body: Record<string, unknown> = { query: input.query };
        if (input.kind !== undefined) {
          body.kind = input.kind;
        }
        return toToolResult(await client.post('evidence_search', body));
      },
    },
    {
      name: 'evidence_upsert',
      description:
        'Record a piece of durable knowledge (decision, lesson, plan, research, ...) into the shared evidence store.',
      inputSchema: evidenceUpsertInputSchema,
      handler: async (args) => {
        const input = z.object(evidenceUpsertInputSchema).parse(args);
        return toToolResult(
          await client.post('evidence_upsert', {
            anchor: input.anchor,
            kind: input.kind,
            title: input.title,
            summary: input.summary,
          }),
        );
      },
    },
  ];
}
