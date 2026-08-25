// catalog-routes — read-only settings catalogs for the settings overlay:
//   GET /api/skills     → the M11 skill manifest (id + routing metadata)
//   GET /api/sop        → the M12 loaded SOP definition (stages)
//   GET /api/mcp/tools  → the M10 MCP tool catalog (name + description)
//
// Read-only by design: these LIST the loaded definitions. Editing/management
// (uploading skills, MCP servers, SOP authoring) is a separate, unbuilt concern —
// the settings panes are honest about that. No fabricated data: each reflects the
// real loaded manifest / definition / tool registry.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppServices } from '@choco/api/infrastructure/app-services';
import { compileSystemPromptL0, L0_TEMPLATE_PATH } from '@choco/api/context/system-prompt-l0';
import { skillsDir } from '@choco/skills';
import type {
  L0PromptsBlock,
  PromptConsumptionInfo,
  ProviderGuide,
  RuleFile,
  RulesPayload,
} from '@choco/shared';
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

const ROUTE_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(ROUTE_DIR, '..', '..', '..', '..');

function usage(
  kind: PromptConsumptionInfo['kind'],
  label: string,
  detail: string,
  consumers: readonly string[],
): PromptConsumptionInfo {
  return { kind, label, detail, consumers };
}

function readRuleFile(path: string, consumption: PromptConsumptionInfo): RuleFile {
  const fullPath = resolve(PROJECT_ROOT, path);
  if (!fullPath.startsWith(PROJECT_ROOT) || !existsSync(fullPath)) {
    return { path, content: '', exists: false, lineCount: 0, consumption };
  }
  const content = readFileSync(fullPath, 'utf8');
  return { path, content, exists: true, lineCount: countLines(content), consumption };
}

function countLines(content: string): number {
  if (content.length === 0) return 0;
  return content.split(/\r\n|\r|\n/).length;
}

function isWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function buildRulesPayload(services: AppServices): RulesPayload {
  const referenceUse = usage(
    'reference',
    'reference',
    'Read by the settings catalog and by operators as the canonical process definition.',
    ['/api/sop', '/api/rules'],
  );
  const harnessUse = usage(
    'harness-injected',
    'harness injected',
    'Provider harnesses read these project guide files directly when present.',
    ['Claude Code / Codex / Gemini project-doc loaders'],
  );
  const l0Use = usage(
    'actual-prompt',
    'actual prompt',
    'L0 prompt template is compiled into per-agent system prompts when present.',
    ['SystemPromptBuilder'],
  );

  const l0Template = readRuleFile(L0_TEMPLATE_PATH, l0Use);
  const allAgents = services.registry.getAll();
  const resolveConfig = services.registry.get.bind(services.registry);
  const l0Prompts: L0PromptsBlock = {
    template: l0Template,
    compiledByAgent: allAgents.map((agent) => {
      try {
        return {
          agentId: agent.id,
          displayName: agent.displayName,
          compiled: l0Template.exists
            ? compileSystemPromptL0({
                template: l0Template.content,
                agent,
                teammates: allAgents.map((item) => item.id),
                resolveConfig,
              })
            : '',
          error: l0Template.exists ? null : `L0 template missing: ${L0_TEMPLATE_PATH}`,
          consumption: l0Use,
        };
      } catch (error) {
        return {
          agentId: agent.id,
          displayName: agent.displayName,
          compiled: '',
          error: error instanceof Error ? error.message : 'compile failed',
          consumption: l0Use,
        };
      }
    }),
    customization: {
      templatePath: L0_TEMPLATE_PATH,
      compileScript: 'scripts/compile-system-prompt-l0.mjs',
      verifyCommand: 'npx tsc --noEmit',
    },
  };

  const providerGuide = (
    provider: ProviderGuide['provider'],
    path: string,
  ): ProviderGuide => ({ provider, ...readRuleFile(path, harnessUse) });

  return {
    sharedRules: [
      readRuleFile('cat-cafe-skills/refs/shared-rules.md', referenceUse),
      readRuleFile('docs/SOP.md', referenceUse),
    ],
    providerGuides: [
      providerGuide('claude', 'CLAUDE.md'),
      providerGuide('codex', 'AGENTS.md'),
      providerGuide('gemini', 'GEMINI.md'),
    ],
    l0Prompts,
    sop: services.sopService.getDefinition(),
  };
}

function readSkillRuleFile(name: string, consumption: PromptConsumptionInfo): RuleFile | null {
  const packageSkill = resolve(skillsDir, `${name}.md`);
  if (isWithinRoot(skillsDir, packageSkill) && existsSync(packageSkill)) {
    const content = readFileSync(packageSkill, 'utf8');
    return {
      path: `packages/skills/skills/${name}.md`,
      content,
      exists: true,
      lineCount: countLines(content),
      consumption,
    };
  }

  const skillRoot = resolve(PROJECT_ROOT, 'cat-cafe-skills');
  const skillFile = resolve(skillRoot, name, 'SKILL.md');
  if (isWithinRoot(skillRoot, skillFile) && existsSync(skillFile)) {
    const content = readFileSync(skillFile, 'utf8');
    return {
      path: `cat-cafe-skills/${name}/SKILL.md`,
      content,
      exists: true,
      lineCount: countLines(content),
      consumption,
    };
  }

  return null;
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

  app.get('/api/rules', async (_request, reply) => {
    return reply.send(buildRulesPayload(services));
  });

  app.get('/api/rules/skill/*', async (_request, reply) => {
    return reply.code(400).send({ error: 'invalid_skill_name' });
  });

  app.get('/api/rules/skill/:name', async (request, reply) => {
    const params = z.object({ name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/) }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_skill_name' });
    const skillUse = usage(
      'skill-on-demand',
      'skill on demand',
      'Skill content is loaded only when an agent selects or enables that skill.',
      ['SkillService', 'SystemPromptBuilder'],
    );
    const file = readSkillRuleFile(params.data.name, skillUse);
    if (file === null) return reply.code(404).send({ error: 'skill_not_found' });
    return reply.send(file);
  });

  app.get('/api/mcp/tools', async (_request, reply) => {
    return reply.send({ tools: mcpToolCatalog() });
  });
}
