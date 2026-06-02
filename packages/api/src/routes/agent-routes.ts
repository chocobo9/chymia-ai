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
  const { registry } = services;

  app.get('/api/agents', async (_request, reply) => {
    const agents = registry.getAll().map(toListEntry);
    return reply.send({ agents });
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
