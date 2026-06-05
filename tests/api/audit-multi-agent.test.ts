// Diagnostic: does a multi-agent (@all) turn emit `invoked` for EVERY agent, or
// only the first (claude)? (User: "审计只记录了claude，没有记录其他两个".)
import Database from 'better-sqlite3';
import { describe, it, expect, afterEach } from 'vitest';
import type { AuditEvent } from '@choco/shared';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';
import { CLAUDE, CODEX, GEMINI, replyScript } from './helpers.js';
import { FakeAgentService } from '../invocation/fake-agent-service.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function getAudit(app: BuiltApp, threadId: string): Promise<AuditEvent[]> {
  const res = await app.api.inject({ method: 'GET', url: `/api/audit/thread/${threadId}` });
  return res.json<{ events: AuditEvent[] }>().events;
}

describe('audit — multi-agent invoked coverage', () => {
  it('@all emits invoked for EVERY available agent (not just claude)', async () => {
    const db = new Database(':memory:');
    const app = buildApp({
      db,
      agentServices: {
        'claude-opus': new FakeAgentService([replyScript(CLAUDE, 'claude 回复')]),
        'codex-gpt': new FakeAgentService([replyScript(CODEX, 'codex 回复')]),
        'gemini-pro': new FakeAgentService([replyScript(GEMINI, 'gemini 回复')]),
      },
    });
    cleanups.push(app.close);

    const r = await app.submitPlatformMessage({
      adapterName: 'wechat', channelId: 'gh_multi', platformUserId: 'u',
      platformMessageId: 'm1', text: '@all 大家读一下这个目录', receivedAt: 1_700_000_000_000,
    });

    const events = await getAudit(app, r.threadId);
    const invokedAgents = events.filter((e) => e.type === 'invoked').map((e) => e.data.agentId);
    expect(invokedAgents).toContain('claude-opus');
    expect(invokedAgents).toContain('codex-gpt');
    expect(invokedAgents).toContain('gemini-pro');
  });
});
