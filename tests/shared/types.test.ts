// M1 QA — runtime contract tests for @choco/shared.
// Written independently from the design docs (§4 / §B1a / §A10), NOT from the
// implementation. Constructs real-content instances and asserts the externalized
// defaults equal the design values exactly. Authored by the QA subagent (dev≠QA).

import { describe, it, expect } from 'vitest';
import {
  createAgentId,
  DEFAULT_HIERARCHICAL_CONTEXT_CONFIG,
  DEFAULT_COLD_MENTION_THRESHOLD,
  DEFAULT_BURST_SILENCE_GAP_MS,
  DEFAULT_MAX_BURST_MESSAGES,
  DEFAULT_MIN_BURST_MESSAGES,
  DEFAULT_MAX_TOMBSTONE_KEYWORDS,
  DEFAULT_EVIDENCE_RECALL_TIMEOUT_MS,
  DEFAULT_MAX_EVIDENCE_HITS,
  DEFAULT_COLD_MENTION_TOKEN_THRESHOLD,
  DEFAULT_MAX_ANCHORS,
  DEFAULT_MAX_THREAD_MEMORY_TOKENS,
} from '@choco/shared';
import type {
  AgentId,
  AgentConfig,
  AgentState,
  AgentMessage,
  AgentMessageType,
  MessageMetadata,
  StoredMessage,
  Thread,
  EvidenceItem,
  EntityRecord,
  EvidenceEdge,
  EvidenceSearchOptions,
  EvidenceSearchResult,
  InvocationRecord,
  VerifyResult,
  AuthFailureReason,
  SkillDefinition,
  SkillManifest,
  SopDefinition,
  SopStage,
  SopRule,
  SopPredicate,
  InvocationContext,
  HierarchicalContextConfig,
  CoverageMap,
  ContextTombstone,
  ImportanceSignals,
  ScoredMessage,
  IncomingPlatformMessage,
} from '@choco/shared';

// Real project agent ids per design (clientId 'anthropic'|'openai'|'google';
// example id 'claude-opus'). Use the team's claude/codex/gemini naming.
const claudeId: AgentId = createAgentId('claude-opus');
const codexId: AgentId = createAgentId('codex-gpt');
const geminiId: AgentId = createAgentId('gemini-pro');
const reviewThread = 'thread-pr-1843-review';

describe('M1 agent (§4.1) — real instances', () => {
  it('constructs an AgentConfig for the claude provider with mention patterns', () => {
    const cfg: AgentConfig = {
      id: claudeId,
      name: 'Claude',
      displayName: 'Claude',
      clientId: 'anthropic',
      defaultModel: 'claude-opus-4-6',
      mcpSupport: true,
      mentionPatterns: ['@claude', '@claude', '@claude'],
      personality: '沉稳、注重架构清晰度',
      roleDescription: '架构与实现主力',
      strengths: ['架构设计', '代码实现'],
      restrictions: ['不在 main 分支直接提交'],
      color: { primary: '#6366f1', secondary: '#818cf8' },
    };
    expect(cfg.clientId).toBe('anthropic');
    expect(cfg.mentionPatterns).toContain('@claude');
    expect(cfg.color.primary).toBe('#6366f1');
  });

  it('constructs a working AgentState bound to a thread and session', () => {
    const state: AgentState = {
      id: codexId,
      status: 'working',
      currentThreadId: reviewThread,
      lastActiveAt: 1748600000000,
      sessionId: 'sess-codex-7f3a',
    };
    expect(state.status).toBe('working');
    expect(state.currentThreadId).toBe(reviewThread);
  });

  it('createAgentId preserves the underlying string value', () => {
    expect(createAgentId('gemini-pro')).toBe('gemini-pro');
  });
});

describe('M1 message (§4.2/§4.3) — one real AgentMessage per AgentMessageType', () => {
  const cases: ReadonlyArray<{ type: AgentMessageType; content: string }> = [
    { type: 'session_init', content: 'session started for thread thread-pr-1843-review' },
    { type: 'text', content: '我已经定位到 packages/api/src/routing 里的乒乓循环问题。' },
    { type: 'tool_use', content: 'Read packages/api/src/routing/router.ts' },
    { type: 'tool_result', content: 'router.ts: 214 lines, exports route() and resolveTargets()' },
    { type: 'thinking', content: '先确认 resolveTargets 是否对访问者去重' },
    { type: 'error', content: 'ENOENT: cannot spawn codex — command not found on PATH' },
    { type: 'done', content: '' },
    { type: 'a2a_handoff', content: '@codex 接力实现修复' },
    { type: 'system_info', content: 'invocation inv-2026-0530-0007 created' },
  ];

  it.each(cases)('builds a valid AgentMessage of type %s', ({ type, content }) => {
    const msg: AgentMessage = {
      type,
      agentId: claudeId,
      content,
      timestamp: 1748600200000,
    };
    expect(msg.type).toBe(type);
    expect(msg.agentId).toBe(claudeId);
    expect(msg.timestamp).toBeGreaterThan(0);
  });

  it('builds a tool_use AgentMessage carrying tool fields + a2a_handoff target + metadata', () => {
    const meta: MessageMetadata = {
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      inputTokens: 1820,
      outputTokens: 412,
    };
    const toolUse: AgentMessage = {
      type: 'tool_use',
      agentId: claudeId,
      content: '',
      toolName: 'Read',
      toolInput: { file_path: 'packages/api/src/routing/router.ts' },
      toolUseId: 'toolu_01abc',
      invocationId: 'inv-2026-0530-0007',
      metadata: meta,
      timestamp: 1748600210000,
    };
    const handoff: AgentMessage = {
      type: 'a2a_handoff',
      agentId: claudeId,
      content: '@codex 请基于根因实现修复',
      targetAgentId: codexId,
      timestamp: 1748600220000,
    };
    const done: AgentMessage = {
      type: 'done',
      agentId: codexId,
      isFinal: true,
      errorCode: undefined,
      timestamp: 1748600230000,
    };
    expect(toolUse.toolName).toBe('Read');
    expect(toolUse.toolInput?.file_path).toBe('packages/api/src/routing/router.ts');
    expect(toolUse.metadata?.outputTokens).toBe(412);
    expect(handoff.targetAgentId).toBe(codexId);
    expect(done.isFinal).toBe(true);
  });

  it('constructs a user StoredMessage (agentId null) with a real @mention and mentions list', () => {
    const userMsg: StoredMessage = {
      id: 'msg-0531-0042',
      threadId: reviewThread,
      userId: 'user',
      agentId: null,
      content: '@claude 这个 NDJSON parser 的 edge case 你能看一下吗？',
      mentions: [claudeId],
      origin: 'user',
      timestamp: 1748600300000,
    };
    expect(userMsg.agentId).toBeNull();
    expect(userMsg.content).toContain('@claude');
    expect(userMsg.mentions).toEqual([claudeId]);
    expect(userMsg.origin).toBe('user');
  });

  it('constructs an agent StoredMessage from a stream with extra tracing payload', () => {
    const agentMsg: StoredMessage = {
      id: 'msg-0531-0043',
      threadId: reviewThread,
      userId: 'agent:claude-opus',
      agentId: claudeId,
      content: '修复完成：在 router.ts 加入 pingPongWarning 短路逻辑。',
      mentions: [],
      origin: 'stream',
      timestamp: 1748600400000,
      extra: { invocationId: 'inv-2026-0530-0007', crossPost: false },
    };
    expect(agentMsg.agentId).toBe(claudeId);
    expect(agentMsg.origin).toBe('stream');
    expect(agentMsg.extra?.invocationId).toBe('inv-2026-0530-0007');
  });
});

describe('M1 thread (§4.4) — real instance', () => {
  it('constructs a multi-agent Thread with a SOP stage and thinking mode', () => {
    const thread: Thread = {
      id: reviewThread,
      title: 'PR #1843 路由模块代码评审',
      projectPath: 'D:/proj/choco-ai',
      createdAt: 1748600000000,
      lastActiveAt: 1748600400000,
      participants: [claudeId, codexId, geminiId],
      sopStageId: 'impl',
      thinkingMode: 'debug',
    };
    expect(thread.participants).toHaveLength(3);
    expect(thread.sopStageId).toBe('impl');
    expect(thread.thinkingMode).toBe('debug');
  });
});

describe('M1 evidence (§4.5) — real instances with Chinese content', () => {
  it('constructs a decision EvidenceItem with Chinese keywords + provenance', () => {
    const ev: EvidenceItem = {
      anchor: 'decision:2026-05-30-api-framework',
      kind: 'decision',
      status: 'active',
      title: 'API 框架选型：Fastify',
      summary: '选用 Fastify 而非 Express：TS 原生、schema validation、性能更好。',
      keywords: ['Fastify', 'API框架', '选型'],
      authority: 'authoritative',
      provenance: { tier: 'authoritative', source: 'clowder-architecture-design.md §2' },
      updatedAt: '2026-05-30T08:15:00.000Z',
    };
    expect(ev.kind).toBe('decision');
    expect(ev.keywords).toContain('API框架');
    expect(ev.provenance?.tier).toBe('authoritative');
  });

  it('constructs an EntityRecord and an EvidenceEdge linking two anchors', () => {
    const entity: EntityRecord = {
      entityId: 'agent:claude-opus',
      type: 'agent',
      canonicalName: 'Claude',
      aliases: ['claude', 'Claude', '宪宪'],
      updatedAt: '2026-05-30T08:00:00.000Z',
    };
    const edge: EvidenceEdge = {
      fromAnchor: 'decision:2026-05-30-api-framework',
      toAnchor: 'plan:2026-05-30-fastify-migration',
      relation: 'evolved_from',
      createdAt: '2026-05-30T09:00:00.000Z',
    };
    expect(entity.type).toBe('agent');
    expect(entity.aliases).toContain('Claude');
    expect(edge.relation).toBe('evolved_from');
  });

  it('constructs an EvidenceSearchOptions (hybrid) and a degraded EvidenceSearchResult', () => {
    const opts: EvidenceSearchOptions = {
      kind: 'decision',
      mode: 'hybrid',
      limit: 5,
      scope: 'project',
    };
    const result: EvidenceSearchResult = {
      items: [],
      meta: {
        effectiveMode: 'lexical',
        degraded: true,
        degradeReason: 'embedding server unavailable, fell back to lexical',
      },
    };
    expect(opts.mode).toBe('hybrid');
    expect(result.meta.degraded).toBe(true);
    expect(result.meta.effectiveMode).toBe('lexical');
  });
});

describe('M1 invocation (§4.6) — real instances', () => {
  it('constructs an InvocationRecord with a populated claimedMessageIds Set', () => {
    const rec: InvocationRecord = {
      invocationId: 'inv-2026-0530-0007',
      callbackToken: 'cbk-9d2c-7f3a',
      userId: 'user',
      agentId: claudeId,
      threadId: reviewThread,
      a2aTriggerMessageId: 'msg-0531-0042',
      claimedMessageIds: new Set<string>(['msg-0531-0042']),
      createdAt: 1748600200000,
      expiresAt: 1748600200000 + 2 * 60 * 60 * 1000,
    };
    expect(rec.claimedMessageIds.has('msg-0531-0042')).toBe(true);
    expect(rec.expiresAt - rec.createdAt).toBe(2 * 60 * 60 * 1000);
  });

  it('models VerifyResult both branches of the discriminated union', () => {
    const ok: VerifyResult = {
      ok: true,
      record: {
        invocationId: 'inv-1',
        callbackToken: 'cbk-1',
        userId: 'user',
        agentId: claudeId,
        threadId: reviewThread,
        claimedMessageIds: new Set<string>(),
        createdAt: 1,
        expiresAt: 2,
      },
    };
    const expired: AuthFailureReason = 'expired';
    const fail: VerifyResult = { ok: false, reason: expired };
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.record.invocationId).toBe('inv-1');
    expect(fail.ok).toBe(false);
    if (!fail.ok) expect(fail.reason).toBe('expired');
  });
});

describe('M1 skill (§4.7) — real instances', () => {
  it('constructs a SkillDefinition with triggers/notFor/next/sopStep', () => {
    const skill: SkillDefinition = {
      id: 'tdd',
      description: '测试驱动开发：先写测试（RED），再实现（GREEN），再重构。',
      triggers: ['tdd', '写测试', '测试先行'],
      notFor: ['纯文档', '配置改动'],
      output: '失败的测试 → 通过的实现 → 重构后的代码 + 覆盖率报告',
      next: ['quality-gate', 'request-review'],
      sopStep: 'impl',
    };
    expect(skill.triggers).toContain('测试先行');
    expect(skill.next).toContain('quality-gate');
    expect(skill.sopStep).toBe('impl');
  });

  it('constructs a SkillManifest keyed by skill id', () => {
    const manifest: SkillManifest = {
      skills: {
        tdd: {
          id: 'tdd',
          description: 'TDD 流程',
          triggers: ['tdd'],
          notFor: [],
          output: 'tests + impl',
          sopStep: null,
        },
        debugging: {
          id: 'debugging',
          description: '系统化调试：复现→最小化→定位根因',
          triggers: ['debug', '调试', '定位'],
          notFor: ['新功能'],
          output: '根因 + 修复 + 回归测试',
        },
      },
    };
    expect(Object.keys(manifest.skills)).toEqual(['tdd', 'debugging']);
    expect(manifest.skills.debugging.triggers).toContain('定位');
    expect(manifest.skills.tdd.sopStep).toBeNull();
  });
});

describe('M1 sop (§4.8) — real instances covering all SopPredicate variants', () => {
  it('constructs a SopDefinition with stages, hardRules and pitfalls', () => {
    const handleCheck: SopPredicate = { type: 'handle_check', constraint: 'reviewer != author' };
    const gitState: SopPredicate = { type: 'git_state_predicate', checks: ['ahead==0', 'behind==0'] };
    const rules: SopRule[] = [
      { id: 'no-self-review', text: '不能自己 review 自己的代码', severity: 'blocker', predicate: handleCheck },
      { id: 'branch-synced', text: '分支需与 target 同步', severity: 'warn', predicate: gitState },
    ];
    const reviewStage: SopStage = {
      id: 'review',
      label: '代码评审',
      suggestedSkill: 'request-review',
      hardRules: [rules[0]],
      pitfalls: [rules[1]],
    };
    const sop: SopDefinition = {
      id: 'development',
      domain: 'coding',
      label: '开发流程 SOP',
      stages: [reviewStage],
    };
    expect(sop.stages[0].hardRules[0].severity).toBe('blocker');
    expect(sop.stages[0].pitfalls[0].predicate.type).toBe('git_state_predicate');
    expect(sop.stages[0].suggestedSkill).toBe('request-review');
  });

  it('accepts every SopPredicate variant of the discriminated union', () => {
    const predicates: SopPredicate[] = [
      { type: 'manual_only', reason: '需人工确认部署窗口' },
      { type: 'git_state_predicate', checks: ['ahead==0'] },
      { type: 'command_pattern', mustMatch: 'npx vitest run' },
      { type: 'handle_check', constraint: 'reviewer != author' },
    ];
    expect(predicates.map((p) => p.type)).toEqual([
      'manual_only',
      'git_state_predicate',
      'command_pattern',
      'handle_check',
    ]);
  });
});

describe('M1 context (§5.4) — InvocationContext with all required A2A fields', () => {
  it('constructs an InvocationContext populating every spec-listed optional field', () => {
    const ctx: InvocationContext = {
      agentId: claudeId,
      mode: 'serial',
      chainIndex: 2,
      chainTotal: 3,
      teammates: [codexId, geminiId],
      mcpAvailable: true,
      a2aEnabled: true,
      directMessageFrom: codexId,
      crossThreadReplyHint: { sourceThreadId: 'thread-pr-1800-design', senderCatId: 'codex-gpt' },
      pingPongWarning: { pairedWith: codexId, count: 2 },
      mentionRoutingFeedback: { items: [{ targetCatId: 'gemini-pro' }] },
      sopStageHint: '当前阶段：impl。请遵守 worktree 同步与 TDD。',
      promptTags: ['#critique', 'skill:debugging'],
      activeParticipants: [
        { catId: 'claude-opus', lastMessageAt: 1748600400000 },
        { catId: 'codex-gpt', lastMessageAt: 1748600300000 },
      ],
    };
    expect(ctx.directMessageFrom).toBe(codexId);
    expect(ctx.crossThreadReplyHint?.sourceThreadId).toBe('thread-pr-1800-design');
    expect(ctx.pingPongWarning?.count).toBe(2);
    expect(ctx.mentionRoutingFeedback?.items[0].targetCatId).toBe('gemini-pro');
    expect(ctx.activeParticipants).toHaveLength(2);
    expect(ctx.activeParticipants?.[0].catId).toBe('claude-opus');
    expect(ctx.sopStageHint).toContain('impl');
  });
});

describe('M1 hierarchical-context (§B1a) — externalized defaults equal design exactly', () => {
  it('exposes each individual default constant equal to §B1a', () => {
    expect(DEFAULT_COLD_MENTION_THRESHOLD).toBe(15);
    expect(DEFAULT_BURST_SILENCE_GAP_MS).toBe(15 * 60 * 1000);
    expect(DEFAULT_BURST_SILENCE_GAP_MS).toBe(900000);
    expect(DEFAULT_MAX_BURST_MESSAGES).toBe(12);
    expect(DEFAULT_MIN_BURST_MESSAGES).toBe(4);
    expect(DEFAULT_MAX_TOMBSTONE_KEYWORDS).toBe(4);
    expect(DEFAULT_EVIDENCE_RECALL_TIMEOUT_MS).toBe(500);
    expect(DEFAULT_MAX_EVIDENCE_HITS).toBe(3);
    expect(DEFAULT_COLD_MENTION_TOKEN_THRESHOLD).toBe(10_000);
    expect(DEFAULT_MAX_ANCHORS).toBe(3);
    expect(DEFAULT_MAX_THREAD_MEMORY_TOKENS).toBe(300);
  });

  it('exposes DEFAULT_HIERARCHICAL_CONTEXT_CONFIG equal to the aggregate of §B1a defaults', () => {
    const expected: HierarchicalContextConfig = {
      coldMentionThreshold: 15,
      burstSilenceGapMs: 900000,
      maxBurstMessages: 12,
      minBurstMessages: 4,
      maxTombstoneKeywords: 4,
      evidenceRecallTimeoutMs: 500,
      maxEvidenceHits: 3,
      coldMentionTokenThreshold: 10000,
      maxAnchors: 3,
      maxThreadMemoryTokens: 300,
    };
    expect(DEFAULT_HIERARCHICAL_CONTEXT_CONFIG).toStrictEqual(expected);
  });

  it('wires the aggregate config from the individual constants', () => {
    expect(DEFAULT_HIERARCHICAL_CONTEXT_CONFIG.burstSilenceGapMs).toBe(DEFAULT_BURST_SILENCE_GAP_MS);
    expect(DEFAULT_HIERARCHICAL_CONTEXT_CONFIG.coldMentionThreshold).toBe(DEFAULT_COLD_MENTION_THRESHOLD);
    expect(DEFAULT_HIERARCHICAL_CONTEXT_CONFIG.maxThreadMemoryTokens).toBe(DEFAULT_MAX_THREAD_MEMORY_TOKENS);
  });

  it('constructs CoverageMap, ContextTombstone, ImportanceSignals and ScoredMessage', () => {
    const coverage: CoverageMap = {
      omitted: { count: 25, timeRange: { from: 1748590000000, to: 1748599000000 }, participants: ['claude-opus', 'codex-gpt'] },
      burst: { count: 6, timeRange: { from: 1748599500000, to: 1748600400000 } },
      anchorIds: ['msg-0531-0001', 'msg-0531-0007'],
      threadMemory: {
        available: true,
        sessionsIncorporated: 2,
        decisions: ['采用 Fastify'],
        openQuestions: ['jieba 还是 jieba-wasm？'],
      },
      retrievalHints: ['search_evidence("Fastify 选型")'],
    };
    const tombstone: ContextTombstone = {
      omittedCount: 25,
      timeRange: { from: 1748590000000, to: 1748599000000 },
      participants: ['claude-opus', 'codex-gpt'],
      keywords: ['数据库', '路由', 'jieba'],
      retrievalHints: ['search_evidence("数据库 路由", threadId="thread-pr-1843-review")'],
    };
    const signals: ImportanceSignals = { structural: 3, positional: 5, relevance: 2 };
    const scored: ScoredMessage = {
      message: {
        id: 'msg-0531-0001',
        threadId: reviewThread,
        userId: 'user',
        agentId: null,
        content: '@claude @codex 我们先确定路由的乒乓检测阈值',
        mentions: [claudeId, codexId],
        origin: 'user',
        timestamp: 1748590000000,
      },
      score: 10,
      signals,
      isPrimacy: true,
    };
    expect(coverage.omitted.count).toBe(25);
    expect(coverage.threadMemory?.sessionsIncorporated).toBe(2);
    expect(tombstone.keywords).toContain('数据库');
    expect(scored.score).toBe(signals.structural + signals.positional + signals.relevance);
    expect(scored.isPrimacy).toBe(true);
  });
});

describe('M1 platform (§A10) — IncomingPlatformMessage real instances', () => {
  const samples: ReadonlyArray<{ adapterName: string; channelId: string; platformUserId: string }> = [
    { adapterName: 'wechat', channelId: 'oABCD1234efgh', platformUserId: 'wxuser-001' },
    { adapterName: 'telegram', channelId: '584213099', platformUserId: '584213099' },
  ];

  it.each(samples)('normalizes an IncomingPlatformMessage from %s', ({ adapterName, channelId, platformUserId }) => {
    const incoming: IncomingPlatformMessage = {
      adapterName,
      channelId,
      platformUserId,
      platformMessageId: `${adapterName}-msg-7788`,
      text: '@claude 请帮我跑一下全量回归测试',
      receivedAt: 1748600900000,
      raw: { adapterName, payload: 'original-platform-object' },
    };
    expect(incoming.adapterName).toBe(adapterName);
    expect(incoming.channelId).toBe(channelId);
    expect(incoming.text).toContain('@claude');
    expect(incoming.platformMessageId).toContain(adapterName);
  });
});
