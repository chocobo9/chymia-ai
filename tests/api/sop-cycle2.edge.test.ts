// SOP-Cycle-2 QA — edge + adversarial gating suite (independently authored, ≠ the
// dev who wired `advanceStageWithEval`). Gates the advisory post-hoc SOP eval that
// fires ON STAGE-ADVANCE (not per-turn): "只提示不拦截" (notify, never block).
//
// Non-negotiable behaviours under test:
//   1. TRIGGER: eval fires ONLY when a REAL (non-null) stage is being LEFT. First
//      set (oldStage undefined) → no eval. A normal agent turn (no advance) → no eval.
//   2. PAYLOAD: the `sop_violation` carries the LEFT stage's id + the right threadId.
//   3. ADVISORY: the transition + the PATCH/callback response ALWAYS succeed and the
//      stage ALWAYS updates, even when a dependency THROWS during the eval (best-effort).
//   4. NOTIFY-ONLY: the eval never feeds anything back into the agent's prompt.
//   5. ADAPTER: command extraction from Bash-style events; malformed input never throws.
//
// Ground truth for the development.yaml stage→predicate map was established by a
// throwaway probe before writing these assertions (kickoff=all-skip; impl git_state
// PASSES with no git data + manual skips → no violation; quality_gate command_pattern
// `vitest run|pnpm test|npm test`; review handle_check SKIPS but pitfall
// command_pattern `request review|请 review` fires without that command; merge
// command_pattern). Tests assert the REAL outcomes, not a simplification.

import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type {
  AgentId,
  SopViolationPayload,
  StoredToolEvent,
  Thread,
} from '@choco/shared';
import { createAgentId } from '@choco/shared';
import { resolve } from 'node:path';
import { buildApp, type BuiltApp } from '@choco/api/app-factory';
import { advanceStageWithEval } from '@choco/api/sop/advance-stage';
import { buildSopTraceContext } from '@choco/api/sop/sop-trace-adapter';
import { SopServiceImpl } from '@choco/api/sop/sop-service';
import type { AppServices } from '@choco/api/infrastructure/app-services';
import type { SopEvalResult, SopTraceInput } from '@choco/api/sop/trace-evaluator';
import { connectClient, startTestApp, replyScript, type TestApp } from './helpers.js';
import type { Socket as ClientSocket } from 'socket.io-client';

const CLAUDE: AgentId = createAgentId('claude-opus');
const REVIEW_REQUEST_COMMAND = 'request review on PR #42';

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

/** Build a listening app over an in-memory db with a capturing logger. */
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
async function appendBashCommand(app: BuiltApp, threadId: string, command: string): Promise<void> {
  await app.stores.toolEventLog.append({
    invocationId: 'inv-cycle2-edge',
    threadId,
    agentId: CLAUDE,
    toolName: 'Bash',
    toolInput: JSON.stringify({ command }),
    timestamp: Date.now(),
  });
}

/** Collect every `sop_violation` a joined client receives within `timeoutMs`. */
function collectSopViolations(socket: ClientSocket, timeoutMs = 600): Promise<SopViolationPayload[]> {
  return new Promise((resolve) => {
    const received: SopViolationPayload[] = [];
    socket.on('sop_violation', (payload: SopViolationPayload) => {
      received.push(payload);
    });
    setTimeout(() => resolve(received), timeoutMs);
  });
}

// ───────────────────────────── Stub AppServices for the helper unit tests ────
//
// `advanceStageWithEval` destructures only { threadStore, toolEventLog, sopService,
// socket, logger }. A test double exposing exactly those (other AppServices fields
// are never touched at runtime) is the standard pattern — cast through `unknown` so
// no `any` is introduced (CLAUDE.md §2.1). Each builder lets ONE dependency throw to
// prove the helper is best-effort: the transition still happens + it never rejects.

interface StubBundle {
  readonly services: AppServices;
  readonly updateCalls: Array<{ threadId: string; stageId: string | null }>;
  readonly broadcasts: SopViolationPayload[];
  readonly logs: LogEvent[];
}

interface StubOverrides {
  readonly existingStage?: string | undefined;
  readonly readByThreadThrows?: boolean;
  readonly evaluateTraceThrows?: boolean;
  readonly broadcastThrows?: boolean;
  readonly events?: readonly StoredToolEvent[];
  readonly evalResult?: SopEvalResult;
}

function buildStub(overrides: StubOverrides = {}): StubBundle {
  const updateCalls: Array<{ threadId: string; stageId: string | null }> = [];
  const broadcasts: SopViolationPayload[] = [];
  const logs: LogEvent[] = [];

  const existing: Thread | null =
    overrides.existingStage === undefined
      ? null
      : {
          id: 'th-stub',
          createdAt: 1,
          lastActiveAt: 1,
          participants: [],
          sopStageId: overrides.existingStage,
          thinkingMode: 'debug',
        };

  const defaultResult: SopEvalResult = overrides.evalResult ?? {
    violations: [{ ruleId: 'quality-gate-full-test-evidence', text: '声称完成但没跑全量测试', severity: 'blocker' }],
    passed: [],
    skipped: [],
  };

  const services = {
    threadStore: {
      get: async (_id: string): Promise<Thread | null> => existing,
      updateSopStage: async (threadId: string, stageId: string | null): Promise<void> => {
        updateCalls.push({ threadId, stageId });
      },
    },
    toolEventLog: {
      readByThread: async (_threadId: string): Promise<StoredToolEvent[]> => {
        if (overrides.readByThreadThrows) throw new Error('toolEventLog.readByThread boom');
        return [...(overrides.events ?? [])];
      },
    },
    sopService: {
      evaluateTrace: (_stageId: string, _trace: SopTraceInput): SopEvalResult => {
        if (overrides.evaluateTraceThrows) throw new Error('sopService.evaluateTrace boom');
        return defaultResult;
      },
    },
    socket: {
      broadcastSopViolation: async (_threadId: string, payload: SopViolationPayload): Promise<void> => {
        if (overrides.broadcastThrows) throw new Error('socket.broadcastSopViolation boom');
        broadcasts.push(payload);
      },
    },
    logger: (event: LogEvent): void => {
      logs.push(event);
    },
  } as unknown as AppServices;

  return { services, updateCalls, broadcasts, logs };
}

// ════════════════════════════════════════════════════════════════════════════
// EDGE — TRIGGER CORRECTNESS
// ════════════════════════════════════════════════════════════════════════════

describe('edge: trigger fires ONLY when a real stage is LEFT', () => {
  it('first-set (no prior stage) does NOT evaluate — no broadcast, no warn, stage updates', async () => {
    const stub = buildStub({ existingStage: undefined });

    await advanceStageWithEval(stub.services, 'th-first-set', 'quality_gate');

    // Transition still happens.
    expect(stub.updateCalls).toEqual([{ threadId: 'th-first-set', stageId: 'quality_gate' }]);
    // But NO eval ran (oldStage undefined → early return before any eval work).
    expect(stub.broadcasts).toHaveLength(0);
    expect(stub.logs).toHaveLength(0);
  });

  it('clearing a real stage (newStage=null) STILL evaluates the stage being left', async () => {
    const stub = buildStub({ existingStage: 'quality_gate' });

    await advanceStageWithEval(stub.services, 'th-clear', null);

    expect(stub.updateCalls).toEqual([{ threadId: 'th-clear', stageId: null }]);
    // A real stage was left → eval runs and the (default) violation broadcasts.
    expect(stub.broadcasts).toHaveLength(1);
    expect(stub.broadcasts[0]?.stageId).toBe('quality_gate');
  });

  it('live PATCH: setting a stage on a NEW thread with a violating trace → NO sop_violation', async () => {
    const { app, logs, baseUrl } = await startApp();
    // No projectPath → auto-created thread has NO sop stage. Even a trace that WOULD
    // violate quality_gate must not eval, because no real stage is being left.
    const created = await app.stores.threadStore.create({ title: '首次设置阶段的线程' });
    expect(created.sopStageId).toBeUndefined();
    await appendBashCommand(app, created.id, 'git diff --stat');

    const client = await connectClient(baseUrl, created.id);
    const violations = collectSopViolations(client);

    const res = await app.api.inject({
      method: 'PATCH',
      url: `/api/threads/${created.id}/sop-stage`,
      payload: { stageId: 'quality_gate' },
    });

    expect(res.statusCode).toBe(200);
    expect((await app.stores.threadStore.get(created.id))?.sopStageId).toBe('quality_gate');

    const received = await violations;
    client.close();
    expect(received).toHaveLength(0);
    expect(logs.some((l) => l.message.includes('SOP advisory'))).toBe(false);
  });
});

describe('edge: NOT per-turn — a normal agent turn emits no sop_violation', () => {
  it('routing a message through a thread parked in quality_gate (no test cmd) does NOT broadcast', async () => {
    const testApp: TestApp = await startTestApp({
      'claude-opus': [replyScript(CLAUDE, '收到，开始分析这个 TODO API 的边界条件。')],
    });
    cleanups.push(testApp.close);
    const { app, baseUrl } = testApp;

    const created = await app.stores.threadStore.create({ title: '自检中线程' });
    // Park the thread in quality_gate WITHOUT a test command — if the eval ran
    // per-turn (it must NOT), this turn would surface a command_pattern violation.
    await app.stores.threadStore.updateSopStage(created.id, 'quality_gate');
    await appendBashCommand(app, created.id, 'git status');

    const client = await connectClient(baseUrl, created.id);
    const violations = collectSopViolations(client, 900);

    const res = await app.api.inject({
      method: 'POST',
      url: `/api/threads/${created.id}/messages`,
      payload: { content: '@claude 分析一下当前进度', userId: 'user-makima' },
    });
    expect(res.statusCode).toBe(200);

    const received = await violations;
    client.close();

    // The turn ran (no advance), so NO advisory eval and NO violation broadcast.
    expect(received).toHaveLength(0);
    // Stage unchanged by a normal turn.
    expect((await app.stores.threadStore.get(created.id))?.sopStageId).toBe('quality_gate');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// EDGE — PER-STAGE EVAL OUTCOMES (advisory, low-noise)
// ════════════════════════════════════════════════════════════════════════════

describe('edge: quality_gate command_pattern outcome on leave', () => {
  it('leaving quality_gate with NO test command → broadcasts violation AND callback still 200 + stage updates', async () => {
    const { app, logs, baseUrl } = await startApp();
    const threadId = 'thread-qg-no-test';
    await app.stores.threadStore.ensureThread(threadId, '自检阶段');
    await app.stores.threadStore.updateSopStage(threadId, 'quality_gate');
    await appendBashCommand(app, threadId, 'git log --oneline -3'); // not a test command

    const record = app.invocations.create({ userId: 'user', agentId: CLAUDE, threadId });
    const client = await connectClient(baseUrl, threadId);
    const violations = collectSopViolations(client);

    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/sop_advance_stage',
      headers: { 'x-invocation-id': record.invocationId, 'x-callback-token': record.callbackToken },
      payload: { stageId: 'review' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ stageId: string }>().stageId).toBe('review');
    expect((await app.stores.threadStore.get(threadId))?.sopStageId).toBe('review');

    const received = await violations;
    client.close();

    expect(received).toHaveLength(1);
    expect(received[0]?.stageId).toBe('quality_gate'); // the LEFT stage, not 'review'
    expect(received[0]?.violations.some((v) => v.ruleId === 'quality-gate-full-test-evidence')).toBe(true);
    expect(logs.some((l) => l.level === 'warn' && l.message.includes('quality_gate'))).toBe(true);
  });

  it('leaving quality_gate WHEN a prior event ran `npx vitest run` → NO violation', async () => {
    const { app, logs, baseUrl } = await startApp();
    const created = await app.stores.threadStore.create({ title: '自检通过' });
    await app.stores.threadStore.updateSopStage(created.id, 'quality_gate');
    await appendBashCommand(app, created.id, 'npx vitest run tests/api');

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

describe('edge: stages whose only observable predicates skip/pass → no false violation', () => {
  it('leaving kickoff (manual_only) → all skipped → no broadcast', async () => {
    const { app, baseUrl } = await startApp();
    const created = await app.stores.threadStore.create({
      title: '立项',
      projectPath: 'D:/proj/choco-ai',
    });
    expect(created.sopStageId).toBe('kickoff');
    await appendBashCommand(app, created.id, 'git status'); // irrelevant to manual_only rules

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

  it('leaving impl (git_state with no git data → pass; rest manual_only skip) → no broadcast', async () => {
    const { app, logs, baseUrl } = await startApp();
    const created = await app.stores.threadStore.create({ title: '实现阶段' });
    await app.stores.threadStore.updateSopStage(created.id, 'impl');
    // git ahead/behind not observable from a chat thread → default 0 → git_state PASSES.

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

  it('leaving review: handle_check (no reviewer) SKIPS — no false self-review violation; the pitfall only fires absent a request-review command', async () => {
    const { app, baseUrl } = await startApp();
    const created = await app.stores.threadStore.create({ title: 'Review 阶段' });
    await app.stores.threadStore.updateSopStage(created.id, 'review');
    // Provide the request-review command so the command_pattern pitfall is satisfied;
    // the handle_check hard rule then skips (no reviewer) → ZERO violations.
    await appendBashCommand(app, created.id, REVIEW_REQUEST_COMMAND);

    const client = await connectClient(baseUrl, created.id);
    const violations = collectSopViolations(client);

    const res = await app.api.inject({
      method: 'PATCH',
      url: `/api/threads/${created.id}/sop-stage`,
      payload: { stageId: 'merge' },
    });
    expect(res.statusCode).toBe(200);

    const received = await violations;
    client.close();
    // No false violation from the self-review (handle_check) rule.
    expect(received.flatMap((p) => p.violations).some((v) => v.ruleId === 'review-no-self-review')).toBe(false);
    // With the request-review command present, the whole stage is clean.
    expect(received).toHaveLength(0);
  });
});

describe('edge: payload shape carries the LEFT stage id + correct threadId', () => {
  it('the broadcast stageId is the OUTGOING stage and threadId matches the thread', async () => {
    const { app, baseUrl } = await startApp();
    const created = await app.stores.threadStore.create({ title: '阶段载荷校验' });
    await app.stores.threadStore.updateSopStage(created.id, 'quality_gate');
    await appendBashCommand(app, created.id, 'git diff'); // no test command → violation

    const client = await connectClient(baseUrl, created.id);
    const violations = collectSopViolations(client);

    await app.api.inject({
      method: 'PATCH',
      url: `/api/threads/${created.id}/sop-stage`,
      payload: { stageId: 'merge' }, // new stage is 'merge'…
    });

    const received = await violations;
    client.close();

    expect(received).toHaveLength(1);
    expect(received[0]?.stageId).toBe('quality_gate'); // …but the payload names the LEFT stage
    expect(received[0]?.stageId).not.toBe('merge');
    expect(received[0]?.threadId).toBe(created.id);
    expect(Array.isArray(received[0]?.violations)).toBe(true);
    expect(received[0]?.violations.length).toBeGreaterThan(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ADVERSARIAL — BEST-EFFORT / NEVER-BLOCKING (the headline gate)
// ════════════════════════════════════════════════════════════════════════════

describe('adversarial: a throwing dependency during eval NEVER fails the transition', () => {
  it('toolEventLog.readByThread throws → transition done, helper resolves, warn logged', async () => {
    const stub = buildStub({ existingStage: 'quality_gate', readByThreadThrows: true });

    await expect(advanceStageWithEval(stub.services, 'th-a', 'review')).resolves.toBeUndefined();

    // The transition ALWAYS happened first.
    expect(stub.updateCalls).toEqual([{ threadId: 'th-a', stageId: 'review' }]);
    // No violation could be computed → none broadcast.
    expect(stub.broadcasts).toHaveLength(0);
    // Failure logged (never silently swallowed) referencing the left stage.
    const warn = stub.logs.find((l) => l.level === 'warn' && l.message.includes('quality_gate'));
    expect(warn).toBeDefined();
    expect(warn?.message).toContain('failed');
  });

  it('sopService.evaluateTrace throws → transition done, helper resolves, warn logged', async () => {
    const stub = buildStub({ existingStage: 'quality_gate', evaluateTraceThrows: true });

    await expect(advanceStageWithEval(stub.services, 'th-b', 'review')).resolves.toBeUndefined();

    expect(stub.updateCalls).toEqual([{ threadId: 'th-b', stageId: 'review' }]);
    expect(stub.broadcasts).toHaveLength(0);
    expect(stub.logs.some((l) => l.level === 'warn' && l.message.includes('failed'))).toBe(true);
  });

  it('socket.broadcastSopViolation throws → transition done, helper resolves, warn logged', async () => {
    const stub = buildStub({ existingStage: 'quality_gate', broadcastThrows: true });

    await expect(advanceStageWithEval(stub.services, 'th-c', 'review')).resolves.toBeUndefined();

    // Transition succeeded BEFORE the broadcast was even attempted.
    expect(stub.updateCalls).toEqual([{ threadId: 'th-c', stageId: 'review' }]);
    // The broadcast threw, so nothing landed in the captured list…
    expect(stub.broadcasts).toHaveLength(0);
    // …but the failure was caught + logged (advisory warn for the violation AND the
    // catch-all "failed" warn both pass through the same logger).
    expect(stub.logs.some((l) => l.level === 'warn' && l.message.includes('failed'))).toBe(true);
  });

  it('live PATCH with a throwing toolEventLog still returns 200 + updates the stage', async () => {
    const { app, baseUrl } = await startApp();
    const created = await app.stores.threadStore.create({ title: '注入抛错的真实路径' });
    await app.stores.threadStore.updateSopStage(created.id, 'quality_gate');

    // Monkeypatch the live store seam to throw inside the eval. Restored in finally.
    const original = app.stores.toolEventLog.readByThread.bind(app.stores.toolEventLog);
    const log = app.stores.toolEventLog as unknown as {
      readByThread: (threadId: string) => Promise<StoredToolEvent[]>;
    };
    log.readByThread = async (): Promise<StoredToolEvent[]> => {
      throw new Error('injected readByThread failure');
    };

    const client = await connectClient(baseUrl, created.id);
    const violations = collectSopViolations(client);
    try {
      const res = await app.api.inject({
        method: 'PATCH',
        url: `/api/threads/${created.id}/sop-stage`,
        payload: { stageId: 'review' },
      });
      // The advisory eval blew up internally; the request is unaffected.
      expect(res.statusCode).toBe(200);
      expect((await app.stores.threadStore.get(created.id))?.sopStageId).toBe('review');
    } finally {
      log.readByThread = original;
    }

    const received = await violations;
    client.close();
    expect(received).toHaveLength(0); // eval failed → nothing broadcast, request still fine
  });
});

describe('adversarial: notify-only — eval result is not fed back into the agent prompt', () => {
  it('a callback advance with a violating thread does NOT write any agent-facing message', async () => {
    const { app, baseUrl } = await startApp();
    const threadId = 'thread-notify-only';
    await app.stores.threadStore.ensureThread(threadId, '通知不入提示词');
    await app.stores.threadStore.updateSopStage(threadId, 'quality_gate');
    await appendBashCommand(app, threadId, 'git diff'); // → violation

    const record = app.invocations.create({ userId: 'user', agentId: CLAUDE, threadId });
    const before = await app.stores.messageStore.getByThread(threadId);

    const client = await connectClient(baseUrl, threadId);
    const violations = collectSopViolations(client);
    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/sop_advance_stage',
      headers: { 'x-invocation-id': record.invocationId, 'x-callback-token': record.callbackToken },
      payload: { stageId: 'review' },
    });
    expect(res.statusCode).toBe(200);

    const received = await violations;
    client.close();

    // A violation WAS surfaced via the socket (advisory)…
    expect(received).toHaveLength(1);
    // …but NO message was injected into the thread transcript (not fed to the prompt).
    const after = await app.stores.messageStore.getByThread(threadId);
    expect(after.length).toBe(before.length);
    expect(after.some((m) => m.content.includes('SOP') || m.content.includes('violation'))).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// EDGE — TRACE ADAPTER
// ════════════════════════════════════════════════════════════════════════════

describe('edge: buildSopTraceContext command extraction + defensive parsing', () => {
  it('extracts commands from every command-runner tool name (Bash/Shell/Exec/Run), ignores non-runners', () => {
    const mk = (toolName: string, toolInput: string | undefined, ts: number): StoredToolEvent => ({
      id: `e${ts}`,
      invocationId: 'inv',
      threadId: 'th',
      agentId: CLAUDE,
      toolName,
      ...(toolInput !== undefined ? { toolInput } : {}),
      timestamp: ts,
    });

    const events: StoredToolEvent[] = [
      mk('Bash', JSON.stringify({ command: 'npx vitest run' }), 1),
      mk('Read', JSON.stringify({ file_path: 'src/x.ts' }), 2), // not a runner → ignored
      mk('Shell', JSON.stringify({ command: 'pnpm test' }), 3),
      mk('Exec', JSON.stringify({ command: 'gh pr view 7' }), 4),
      mk('Run', JSON.stringify({ command: 'git status' }), 5),
    ];

    const ctx = buildSopTraceContext(events, CLAUDE);
    expect(ctx.commands).toEqual(['npx vitest run', 'pnpm test', 'gh pr view 7', 'git status']);
    expect(ctx.authorId).toBe(CLAUDE as string);
    expect(ctx.gitAhead).toBeUndefined();
    expect(ctx.reviewerId).toBeUndefined();
    expect(ctx.env).toBeUndefined();
  });

  it('malformed / missing / non-string command inputs never throw and are skipped', () => {
    const mk = (toolName: string, toolInput: string | undefined): StoredToolEvent => ({
      id: `m${Math.random()}`,
      invocationId: 'inv',
      threadId: 'th',
      agentId: CLAUDE,
      toolName,
      ...(toolInput !== undefined ? { toolInput } : {}),
      timestamp: 1,
    });

    const adversarial: StoredToolEvent[] = [
      mk('Bash', '{not valid json'), // unparseable → skip
      mk('Bash', undefined), // absent input → skip
      mk('Bash', JSON.stringify({ notCommand: 'x' })), // wrong key → skip
      mk('Bash', JSON.stringify({ command: 42 })), // non-string command → skip
      mk('Bash', JSON.stringify({ command: '' })), // empty string → skip
      mk('Bash', JSON.stringify(['array', 'not', 'object'])), // array, not object → skip
      mk('Bash', JSON.stringify(null)), // literal null → skip
      mk('Bash', JSON.stringify({ command: 'gh pr merge 7 --squash' })), // the ONE real command
    ];

    let ctx: ReturnType<typeof buildSopTraceContext> | undefined;
    expect(() => {
      ctx = buildSopTraceContext(adversarial, CLAUDE);
    }).not.toThrow();
    expect(ctx?.commands).toEqual(['gh pr merge 7 --squash']);
  });

  it('authorId falls back to the most recent tool event agentId when advancedBy is absent', () => {
    const other = createAgentId('codex-gpt');
    const events: StoredToolEvent[] = [
      {
        id: 'a',
        invocationId: 'inv',
        threadId: 'th',
        agentId: CLAUDE,
        toolName: 'Bash',
        toolInput: JSON.stringify({ command: 'git status' }),
        timestamp: 1,
      },
      {
        id: 'b',
        invocationId: 'inv',
        threadId: 'th',
        agentId: other,
        toolName: 'Bash',
        toolInput: JSON.stringify({ command: 'gh pr view' }),
        timestamp: 2,
      },
    ];
    // No advancedBy → authorId is the LAST event's agentId.
    expect(buildSopTraceContext(events).authorId).toBe(other as string);
    // advancedBy supplied → it wins over the last event's agentId.
    expect(buildSopTraceContext(events, CLAUDE).authorId).toBe(CLAUDE as string);
    // Empty trace → no authorId at all (field omitted).
    expect(buildSopTraceContext([]).authorId).toBeUndefined();
    expect(buildSopTraceContext([]).commands).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// EDGE — CROSS-THREAD (re-confirm Cycle-1 invariant) + TYPE-MOVE REGRESSION
// ════════════════════════════════════════════════════════════════════════════

describe('edge: callback advance is scoped to the VERIFIED record thread only', () => {
  it('a violation reflects the callback record thread, not any body-supplied thread', async () => {
    const { app, baseUrl } = await startApp();
    const ownThread = 'thread-own-callback';
    const otherThread = 'thread-bystander';
    await app.stores.threadStore.ensureThread(ownThread, '本线程');
    await app.stores.threadStore.ensureThread(otherThread, '旁观线程');
    await app.stores.threadStore.updateSopStage(ownThread, 'quality_gate');
    await app.stores.threadStore.updateSopStage(otherThread, 'quality_gate');
    await appendBashCommand(app, ownThread, 'git diff'); // own thread violates

    const record = app.invocations.create({ userId: 'user', agentId: CLAUDE, threadId: ownThread });

    // A bystander client joined to the OTHER thread must receive nothing.
    const bystander = await connectClient(baseUrl, otherThread);
    const bystanderViolations = collectSopViolations(bystander);
    const owner = await connectClient(baseUrl, ownThread);
    const ownerViolations = collectSopViolations(owner);

    const res = await app.api.inject({
      method: 'POST',
      url: '/api/callback/sop_advance_stage',
      headers: { 'x-invocation-id': record.invocationId, 'x-callback-token': record.callbackToken },
      payload: { stageId: 'review' },
    });
    expect(res.statusCode).toBe(200);

    const [ownerGot, bystanderGot] = await Promise.all([ownerViolations, bystanderViolations]);
    owner.close();
    bystander.close();

    expect(ownerGot).toHaveLength(1);
    expect(ownerGot[0]?.threadId).toBe(ownThread);
    expect(ownerGot[0]?.stageId).toBe('quality_gate');
    // The other thread's room received nothing (room isolation holds).
    expect(bystanderGot).toHaveLength(0);
    // The bystander thread's own stage was NOT advanced by this callback.
    expect((await app.stores.threadStore.get(otherThread))?.sopStageId).toBe('quality_gate');
  });
});

describe('edge: SopViolation type-move to @choco/shared did not regress evaluateTrace consumers', () => {
  it('evaluateTrace still produces shared-shaped violations with ruleId/text/severity', () => {
    // Built through the real SopService over the live development.yaml so the shared
    // SopViolation shape is what consumers actually receive.
    const sopService = new SopServiceImpl(resolve(process.cwd(), 'sop/development.yaml'));
    const result = sopService.evaluateTrace('quality_gate', {
      agentId: CLAUDE,
      threadId: 'th-typemove',
      responseContent: '',
      context: { commands: ['git diff'], authorId: CLAUDE as string }, // no test command → violation
    });
    expect(result.violations.length).toBeGreaterThan(0);
    const v = result.violations[0];
    expect(typeof v?.ruleId).toBe('string');
    expect(typeof v?.text).toBe('string');
    expect(['blocker', 'warn']).toContain(v?.severity);
    // A SopViolation is assignable to the shared SopViolationPayload.violations slot.
    const payload: SopViolationPayload = {
      threadId: 'th-typemove',
      stageId: 'quality_gate',
      violations: result.violations,
    };
    expect(payload.violations).toBe(result.violations);
  });
});
