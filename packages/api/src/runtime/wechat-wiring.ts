// packages/api/src/runtime/wechat-wiring.ts
// M13 runtime wiring — the missing entrypoint that turns the BUILT-but-unwired
// WeChat (WeCom) adapter into a LIVE webhook. The composition root (main.ts) calls
// this between buildApp() and api.listen(): when the persisted config is enabled +
// complete, it constructs the adapter (which registers its /api/adapters/wechat/
// webhook on the Fastify instance) and starts it. Not configured / disabled →
// returns false and the platform stays web-only (honest no-op, never throws).

import type { FastifyInstance } from 'fastify';
import {
  createWeChatAdapter,
  type SubmitPlatformMessage,
  type AdapterLogger,
} from '@choco/adapters/wechat';
import type { WeChatConfigStore } from '@choco/api/config/wechat-config-store';

export interface WireWeChatDeps {
  /** The Fastify instance from buildApp().api (the webhook mounts here). */
  readonly api: FastifyInstance;
  /** The platform-ingress seam from buildApp().submitPlatformMessage. */
  readonly submitPlatformMessage: SubmitPlatformMessage;
  /** The persisted WeCom config store (resolves the creds + enabled flag). */
  readonly store: WeChatConfigStore;
  readonly logger?: AdapterLogger;
  readonly now?: () => number;
}

/**
 * Wire the WeChat adapter when configured. Returns true if the adapter was
 * started (webhook live), false if it was skipped (not enabled / missing creds).
 * MUST be called BEFORE api.listen() — the adapter registers routes at construct.
 */
export async function wireWeChatAdapter(deps: WireWeChatDeps): Promise<boolean> {
  const creds = deps.store.resolveAdapterCreds();
  if (creds === null) return false;
  const adapter = createWeChatAdapter({
    api: deps.api,
    submitPlatformMessage: deps.submitPlatformMessage,
    config: creds,
    ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });
  await adapter.start();
  return true;
}
