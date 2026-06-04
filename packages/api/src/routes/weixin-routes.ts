// weixin-routes — the browser-facing personal-WeChat (iLink) QR-login surface.
//
// Drives the manager: start a login (fetch a QR), poll the scan status (a confirm
// persists the bot_token + starts the long-poll adapter), report connection state,
// and logout. The bot_token NEVER crosses the API boundary — login/status return
// only the QR + a status string.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { WeixinManager } from '@choco/api/runtime/weixin-manager';

const StatusQuerySchema = z.object({ qrPayload: z.string().min(1).max(512) });

/**
 * Register the personal-WeChat routes (manager passed directly — it is stateful
 * and not part of the per-route AppServices bundle):
 *   POST /api/adapters/weixin/login/start   → { qrUrl, qrPayload }
 *   GET  /api/adapters/weixin/login/status  → { status, message? }
 *   GET  /api/adapters/weixin/status        → { connected, hasToken }
 *   POST /api/adapters/weixin/logout        → { ok: true }
 */
export function registerWeixinRoutes(app: FastifyInstance, manager: WeixinManager): void {
  app.post('/api/adapters/weixin/login/start', async (_request, reply) => {
    try {
      const qr = await manager.loginStart();
      return reply.send({ qrUrl: qr.qrUrl, qrPayload: qr.qrPayload });
    } catch (err) {
      return reply.code(502).send({ error: 'qr_unavailable', message: String(err) });
    }
  });

  app.get('/api/adapters/weixin/login/status', async (request, reply) => {
    const q = StatusQuerySchema.safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: 'invalid_params' });
    const result = await manager.loginPoll(q.data.qrPayload);
    // Never echo the bot_token; 'confirmed' just means connected now.
    return reply.send(
      result.status === 'error'
        ? { status: 'error', message: result.message }
        : { status: result.status },
    );
  });

  app.get('/api/adapters/weixin/status', async (_request, reply) => {
    return reply.send(manager.status());
  });

  app.post('/api/adapters/weixin/logout', async (_request, reply) => {
    await manager.logout();
    return reply.send({ ok: true });
  });
}
