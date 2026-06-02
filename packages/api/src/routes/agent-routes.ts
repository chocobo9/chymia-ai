// M8 agent-routes — agent roster + runtime status.
//
// Source: clowder-design-supplement.md §C1 + §C6:
//   GET /api/agents            → all agent configs (+ status), cached by the web client
//   GET /api/agents/:id/status → one agent's runtime status
//
// The roster comes from the injected AgentRegistry (loaded from agents.yaml).
// Runtime status: there is no live AgentState store wired in M8, so each agent
// reports 'idle' as its baseline (matches the §C6 sample payload). Live status
// transitions reach the client via the Socket.io `agent_status` event, not this
// REST endpoint (§C6: "WebSocket 的 agent_status 事件实时更新 status 字段").

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AgentConfig, AgentStatus } from '@choco/shared';
import type { AppServices } from '@choco/api/infrastructure/app-services';
import { applyAgentOverride, AgentOverrideSchema } from '@choco/api/config/agent-overrides';

/** Baseline status reported by the REST roster (live updates flow over Socket.io). */
const BASELINE_STATUS: AgentStatus = 'idle';

const AgentParamsSchema = z.object({ id: z.string().min(1) });

/** The per-agent payload shape returned by GET /api/agents (§C6). */
interface AgentListEntry {
  readonly id: string;
  readonly name: string;
  readonly displayName: string;
  readonly clientId: AgentConfig['clientId'];
  readonly color: AgentConfig['color'];
  readonly mentionPatterns: readonly string[];
  readonly strengths: readonly string[];
  readonly status: AgentStatus;
}

function toListEntry(config: AgentConfig): AgentListEntry {
  return {
    id: config.id as string,
    name: config.name,
    displayName: config.displayName,
    clientId: config.clientId,
    color: config.color,
    mentionPatterns: config.mentionPatterns,
    strengths: config.strengths ?? [],
    status: BASELINE_STATUS,
  };
}

/**
 * Register the agent roster/status routes on `app`.
 */
export function registerAgentRoutes(app: FastifyInstance, services: AppServices): void {
  const { registry, agentOverrides } = services;

  app.get('/api/agents', async (_request, reply) => {
    // Layer the live overlay onto each config BEFORE shaping the entry, so the
    // roster (member cards + status bar) reflects edits without a restart.
    const agents = registry
      .getAll()
      .map((c) => toListEntry(applyAgentOverride(c, agentOverrides.get(c.id as string))));
    return reply.send({ agents });
  });

  // PATCH /api/agents/:id — edit an EXISTING member's overlay fields
  // (roleDescription/personality/strengths/displayName/name/restrictions/color).
  // Records the partial override (field-wise merged by the store) and returns the
  // merged entry; the edit takes effect on the next turn's system prompt.
  app.patch('/api/agents/:id', async (request, reply) => {
    const params = AgentParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_params' });
    }
    const id = params.data.id as AgentConfig['id'];
    const base = registry.get(id);
    if (base === undefined) {
      return reply.code(404).send({ error: 'agent_not_found' });
    }
    const body = AgentOverrideSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_body' });
    }
    agentOverrides.set(id as string, body.data);
    const merged = applyAgentOverride(base, agentOverrides.get(id as string));
    return reply.send({ agent: toListEntry(merged) });
  });

  app.get('/api/agents/:id/status', async (request, reply) => {
    const params = AgentParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_params' });
    }
    const config = registry.get(params.data.id as AgentConfig['id']);
    if (config === undefined) {
      return reply.code(404).send({ error: 'agent_not_found' });
    }
    return reply.send({ id: config.id as string, status: BASELINE_STATUS });
  });
}
