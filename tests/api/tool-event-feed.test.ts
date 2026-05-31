// M5-amend dev happy-path integration: the live ToolEventLog feed.
//
// Drives buildApp with a FakeAgentService that emits a real tool_use + paired
// tool_result, POSTs a user message (which runs the router through the real
// invoke seam → message-routes durable sink), then asserts the A6 ToolEventLog
// holds a row for that thread/invocation with a populated durationMs. QA owns
// edge/adversarial coverage (unpaired tools, multi-agent, ordering, etc.).

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { AgentMessage } from '@clowder/shared';
import { buildApp, type BuiltApp } from '@clowder/api/app-factory';
import { FakeAgentService } from '../invocation/fake-agent-service.js';
import { CLAUDE } from './helpers.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

/** A reply that uses one tool: session_init, tool_use, tool_result, text, done. */
function toolUsingReply(): AgentMessage[] {
  const ts = 1_700_000_900_000;
  return [
    { type: 'session_init', agentId: CLAUDE, content: 'sess-claude', timestamp: ts },
    {
      type: 'tool_use',
      agentId: CLAUDE,
      toolName: 'read_file',
      toolUseId: 'tu-1',
      toolInput: { path: 'packages/api/src/app-factory.ts' },
      timestamp: ts + 10,
    },
    {
      type: 'tool_result',
      agentId: CLAUDE,
      toolUseId: 'tu-1',
      content: 'export function buildApp(...) { … }',
      timestamp: ts + 60,
    },
    { type: 'text', agentId: CLAUDE, content: '已读取 app-factory，下面是评审意见。', timestamp: ts + 70 },
    { type: 'done', agentId: CLAUDE, isFinal: true, timestamp: ts + 80 },
  ];
}

describe('ToolEventLog live feed (integration, happy path)', () => {
  it('persists a tool event with invocationId, thread, and durationMs on POST', async () => {
    const db = new Database(':memory:');
    const fakes = { 'claude-opus': new FakeAgentService([toolUsingReply()]) };
    const app: BuiltApp = buildApp({ db, agentServices: fakes });
    cleanups.push(app.close);

    const threadId = 'thread-tool-feed';
    const res = await app.api.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/messages`,
      payload: { content: '@claude 评审 app-factory 的 DI 接线', userId: 'user-makima' },
    });
    expect(res.statusCode).toBe(200);

    const rows = await app.stores.toolEventLog.readByThread(threadId);
    expect(rows).toHaveLength(1);

    const event = rows[0];
    expect(event?.threadId).toBe(threadId);
    expect(event?.agentId).toBe(CLAUDE);
    expect(event?.toolName).toBe('read_file');
    expect(event?.toolInput).toBe(JSON.stringify({ path: 'packages/api/src/app-factory.ts' }));
    expect(event?.toolResult).toBe('export function buildApp(...) { … }');
    // tool_result.timestamp - tool_use.timestamp = 60 - 10 = 50
    expect(event?.durationMs).toBe(50);

    // The same row is retrievable by its (real, minted) invocationId.
    expect(event?.invocationId).toBeTruthy();
    const byInvocation = await app.stores.toolEventLog.readByInvocation(event!.invocationId);
    expect(byInvocation).toHaveLength(1);
    expect(byInvocation[0]?.id).toBe(event?.id);
  });

  it('records the tool_events row on the happy path and logs nothing when the append succeeds', async () => {
    // Regression guard for the logging fix: when the durable append SUCCEEDS, the
    // wired RouteLogger must stay silent (the warn is reserved for the failure
    // path) AND the row must still be persisted (the fix did not break the happy
    // path). An injected capturing logger lets us assert no warn was emitted.
    const warnEvents: Array<{ level: string; message: string }> = [];
    const db = new Database(':memory:');
    const fakes = { 'claude-opus': new FakeAgentService([toolUsingReply()]) };
    const app: BuiltApp = buildApp({
      db,
      agentServices: fakes,
      logger: (event) => {
        if (event.level === 'warn') warnEvents.push({ level: event.level, message: event.message });
      },
    });
    cleanups.push(app.close);

    const threadId = 'thread-tool-feed-happy';
    const res = await app.api.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/messages`,
      payload: { content: '@claude 评审 app-factory 的 DI 接线', userId: 'user-makima' },
    });
    expect(res.statusCode).toBe(200);

    // The durable feed wrote the row (append succeeded → no swallowed failure).
    const rows = await app.stores.toolEventLog.readByThread(threadId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.toolName).toBe('read_file');

    // No tool-event-feed warning should have been logged on a successful append.
    const feedWarnings = warnEvents.filter((e) => e.message.includes('tool-event-feed'));
    expect(feedWarnings).toEqual([]);
  });
});
