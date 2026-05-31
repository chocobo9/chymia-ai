// M10 dev happy-path — MCP server end-to-end through the REAL API callbacks.
//
// This is an INTEGRATION test (no mock of the callback layer): it stands up the
// real buildApp() over an in-memory SQLite db, listens on an ephemeral port,
// mints a live invocation via the app's own InvocationRegistry, sets the three
// CLOWDER_* env vars the MCP server reads, then drives the McpServer through a
// real MCP Client over an in-memory transport pair. evidence_search is proven
// round-trip: tool call → callback-client HTTP POST → real /api/callback/
// evidence_search → real EvidenceStore → results back to the tool caller.
//
// Also asserts tools/list exposes all 8 registered tools.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createAgentId } from '@clowder/shared';
import { buildApp, type BuiltApp } from '@clowder/api/app-factory';
import { CallbackClient } from '@clowder/mcp-server/callback-client';
import { createServer } from '@clowder/mcp-server/index';

const CODEX = createAgentId('codex-gpt');

/** Every tool the MCP server must register (arch §5.7 + 补充 E). */
const EXPECTED_TOOLS = [
  'evidence_search',
  'evidence_upsert',
  'post_message',
  'read_file',
  'search_files',
  'list_session_chain',
  'read_session_digest',
  'read_session_events',
] as const;

interface ToolTextResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

/** Parse the JSON text block an MCP tool returns. */
function parseToolJson(result: ToolTextResult): unknown {
  const text = result.content.find((b) => b.type === 'text')?.text ?? '';
  return JSON.parse(text);
}

describe('M10 MCP server (happy path)', () => {
  it('tools/list returns all 8 registered tools', async () => {
    // No env / no API needed — pure registration surface.
    const server = createServer(new CallbackClient({ env: {} }));
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_TOOLS].sort());

    await client.close();
    await server.close();
  });

  describe('end-to-end through the real API', () => {
    let app: BuiltApp;
    let baseUrl: string;
    let client: Client;
    let server: ReturnType<typeof createServer>;

    beforeEach(async () => {
      const db = new Database(':memory:');
      app = buildApp({ db });
      const address = await app.api.listen({ port: 0, host: '127.0.0.1' });
      baseUrl = typeof address === 'string' ? address : 'http://127.0.0.1';

      // Mint a live invocation the way the running CLI would be handed one.
      const threadId = 'thread-mcp-e2e';
      await app.stores.threadStore.ensureThread(threadId, 'MCP e2e');
      const record = app.invocations.create({ userId: 'user', agentId: CODEX, threadId });

      // The env the CLI injects into this MCP subprocess (frozen §C3 contract).
      const env: NodeJS.ProcessEnv = {
        CLOWDER_API_URL: baseUrl,
        CLOWDER_INVOCATION_ID: record.invocationId,
        CLOWDER_CALLBACK_TOKEN: record.callbackToken,
      };

      server = createServer(new CallbackClient({ env }));
      client = new Client({ name: 'test-client', version: '0.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    });

    afterEach(async () => {
      await client.close();
      await server.close();
      await app.close();
    });

    it('evidence_search round-trips real results from the callback', async () => {
      app.stores.evidenceStore.upsert({
        anchor: 'decision:storage',
        kind: 'decision',
        status: 'active',
        title: '存储选型：SQLite + FTS5',
        summary: '决定使用 better-sqlite3 配合 FTS5 全文检索作为持久化方案。',
        keywords: ['SQLite', 'FTS5', '存储'],
        updatedAt: new Date().toISOString(),
      });

      const result = (await client.callTool({
        name: 'evidence_search',
        arguments: { query: 'SQLite' },
      })) as ToolTextResult;

      expect(result.isError).toBeFalsy();
      const data = parseToolJson(result) as { items: Array<{ anchor: string }> };
      expect(data.items.length).toBeGreaterThanOrEqual(1);
      expect(data.items.some((i) => i.anchor === 'decision:storage')).toBe(true);
    });

    it('evidence_upsert then evidence_search finds the written item (write path round-trip)', async () => {
      const upsert = (await client.callTool({
        name: 'evidence_upsert',
        arguments: {
          anchor: 'lesson:retry',
          kind: 'lesson',
          title: '重试策略教训',
          summary: 'missing-session 错误应清除 session 后重试，最多两次。',
        },
      })) as ToolTextResult;
      expect(upsert.isError).toBeFalsy();
      expect(parseToolJson(upsert)).toMatchObject({ anchor: 'lesson:retry', upserted: true });

      const search = (await client.callTool({
        name: 'evidence_search',
        arguments: { query: '重试', kind: 'lesson' },
      })) as ToolTextResult;
      const data = parseToolJson(search) as { items: Array<{ anchor: string }> };
      expect(data.items.some((i) => i.anchor === 'lesson:retry')).toBe(true);
    });

    it('post_message posts into the thread and the API persists it (201 → messageId)', async () => {
      const result = (await client.callTool({
        name: 'post_message',
        arguments: { content: '进度：MCP 工具已接通 API callback。' },
      })) as ToolTextResult;

      expect(result.isError).toBeFalsy();
      const data = parseToolJson(result) as { messageId?: string };
      expect(data.messageId).toBeTruthy();

      const stored = await app.stores.messageStore.getByThread('thread-mcp-e2e');
      expect(stored.some((m) => m.origin === 'callback' && m.agentId === 'codex-gpt')).toBe(true);
    });

    it('list_session_chain returns the thread session chain (200)', async () => {
      const result = (await client.callTool({
        name: 'list_session_chain',
        arguments: {},
      })) as ToolTextResult;

      expect(result.isError).toBeFalsy();
      const data = parseToolJson(result) as { sessions: unknown[] };
      expect(Array.isArray(data.sessions)).toBe(true);
    });
  });

  it('a tool call without callback env returns a clean error (graceful degradation, no crash)', async () => {
    // Server constructed with an empty env — startup must NOT crash, and a tool
    // call must surface a clean isError result instead of an unhandled rejection.
    const server = createServer(new CallbackClient({ env: {} }));
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = (await client.callTool({
      name: 'evidence_search',
      arguments: { query: '在没有凭证时调用' },
    })) as ToolTextResult;

    expect(result.isError).toBe(true);
    const text = result.content.find((b) => b.type === 'text')?.text ?? '';
    expect(text).toContain('not configured');

    await client.close();
    await server.close();
  });
});
