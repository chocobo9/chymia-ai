// Shared fixtures for M7 context happy-path tests.
// Realistic agent configs + thread messages (real @mentions, tool_use/tool_result
// pairs, mixed Chinese/English). No placeholder data.

import { createAgentId, type AgentConfig, type AgentId, type StoredMessage } from '@choco/shared';
import type { ResolveAgentConfig } from '@choco/api/context/context-assembler';

export const CLAUDE: AgentId = createAgentId('claude-opus');
export const CODEX: AgentId = createAgentId('codex-gpt');
export const GEMINI: AgentId = createAgentId('gemini-pro');

export const THREAD_ID = 'thread-todo-api';
export const USER_ID = 'user-makima';

const AGENT_CONFIGS: Record<string, AgentConfig> = {
  [CLAUDE as string]: {
    id: CLAUDE,
    name: 'Claude',
    displayName: 'Claude',
    clientId: 'anthropic',
    defaultModel: 'claude-opus-4-6',
    mcpSupport: true,
    mentionPatterns: ['@claude'],
    personality: '沉稳、重架构，先想清楚再动手。',
    roleDescription: '架构设计与核心实现',
    strengths: ['架构设计', '代码实现'],
    restrictions: ['禁止直接合并到 main'],
    color: { primary: '#6366f1', secondary: '#818cf8' },
  },
  [CODEX as string]: {
    id: CODEX,
    name: 'Codex',
    displayName: 'Codex',
    clientId: 'openai',
    defaultModel: 'gpt-5-codex',
    mcpSupport: true,
    mentionPatterns: ['@codex'],
    personality: '挑剔、较真，code review 一针见血。',
    roleDescription: '代码审查与质量把关',
    strengths: ['代码审查', '测试'],
    restrictions: ['禁止写产品需求文档'],
    color: { primary: '#10b981', secondary: '#34d399' },
  },
  [GEMINI as string]: {
    id: GEMINI,
    name: 'Gemini',
    displayName: 'Gemini',
    clientId: 'google',
    defaultModel: 'gemini-2.5-pro',
    mcpSupport: false,
    mentionPatterns: ['@gemini'],
    personality: '审美在线，关注交互与视觉。',
    roleDescription: '前端与视觉设计',
    strengths: ['UI 设计', '交互'],
    color: { primary: '#f59e0b', secondary: '#fbbf24' },
  },
};

export const resolveConfig: ResolveAgentConfig = (id) => AGENT_CONFIGS[id as string];

export interface MessageSpec {
  agentId?: AgentId | null;
  content: string;
  mentions?: AgentId[];
  /** Minutes after the thread base time. */
  offsetMin: number;
  toolEvents?: Array<{ type: 'tool_use' | 'tool_result'; label?: string }>;
}

/** Thread base: a fixed UTC instant so HH:MM stamps are deterministic. */
export const BASE_TS = Date.UTC(2026, 4, 30, 14, 0, 0);

let idCounter = 0;

export function makeMessage(spec: MessageSpec): StoredMessage {
  idCounter += 1;
  const agentId = spec.agentId === undefined ? null : spec.agentId;
  const extra =
    spec.toolEvents && spec.toolEvents.length > 0 ? { toolEvents: spec.toolEvents } : undefined;
  return {
    id: `msg_${String(BASE_TS + spec.offsetMin * 60_000).padStart(15, '0')}_${idCounter.toString(36)}`,
    threadId: THREAD_ID,
    userId: agentId === null ? USER_ID : (agentId as string),
    agentId,
    content: spec.content,
    mentions: spec.mentions ?? [],
    origin: agentId === null ? 'user' : 'stream',
    timestamp: BASE_TS + spec.offsetMin * 60_000,
    ...(extra !== undefined ? { extra } : {}),
  };
}

/**
 * A 25-message thread: 18 clustered messages, a 30-minute silence gap, then a
 * 7-message recent burst. Exceeds coldMentionThreshold (15) → smart window.
 */
export function build25MessageThread(): StoredMessage[] {
  const msgs: StoredMessage[] = [];
  // Thread opener (primacy) — code block + @mention → high importance.
  msgs.push(
    makeMessage({
      agentId: null,
      content:
        '@claude 帮我搭一个 TODO API，先把数据库 schema 定下来：\n```sql\nCREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT, done INTEGER);\n```',
      mentions: [CLAUDE],
      offsetMin: 0,
    }),
  );
  // Filler clustered exchange (indices 1..17).
  for (let i = 1; i <= 17; i += 1) {
    const isAgent = i % 2 === 1;
    msgs.push(
      makeMessage({
        agentId: isAgent ? CLAUDE : null,
        content: isAgent
          ? `Claude回复 #${i}：schema 设计了 todos 表与 indexes，迁移脚本已写好。`
          : `用户追问 #${i}：那 database 索引怎么建？要不要加 created_at？`,
        offsetMin: i,
      }),
    );
  }
  // 30-minute silence gap, then the recent burst (indices 18..24, 7 messages).
  const burstBase = 17 + 30;
  msgs.push(
    makeMessage({
      agentId: null,
      content: '@codex 上面的 schema 和迁移脚本，帮我 review 一下有没有问题？',
      mentions: [CODEX],
      offsetMin: burstBase,
    }),
  );
  msgs.push(
    makeMessage({
      agentId: CODEX,
      content: 'Codex开始 review，先读迁移脚本。',
      offsetMin: burstBase + 1,
      toolEvents: [{ type: 'tool_use', label: 'read_file' }],
    }),
  );
  msgs.push(
    makeMessage({
      agentId: CODEX,
      content: '迁移脚本内容如下（已读取）：CREATE TABLE todos ...',
      offsetMin: burstBase + 2,
      toolEvents: [{ type: 'tool_result', label: 'read_file' }],
    }),
  );
  msgs.push(
    makeMessage({
      agentId: CODEX,
      content: 'Codex review 结论：indexes 缺 created_at，建议补一个 idx_todos_created。',
      offsetMin: burstBase + 3,
    }),
  );
  msgs.push(
    makeMessage({
      agentId: null,
      content: '好的，那 @claude 按Codex 的意见补一下索引。',
      mentions: [CLAUDE],
      offsetMin: burstBase + 4,
    }),
  );
  msgs.push(
    makeMessage({
      agentId: CLAUDE,
      content: 'Claude已补 idx_todos_created 索引并更新迁移脚本。',
      offsetMin: burstBase + 5,
    }),
  );
  msgs.push(
    makeMessage({
      agentId: null,
      content: '现在 database schema 怎么样了？indexes 都齐了吗？',
      offsetMin: burstBase + 6,
    }),
  );
  return msgs;
}
