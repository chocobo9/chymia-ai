// tests/api/helpers — M8 dev happy-path test harness.
//
// Builds a buildApp() instance over an in-memory SQLite db with a Fake provider
// injected, listens on an ephemeral port (so a real socket.io-client can connect
// for the room-broadcast assertions), and tears everything down. No global state
// — every test gets its own app/db (hermetic isolation).

import Database from 'better-sqlite3';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import type { AgentId, AgentMessage } from '@clowder/shared';
import { createAgentId } from '@clowder/shared';
import { buildApp, type BuiltApp } from '@clowder/api/app-factory';
import { FakeAgentService } from '../invocation/fake-agent-service.js';

/** The three roster agent ids (from packages/api/src/config/agents.yaml). */
export const CLAUDE: AgentId = createAgentId('claude-opus');
export const CODEX: AgentId = createAgentId('codex-gpt');
export const GEMINI: AgentId = createAgentId('gemini-pro');

/** Build a `text` then `done` script for one agent reply. */
export function replyScript(agentId: AgentId, text: string): AgentMessage[] {
  const ts = Date.now();
  return [
    { type: 'session_init', agentId, content: `sess-${agentId as string}`, timestamp: ts },
    { type: 'text', agentId, content: text, timestamp: ts + 1 },
    { type: 'done', agentId, isFinal: true, timestamp: ts + 2 },
  ];
}

export interface TestApp {
  readonly app: BuiltApp;
  readonly baseUrl: string;
  readonly fakes: Record<string, FakeAgentService>;
  close(): Promise<void>;
}

/**
 * Start a test app. `scripts` maps an agent id to the event scripts its Fake
 * provider should replay (one inner array per invocation).
 */
export async function startTestApp(
  scripts: Record<string, readonly (readonly AgentMessage[])[]>,
): Promise<TestApp> {
  const db = new Database(':memory:');
  const fakes: Record<string, FakeAgentService> = {};
  for (const [id, agentScripts] of Object.entries(scripts)) {
    fakes[id] = new FakeAgentService(agentScripts);
  }

  const app = buildApp({ db, agentServices: fakes });
  // Ephemeral port so socket.io-client can connect over a real HTTP server.
  const address = await app.api.listen({ port: 0, host: '127.0.0.1' });
  const baseUrl = typeof address === 'string' ? address : `http://127.0.0.1`;

  return {
    app,
    baseUrl,
    fakes,
    close: async () => {
      await app.close();
    },
  };
}

/** Connect a socket.io client, join `threadId`, and resolve once joined. */
export async function connectClient(
  baseUrl: string,
  threadId: string,
): Promise<ClientSocket> {
  const socket = ioClient(baseUrl, { transports: ['websocket'], forceNew: true });
  await new Promise<void>((resolve, reject) => {
    socket.on('connect', () => {
      socket.emit('join_thread', { threadId });
      // Give the server a tick to process the room join before resolving.
      setTimeout(resolve, 30);
    });
    socket.on('connect_error', reject);
  });
  return socket;
}

/** Collect agent_event payloads a client receives until `done` (or timeout). */
export function collectAgentEvents(
  socket: ClientSocket,
  timeoutMs = 2000,
): Promise<AgentMessage[]> {
  return new Promise((resolve) => {
    const events: AgentMessage[] = [];
    const timer = setTimeout(() => resolve(events), timeoutMs);
    socket.on('agent_event', (msg: AgentMessage) => {
      events.push(msg);
      if (msg.type === 'done') {
        clearTimeout(timer);
        // Small grace period in case more than one agent's done arrives.
        setTimeout(() => resolve(events), 80);
      }
    });
  });
}
