// M12 SopService — bulletin-board hints + post-hoc trace evaluation.
// Source: clowder-architecture-design.md §5.6.

import type { SopDefinition } from '@clowder/shared';
import { loadSopDefinition } from './sop-loader.js';
import { evaluateTrace, type SopEvalResult, type SopTraceInput } from './trace-evaluator.js';

export interface SopService {
  loadDefinition(path: string): SopDefinition;
  getSuggestedSkill(stageId: string): string | undefined;
  getStageHint(stageId: string): string;
  /** All known stage ids, in definition order. Used to validate a setter's stageId. */
  getStageIds(): string[];
  /** Whether `stageId` is a known stage of the loaded definition. */
  hasStage(stageId: string): boolean;
  evaluateTrace(stageId: string, trace: SopTraceInput): SopEvalResult;
}

export class SopServiceImpl implements SopService {
  private definition: SopDefinition;

  constructor(definitionOrPath: SopDefinition | string) {
    this.definition =
      typeof definitionOrPath === 'string' ? loadSopDefinition(definitionOrPath) : definitionOrPath;
  }

  loadDefinition(path: string): SopDefinition {
    this.definition = loadSopDefinition(path);
    return this.definition;
  }

  getSuggestedSkill(stageId: string): string | undefined {
    return this.definition.stages.find((s) => s.id === stageId)?.suggestedSkill;
  }

  getStageHint(stageId: string): string {
    const stage = this.definition.stages.find((s) => s.id === stageId);
    if (stage === undefined) return '';
    const skill = stage.suggestedSkill ? ` suggested skill: ${stage.suggestedSkill}` : '';
    return `${stage.label}（${stage.id}）—${skill}`.trim();
  }

  getStageIds(): string[] {
    return this.definition.stages.map((s) => s.id);
  }

  hasStage(stageId: string): boolean {
    return this.definition.stages.some((s) => s.id === stageId);
  }

  evaluateTrace(stageId: string, trace: SopTraceInput): SopEvalResult {
    return evaluateTrace(stageId, trace, this.definition);
  }
}
