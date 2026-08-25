import type { AgentConfig, AgentId, ClientId, InvocationContext } from '@choco/shared';
import type { ResolveAgentConfig } from './context-assembler.js';

export const L0_TEMPLATE_PATH = 'assets/system-prompts/system-prompt-l0.md';

const PROVIDER_LABELS: Record<ClientId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
};

function providerLabel(clientId: ClientId): string {
  return PROVIDER_LABELS[clientId] ?? clientId;
}

export function buildL0IdentityBlock(config: AgentConfig): string {
  const lines = [
    `You are ${config.displayName} (${config.name}), an AI agent provided by ${providerLabel(config.clientId)}.`,
    `Role: ${config.roleDescription}`,
    `Personality: ${config.personality}`,
    `Identity constant: @${config.id} model=${config.defaultModel}`,
  ];
  if (config.strengths && config.strengths.length > 0) {
    lines.push(`Strengths: ${config.strengths.join(', ')}`);
  }
  if (config.restrictions && config.restrictions.length > 0) {
    lines.push(`Hard restrictions: ${config.restrictions.join(', ')}.`);
  }
  return lines.join('\n');
}

export function buildL0TeammateRoster(
  currentAgentId: AgentId,
  teammates: readonly AgentId[],
  resolveConfig: ResolveAgentConfig,
): string {
  const rows: string[] = [];
  for (const id of teammates) {
    if (id === currentAgentId) continue;
    const config = resolveConfig(id);
    if (!config) continue;
    const mention = config.mentionPatterns[0] ?? `@${id as string}`;
    const strengths = config.strengths?.join(', ') ?? config.roleDescription;
    const restrictions = config.restrictions?.join(', ') ?? '-';
    rows.push(`| ${config.displayName} | ${mention} | ${strengths} | ${restrictions} |`);
  }
  if (rows.length === 0) return '(No other agents in this invocation.)';
  return ['| Agent | Mention | Strengths | Restrictions |', '|---|---|---|---|', ...rows].join('\n');
}

export function buildL0InvocationContext(
  context: InvocationContext,
  resolveConfig: ResolveAgentConfig,
): string {
  const config = resolveConfig(context.agentId);
  if (!config) return '';

  const lines = [`Identity: ${config.displayName} (@${context.agentId as string}, model=${config.defaultModel})`];

  if (context.directMessageFrom && context.directMessageFrom !== context.agentId) {
    const from = resolveConfig(context.directMessageFrom);
    lines.push(`Direct message from ${from?.displayName ?? `@${context.directMessageFrom as string}`}.`);
  }
  if (context.crossThreadReplyHint) {
    lines.push(
      `Cross-thread message: source=${context.crossThreadReplyHint.sourceThreadId}, sender=@${context.crossThreadReplyHint.senderCatId}.`,
    );
  }
  if (context.pingPongWarning) {
    lines.push(`Ping-pong warning: pairedWith=@${context.pingPongWarning.pairedWith}, count=${context.pingPongWarning.count}.`);
  }
  if (context.mode === 'serial' && context.chainIndex != null && context.chainTotal != null) {
    lines.push(`Mode: serial (${context.chainIndex}/${context.chainTotal}).`);
  } else {
    lines.push(`Mode: ${context.mode}.`);
  }
  if (context.sopStageHint) {
    lines.push(`SOP: ${context.sopStageHint}`);
  }
  if (context.promptTags && context.promptTags.length > 0) {
    lines.push(`Prompt tags: ${context.promptTags.join(', ')}`);
  }

  return lines.join('\n');
}

export function compileSystemPromptL0(args: {
  readonly template: string;
  readonly agent: AgentConfig;
  readonly teammates: readonly AgentId[];
  readonly resolveConfig: ResolveAgentConfig;
  readonly invocationContext?: InvocationContext;
}): string {
  const invocationContext =
    args.invocationContext === undefined
      ? ''
      : buildL0InvocationContext(args.invocationContext, args.resolveConfig);

  return compileSystemPromptL0Blocks(args.template, {
    identityBlock: buildL0IdentityBlock(args.agent),
    teammateRoster: buildL0TeammateRoster(args.agent.id, args.teammates, args.resolveConfig),
    invocationContext,
  });
}

export function compileSystemPromptL0Blocks(
  template: string,
  blocks: {
    readonly identityBlock: string;
    readonly teammateRoster: string;
    readonly invocationContext: string;
  },
): string {
  return template
    .replaceAll('{{IDENTITY_BLOCK}}', blocks.identityBlock)
    .replaceAll('{{TEAMMATE_ROSTER}}', blocks.teammateRoster)
    .replaceAll('{{INVOCATION_CONTEXT}}', blocks.invocationContext);
}
