// account-routes — the browser-facing provider-account / API-key surface (M8).
//
// Serves the `账户与密钥` settings tab: list/create/update/delete provider accounts
// (Anthropic/OpenAI/Google) with an optional BYOK api key. The key is WRITE-ONLY
// across the boundary — POST/PATCH accept `apiKey`, but GET never returns it (only
// `hasApiKey`). Granting a key persists it to ~/.choco/credentials.json (0600);
// the invoke seam injects it into the agent CLI's spawn env on the next turn.
//
// Aligned with Clowder's accounts API (GET/POST/PATCH/DELETE /api/accounts), adapted
// to our ClientId union + the masked AccountSummary read shape.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppServices } from '@choco/api/infrastructure/app-services';

const ClientIdSchema = z.enum(['anthropic', 'openai', 'google']);
const AuthTypeSchema = z.enum(['api_key', 'oauth']);

const CreateBodySchema = z.object({
  clientId: ClientIdSchema,
  authType: AuthTypeSchema.default('api_key'),
  displayName: z.string().min(1).max(80),
  baseUrl: z.string().max(2048).optional(),
  models: z.array(z.string().min(1).max(120)).max(64).optional(),
  apiKey: z.string().max(8192).optional(),
});

const UpdateBodySchema = z.object({
  displayName: z.string().min(1).max(80).optional(),
  authType: AuthTypeSchema.optional(),
  baseUrl: z.string().max(2048).optional(),
  models: z.array(z.string().min(1).max(120)).max(64).optional(),
  // Empty string CLEARS the stored key; omitted leaves it unchanged.
  apiKey: z.string().max(8192).optional(),
});

const IdParamsSchema = z.object({ id: z.string().min(1) });

/**
 * Register the browser-facing account routes:
 *   GET    /api/accounts        → masked summaries (hasApiKey only)
 *   POST   /api/accounts        → create (+ optional apiKey)
 *   PATCH  /api/accounts/:id    → update metadata and/or apiKey
 *   DELETE /api/accounts/:id    → delete account + its secret
 */
export function registerAccountRoutes(app: FastifyInstance, services: AppServices): void {
  const { accountStore } = services;

  app.get('/api/accounts', async (_request, reply) => {
    return reply.send({ accounts: accountStore.listSummaries() });
  });

  app.post('/api/accounts', async (request, reply) => {
    const body = CreateBodySchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_params' });
    const summary = accountStore.create({
      clientId: body.data.clientId,
      authType: body.data.authType,
      displayName: body.data.displayName,
      ...(body.data.baseUrl !== undefined ? { baseUrl: body.data.baseUrl } : {}),
      ...(body.data.models !== undefined ? { models: body.data.models } : {}),
      ...(body.data.apiKey !== undefined ? { apiKey: body.data.apiKey } : {}),
    });
    return reply.code(201).send({ account: summary });
  });

  app.patch('/api/accounts/:id', async (request, reply) => {
    const params = IdParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_params' });
    const body = UpdateBodySchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_params' });
    const summary = accountStore.update(params.data.id, body.data);
    if (summary === undefined) return reply.code(404).send({ error: 'account_not_found' });
    return reply.send({ account: summary });
  });

  app.delete('/api/accounts/:id', async (request, reply) => {
    const params = IdParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_params' });
    const deleted = accountStore.delete(params.data.id);
    if (!deleted) return reply.code(404).send({ error: 'account_not_found' });
    return reply.send({ ok: true });
  });
}
