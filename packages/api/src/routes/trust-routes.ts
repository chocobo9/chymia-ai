// trust-routes — the BROWSER-facing workspace-trust surface (M8).
//
// VSCode-style "do you trust this workspace?" — the GUI half the design always
// intended (workspace-trust.ts: "a GUI dialog in the future packaged app"). The
// terminal launcher (`scripts/ensure-trust.ts`) prompts on a `pnpm app` start;
// this serves the WEB app (and, later, the packaged desktop/exe app — same two
// endpoints) so a browser-launched server can be trusted WITHOUT a terminal.
//
// Same WorkspaceTrustStore + applyWorkspaceTrustEnv the launcher (main.ts) uses —
// one source of truth, no parallel half-store. Granting trust here PERSISTS it
// (remembered forever) AND applies the providers' trust env onto this live
// process, so subsequent agent spawns (which inherit process.env) get gemini's
// GEMINI_CLI_TRUST_WORKSPACE without a restart. We never auto-approve a directory
// the user hasn't explicitly trusted — granting is the ONLY thing that sets the env.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppServices } from '@choco/api/infrastructure/app-services';
import {
  WorkspaceTrustStore,
  resolveTrustStorePath,
  applyWorkspaceTrustEnv,
} from '@choco/api/runtime/workspace-trust';

const TrustBodySchema = z.object({ trust: z.boolean() });

/** Response shape for both trust routes (workspace is null when none is configured). */
interface TrustStatusResponse {
  readonly workspace: string | null;
  readonly trusted: boolean;
}

/**
 * Register the browser-facing workspace-trust routes on `app`:
 *   GET  /api/trust  → { workspace, trusted } for the agents' workspace (cwd)
 *   POST /api/trust  → body { trust: boolean }; grant persists + applies the env
 *
 * When no workspace is configured (e.g. a test build without defaultWorkspace)
 * there is nothing to gate, so we report trusted:true and the UI never blocks.
 */
export function registerTrustRoutes(app: FastifyInstance, services: AppServices): void {
  const store = new WorkspaceTrustStore(resolveTrustStorePath());
  const workspace = services.defaultWorkspace;

  app.get('/api/trust', async (_request, reply) => {
    if (workspace === undefined || workspace.length === 0) {
      return reply.send({ workspace: null, trusted: true } satisfies TrustStatusResponse);
    }
    return reply.send({
      workspace,
      trusted: store.isTrusted(workspace),
    } satisfies TrustStatusResponse);
  });

  app.post('/api/trust', async (request, reply) => {
    const body = TrustBodySchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: 'invalid_params' });
    if (workspace === undefined || workspace.length === 0) {
      return reply.send({ workspace: null, trusted: true } satisfies TrustStatusResponse);
    }
    if (body.data.trust) {
      store.trust(workspace);
      // Apply NOW so the running process's next agent spawn inherits the trust env
      // (gemini's headless auto-approve) without waiting for a restart.
      applyWorkspaceTrustEnv(process.env);
      return reply.send({ workspace, trusted: true } satisfies TrustStatusResponse);
    }
    // Explicit "not now" → leave untrusted (restricted mode); report current state.
    return reply.send({
      workspace,
      trusted: store.isTrusted(workspace),
    } satisfies TrustStatusResponse);
  });
}
