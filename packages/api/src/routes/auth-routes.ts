// auth-routes — the OAuth / subscription-login surface of 账户与密钥 (M8).
//
// The API-key (BYOK) half is account-routes; this is the OAuth half: it reports
// each provider CLI's login status (`claude auth status`, etc.) and triggers its
// native `login` / `logout`. The CLI owns the browser OAuth — login spawns it
// detached (it opens the browser on the local machine) and the route returns at
// once; the UI re-reads status after the user finishes.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppServices } from '@choco/api/infrastructure/app-services';
import {
  getAllProviderAuth,
  triggerProviderLogin,
  triggerProviderLogout,
} from '@choco/api/config/provider-auth';

const ClientParamsSchema = z.object({ clientId: z.enum(['anthropic', 'openai', 'google']) });

/**
 * Register the OAuth/login routes:
 *   GET  /api/auth                      → every provider's login status
 *   POST /api/auth/:clientId/login      → trigger the CLI's browser login (detached)
 *   POST /api/auth/:clientId/logout     → trigger the CLI's logout
 */
export function registerAuthRoutes(app: FastifyInstance, services: AppServices): void {
  const runner = services.authRunner;

  app.get('/api/auth', async (_request, reply) => {
    return reply.send({ providers: await getAllProviderAuth(runner) });
  });

  app.post('/api/auth/:clientId/login', async (request, reply) => {
    const params = ClientParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_params' });
    const result = triggerProviderLogin(runner, params.data.clientId);
    if (!result.ok) return reply.code(409).send({ error: 'login_unavailable', reason: result.reason });
    return reply.send({ ok: true });
  });

  app.post('/api/auth/:clientId/logout', async (request, reply) => {
    const params = ClientParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_params' });
    const result = await triggerProviderLogout(runner, params.data.clientId);
    if (!result.ok) return reply.code(409).send({ error: 'logout_unavailable', reason: result.reason });
    return reply.send({ ok: true });
  });
}
