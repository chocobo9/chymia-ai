// feishu-routes — the browser-facing Feishu (飞书) config surface.
//
// app_id / app_secret / enabled (long-connection → no callback URL). The
// app_secret is WRITE-ONLY (GET returns hasAppSecret). Saving a complete+enabled
// config connects the long connection at runtime (no restart); the masked view's
// `ready` + the status route tell the UI whether it's connected.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { FeishuManager } from '@choco/api/runtime/feishu-manager';

const ConfigBodySchema = z.object({
  appId: z.string().max(120).optional(),
  enabled: z.boolean().optional(),
  // 飞书 China (open.feishu.cn) vs Lark International (open.larksuite.com) — picks
  // the long-connection gateway. Wrong region → WS error 1000040351.
  domain: z.enum(['feishu', 'lark']).optional(),
  // Empty string CLEARS the stored secret; omitted leaves it unchanged.
  appSecret: z.string().max(512).optional(),
});

/**
 * Register the Feishu routes (manager passed directly — it is stateful):
 *   GET  /api/adapters/feishu/config  → { config }   (masked)
 *   PUT  /api/adapters/feishu/config  → { config }   (set + connect/disconnect)
 *   GET  /api/adapters/feishu/status  → { connected, ready }
 */
export function registerFeishuRoutes(app: FastifyInstance, manager: FeishuManager): void {
  app.get('/api/adapters/feishu/config', async (_request, reply) => {
    return reply.send({ config: manager.getView() });
  });

  app.put('/api/adapters/feishu/config', async (request, reply) => {
    const body = ConfigBodySchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_params' });
    const config = await manager.applyConfig(body.data);
    return reply.send({ config, status: manager.status() });
  });

  app.get('/api/adapters/feishu/status', async (_request, reply) => {
    return reply.send(manager.status());
  });
}
