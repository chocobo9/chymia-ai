// Operability — the /health liveness endpoint.
//
// A tiny unauthenticated route so a supervisor / load balancer / human can
// confirm the API process is up and responsive. Mirrors the CatCafe operability
// idea (a cheap health probe) adapted to our Fastify app. Registered in buildApp
// — harmless to tests (no logger, no side effects, pure in-memory read).
//
// Reports process uptime (ms) so a restart is observable: a freshly supervised
// child reports a small uptimeMs, which is how the launcher's restart loop can be
// seen to have taken effect.

import type { FastifyInstance } from 'fastify';

/** The payload returned by GET /health. */
export interface HealthPayload {
  readonly status: 'ok';
  /** Process uptime in milliseconds (process.uptime() is seconds → ×1000). */
  readonly uptimeMs: number;
  /** Wall-clock time the health check was served (epoch ms). */
  readonly timestamp: number;
}

/**
 * Register GET /health on `app`. Injectable clock so a deterministic test can
 * assert the timestamp without wall-clock flake; uptime always comes from the
 * live process (that is the value being reported).
 */
export function registerHealthRoutes(
  app: FastifyInstance,
  options: { readonly now?: () => number } = {},
): void {
  const now = options.now ?? Date.now;
  app.get('/health', async (_request, reply) => {
    const payload: HealthPayload = {
      status: 'ok',
      uptimeMs: Math.round(process.uptime() * 1000),
      timestamp: now(),
    };
    return reply.send(payload);
  });
}
