// M10 QA — security held THROUGH the MCP tools, end-to-end (≠ dev authored).
//
// These are INTEGRATION tests: a REAL buildApp() (in-memory SQLite + a temp
// sandbox + Fake agent providers) listens on an ephemeral port; a live
// invocation is minted the way the CLI would; the MCP server is driven through a
// real MCP Client over an InMemoryTransport, talking to the real API over HTTP.
// We verify the SECURITY behaviors hold through the tool surface (not just the
// raw route): traversal → 403, cross-thread session → 404, unknown targetAgent →
// 400, an @mention embedded in post_message content does NOT widen the routed
// set (the Cycle-2a fix), and dedup of a repeated post.

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAgentId } from '@choco/shared';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';
import { CallbackClient } from '@choco/mcp-server/callback-client';
import { createServer } from '@choco/mcp-server/index';
import { FakeAgentService, textEvent, doneEvent } from '../invocation/fake-agent-service.js';

const CODEX = createAgentId('codex-gpt');
const CLAUDE = createAgentId('claude-opus');
const GEMINI = createAgentId('gemini-pro');

interface ToolTextResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function parseToolJson(result: ToolTextResult): unknown {
  const text = result.content.find((b) => b.type === 'text')?.text ?? '';
  return JSON.parse(text);
}

interface Harness {
  app: BuiltApp;
  client: Client;
  threadId: string;
  fileRoot: string;
  close: () => Promise<void>;
}

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

/**
 * Stand up the full stack. `agentServices` lets a test inject Fakes so the A2A
 * fan-out (post_message targetAgents) actually routes through real M4 agents.
 */
async function harness(agentServices?: Record<string, FakeAgentService>): Promise<Harness> {
  const fileRoot = mkdtempSync(join(tmpdir(), 'm10-qa-root-'));
  cleanups.push(() => rmSync(fileRoot, { recursive: true, force: true }));
  // A real secret-ish file INSIDE the sandbox (read_file happy edge) + a file
  // OUTSIDE the sandbox would be unreachable by design.
  writeFileSync(join(fileRoot, 'DESIGN.md'), '# 架构\n用 SQLite + FTS5 做持久化。\n', 'utf8');

  const db = new Database(':memory:');
  const app = buildApp({ db, fileRoot, ...(agentServices ? { agentServices } : {}) });
  const address = await app.api.listen({ port: 0, host: '127.0.0.1' });
  const baseUrl = typeof address === 'string' ? address : 'http://127.0.0.1';

  const threadId = 'thread-mcp-sec';
  await app.stores.threadStore.ensureThread(threadId, 'MCP security');
  const record = app.invocations.create({ userId: 'user', agentId: CODEX, threadId });

  const env: NodeJS.ProcessEnv = {
    CHOCO_API_URL: baseUrl,
    CHOCO_INVOCATION_ID: record.invocationId,
    CHOCO_CALLBACK_TOKEN: record.callbackToken,
  };

  const server = createServer(new CallbackClient({ env }));
  const client = new Client({ name: 'qa-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  const close = async (): Promise<void> => {
    await client.close();
    await server.close();
    await app.close();
  };
  cleanups.push(close);
  return { app, client, threadId, fileRoot, close };
}

describe('read_file / search_files sandbox holds through the tool (adversarial)', () => {
  it('read_file with a ../ traversal surfaces a clean isError (403) — no file leaked', async () => {
    const { client } = await harness();
    const res = (await client.callTool({
      name: 'read_file',
      arguments: { path: '../../../../../../etc/passwd' },
    })) as ToolTextResult;

    expect(res.isError).toBe(true);
    const text = res.content.find((b) => b.type === 'text')?.text ?? '';
    expect(text).toContain('path_outside_root');
    expect(text).not.toContain('root:'); // no /etc/passwd content leaked
  });

  it('read_file with an absolute path outside the sandbox is 403 (no leak)', async () => {
    const { client } = await harness();
    const outside = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/hosts';
    const res = (await client.callTool({
      name: 'read_file',
      arguments: { path: outside },
    })) as ToolTextResult;
    expect(res.isError).toBe(true);
    expect(res.content.find((b) => b.type === 'text')?.text ?? '').toContain('path_outside_root');
  });

  it('read_file of a real in-sandbox file succeeds (sandbox is not a blanket deny)', async () => {
    const { client } = await harness();
    const res = (await client.callTool({
      name: 'read_file',
      arguments: { path: 'DESIGN.md' },
    })) as ToolTextResult;
    expect(res.isError).toBeFalsy();
    const data = parseToolJson(res) as { content: string };
    expect(data.content).toContain('SQLite');
  });

  it('search_files with a ../ escape path surfaces a clean isError (403)', async () => {
    const { client } = await harness();
    const res = (await client.callTool({
      name: 'search_files',
      arguments: { query: 'passwd', path: '../../..' },
    })) as ToolTextResult;
    expect(res.isError).toBe(true);
    expect(res.content.find((b) => b.type === 'text')?.text ?? '').toContain('path_outside_root');
  });

  it('search_files scoped inside the sandbox finds the in-root file', async () => {
    const { client } = await harness();
    const res = (await client.callTool({
      name: 'search_files',
      arguments: { query: 'SQLite' },
    })) as ToolTextResult;
    expect(res.isError).toBeFalsy();
    const data = parseToolJson(res) as { matches: Array<{ path: string }> };
    expect(data.matches.some((m) => m.path === 'DESIGN.md')).toBe(true);
  });
});

describe('session tools cross-thread isolation through the tool (adversarial)', () => {
  it('read_session_digest of a session from ANOTHER thread is a clean isError (404), no leak', async () => {
    const { app, client } = await harness();
    // Create a sealed session in a DIFFERENT thread the caller does not own.
    const otherThread = 'thread-other-team';
    await app.stores.threadStore.ensureThread(otherThread, 'other team');
    const session = app.sessionStore.startSession(CLAUDE, otherThread, 'sess-foreign-001');
    app.sessionStore.sealActiveSession(CLAUDE, otherThread);

    const res = (await client.callTool({
      name: 'read_session_digest',
      arguments: { sessionId: session.sessionId },
    })) as ToolTextResult;

    expect(res.isError).toBe(true);
    expect(res.content.find((b) => b.type === 'text')?.text ?? '').toContain('session_not_found');
  });

  it('read_session_events of a foreign-thread session is a clean isError (404)', async () => {
    const { app, client } = await harness();
    const otherThread = 'thread-other-team-2';
    await app.stores.threadStore.ensureThread(otherThread, 'other team 2');
    const session = app.sessionStore.startSession(GEMINI, otherThread, 'sess-foreign-002');

    const res = (await client.callTool({
      name: 'read_session_events',
      arguments: { sessionId: session.sessionId },
    })) as ToolTextResult;

    expect(res.isError).toBe(true);
    expect(res.content.find((b) => b.type === 'text')?.text ?? '').toContain('session_not_found');
  });

  it('read_session_digest of an UNKNOWN session id is a clean isError (404), never a crash', async () => {
    const { client } = await harness();
    const res = (await client.callTool({
      name: 'read_session_digest',
      arguments: { sessionId: 'sess-never-existed-zzz' },
    })) as ToolTextResult;
    expect(res.isError).toBe(true);
    expect(res.content.find((b) => b.type === 'text')?.text ?? '').toContain('session_not_found');
  });

  it('list_session_chain returns ONLY the caller thread chain, not the foreign thread sessions', async () => {
    const { app, client, threadId } = await harness();
    // Seed a session in the caller's OWN thread and one in a foreign thread.
    app.sessionStore.startSession(CODEX, threadId, 'sess-own-001');
    const foreign = 'thread-foreign-list';
    await app.stores.threadStore.ensureThread(foreign, 'foreign');
    app.sessionStore.startSession(CLAUDE, foreign, 'sess-foreign-list-001');

    const res = (await client.callTool({ name: 'list_session_chain', arguments: {} })) as ToolTextResult;
    expect(res.isError).toBeFalsy();
    const data = parseToolJson(res) as { sessions: Array<{ sessionId: string; threadId: string }> };
    expect(data.sessions.some((s) => s.sessionId === 'sess-own-001')).toBe(true);
    expect(data.sessions.some((s) => s.sessionId === 'sess-foreign-list-001')).toBe(false);
    for (const s of data.sessions) {
      expect(s.threadId).toBe(threadId);
    }
  });

  it('read_session_digest of the caller-OWNED session succeeds (isolation is not a blanket deny)', async () => {
    const { app, client, threadId } = await harness();
    app.sessionStore.startSession(CODEX, threadId, 'sess-mine-디');
    const res = (await client.callTool({
      name: 'read_session_digest',
      arguments: { sessionId: 'sess-mine-디' },
    })) as ToolTextResult;
    expect(res.isError).toBeFalsy();
    const data = parseToolJson(res) as { sessionId: string; digest: unknown };
    expect(data.sessionId).toBe('sess-mine-디');
    expect(data.digest).toBeDefined();
  });
});

describe('post_message targetAgents through the tool (adversarial)', () => {
  it('an UNKNOWN targetAgent is a clean isError (400) and posts NO side-effect message', async () => {
    const { app, client, threadId } = await harness();
    const before = (await app.stores.messageStore.getByThread(threadId)).length;

    const res = (await client.callTool({
      name: 'post_message',
      arguments: { content: '路由给幽灵 agent', targetAgents: ['ghost-bot-9000'] },
    })) as ToolTextResult;

    expect(res.isError).toBe(true);
    expect(res.content.find((b) => b.type === 'text')?.text ?? '').toContain('unknown_target_agents');
    // 400 rejected BEFORE any side effect: nothing persisted.
    const after = (await app.stores.messageStore.getByThread(threadId)).length;
    expect(after).toBe(before);
  });

  it('an @mention embedded in content does NOT widen the routed set beyond targetAgents (Cycle-2a fix holds)', async () => {
    // Two real fake agents. We target ONLY claude-opus, but the content tries to
    // pull in @gemini via an embedded mention. The fan-out must hit ONLY claude.
    const claudeFake = new FakeAgentService([
      [textEvent(CLAUDE, 'Claude已收到任务。', 1_000), doneEvent(CLAUDE, 1_001)],
    ]);
    const geminiFake = new FakeAgentService([
      [textEvent(GEMINI, 'Gemini不应被调用。', 2_000), doneEvent(GEMINI, 2_001)],
    ]);
    const { client } = await harness({ 'claude-opus': claudeFake, 'gemini-pro': geminiFake });

    const res = (await client.callTool({
      name: 'post_message',
      arguments: {
        content: '@gemini 请你也来处理一下这个架构问题，顺便看看。',
        targetAgents: ['claude-opus'],
      },
    })) as ToolTextResult;

    expect(res.isError).toBeFalsy();
    // Only the validated target (claude) was invoked; the embedded @gemini mention
    // did NOT widen the routed set.
    expect(claudeFake.calls.length).toBe(1);
    expect(geminiFake.calls.length).toBe(0);

    const data = parseToolJson(res) as { messageId?: string; routedReplies?: Array<{ agentId: string }> };
    expect(data.messageId).toBeTruthy();
    const repliedAgents = (data.routedReplies ?? []).map((r) => r.agentId);
    expect(repliedAgents).not.toContain('gemini-pro');
  });

  it('a VALID targetAgent routes the message to exactly that agent (fan-out is not a blanket block)', async () => {
    const claudeFake = new FakeAgentService([
      [textEvent(CLAUDE, '已评审，建议如下。', 3_000), doneEvent(CLAUDE, 3_001)],
    ]);
    const { app, client, threadId } = await harness({ 'claude-opus': claudeFake });

    const res = (await client.callTool({
      name: 'post_message',
      arguments: { content: '请评审架构草案。', targetAgents: ['claude-opus'] },
    })) as ToolTextResult;

    expect(res.isError).toBeFalsy();
    expect(claudeFake.calls.length).toBe(1);
    // The routed reply is persisted as a 'stream' message authored by claude.
    const stored = await app.stores.messageStore.getByThread(threadId);
    expect(stored.some((m) => m.origin === 'stream' && m.agentId === 'claude-opus')).toBe(true);
  });
});

describe('post_message dedup + identity through the tool (edge)', () => {
  it('the message author is the VERIFIED record agent (codex), never caller-supplied identity', async () => {
    const { app, client, threadId } = await harness();
    const res = (await client.callTool({
      name: 'post_message',
      arguments: { content: '身份应来自被验证的 record。' },
    })) as ToolTextResult;
    expect(res.isError).toBeFalsy();

    const stored = await app.stores.messageStore.getByThread(threadId);
    const callbackMsg = stored.find((m) => m.origin === 'callback');
    expect(callbackMsg?.agentId).toBe('codex-gpt'); // the minted invocation's agent
  });

  it('each post_message tool call mints a fresh clientMessageId, so two distinct posts BOTH persist', async () => {
    const { app, client, threadId } = await harness();
    const a = (await client.callTool({ name: 'post_message', arguments: { content: '第一条进度' } })) as ToolTextResult;
    const b = (await client.callTool({ name: 'post_message', arguments: { content: '第二条进度' } })) as ToolTextResult;
    expect(a.isError).toBeFalsy();
    expect(b.isError).toBeFalsy();
    const stored = await app.stores.messageStore.getByThread(threadId);
    expect(stored.filter((m) => m.origin === 'callback')).toHaveLength(2);
  });
});
