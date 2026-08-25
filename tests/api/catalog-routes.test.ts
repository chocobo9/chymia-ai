// catalog-routes — read-only Skill / SOP / MCP catalogs for the settings overlay.
// These hit the REAL loaded manifest / SOP definition / MCP tool registry (no mocks)
// via app.inject, so they gate that the routes reflect real data, shaped right.
//
// Distribution: happy ≤50%, edge ≥30%, adversarial ≥20%.

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { buildApp } from '@choco/api/app-factory';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function makeApp(): ReturnType<typeof buildApp> {
  const app = buildApp({ db: new Database(':memory:') });
  cleanups.push(app.close);
  return app;
}

describe('catalog routes — Skill / SOP / MCP (read-only, real data)', () => {
  it('GET /api/skills lists the loaded skill manifest (id + routing metadata)', async () => {
    const res = await makeApp().api.inject({ method: 'GET', url: '/api/skills' });
    expect(res.statusCode).toBe(200);
    const { skills } = res.json<{
      skills: { id: string; description: string; triggers: string[]; output: string }[];
    }>();
    expect(skills.length).toBeGreaterThan(0);
    expect(skills[0].id.length).toBeGreaterThan(0);
    expect(skills[0].description.length).toBeGreaterThan(0);
    expect(Array.isArray(skills[0].triggers)).toBe(true);
  });

  it('[edge] skills carry their `group` (category) + POST /api/skills/sync re-reads the manifest', async () => {
    const app = makeApp();
    const list = await app.api.inject({ method: 'GET', url: '/api/skills' });
    const { skills } = list.json<{ skills: { group?: string }[] }>();
    // The real manifest groups skills (dev-chain / memory / meta / multi-agent).
    expect(skills.some((s) => typeof s.group === 'string' && s.group.length > 0)).toBe(true);

    const synced = await app.api.inject({ method: 'POST', url: '/api/skills/sync' });
    expect(synced.statusCode).toBe(200);
    const body = synced.json<{ skills: unknown[]; count: number }>();
    expect(body.count).toBe(body.skills.length);
    expect(body.count).toBe(skills.length); // same local manifest re-read
  });

  it('GET /api/sop returns the SOP definition with its stages', async () => {
    const res = await makeApp().api.inject({ method: 'GET', url: '/api/sop' });
    expect(res.statusCode).toBe(200);
    const { sop } = res.json<{
      sop: { label: string; domain: string; description?: string; stages: { id: string; label: string; hardRules: { text: string; severity: string }[]; pitfalls: unknown[] }[] };
    }>();
    expect(sop.label.length).toBeGreaterThan(0);
    expect(sop.stages.length).toBeGreaterThan(0);
    // The consumption note is surfaced now (was parsed-but-dropped).
    expect(typeof sop.description).toBe('string');
    // Stage rules carry real text + severity (not just counts).
    const withRule = sop.stages.find((s) => s.hardRules.length > 0);
    expect(withRule?.hardRules[0].text.length).toBeGreaterThan(0);
    expect(['blocker', 'warn']).toContain(withRule?.hardRules[0].severity);
  });

  it('[red] GET /api/rules exposes Clowder-style rule sources + prompt consumption chain', async () => {
    const res = await makeApp().api.inject({ method: 'GET', url: '/api/rules' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      sharedRules: Array<{ path: string; exists: boolean; content: string; consumption: { kind: string; consumers: string[] } }>;
      providerGuides: Array<{ provider: string; path: string; exists: boolean; consumption: { kind: string } }>;
      l0Prompts: {
        template: { path: string; exists: boolean; consumption: { kind: string } };
        compiledByAgent: Array<{ agentId: string; displayName: string; compiled: string; error: string | null; consumption: { kind: string } }>;
        customization: { templatePath: string; verifyCommand: string };
      };
      sop: unknown;
    }>();

    expect(body.sharedRules.map((f) => f.path)).toEqual([
      'cat-cafe-skills/refs/shared-rules.md',
      'docs/SOP.md',
    ]);
    expect(body.providerGuides.map((g) => g.provider).sort()).toEqual(['claude', 'codex', 'gemini']);
    expect(body.providerGuides.map((g) => g.path).sort()).toEqual(['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']);
    expect(body.sharedRules.every((f) => f.consumption.kind === 'reference')).toBe(true);
    expect(body.providerGuides.every((g) => g.consumption.kind === 'harness-injected')).toBe(true);
    expect(body.l0Prompts.template.consumption.kind).toBe('actual-prompt');
    expect(body.l0Prompts.compiledByAgent.length).toBeGreaterThan(0);
    expect(body.l0Prompts.compiledByAgent[0].compiled).toContain('Chymia AI L0');
    expect(body.l0Prompts.compiledByAgent[0].compiled).not.toContain('{{IDENTITY_BLOCK}}');
    expect(body.sop).toBeDefined();
  });

  it('[edge] GET /api/rules/skill/:name previews an allowlisted skill as on-demand prompt content', async () => {
    const res = await makeApp().api.inject({ method: 'GET', url: '/api/rules/skill/tdd' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ path: string; exists: boolean; content: string; consumption: { kind: string } }>();
    expect(body.path).toBe('packages/skills/skills/tdd.md');
    expect(body.exists).toBe(true);
    expect(body.content).toContain('tdd');
    expect(body.consumption.kind).toBe('skill-on-demand');
  });

  it('[adversarial] GET /api/rules/skill/:name rejects invalid or missing skills', async () => {
    const invalid = await makeApp().api.inject({ method: 'GET', url: '/api/rules/skill/..%2FCLAUDE.md' });
    expect(invalid.statusCode).toBe(400);

    const missing = await makeApp().api.inject({ method: 'GET', url: '/api/rules/skill/not-a-real-skill' });
    expect(missing.statusCode).toBe(404);
  });

  it('GET /api/mcp/tools returns the real MCP tool catalog (name + description)', async () => {
    const res = await makeApp().api.inject({ method: 'GET', url: '/api/mcp/tools' });
    expect(res.statusCode).toBe(200);
    const { tools } = res.json<{ tools: { name: string; description: string }[] }>();
    expect(tools.length).toBeGreaterThanOrEqual(9); // the nine M10 tools
    const names = tools.map((t) => t.name);
    expect(names).toContain('post_message');
    expect(names).toContain('list_session_chain');
  });

  it('[edge] every SOP stage carries its hardRules + pitfalls arrays', async () => {
    const res = await makeApp().api.inject({ method: 'GET', url: '/api/sop' });
    const { sop } = res.json<{ sop: { stages: { hardRules: unknown[]; pitfalls: unknown[] }[] } }>();
    for (const stage of sop.stages) {
      expect(Array.isArray(stage.hardRules)).toBe(true);
      expect(Array.isArray(stage.pitfalls)).toBe(true);
    }
  });

  it('[adversarial] the MCP catalog exposes ONLY name + description — never the handler/inputSchema', async () => {
    const res = await makeApp().api.inject({ method: 'GET', url: '/api/mcp/tools' });
    const { tools } = res.json<{ tools: Record<string, unknown>[] }>();
    for (const tool of tools) {
      expect(Object.keys(tool).sort()).toEqual(['description', 'name']);
      expect(typeof tool.description).toBe('string');
      expect((tool.description as string).length).toBeGreaterThan(0);
    }
  });
});
