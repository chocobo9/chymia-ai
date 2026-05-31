import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { skillsDir, manifestPath, skillsPackageRoot } from '@clowder/skills';
import { loadManifest } from '@clowder/api/skills/manifest-loader';
import { loadSkillContent } from '@clowder/api/skills/skill-reader';
import { PackCompiler } from '@clowder/api/skills/pack-compiler';

const EXPECTED_SKILL_IDS = [
  'feat-lifecycle',
  'writing-plans',
  'worktree',
  'tdd',
  'debugging',
  'quality-gate',
  'request-review',
  'receive-review',
  'merge-gate',
  'collaborative-thinking',
  'expert-panel',
  'cross-cat-handoff',
  'cross-thread-sync',
  'thread-orchestration',
  'memory-navigation',
  'memory-search-best-practices',
  'knowledge-engineering',
  'deep-research',
  'self-evolution',
  'incident-response',
  'open-source-teardown',
] as const;

const FIXTURE_PACK = join(import.meta.dirname, 'fixtures', 'sample-pack');

describe('loadManifest (happy path)', () => {
  it('parses manifest.yaml into SkillManifest with all 21 skills', () => {
    const manifest = loadManifest(manifestPath);
    expect(Object.keys(manifest.skills)).toHaveLength(21);
    for (const id of EXPECTED_SKILL_IDS) {
      expect(manifest.skills[id]).toBeDefined();
      expect(manifest.skills[id]?.id).toBe(id);
    }
  });

  it('maps triggers, notFor, output, and optional next/sopStep with correct types', () => {
    const manifest = loadManifest(manifestPath);
    const tdd = manifest.skills.tdd;
    expect(tdd?.triggers).toContain('TDD');
    expect(tdd?.notFor).toContain('纯文档');
    expect(tdd?.output).toContain('red-green-refactor');
    expect(tdd?.next).toEqual(['quality-gate']);
    expect(tdd?.sopStep).toBe('1');

    const feat = manifest.skills['feat-lifecycle'];
    expect(feat?.sopStep).toBeNull();
    expect(feat?.next).toEqual(['writing-plans']);
  });
});

describe('loadSkillContent (happy path)', () => {
  it("returns non-empty markdown for skill id 'tdd'", () => {
    const body = loadSkillContent('tdd');
    expect(body.length).toBeGreaterThan(100);
    expect(body).toContain('TDD');
    expect(body).toContain('Red-Green-Refactor');
  });

  it('reads from the @clowder/skills exported skillsDir', () => {
    const body = loadSkillContent('quality-gate', skillsDir);
    expect(body).toContain('质量');
  });
});

describe('PackCompiler (happy path)', () => {
  it('compiles a fixture pack dir into all four CompiledPackBlocks', async () => {
    const blocks = await new PackCompiler().compile(FIXTURE_PACK, 'sample-pack');
    expect(blocks.guardrailBlock).toContain('硬约束');
    expect(blocks.guardrailBlock).toContain('禁止直接 merge');
    expect(blocks.defaultsBlock).toContain('默认行为');
    expect(blocks.defaultsBlock).toContain('spec 和测试计划');
    expect(blocks.masksBlock).toContain('角色叠加');
    expect(blocks.masksBlock).toContain('架构师模式');
    expect(blocks.workflowsBlock).toContain('工作流');
    expect(blocks.workflowsBlock).toContain('feat-lifecycle');
  });

  it('returns an empty object for the skills package root (no optional pack YAML yet)', async () => {
    const blocks = await new PackCompiler().compile(skillsPackageRoot);
    expect(blocks).toEqual({});
  });
});

describe('skill markdown inventory (happy path)', () => {
  it('has a non-empty markdown file for every manifest skill id', () => {
    const manifest = loadManifest(manifestPath);
    const files = new Set(readdirSync(skillsDir).filter((f) => f.endsWith('.md')));
    for (const id of Object.keys(manifest.skills)) {
      expect(files.has(`${id}.md`)).toBe(true);
      const content = readFileSync(join(skillsDir, `${id}.md`), 'utf-8');
      expect(content.trim().length).toBeGreaterThan(50);
    }
  });
});
