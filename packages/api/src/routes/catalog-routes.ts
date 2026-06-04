// catalog-routes — read-only settings catalogs for the settings overlay:
//   GET /api/skills     → the M11 skill manifest (id + routing metadata)
//   GET /api/sop        → the M12 loaded SOP definition (stages)
//   GET /api/mcp/tools  → the M10 MCP tool catalog (name + description)
//
// Read-only by design: these LIST the loaded definitions. Editing/management
// (uploading skills, MCP servers, SOP authoring) is a separate, unbuilt concern —
// the settings panes are honest about that. No fabricated data: each reflects the
// real loaded manifest / definition / tool registry.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppServices } from '@choco/api/infrastructure/app-services';
// The MCP tool DEFS (name + description) come from the mcp-server's tool factories.
// These modules are SDK-free (only the server entrypoint imports the MCP SDK), so
// importing them here to CATALOG tool metadata stays light. Handlers are never run.
import { CallbackClient } from '@choco/mcp-server/callback-client';
import { buildEvidenceTools } from '@choco/mcp-server/tools/evidence-tools';
import { buildMessageTools } from '@choco/mcp-server/tools/message-tools';
import { buildFileTools } from '@choco/mcp-server/tools/file-tools';
import { buildSessionTools } from '@choco/mcp-server/tools/session-tools';
import { buildSopTools } from '@choco/mcp-server/tools/sop-tools';

/** One MCP tool's catalog entry (no handler / input schema). */
interface McpToolEntry {
  readonly name: string;
  readonly description: string;
}

/** Build the MCP tool catalog (name + description) — pure, runs no handler. */
function mcpToolCatalog(): McpToolEntry[] {
  // The client is captured by the handlers (never invoked here), so a default one
  // is fine — we only read the static name/description off each def.
  const client = new CallbackClient();
  const defs = [
    ...buildEvidenceTools(client),
    ...buildMessageTools(client),
    ...buildFileTools(client),
    ...buildSessionTools(client),
    ...buildSopTools(client),
  ];
  return defs.map((d) => ({ name: d.name, description: d.description }));
}

/** Register the read-only Skill / SOP / MCP catalog routes. */
export function registerCatalogRoutes(app: FastifyInstance, services: AppServices): void {
  const { sopService, skillService } = services;

  // GET /api/skills — the catalog WITH each skill's on/off state (enabled skills
  // are injected into the agent system prompt by the invoke seam).
  app.get('/api/skills', async (_request, reply) => {
    return reply.send({ skills: skillService.list() });
  });

  // POST /api/skills/sync — re-read the manifest from disk (picks up edits to
  // manifest.yaml / skill files). Our skills are LOCAL files (no remote registry),
  // so "同步" = re-read from disk — honest, not a fake "download from marketplace".
  app.post('/api/skills/sync', async (_request, reply) => {
    const skills = skillService.list();
    return reply.send({ skills, count: skills.length });
  });

  // PUT /api/skills/:id/enabled — turn a skill on/off. Enabling injects its guidance
  // into the agent's system prompt on the NEXT turn; disabling removes it.
  app.put('/api/skills/:id/enabled', async (request, reply) => {
    const params = z.object({ id: z.string().min(1) }).safeParse(request.params);
    const body = z.object({ enabled: z.boolean() }).safeParse(request.body);
    if (!params.success || !body.success) return reply.code(400).send({ error: 'invalid_params' });
    const ok = skillService.setEnabled(params.data.id, body.data.enabled);
    if (!ok) return reply.code(404).send({ error: 'skill_not_found' });
    return reply.send({ id: params.data.id, enabled: body.data.enabled });
  });

  app.get('/api/sop', async (_request, reply) => {
    return reply.send({ sop: sopService.getDefinition() });
  });

  app.get('/api/mcp/tools', async (_request, reply) => {
    return reply.send({ tools: mcpToolCatalog() });
  });
}
