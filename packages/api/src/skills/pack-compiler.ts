// M11 PackCompiler — compile a pack directory into canonical prompt blocks.
//
// Source: clowder-architecture-design.md §5.5 (CompiledPackBlocks) +
// clowder-design-supplement.md §B2 (masks/guardrails/defaults/workflows mapping).
//
// Pattern from Clowder PackCompiler.ts (re-authored): reads optional YAML
// sources under the pack root; missing files yield undefined blocks (fail-open).

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { load } from 'js-yaml';

/** Canonical prompt blocks produced at pack install time. Source: §5.5. */
export interface CompiledPackBlocks {
  masksBlock?: string;
  guardrailBlock?: string;
  defaultsBlock?: string;
  workflowsBlock?: string;
}

interface GuardrailConstraint {
  rule: string;
  severity?: 'block' | 'warn';
  scope?: string;
  breeds?: string[];
}

interface DefaultBehavior {
  behavior: string;
  scope?: string;
  breeds?: string[];
}

interface PackMask {
  name: string;
  activation: string;
  roleOverlay: string;
  personalityOverlay?: string;
  expertise?: string[];
}

interface PackWorkflowStep {
  action: string;
  params?: Record<string, unknown>;
}

interface PackWorkflow {
  name: string;
  trigger: string;
  steps: PackWorkflowStep[];
}

/** Display name embedded in compiled block headers. */
const DEFAULT_PACK_LABEL = 'choco-skills';

/**
 * Compile a pack directory into {@link CompiledPackBlocks}.
 * Pure async read → format; tolerates missing optional sources.
 */
export class PackCompiler {
  async compile(packDir: string, packLabel: string = DEFAULT_PACK_LABEL): Promise<CompiledPackBlocks> {
    const [guardrailBlock, defaultsBlock, masksBlock, workflowsBlock] = await Promise.all([
      this.compileGuardrails(packDir, packLabel),
      this.compileDefaults(packDir, packLabel),
      this.compileMasks(packDir, packLabel),
      this.compileWorkflows(packDir, packLabel),
    ]);
    return {
      ...(guardrailBlock !== undefined ? { guardrailBlock } : {}),
      ...(defaultsBlock !== undefined ? { defaultsBlock } : {}),
      ...(masksBlock !== undefined ? { masksBlock } : {}),
      ...(workflowsBlock !== undefined ? { workflowsBlock } : {}),
    };
  }

  private async compileGuardrails(packDir: string, packLabel: string): Promise<string | undefined> {
    const raw = await safeReadYaml(join(packDir, 'guardrails.yaml'));
    if (raw === null || typeof raw !== 'object') return undefined;
    const constraints = (raw as { constraints?: unknown }).constraints;
    if (!Array.isArray(constraints) || constraints.length === 0) return undefined;

    const lines: string[] = [`## [Pack: ${packLabel}] 硬约束（不可覆盖）`];
    for (const entry of constraints) {
      if (entry === null || typeof entry !== 'object') continue;
      const c = entry as GuardrailConstraint;
      if (typeof c.rule !== 'string' || c.rule.length === 0) continue;
      const scopeNote =
        c.scope === 'specific-breeds' && c.breeds && c.breeds.length > 0
          ? ` [${c.breeds.join(',')}]`
          : '';
      const severityTag = c.severity === 'block' ? '🚫' : '⚠️';
      lines.push(`- ${severityTag}${scopeNote} ${c.rule}`);
    }
    return lines.length > 1 ? lines.join('\n') : undefined;
  }

  private async compileDefaults(packDir: string, packLabel: string): Promise<string | undefined> {
    const raw = await safeReadYaml(join(packDir, 'defaults.yaml'));
    if (raw === null || typeof raw !== 'object') return undefined;
    const behaviors = (raw as { behaviors?: unknown }).behaviors;
    if (!Array.isArray(behaviors) || behaviors.length === 0) return undefined;

    const lines: string[] = [`## [Pack: ${packLabel}] 默认行为（用户可覆盖）`];
    for (const entry of behaviors) {
      if (entry === null || typeof entry !== 'object') continue;
      const b = entry as DefaultBehavior;
      if (typeof b.behavior !== 'string' || b.behavior.length === 0) continue;
      const scopeNote =
        b.scope === 'specific-breeds' && b.breeds && b.breeds.length > 0
          ? ` [${b.breeds.join(',')}]`
          : '';
      lines.push(`- ${scopeNote} ${b.behavior}`);
    }
    return lines.length > 1 ? lines.join('\n') : undefined;
  }

  private async compileMasks(packDir: string, packLabel: string): Promise<string | undefined> {
    const masksDir = join(packDir, 'masks');
    const files = await safeReaddir(masksDir);
    const yamlFiles = files.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
    if (yamlFiles.length === 0) return undefined;

    const lines: string[] = [`## [Pack: ${packLabel}] 角色叠加`];
    for (const fileName of yamlFiles) {
      const raw = await safeReadYaml(join(masksDir, fileName));
      if (raw === null || typeof raw !== 'object') continue;
      const m = raw as Partial<PackMask>;
      if (typeof m.name !== 'string' || typeof m.activation !== 'string' || typeof m.roleOverlay !== 'string') {
        continue;
      }
      lines.push(`- **${m.name}**（${m.activation}）: ${m.roleOverlay}`);
      if (typeof m.personalityOverlay === 'string' && m.personalityOverlay.length > 0) {
        lines.push(`  性格叠加: ${m.personalityOverlay}`);
      }
      if (Array.isArray(m.expertise) && m.expertise.length > 0) {
        lines.push(`  专长: ${m.expertise.join(', ')}`);
      }
    }
    return lines.length > 1 ? lines.join('\n') : undefined;
  }

  private async compileWorkflows(packDir: string, packLabel: string): Promise<string | undefined> {
    const workflowsDir = join(packDir, 'workflows');
    const files = await safeReaddir(workflowsDir);
    const yamlFiles = files.filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'));
    if (yamlFiles.length === 0) return undefined;

    const lines: string[] = [`## [Pack: ${packLabel}] 工作流`];
    for (const fileName of yamlFiles) {
      const raw = await safeReadYaml(join(workflowsDir, fileName));
      if (raw === null || typeof raw !== 'object') continue;
      const w = raw as Partial<PackWorkflow>;
      if (typeof w.name !== 'string' || typeof w.trigger !== 'string' || !Array.isArray(w.steps)) continue;
      lines.push(`- **${w.name}**（触发: ${w.trigger}）`);
      for (const step of w.steps) {
        if (step === null || typeof step !== 'object') continue;
        const s = step as PackWorkflowStep;
        if (typeof s.action !== 'string') continue;
        const params =
          s.params !== undefined && Object.keys(s.params).length > 0
            ? ` (${JSON.stringify(s.params)})`
            : '';
        lines.push(`  → ${s.action}${params}`);
      }
    }
    return lines.length > 1 ? lines.join('\n') : undefined;
  }
}

async function safeReadYaml(filePath: string): Promise<unknown | null> {
  try {
    const raw = await readFile(filePath, 'utf-8');
    return load(raw) as unknown;
  } catch {
    return null;
  }
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    const s = await stat(dir);
    if (!s.isDirectory()) return [];
    return await readdir(dir);
  } catch {
    return [];
  }
}
