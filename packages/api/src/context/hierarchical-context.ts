// Hierarchical context — orchestrate the 5-layer smart-window assembly.
//
// Source: clowder-design-supplement.md §B1 (assembly flow + budget truncation
// priority) + §B1a (config thresholds) + clowder-architecture-design.md §6.2
// (context 组装) + §7.3 (budget control).
//
// Layer order in the rendered text (§B1):
//   header → coverage map (+thread memory) → tombstone → anchor lines →
//   [Related evidence]…[/Related evidence] → burst messages → footer
//
// Budget truncation priority — drop FIRST → LAST (§B1 / PROJECT_SPEC M7 verify):
//   evidence → coverage map → anchors → tombstone → burst
//
// WHY (research, from Clowder context-transport.ts): the smart window only
// engages past the cold-mention threshold (message count OR token count);
// otherwise a plain recent-history window suffices. Burst is the last thing cut
// because the most-recent exchange matters most.

import type {
  ContextTombstone,
  CoverageMap,
  CoverageMapThreadMemory,
  HierarchicalContextConfig,
  ScoredMessage,
  StoredMessage,
} from '@clowder/shared';
import { DEFAULT_HIERARCHICAL_CONTEXT_CONFIG } from '@clowder/shared';
import {
  ContextAssembler,
  DEFAULT_MAX_CONTENT_LENGTH,
  DEFAULT_MAX_TOTAL_TOKENS,
  estimateTokens,
  formatMessage,
  type ResolveAgentConfig,
} from './context-assembler.js';
import { detectRecentBurst } from './burst-detector.js';
import { buildTombstone, formatTombstone } from './tombstone.js';
import { formatAnchors, selectAnchors } from './anchor-selector.js';
import { recallEvidence, type EvidenceRecaller } from './evidence-recall.js';
import { scrubToolPayloads } from './tool-scrub.js';
import { buildCoverageMap, formatCoverageMap } from './coverage-map.js';

/** Min query-term length for relevance/anchor matching. Mirrors tombstone MIN_KEYWORD_LENGTH. */
const MIN_QUERY_TERM_LENGTH = 3;

export type ContextLayerName = 'evidence' | 'coverageMap' | 'anchors' | 'tombstone' | 'burst';

/** Drop order when over budget (FIRST dropped → LAST dropped). Source: §B1 priority. */
const DROP_ORDER: readonly ContextLayerName[] = [
  'evidence',
  'coverageMap',
  'anchors',
  'tombstone',
  'burst',
];

export interface HierarchicalContextParams {
  /** Full thread history in chronological order. */
  messages: readonly StoredMessage[];
  /** Thread title (seeds tombstone + evidence composite query). */
  threadTitle: string;
  /** The current user message driving this invocation. */
  currentUserMessage: string;
  /** Config (defaults to DEFAULT_HIERARCHICAL_CONTEXT_CONFIG). */
  config?: HierarchicalContextConfig;
  /** Evidence store for recall (optional; fail-open if slow/absent). */
  evidenceStore?: EvidenceRecaller;
  /** Thread id (embedded into tombstone retrieval hints). */
  threadId?: string;
  /** Optional thread-memory summary for the coverage map. */
  threadMemory?: CoverageMapThreadMemory | null;
  /** Total token budget for the assembled context (default 2000). */
  maxContextTokens?: number;
  /** Resolver for sender display names. */
  resolveConfig?: ResolveAgentConfig;
  /** Per-message content truncation for burst lines (default 1500). */
  contentTruncate?: number;
}

export interface HierarchicalContext {
  /** Final assembled context string to inject into the user prompt. */
  contextText: string;
  /** Whether the smart window engaged (vs. the plain recent-history path). */
  usedSmartWindow: boolean;
  coverageMap: CoverageMap | null;
  tombstone: ContextTombstone | null;
  anchors: ScoredMessage[];
  /** Burst messages kept verbatim (tool payloads scrubbed except the last). */
  burst: StoredMessage[];
  evidenceLines: string[];
  /** Layers removed (in removal order) to satisfy the token budget. */
  droppedLayers: ContextLayerName[];
  estimatedTokens: number;
}

/** Extract dedup'd lowercased query terms (length ≥ 3) from the current message. */
export function extractQueryTerms(message: string): string[] {
  const seen = new Set<string>();
  for (const word of message.toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/i)) {
    if (word.length >= MIN_QUERY_TERM_LENGTH) seen.add(word);
  }
  return [...seen];
}

/**
 * Build the hierarchical (smart-window) context for an invocation.
 * Below the cold-mention thresholds it returns a plain recent-history window;
 * above them it assembles the full 5-layer context with budget truncation.
 */
export async function buildHierarchicalContext(
  params: HierarchicalContextParams,
): Promise<HierarchicalContext> {
  const config = params.config ?? DEFAULT_HIERARCHICAL_CONTEXT_CONFIG;
  const budget = params.maxContextTokens ?? DEFAULT_MAX_TOTAL_TOKENS;
  const contentTruncate = params.contentTruncate ?? DEFAULT_MAX_CONTENT_LENGTH;
  const resolveConfig = params.resolveConfig;
  const messages = params.messages;

  const emptyResult: HierarchicalContext = {
    contextText: '',
    usedSmartWindow: false,
    coverageMap: null,
    tombstone: null,
    anchors: [],
    burst: [],
    evidenceLines: [],
    droppedLayers: [],
    estimatedTokens: 0,
  };
  if (messages.length === 0) return emptyResult;

  // Cold-mention gate: small + cheap → plain recent-history window.
  const totalContentTokens = estimateTokens(messages.map((m) => m.content).join('\n'));
  const isSmartWindow =
    messages.length > config.coldMentionThreshold ||
    totalContentTokens > config.coldMentionTokenThreshold;

  const assemblerOptions = {
    maxTotalTokens: budget,
    maxContentLength: contentTruncate,
    ...(resolveConfig ? { resolveConfig } : {}),
  };

  if (!isSmartWindow) {
    const assembled = new ContextAssembler(assemblerOptions).assemble(messages);
    return {
      ...emptyResult,
      contextText: assembled.contextText,
      burst: [...messages.slice(-config.maxBurstMessages)],
      estimatedTokens: assembled.estimatedTokens,
    };
  }

  // --- Smart window: build every layer, then truncate to budget. ---
  const { burst, omitted } = detectRecentBurst(messages, config);
  const queryTerms = extractQueryTerms(params.currentUserMessage);

  const tombstone = buildTombstone(omitted, params.threadTitle, config, {
    ...(params.threadId !== undefined ? { threadId: params.threadId } : {}),
    ...(resolveConfig ? { resolveConfig } : {}),
  });
  const anchors = selectAnchors(omitted, queryTerms, config.maxAnchors);
  const evidenceLines = await recallEvidence(
    params.evidenceStore,
    params.threadTitle,
    params.currentUserMessage,
    burst,
    config,
  );
  const scrubbedBurst = scrubToolPayloads(burst);

  const omittedParticipants = tombstone?.participants ?? [];
  const coverageMap = buildCoverageMap({
    omitted: {
      count: omitted.length,
      timeRange: tombstone?.timeRange ?? { from: 0, to: 0 },
      participants: omittedParticipants,
    },
    burst: {
      count: burst.length,
      timeRange: {
        from: burst[0]?.timestamp ?? 0,
        to: burst[burst.length - 1]?.timestamp ?? 0,
      },
    },
    anchorIds: anchors.map((a) => a.message.id),
    threadMemory: params.threadMemory ?? null,
    retrievalHints: tombstone?.retrievalHints ?? [],
  });

  // Rendered fragments per layer.
  const burstLines = scrubbedBurst.map((m) =>
    formatMessage(m, { truncate: contentTruncate, ...(resolveConfig ? { resolveConfig } : {}) }),
  );
  const anchorLines = formatAnchors(anchors, {
    ...(resolveConfig ? { resolveConfig } : {}),
  });

  const header = `[对话历史增量 - 智能窗口: ${omitted.length} 条已摘要, ${burst.length} 条详细]`;
  const footer = '[/对话历史]';

  // Track which layers are present; drop in DROP_ORDER until under budget.
  const present: Record<ContextLayerName, boolean> = {
    evidence: evidenceLines.length > 0,
    coverageMap: true,
    anchors: anchorLines.length > 0,
    tombstone: tombstone !== null,
    burst: burstLines.length > 0,
  };

  const render = (): string => {
    const parts: string[] = [header];
    if (present.coverageMap) parts.push(formatCoverageMap(coverageMap));
    if (present.tombstone && tombstone) parts.push(formatTombstone(tombstone));
    if (present.anchors && anchorLines.length > 0) parts.push(...anchorLines);
    if (present.evidence && evidenceLines.length > 0) {
      parts.push('[Related evidence]', ...evidenceLines, '[/Related evidence]');
    }
    if (present.burst && burstLines.length > 0) parts.push(...burstLines);
    parts.push(footer);
    return parts.join('\n');
  };

  const droppedLayers: ContextLayerName[] = [];
  let contextText = render();
  for (const layer of DROP_ORDER) {
    if (estimateTokens(contextText) <= budget) break;
    if (!present[layer]) continue;
    present[layer] = false;
    droppedLayers.push(layer);
    contextText = render();
  }

  return {
    contextText,
    usedSmartWindow: true,
    coverageMap,
    tombstone,
    anchors,
    burst: scrubbedBurst,
    evidenceLines,
    droppedLayers,
    estimatedTokens: estimateTokens(contextText),
  };
}
