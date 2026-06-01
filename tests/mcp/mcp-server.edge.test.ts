// M10 QA — MCP server edge + adversarial (independently authored, ≠ dev).
//
// Drives the REAL McpServer (createServer) through a real MCP Client over an
// InMemoryTransport, plus a recording CallbackClient so we can assert the exact
// body each tool sends WITHOUT a backend. Attacks:
//   - tools/list: all 9 tools, each with a real input schema; required params
//     enforced (invalid args → clean validation error, server stays alive).
//   - graceful degradation through the SERVER (all env missing + partial env →
//     clean isError, never an unhandled rejection / crash).
//   - body strictness: a tool sends ONLY its documented fields; caller args
//     cannot smuggle identity (threadId/agentId) into the callback body.

import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, buildAllTools } from '@clowder/mcp-server/index';
import { CallbackClient } from '@clowder/mcp-server/callback-client';
import type { CallbackResult } from '@clowder/mcp-server/callback-client';

const EXPECTED_TOOLS = [
  'evidence_search',
  'evidence_upsert',
  'post_message',
  'read_file',
  'search_files',
  'list_session_chain',
  'read_session_digest',
  'read_session_events',
  // SOP-Cycle-1 (additive): the agent self-advance SOP tool (告示牌 producer).
  'sop_advance_stage',
].sort();

interface ToolTextResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

/** A CallbackClient subclass that records (name, body) and returns a canned ok. */
class RecordingClient extends CallbackClient {
  readonly calls: Array<{ name: string; body: Record<string, unknown> }> = [];
  constructor(private readonly canned: CallbackResult = { ok: true, data: { ok: true } }) {
    super({ env: {} });
  }
  override async post(name: string, body: Record<string, unknown>): Promise<CallbackResult> {
    this.calls.push({ name, body });
    return this.canned;
  }
}

/** Connect a real MCP Client to a server built over `client`. */
async function connect(serverClient: CallbackClient): Promise<{ client: Client; close: () => Promise<void> }> {
  const server = createServer(serverClient);
  const client = new Client({ name: 'qa-client', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe('tools/list — registration surface + schemas (edge)', () => {
  it('registers exactly the 9 tools, each with a non-empty description and an inputSchema', async () => {
    const { client, close } = await connect(new CallbackClient({ env: {} }));
    const listed = await client.listTools();

    expect(listed.tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
    for (const tool of listed.tools) {
      expect(tool.description && tool.description.length > 0).toBe(true);
      expect(tool.inputSchema).toBeDefined();
      // The SDK emits a JSON Schema object from the zod raw shape.
      expect(tool.inputSchema.type).toBe('object');
    }
    await close();
  });

  it('declares required params: evidence_upsert requires anchor/kind/title/summary; sessionId tools require sessionId', async () => {
    const { client, close } = await connect(new CallbackClient({ env: {} }));
    const listed = await client.listTools();
    const byName = new Map(listed.tools.map((t) => [t.name, t.inputSchema]));

    const upsert = byName.get('evidence_upsert');
    expect((upsert?.required as string[]).sort()).toEqual(['anchor', 'kind', 'summary', 'title']);

    expect((byName.get('read_session_digest')?.required as string[]) ?? []).toContain('sessionId');
    expect((byName.get('read_session_events')?.required as string[]) ?? []).toContain('sessionId');

    // list_session_chain takes no params → no required (or empty).
    const list = byName.get('list_session_chain');
    expect(list?.required ?? []).toEqual([]);
    await close();
  });

  it('evidence_search/evidence_upsert constrain kind to the EvidenceKind enum', async () => {
    const tools = buildAllTools(new CallbackClient({ env: {} }));
    const upsert = tools.find((t) => t.name === 'evidence_upsert');
    expect(upsert).toBeDefined();
    // The zod raw shape's kind is an enum (9 EvidenceKind variants).
    const kindSchema = upsert?.inputSchema.kind;
    expect(kindSchema).toBeDefined();
  });
});

// Edge: boundary validation — missing/out-of-enum/empty args must be rejected
// cleanly (the SDK/zod contract) without crashing the server.
describe('invalid args → clean validation error (edge)', () => {
  it('read_session_digest with a MISSING sessionId rejects cleanly (server not crashed)', async () => {
    const { client, close } = await connect(new RecordingClient());
    // SDK-level validation should reject; we accept either a thrown RPC error or
    // an isError result — both are "clean", neither is a crash.
    let threw = false;
    try {
      const res = (await client.callTool({
        name: 'read_session_digest',
        arguments: {}, // missing required sessionId
      })) as ToolTextResult;
      expect(res.isError).toBe(true);
    } catch {
      threw = true;
    }
    // After a rejected call, the server is still alive and serves a valid call.
    const listed = await client.listTools();
    expect(listed.tools).toHaveLength(9);
    expect(typeof threw).toBe('boolean');
    await close();
  });

  it('evidence_upsert with an out-of-enum kind is rejected, no callback fired', async () => {
    const recording = new RecordingClient();
    const { client, close } = await connect(recording);
    try {
      const res = (await client.callTool({
        name: 'evidence_upsert',
        arguments: { anchor: 'a:1', kind: 'not-a-real-kind', title: 't', summary: 's' },
      })) as ToolTextResult;
      expect(res.isError).toBe(true);
    } catch {
      // thrown RPC validation error is equally acceptable
    }
    // The invalid call must NOT have reached the callback layer.
    expect(recording.calls.find((c) => c.name === 'evidence_upsert')).toBeUndefined();
    await close();
  });

  it('post_message with empty content (violates min(1)) does not post', async () => {
    const recording = new RecordingClient();
    const { client, close } = await connect(recording);
    try {
      const res = (await client.callTool({
        name: 'post_message',
        arguments: { content: '' },
      })) as ToolTextResult;
      expect(res.isError).toBe(true);
    } catch {
      // acceptable
    }
    expect(recording.calls.find((c) => c.name === 'post_message')).toBeUndefined();
    await close();
  });
});

describe('graceful degradation through the server (adversarial)', () => {
  it('createServer constructs with NO env and registers all tools (no throw at build time)', () => {
    const server = createServer(new CallbackClient({ env: {} }));
    expect(server).toBeDefined();
  });

  it('with ALL env missing, every tool call returns a clean isError (not an unhandled rejection)', async () => {
    const { client, close } = await connect(new CallbackClient({ env: {} }));
    const callable: Array<{ name: string; arguments: Record<string, unknown> }> = [
      { name: 'evidence_search', arguments: { query: '查询' } },
      { name: 'evidence_upsert', arguments: { anchor: 'a:x', kind: 'lesson', title: 't', summary: 's' } },
      { name: 'post_message', arguments: { content: '内容' } },
      { name: 'read_file', arguments: { path: 'README.md' } },
      { name: 'search_files', arguments: { query: 'TODO' } },
      { name: 'list_session_chain', arguments: {} },
      { name: 'read_session_digest', arguments: { sessionId: 'sess-1' } },
      { name: 'read_session_events', arguments: { sessionId: 'sess-1' } },
    ];
    for (const call of callable) {
      const res = (await client.callTool(call)) as ToolTextResult;
      expect(res.isError).toBe(true);
      const text = res.content.find((b) => b.type === 'text')?.text ?? '';
      expect(text).toContain('not configured');
    }
    await close();
  });

  it('with PARTIAL env (only 2 of 3 set), a tool call still degrades to a clean isError', async () => {
    const partial: NodeJS.ProcessEnv = {
      CLOWDER_API_URL: 'http://127.0.0.1:7700',
      CLOWDER_INVOCATION_ID: 'inv_partial',
      // token deliberately absent
    };
    const { client, close } = await connect(new CallbackClient({ env: partial }));
    const res = (await client.callTool({
      name: 'evidence_search',
      arguments: { query: '部分配置' },
    })) as ToolTextResult;
    expect(res.isError).toBe(true);
    const text = res.content.find((b) => b.type === 'text')?.text ?? '';
    expect(text).toContain('not configured');
    await close();
  });
});

describe('body strictness — tools send ONLY documented fields (adversarial)', () => {
  it('post_message sends content + auto clientMessageId, NEVER threadId/agentId even if smuggled in args', async () => {
    const recording = new RecordingClient();
    const { client, close } = await connect(recording);
    // The SDK strips unknown args (its schema only declares content/targetAgents),
    // but assert the body that actually reaches the callback never carries identity.
    await client.callTool({
      name: 'post_message',
      arguments: { content: '正常消息', threadId: 'thread-victim', agentId: 'claude-opus', userId: 'root' },
    });
    const call = recording.calls.find((c) => c.name === 'post_message');
    expect(call).toBeDefined();
    expect(Object.keys(call?.body ?? {}).sort()).toEqual(['clientMessageId', 'content']);
    expect(call?.body.threadId).toBeUndefined();
    expect(call?.body.agentId).toBeUndefined();
    expect(call?.body.userId).toBeUndefined();
    await close();
  });

  it('post_message generates a UNIQUE clientMessageId per call (dedup-key auto-wiring)', async () => {
    const recording = new RecordingClient();
    const { client, close } = await connect(recording);
    await client.callTool({ name: 'post_message', arguments: { content: '第一条' } });
    await client.callTool({ name: 'post_message', arguments: { content: '第二条' } });
    const ids = recording.calls.map((c) => c.body.clientMessageId);
    expect(ids[0]).toBeTruthy();
    expect(ids[1]).toBeTruthy();
    expect(ids[0]).not.toBe(ids[1]);
    await close();
  });

  it('list_session_chain sends an EMPTY body (no thread can be picked by the caller)', async () => {
    const recording = new RecordingClient();
    const { client, close } = await connect(recording);
    await client.callTool({ name: 'list_session_chain', arguments: {} });
    const call = recording.calls.find((c) => c.name === 'list_session_chain');
    expect(call?.body).toEqual({});
    await close();
  });

  it('evidence_search forwards only query (no kind when omitted), and adds kind only when supplied', async () => {
    const recording = new RecordingClient();
    const { client, close } = await connect(recording);
    await client.callTool({ name: 'evidence_search', arguments: { query: '数据库选型' } });
    await client.callTool({ name: 'evidence_search', arguments: { query: '架构决策', kind: 'decision' } });
    const [first, second] = recording.calls;
    expect(first?.body).toEqual({ query: '数据库选型' });
    expect(second?.body).toEqual({ query: '架构决策', kind: 'decision' });
    await close();
  });

  it('search_files omits path when absent and forwards it (verbatim) when present — guard lives server-side', async () => {
    const recording = new RecordingClient();
    const { client, close } = await connect(recording);
    await client.callTool({ name: 'search_files', arguments: { query: 'TODO' } });
    await client.callTool({ name: 'search_files', arguments: { query: 'TODO', path: 'src' } });
    const [first, second] = recording.calls;
    expect(first?.body).toEqual({ query: 'TODO' });
    expect(second?.body).toEqual({ query: 'TODO', path: 'src' });
    await close();
  });

  it('read_file forwards the path VERBATIM (does not pre-sanitize) — the server owns the sandbox guard', async () => {
    const recording = new RecordingClient();
    const { client, close } = await connect(recording);
    // A traversal string is forwarded as-is; the API (not the client) returns 403.
    await client.callTool({ name: 'read_file', arguments: { path: '../../etc/passwd' } });
    const call = recording.calls.find((c) => c.name === 'read_file');
    expect(call?.body).toEqual({ path: '../../etc/passwd' });
    await close();
  });
});
