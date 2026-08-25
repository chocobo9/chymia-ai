import type { AgentId } from './agent.js';
import type { SopDefinition } from './sop.js';

export type PromptConsumptionKind =
  | 'actual-prompt'
  | 'harness-injected'
  | 'reference'
  | 'skill-on-demand';

export interface PromptConsumptionInfo {
  readonly kind: PromptConsumptionKind;
  readonly label: string;
  readonly detail: string;
  readonly consumers: readonly string[];
}

export interface RuleFile {
  readonly path: string;
  readonly content: string;
  readonly exists: boolean;
  readonly lineCount: number;
  readonly consumption: PromptConsumptionInfo;
}

export interface ProviderGuide extends RuleFile {
  readonly provider: 'claude' | 'codex' | 'gemini';
}

export interface L0CompiledForAgent {
  readonly agentId: AgentId;
  readonly displayName: string;
  readonly compiled: string;
  readonly error: string | null;
  readonly consumption: PromptConsumptionInfo;
}

export interface L0PromptsBlock {
  readonly template: RuleFile;
  readonly compiledByAgent: readonly L0CompiledForAgent[];
  readonly customization: {
    readonly templatePath: string;
    readonly compileScript: string;
    readonly verifyCommand: string;
  };
}

export interface RulesPayload {
  readonly sharedRules: readonly RuleFile[];
  readonly providerGuides: readonly ProviderGuide[];
  readonly l0Prompts: L0PromptsBlock;
  readonly sop: SopDefinition;
}
