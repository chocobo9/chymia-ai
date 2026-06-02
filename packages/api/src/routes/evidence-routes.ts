// M8 evidence-routes — evidence search + manual upsert.
//
// Source: clowder-design-supplement.md §C1:
//   GET  /api/evidence/search?q=... → search the evidence store
//   POST /api/evidence              → manually upsert one EvidenceItem
//
// Backed by the injected M6 SqliteEvidenceStore. search() is fail-open by design
// (degrades to lexical when embeddings are absent); we surface its meta so the
// client can see effectiveMode/degraded. Upsert validates the EvidenceItem shape
// at the boundary (CLAUDE.md input-validation) before persisting.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  EvidenceItem,
  EvidenceKind,
  EvidenceSearchMode,
} from '@choco/shared';
import type { AppServices } from '@choco/api/infrastructure/app-services';

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
] as const satisfies readonly EvidenceKind[];

const EVIDENCE_STATUSES = [
  'active',
  'done',
  'archived',
  'review',
  'invalidated',
] as const;

const SEARCH_MODES = ['lexical', 'semantic', 'hybrid'] as const satisfies readonly EvidenceSearchMode[];

/** Query schema for GET /api/evidence/search. */
const SearchQuerySchema = z
  .object({
    q: z.string().min(1),
    mode: z.enum(SEARCH_MODES).optional(),
    kind: z.enum(EVIDENCE_KINDS).optional(),
    limit: z.coerce.number().int().positive().optional(),
  })
  .strict();

/** Body schema for POST /api/evidence (the manually-writable EvidenceItem fields). */
const UpsertBodySchema = z
  .object({
    anchor: z.string().min(1),
    kind: z.enum(EVIDENCE_KINDS),
    status: z.enum(EVIDENCE_STATUSES),
    title: z.string().min(1),
    summary: z.string().optional(),
    keywords: z.array(z.string().min(1)).optional(),
    sourcePath: z.string().optional(),
    updatedAt: z.string().min(1).optional(),
  })
  .strict();

/**
 * Register the evidence routes on `app`.
 */
export function registerEvidenceRoutes(app: FastifyInstance, services: AppServices): void {
  const { evidenceStore, now } = services;

  app.get('/api/evidence/search', async (request, reply) => {
    const query = SearchQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: 'invalid_query', issues: query.error.issues });
    }
    const { q, mode, kind, limit } = query.data;
    const result = evidenceStore.search(q, {
      ...(mode !== undefined ? { mode } : {}),
      ...(kind !== undefined ? { kind } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return reply.send(result);
  });

  app.post('/api/evidence', async (request, reply) => {
    const body = UpsertBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });
    }
    const data = body.data;
    const item: EvidenceItem = {
      anchor: data.anchor,
      kind: data.kind,
      status: data.status,
      title: data.title,
      ...(data.summary !== undefined ? { summary: data.summary } : {}),
      ...(data.keywords !== undefined ? { keywords: data.keywords } : {}),
      ...(data.sourcePath !== undefined ? { sourcePath: data.sourcePath } : {}),
      updatedAt: data.updatedAt ?? new Date(now()).toISOString(),
    };
    evidenceStore.upsert(item);
    return reply.code(201).send({ anchor: item.anchor, upserted: true });
  });
}
