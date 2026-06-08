// SystemPromptBuilder — build the identity/system prompt for a single invocation.
//
// Source: clowder-architecture-design.md §5.4 (buildSystemPrompt 纯函数;
// Static Identity = 身份 + 性格 + 队友名单 + 限制规则 + pack blocks; Invocation
// Context = mode + chain position + A2A 提示 + SOP hint + ping-pong 警告).
//
// WHY (research, from Clowder SystemPromptBuilder.ts): the reference resolves
// configs from a GLOBAL catRegistry. Supplement D forbids global singletons, so we
// inject a config resolver (ResolveAgentConfig). The three exported functions stay
// pure (same inputs → same output). See DEV report "deviations".

import type { AgentConfig, AgentId, ClientId, InvocationContext } from '@choco/shared';
import type { ResolveAgentConfig } from './context-assembler.js';

/** Human-readable provider labels by CLI client. Source: §4.1 (ClientId). */
const PROVIDER_LABELS: Record<ClientId, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
};

function providerLabel(clientId: ClientId): string {
  return PROVIDER_LABELS[clientId] ?? clientId;
}

/**
 * Build the static identity block: identity, role, personality, hard
 * restrictions, and the teammate roster. Persistent across invocations.
 * Returns '' for an unknown agent.
 */
export function buildStaticIdentity(
  agentId: AgentId,
  teammates: readonly AgentId[],
  resolveConfig: ResolveAgentConfig,
): string {
  const config = resolveConfig(agentId);
  if (!config) return '';

  const lines: string[] = [];
  lines.push(
    `你是 ${config.displayName}（${config.name}），由 ${providerLabel(config.clientId)} 提供的 AI agent。`,
    `角色：${config.roleDescription}`,
    `性格：${config.personality}`,
  );
  if (config.strengths && config.strengths.length > 0) {
    lines.push(`擅长：${config.strengths.join('、')}`);
  }
  // Hard restrictions — declared inline so the agent can push back on illegitimate tasks.
  if (config.restrictions && config.restrictions.length > 0) {
    lines.push(`你的硬限制：${config.restrictions.join('、')}。被要求做这类任务时请 push back 或退回。`);
  }

  const roster = buildTeammateRoster(agentId, teammates, resolveConfig);
  if (roster) {
    lines.push('', roster);
  }
  return lines.join('\n');
}

/** Build a teammate roster table from the invocation's teammate list. */
function buildTeammateRoster(
  currentAgentId: AgentId,
  teammates: readonly AgentId[],
  resolveConfig: ResolveAgentConfig,
): string | null {
  const rows: string[] = [];
  for (const id of teammates) {
    if (id === currentAgentId) continue;
    const config = resolveConfig(id);
    if (!config) continue;
    const mention = config.mentionPatterns[0] ?? `@${id as string}`;
    const strengths = config.strengths?.join('、') ?? config.roleDescription;
    const restrictions =
      config.restrictions && config.restrictions.length > 0
        ? config.restrictions.join('、')
        : '—';
    rows.push(`| ${config.displayName} | ${mention} | ${strengths} | ${restrictions} |`);
  }
  if (rows.length === 0) return null;
  return ['## 队友名册', '| 队友 | @mention | 擅长 | 硬限制 |', '|------|----------|------|--------|', ...rows].join('\n');
}

/**
 * Build the dynamic invocation-context block: mode/chain position, A2A direct
 * message, ping-pong warning, cross-thread hint, mention-routing feedback,
 * prompt tags, active participants, and SOP stage hint. Returns '' for unknown agent.
 */
export function buildInvocationContext(
  context: InvocationContext,
  resolveConfig: ResolveAgentConfig,
): string {
  const config = resolveConfig(context.agentId);
  if (!config) return '';

  const lines: string[] = [];
  lines.push(`Identity: ${config.displayName} (@${context.agentId as string}, model=${config.defaultModel})`);

  if (context.directMessageFrom && context.directMessageFrom !== context.agentId) {
    const fromName = nameOf(context.directMessageFrom, resolveConfig);
    lines.push(`Direct message from ${fromName}; 请回复 ${fromName}。`);
  }

  if (context.crossThreadReplyHint) {
    const { sourceThreadId, senderCatId } = context.crossThreadReplyHint;
    lines.push(`📨 跨线程消息（source thread: ${sourceThreadId}，发件 agent: @${senderCatId}）。`);
  }

  if (context.pingPongWarning) {
    const other = nameOf(context.pingPongWarning.pairedWith, resolveConfig);
    lines.push(
      `🏓 乒乓警告：你和 ${other} 已连续互相 @ ${context.pingPongWarning.count} 轮，考虑收尾或引入第三方。`,
    );
  }

  if (context.teammates.length > 0) {
    const names = context.teammates
      .filter((id) => id !== context.agentId)
      .map((id) => nameOf(id, resolveConfig));
    if (names.length > 0) lines.push(`你的队友：${names.join('、')}`);
  }

  if (context.mode === 'serial' && context.chainIndex != null && context.chainTotal != null) {
    lines.push(`当前模式：串行——你是第 ${context.chainIndex}/${context.chainTotal} 个，请参考前面 agent 的回复。`);
  } else if (context.mode === 'parallel') {
    lines.push('当前模式：并行——独立思考，给出你自己的观点，不要模仿其他 agent。');
  } else {
    lines.push('当前模式：独立回答。');
  }

  if (context.mentionRoutingFeedback && context.mentionRoutingFeedback.items.length > 0) {
    const items = context.mentionRoutingFeedback.items.slice(0, 2).map((it) => `@${it.targetCatId}`);
    lines.push(`[路由提醒] 上次提到 ${items.join('、')} 但未用行首 @ 路由；需对方行动请在行首独立一行写 @句柄。`);
  }

  if (context.promptTags?.includes('critique')) {
    lines.push('思维方式：批判性分析。挑战假设，找出漏洞，提出反例。');
  }

  if (context.activeParticipants && context.activeParticipants.length > 0) {
    const top = context.activeParticipants
      .filter((p) => p.catId !== (context.agentId as string) && p.lastMessageAt > 0)
      .sort((a, b) => b.lastMessageAt - a.lastMessageAt)[0];
    if (top) lines.push(`最近活跃：@${top.catId}`);
  }

  // F042: thread routing policy hint — a short per-invocation note so the agent
  // knows the thread's review/architecture routing preference (avoid/prefer). Expired
  // rules are skipped (same as the routing layer). Aligns Clowder buildInvocationContext.
  if (context.routingPolicy?.v === 1 && context.routingPolicy.scopes) {
    const toMention = (id: string): string =>
      resolveConfig(id as AgentId)?.mentionPatterns[0] ?? `@${id}`;
    const scopes = context.routingPolicy.scopes;
    const parts: string[] = [];
    for (const scope of ['review', 'architecture'] as const) {
      const rule = scopes[scope];
      if (!rule) continue;
      if (typeof rule.expiresAt === 'number' && rule.expiresAt > 0 && rule.expiresAt < Date.now()) {
        continue;
      }
      const segs: string[] = [];
      const avoid = (Array.isArray(rule.avoidCats) ? rule.avoidCats : [])
        .slice(0, 3)
        .map((id) => toMention(String(id)));
      const prefer = (Array.isArray(rule.preferCats) ? rule.preferCats : [])
        .slice(0, 3)
        .map((id) => toMention(String(id)));
      if (avoid.length > 0) segs.push(`avoid ${avoid.join(', ')}`);
      if (prefer.length > 0) segs.push(`prefer ${prefer.join(', ')}`);
      const reason =
        typeof rule.reason === 'string' ? rule.reason.replace(/[\r\n]+/g, ' ').trim() : '';
      if (reason) segs.push(`(${reason})`);
      if (segs.length > 0) parts.push(`${scope} ${segs.join(' ')}`);
    }
    if (parts.length > 0) lines.push(`Routing: ${parts.join('; ')}`);
  }

  // SOP stage hint — 告示牌 (bulletin board, not a gate).
  if (context.sopStageHint) {
    lines.push(`SOP: ${context.sopStageHint}`);
  }

  return lines.join('\n');
}

function nameOf(id: AgentId, resolveConfig: ResolveAgentConfig): string {
  const config: AgentConfig | undefined = resolveConfig(id);
  return config ? `${config.displayName}(@${id as string})` : `@${id as string}`;
}

/** Deps for the reviewer section: the full roster + an availability probe. */
export interface ReviewerDeps {
  readonly allAgentIds: readonly AgentId[];
  readonly isAvailable: (id: AgentId) => boolean;
}

/**
 * F032: build the reviewer section — which teammates can review this agent's work.
 * family = clientId (cross-provider review = independent perspective); only agents
 * with the 'peer-reviewer' role qualify. Cross-provider reviewers are preferred,
 * same-provider is a fallback, unavailable ones are listed separately. Returns null
 * when there are no reviewers. Aligns Clowder buildReviewerSection (family→clientId,
 * lead / reviewPolicy simplified — this repo has neither).
 */
export function buildReviewerSection(
  currentAgentId: AgentId,
  deps: ReviewerDeps,
  resolveConfig: ResolveAgentConfig,
): string | null {
  const current = resolveConfig(currentAgentId);
  if (!current) return null;

  const crossFamily: string[] = [];
  const sameFamily: string[] = [];
  const unavailable: string[] = [];

  for (const id of deps.allAgentIds) {
    if (id === currentAgentId) continue;
    const config = resolveConfig(id);
    if (!config) continue;
    if (!config.roles?.includes('peer-reviewer')) continue;
    const mention = config.mentionPatterns[0] ?? `@${id as string}`;
    const isDifferentFamily = config.clientId !== current.clientId;
    if (!deps.isAvailable(id)) {
      unavailable.push(`- ${mention} (${config.displayName}, 不可用)`);
      continue;
    }
    const line = isDifferentFamily ? `- ${mention} (${config.clientId})` : `- ${mention}`;
    (isDifferentFamily ? crossFamily : sameFamily).push(line);
  }

  // Cross-provider reviewers preferred (independence); same-provider as fallback.
  let available: string[];
  let fallbackNote: string | null = null;
  if (crossFamily.length > 0) {
    available = crossFamily;
  } else if (sameFamily.length > 0) {
    available = sameFamily;
    fallbackNote = '[注意] 无跨 provider reviewer，同 provider 作 fallback：';
  } else {
    available = [];
  }

  if (available.length === 0 && unavailable.length === 0) return null;

  const lines: string[] = ['## 你的 Reviewers', ''];
  if (available.length > 0) {
    lines.push(fallbackNote ?? '可以找以下 agent review 你的产出：', ...available, '');
  }
  if (unavailable.length > 0) {
    lines.push('[注意] 以下 reviewer 当前不可用：', ...unavailable, '');
  }
  return lines.join('\n').trimEnd();
}

/**
 * Build the full system prompt: static identity + invocation context.
 * Pure function — same inputs always produce the same output. Returns '' for an
 * unknown agent (no identity to anchor on).
 */
export function buildSystemPrompt(
  context: InvocationContext,
  resolveConfig: ResolveAgentConfig,
  reviewerDeps?: ReviewerDeps,
): string {
  const staticPart = buildStaticIdentity(context.agentId, context.teammates, resolveConfig);
  if (!staticPart) return '';
  const parts: string[] = [staticPart];
  // F032: reviewer section between identity and dynamic context (Clowder order).
  if (reviewerDeps) {
    const reviewerSection = buildReviewerSection(context.agentId, reviewerDeps, resolveConfig);
    if (reviewerSection) parts.push(reviewerSection);
  }
  const dynamicPart = buildInvocationContext(context, resolveConfig);
  if (dynamicPart) parts.push(dynamicPart);
  return parts.join('\n\n');
}
