// M9 web test fixtures — realistic Thread / AgentMessage / StoredMessage /
// roster shapes mirroring the M8 server payloads. No placeholder data: real
// @mention text, real agent ids (claude-opus / codex-gpt / gemini-pro), real
// reply prose.

import type {
  AgentId,
  AgentMessage,
  AgentState,
  StoredMessage,
  Thread,
} from '@choco/shared';
import { createAgentId } from '@choco/shared';
import type { AgentRosterEntry } from '../../packages/web/src/lib/api.js';

export const CLAUDE: AgentId = createAgentId('claude-opus');
export const CODEX: AgentId = createAgentId('codex-gpt');
export const GEMINI: AgentId = createAgentId('gemini-pro');

/** Roster as GET /api/agents returns it (3 real agents from agents.yaml). */
export const ROSTER: readonly AgentRosterEntry[] = [
  {
    id: 'claude-opus',
    name: 'Claude',
    displayName: 'Claude',
    clientId: 'anthropic',
    color: { primary: '#6366f1', secondary: '#818cf8' },
    mentionPatterns: ['@claude'],
    strengths: ['架构设计', '代码实现', '重构'],
    status: 'idle',
  },
  {
    id: 'codex-gpt',
    name: 'Codex',
    displayName: 'Codex',
    clientId: 'openai',
    color: { primary: '#10b981', secondary: '#34d399' },
    mentionPatterns: ['@codex'],
    strengths: ['快速实现', '脚本化', '调试'],
    status: 'idle',
  },
  {
    id: 'gemini-pro',
    name: 'Gemini',
    displayName: 'Gemini',
    clientId: 'google',
    color: { primary: '#f59e0b', secondary: '#fbbf24' },
    mentionPatterns: ['@gemini'],
    strengths: ['研究调研', '批判性分析', '方案对比'],
    status: 'idle',
  },
];

export function makeThread(overrides: Partial<Thread> = {}): Thread {
  const now = Date.UTC(2026, 4, 31, 12, 0, 0);
  return {
    id: 'thread_todo_api',
    title: 'TODO API 设计与实现',
    createdAt: now,
    lastActiveAt: now,
    participants: [CLAUDE],
    thinkingMode: 'debug',
    ...overrides,
  };
}

export function makeUserMessage(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: 'msg_user_1',
    threadId: 'thread_todo_api',
    userId: 'user',
    agentId: null,
    content: '@claude 写一个带 CRUD 的 TODO API',
    mentions: [CLAUDE],
    origin: 'user',
    timestamp: Date.UTC(2026, 4, 31, 12, 0, 1),
    ...overrides,
  };
}

export function makeAgentReply(overrides: Partial<StoredMessage> = {}): StoredMessage {
  return {
    id: 'msg_agent_1',
    threadId: 'thread_todo_api',
    userId: 'claude-opus',
    agentId: CLAUDE,
    content: '我已经实现了 TODO API：GET/POST /todos、GET/PATCH/DELETE /todos/:id，并加了 zod 校验。',
    mentions: [],
    origin: 'stream',
    // The backend stamps the turn's invocationId into extra so the client can
    // replace the settled live bubble of the same (agent, invocation). Matches the
    // invocationId the streaming frame fixtures (textFrame/doneFrame) carry.
    extra: { invocationId: 'inv_1' },
    timestamp: Date.UTC(2026, 4, 31, 12, 0, 9),
    ...overrides,
  };
}

/** A streaming text frame from an agent. */
export function textFrame(agentId: AgentId, content: string, ts: number): AgentMessage {
  return { type: 'text', agentId, content, invocationId: 'inv_1', timestamp: ts };
}

export function thinkingFrame(agentId: AgentId, content: string, ts: number): AgentMessage {
  return { type: 'thinking', agentId, content, invocationId: 'inv_1', timestamp: ts };
}

export function toolUseFrame(
  agentId: AgentId,
  toolName: string,
  toolInput: Record<string, unknown>,
  ts: number,
): AgentMessage {
  return {
    type: 'tool_use',
    agentId,
    toolName,
    toolInput,
    toolUseId: 'tool_1',
    invocationId: 'inv_1',
    timestamp: ts,
  };
}

export function doneFrame(agentId: AgentId, ts: number): AgentMessage {
  return { type: 'done', agentId, isFinal: true, invocationId: 'inv_1', timestamp: ts };
}

export function workingStatus(agentId: AgentId, threadId: string): AgentState {
  return {
    id: agentId,
    status: 'working',
    currentThreadId: threadId,
    lastActiveAt: Date.UTC(2026, 4, 31, 12, 0, 2),
  };
}

export function idleStatus(agentId: AgentId, threadId: string): AgentState {
  return {
    id: agentId,
    status: 'idle',
    currentThreadId: threadId,
    lastActiveAt: Date.UTC(2026, 4, 31, 12, 0, 10),
  };
}
