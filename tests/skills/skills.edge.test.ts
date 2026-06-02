// M7 QA-style gate for M11 — edge/adversarial tests (orchestrator instance; dev≠QA).

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadManifest } from '@choco/api/skills/manifest-loader';
import { loadSkillContent } from '@choco/api/skills/skill-reader';
import { PackCompiler } from '@choco/api/skills/pack-compiler';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe('loadManifest (edge)', () => {
  it('rejects a manifest missing the skills map', () => {
    const dir = tempDir('m11-manifest-');
    const path = join(dir, 'bad.yaml');
    writeFileSync(path, 'version: 1\n', 'utf-8');
    expect(() => loadManifest(path)).toThrow();
  });

  it('rejects a skill entry missing description', () => {
    const dir = tempDir('m11-manifest-');
    const path = join(dir, 'bad.yaml');
    writeFileSync(
      path,
      `skills:
  tdd:
    triggers: ["TDD"]
    not_for: ["y"]
    output: "z"
`,
      'utf-8',
    );
    expect(() => loadManifest(path)).toThrow();
  });

  it('rejects unknown extra fields on a skill entry (strict schema)', () => {
    const dir = tempDir('m11-manifest-');
    const path = join(dir, 'bad.yaml');
    writeFileSync(
      path,
      `skills:
  tdd:
    description: "x"
    triggers: ["TDD"]
    not_for: ["doc"]
    output: "tests"
    merged_from: ["legacy"]
`,
      'utf-8',
    );
    expect(() => loadManifest(path)).toThrow();
  });

  it('maps sop_step null explicitly to sopStep null', () => {
    const dir = tempDir('m11-manifest-');
    const path = join(dir, 'ok.yaml');
    writeFileSync(
      path,
      `skills:
  feat-lifecycle:
    description: "feature lifecycle"
    triggers: ["立项"]
    not_for: ["merge"]
    output: "aggregate"
    sop_step: null
`,
      'utf-8',
    );
    const manifest = loadManifest(path);
    expect(manifest.skills['feat-lifecycle']?.sopStep).toBeNull();
  });
});

describe('loadSkillContent (edge)', () => {
  it('rejects skill ids with path traversal characters', () => {
    expect(() => loadSkillContent('../secrets')).toThrow(/Invalid skill id/);
    expect(() => loadSkillContent('foo/bar')).toThrow(/Invalid skill id/);
  });

  it('rejects uppercase or underscore ids', () => {
    expect(() => loadSkillContent('TDD')).toThrow(/Invalid skill id/);
    expect(() => loadSkillContent('quality_gate')).toThrow(/Invalid skill id/);
  });

  it('throws when the markdown file does not exist', () => {
    expect(() => loadSkillContent('nonexistent-skill-xyz')).toThrow();
  });
});

describe('PackCompiler (edge)', () => {
  it('skips guardrails entries without a rule string', async () => {
    const dir = tempDir('m11-pack-');
    writeFileSync(
      join(dir, 'guardrails.yaml'),
      `constraints:
  - severity: block
  - rule: "有效规则"
    severity: block
`,
      'utf-8',
    );
    const blocks = await new PackCompiler().compile(dir);
    expect(blocks.guardrailBlock).toContain('有效规则');
    expect(blocks.guardrailBlock?.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(1);
  });

  it('returns undefined masksBlock when masks/ is empty', async () => {
    const dir = tempDir('m11-pack-');
    mkdirSync(join(dir, 'masks'));
    const blocks = await new PackCompiler().compile(dir);
    expect(blocks.masksBlock).toBeUndefined();
  });

  it('skips workflow files missing steps array', async () => {
    const dir = tempDir('m11-pack-');
    const wf = join(dir, 'workflows');
    mkdirSync(wf);
    writeFileSync(join(wf, 'broken.yaml'), `name: broken\ntrigger: "x"\n`, 'utf-8');
    writeFileSync(
      join(wf, 'good.yaml'),
      `name: ok\ntrigger: "y"\nsteps:\n  - action: tdd\n`,
      'utf-8',
    );
    const blocks = await new PackCompiler().compile(dir);
    expect(blocks.workflowsBlock).toContain('ok');
    expect(blocks.workflowsBlock).not.toContain('broken');
  });
});

describe('M11 skills (adversarial)', () => {
  it('loadManifest throws on completely empty YAML document', () => {
    const dir = tempDir('m11-manifest-');
    const path = join(dir, 'empty.yaml');
    writeFileSync(path, '', 'utf-8');
    expect(() => loadManifest(path)).toThrow();
  });

  it('PackCompiler tolerates corrupt guardrails.yaml without throwing', async () => {
    const dir = tempDir('m11-pack-');
    writeFileSync(join(dir, 'guardrails.yaml'), ':\n- [[[', 'utf-8');
    await expect(new PackCompiler().compile(dir)).resolves.toEqual({});
  });

  it('loadSkillContent rejects empty string id', () => {
    expect(() => loadSkillContent('')).toThrow(/Invalid skill id/);
  });

  it('loadManifest rejects sop_step as a number (must be string|null per schema)', () => {
    const dir = tempDir('m11-manifest-');
    const path = join(dir, 'bad.yaml');
    writeFileSync(
      path,
      `skills:
  worktree:
    description: "worktree"
    triggers: ["worktree"]
    not_for: ["doc"]
    output: "tree"
    sop_step: 1
`,
      'utf-8',
    );
    expect(() => loadManifest(path)).toThrow();
  });
});
