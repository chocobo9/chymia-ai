// wechat-routes — the browser-facing WeCom (企业微信) adapter config surface (M13).
//
// Lets the user configure the IM integration from 设置 → IM 对接 instead of editing
// env files: corpId / secret / token / apiBase + an enabled toggle, persisted to
// ~/.choco/wechat.json. The secret is WRITE-ONLY (GET returns hasSecret, never the
// secret). The adapter is wired at API START (the webhook registers before listen),
// so a config change takes effect on the next API restart — the view's `ready`
// flag tells the UI whether the saved config WOULD wire.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppServices } from '@choco/api/infrastructure/app-services';

const ConfigBodySchema = z.object({
  corpId: z.string().max(120).optional(),
  agentId: z.string().max(64).optional(),
  token: z.string().max(256).optional(),
  apiBase: z.string().max(2048).optional(),
  enabled: z.boolean().optional(),
  // Empty string CLEARS the stored secret/key; omitted leaves it unchanged.
  secret: z.string().max(2048).optional(),
  encodingAesKey: z.string().max(128).optional(),
});

/**
 * Register the WeCom config routes:
 *   GET  /api/adapters/wechat/config  → masked view (hasSecret, webhookPath, ready)
 *   PUT  /api/adapters/wechat/config  → set config (secret write-only)
 */
export function registerWeChatRoutes(app: FastifyInstance, services: AppServices): void {
  const store = services.wechatConfigStore;

  app.get('/api/adapters/wechat/config', async (_request, reply) => {
    return reply.send({ config: store.getView() });
  });

  app.put('/api/adapters/wechat/config', async (request, reply) => {
    const body = ConfigBodySchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_params' });
    return reply.send({ config: store.set(body.data) });
  });
}
