// SOP-Cycle-2 dev happy-path suite — advisory post-hoc evaluateTrace, wired ON
// STAGE-ADVANCE (M12). QA (≠ this dev) owns the edge/adversarial/e2e gating.
//
// These happy tests prove the wired pieces through the REAL buildApp pipeline
// (in-memory db) with real stage ids + real command strings — no placeholders:
//   A) the trace adapter extracts `command` strings from Bash-style tool events.
//   B) leaving `quality_gate` with NO `npx vitest run` in the trace → an advisory
//      `sop_violation` is broadcast + a warn is logged, AND the PATCH still 200s.
//   C) leaving `quality_gate` WHEN a tool event ran `npx vitest run` → no violation.
//   D) leaving `kickoff` (manual_only) → all skipped → no violation.
//   E) setting a stage on a thread with NO prior stage (oldStage null) → no eval.
//   F) the agent self-advance callback routes through the same helper (violation
//      broadcast + 200).

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { AgentId, SopViolationPayload, StoredToolEvent } from '@choco/shared';
import { createAgentId } from '@choco/shared';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';
import { buildSopTraceContext } from '@choco/api/sop/sop-trace-adapter';
import { connectClient } from './helpers.js';
import type { Socket as ClientSocket } from 'socket.io-client';

const CLAUDE: AgentId = createAgentId('claude-opus');

interface LogEvent {
  readonly level: 'info' | 'warn';
  readonly message: string;
  readonly threadId: string;
  readonly agentId?: AgentId;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    const fn = cleanups.pop();
    if (fn) await fn();
  }
});

/** Build a listening app with a capturing logger; returns the app + log buffer. */
async function startApp(): Promise<{ app: BuiltApp; logs: LogEvent[]; baseUrl: string }> {
  const logs: LogEvent[] = [];
  const app = buildApp({
    db: new Database(':memory:'),
    logger: (event) => {
      logs.push(event);
    },
  });
  const address = await app.api.listen({ port: 0, host: '127.0.0.1' });
  const baseUrl = typeof address === 'string' ? address : 'http://127.0.0.1';
  cleanups.push(app.close);
  return { app, logs, baseUrl };
}

/** Append one Bash tool event running `command` for `threadId`. */
async function appendBashCommand(
  app: BuiltApp,
  threadId: string,
  command: string,
): Promise<void> {
  await app.stores.toolEventLog.append({
    invocationId: 'inv-cycle2',
    threadId,
    agentId: CLAUDE,
    toolName: 'Bash',
    toolInput: JSON.stringify({ command }),
    timestamp: Date.now(),
  });
}

/** Collect `sop_violation` payloads a joined client receives within `timeoutMs`. */
function collectSopViolations(socket: ClientSocket, timeoutMs = 600): Promise<SopViolationPayload[]> {
  return new Promise((resolve) => {
    const received: SopViolationPayload[] = [];
    socket.on('sop_violation', (payload: SopViolationPayload) => {
      received.push(payload);
    });
    setTimeout(() => resolve(received), timeoutMs);
  });
}

describe('A) buildSopTraceContext (happy path)', () => {
  it('extracts command strings from Bash-style tool events', () => {
    const events: StoredToolEvent[] = [
      {
        id: 't1',
        invocationId: 'inv-1',
        threadId: 'thread-todo-api',
        agentId: CLAUDE,
        toolName: 'Bash',
        toolInput: JSON.stringify({ command: 'npx vitest run tests/sop/' }),
        timestamp: 1,
      },
      {
        id: 't2',
        invocationId: 'inv-1',
        threadId: 'thread-todo-api',
        agentId: CLAUDE,
        toolName: 'Read', // not a command runner — ignored
        toolInput: JSON.stringify({ file_path: 'src/index.ts' }),
        timestamp: 2,
      },
      {
        id: 't3',
        invocationId: 'inv-1',
        threadId: 'thread-todo-api',
        agentId: CLAUDE,
        toolName: 'Bash',
        toolInput: JSON.stringify({ command: 'git status' }),
        timestamp: 3,
      },
    ];

    const context = buildSopTraceContext(events);

    expect(context.commands).toEqual(['npx vitest run tests/sop/', 'git status']);
    // authorId falls back to the most recent tool event's agentId.
    expect(context.authorId).toBe(CLAUDE as string);
    // No git/reviewer/env observable from a chat thread → undefined (predicates skip).
    expect(context.gitAhead).toBeUndefined();
    expect(context.reviewerId).toBeUndefined();
  });
});

describe('B) PATCH leaving quality_gate WITHOUT a test command (happy path)', () => {
  it('broadcasts an advisory sop_violation + logs a warn, AND still returns 200', async () => {
    const { app, logs, baseUrl } = await startApp();
    const created = await app.stores.threadStore.create({ title: 'TODO API 自检阶段' });
    await app.stores.threadStore.updateSopStage(created.id, 'quality_gate');
    // The thread ran a git command but never a test command — quality_gate's
    // command_pattern (vitest run|pnpm test|npm test) is therefore unsatisfied.
    await appendBashCommand(app, created.id, 'git diff --stat');

    const client = await connectClient(baseUrl, created.id);
    const violations = collectSopViolations(client);

    const res = await app.api.inject({
      method: 'PATCH',
      url: `/api/threads/${created.id}/sop-stage`,
      payload: { stageId: 'review' },
    });

    // Transition always succeeds — advisory eval never gates it.
    expect(res.statusCode).toBe(200);
    expect((await app.stores.threadStore.get(created.id))?.sopStageId).toBe('review');

    const received = await violations;
    client.close();

    expect(received).toHaveLength(1);
    expect(received[0]?.stageId).toBe('quality_gate'); // the stage LEFT
    expect(received[0]?.violations.some((v) => v.ruleId === 'quality-gate-full-test-evidence')).toBe(true);

    const warn = logs.find(
      (l) => l.level === 'warn' && l.message.includes('SOP advisory') && l.threadId === created.id,
    );
    expect(warn).toBeDefined();
    expect(warn?.message).toContain('quality_gate');
  });
});

describe('C) PATCH leaving quality_gate WITH a test command (happy path)', () => {
  it('passes the test command_pattern → no sop_violation broadcast, still 200', async () => {
    const { app, logs, baseUrl } = await startApp();
    const created = await app.stores.threadStore.create({ title: '自检通过' });
    await app.stores.threadStore.updateSopStage(created.id, 'quality_gate');
    await appendBashCommand(app, created.id, 'npx vitest run');

    const client = await connectClient(baseUrl, created.id);
    const violations = collectSopViolations(client);

    const res = await app.api.inject({
      method: 'PATCH',
      url: `/api/threads/${created.id}/sop-stage`,
      payload: { stageId: 'review' },
    });

    expect(res.statusCode).toBe(200);

    const received = await violations;
    client.close();

    expect(received).toHaveLength(0);
    expect(logs.some((l) => l.message.includes('SOP advisory'))).toBe(false);
  });
});

describe('D) PATCH leaving kickoff (manual_only) (happy path)', () => {
  it('skips all manual_only rules → no sop_violation broadcast', async () => {
    const { app, baseUrl } = await startApp();
    // A project thread defaults to 'kickoff'.
    const created = await app.stores.threadStore.create({
      title: '立项阶段',
      projectPath: 'D:/proj/choco-ai',
    });
    expect(created.sopStageId).toBe('kickoff');

    const client = await connectClient(baseUrl, created.id);
    const violations = collectSopViolations(client);

    const res = await app.api.inject({
      method: 'PATCH',
      url: `/api/threads/${created.id}/sop-stage`,
      payload: { stageId: 'impl' },
    });

    expect(res.statusCode).toBe(200);

    const received = await violations;
    client.close();

    expect(received).toHaveLength(0);
  });
});

describe('E) setting a stage on a thread with NO prior stage (happy path)', () => {
  it('does NOT evaluate when oldStage is null → no sop_violation broadcast', async () => {
    const { app, logs, baseUrl } = await startApp();
    // Auto-created (no projectPath) → no SOP stage. Even with a trace that WOULD
    // violate quality_gate, no eval runs because no stage is being LEFT.
    const created = await app.stores.threadStore.create({ title: '无阶段线程' });
    expect(created.sopStageId).toBeUndefined();
    await appendBashCommand(app, created.id, 'git status');

    const client = await connectClient(baseUrl, created.id);
    const violations = collectSopViolations(client);

    const res = await app.api.inject({
      method: 'PATCH',
      url: `/api/threads/${created.id}/sop-stage`,
      payload: { stageId: 'quality_gate' },
    });

    expect(res.statusCode).toBe(200);

    const received = await violations;
    client.close();

    expect(received).toHaveLength(0);
    expect(logs.some((l) => l.message.includes('SOP advisory'))).toBe(false);
  });
});

describe('F) sop_advance_stage callback routes through the same helper (happy path)', () => {
  it('broadcasts an advisory sop_violation when the agent leaves quality_gate, still 200', async () => {
    const { app, baseUrl } = await startApp();
    const threadId = 'thread-agent-quality-gate';
    await app.stores.threadStore.ensureThread(threadId, '功能开发');
    await app.stores.threadStore.updateSopStage(threadId, 'quality_gate');
    await appendBashCommand(app, threadId, 'git log --oneline -5'); // no test command

    const record = app.invocations.create({ userId: 'user', agentId: CLAUDE, threadId });

    const client = await connectClient(baseUrl, threadId);
    const violations = collectSopViolations(client);

    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/sop_advance_stage',
      headers: {
        'x-invocation-id': record.invocationId,
        'x-callback-token': record.callbackToken,
      },
      payload: { stageId: 'review' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ stageId: string }>().stageId).toBe('review');

    const received = await violations;
    client.close();

    expect(received).toHaveLength(1);
    expect(received[0]?.stageId).toBe('quality_gate');
    expect(received[0]?.violations.some((v) => v.ruleId === 'quality-gate-full-test-evidence')).toBe(true);
  });
});
