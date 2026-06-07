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
import { NewMemberSchema, newMemberToConfig } from '@choco/api/config/runtime-roster';
import { RELAY_AGENT_ID } from '@choco/api/routing/route-serial';

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
  /** True for a runtime-ADDED member (deletable); false for a base agents.yaml one. */
  readonly removable: boolean;
}

function toListEntry(config: AgentConfig, removable: boolean): AgentListEntry {
  return {
    id: config.id as string,
    name: config.name,
    displayName: config.displayName,
    clientId: config.clientId,
    color: config.color,
    mentionPatterns: config.mentionPatterns,
    strengths: config.strengths ?? [],
    status: BASELINE_STATUS,
    removable,
  };
}

/**
 * Register the agent roster/status routes on `app`.
 */
export function registerAgentRoutes(app: FastifyInstance, services: AppServices): void {
  const { registry, agentOverrides, runtimeRoster, buildMemberService } = services;

  app.get('/api/agents', async (_request, reply) => {
    // Layer the live overlay onto each config BEFORE shaping the entry, so the
    // roster (member cards + status bar) reflects edits without a restart.
    const agents = registry
      .getAll()
      // F215: hide the relay cat — it is a system backup (form A 接班 target), not a
      // user-facing roster member; it must not appear in the member list / scope picker.
      .filter((c) => c.id !== RELAY_AGENT_ID)
      .map((c) =>
        toListEntry(
          applyAgentOverride(c, agentOverrides.get(c.id as string)),
          runtimeRoster.has(c.id as string),
        ),
      );
    return reply.send({ agents });
  });

  // POST /api/agents — ADD a member at runtime (成员增删). Validates the new member,
  // rejects an id or @mention that collides with an existing one, builds its
  // provider, hot-registers it (immediately routable), and persists it to the
  // runtime roster. base agents.yaml members are unaffected.
  app.post('/api/agents', async (request, reply) => {
    const body = NewMemberSchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_body', detail: body.error.issues });
    }
    const config = newMemberToConfig(body.data);
    if (registry.get(config.id) !== undefined) {
      return reply.code(409).send({ error: 'id_taken', id: config.id as string });
    }
    // @mention uniqueness — a token already owned by another member would make
    // routing ambiguous, so reject rather than silently shadow.
    const clash = config.mentionPatterns.find((m) => registry.resolveByMention(m) !== undefined);
    if (clash !== undefined) {
      return reply.code(409).send({ error: 'mention_taken', mention: clash });
    }
    registry.register(config, buildMemberService(config), true);
    runtimeRoster.add(config);
    return reply.code(201).send({ agent: toListEntry(config, true) });
  });

  // DELETE /api/agents/:id — remove a RUNTIME-ADDED member (unregister + un-persist).
  // base agents.yaml members are protected (409) so the core team can't be deleted.
  app.delete('/api/agents/:id', async (request, reply) => {
    const params = AgentParamsSchema.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid_params' });
    }
    const id = params.data.id;
    if (registry.get(id as AgentConfig['id']) === undefined) {
      return reply.code(404).send({ error: 'agent_not_found' });
    }
    if (!runtimeRoster.has(id)) {
      return reply.code(409).send({ error: 'base_member_protected', id });
    }
    registry.unregister(id as AgentConfig['id']);
    runtimeRoster.remove(id);
    return reply.send({ deleted: true, id });
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
    return reply.send({ agent: toListEntry(merged, runtimeRoster.has(id as string)) });
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
