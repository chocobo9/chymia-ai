// Operability dev happy-path: the runtime invariant probes.
//
// Each probe gets a capturing RouteLogger; a VIOLATING case must fire exactly one
// warn, and a CLEAN case must fire none. Real inputs (real resolved paths, real
// agent reply text, real tool names). QA owns edge/adversarial (path traversal
// variants, unicode reply doubling, threshold boundaries, etc.).

import { describe, it, expect } from 'vitest';
import { resolve } from 'node:path';
import { createAgentId } from '@choco/shared';
import type { RouteLogger } from '@choco/api/routing/agent-router';
import {
  checkWorkspaceMatch,
  checkReplyNotDuplicated,
  checkToolWritePathInside,
  checkInvocationProductive,
} from '@choco/api/infrastructure/invariants';

interface CapturedWarn {
  readonly level: 'info' | 'warn';
  readonly message: string;
  readonly threadId: string;
  readonly agentId?: string;
}

/** A capturing RouteLogger that records every event it receives. */
function capturing(): { logger: RouteLogger; events: CapturedWarn[] } {
  const events: CapturedWarn[] = [];
  const logger: RouteLogger = (event) => {
    events.push({
      level: event.level,
      message: event.message,
      threadId: event.threadId,
      ...(event.agentId !== undefined ? { agentId: event.agentId as string } : {}),
    });
  };
  return { logger, events };
}

const CTX = { threadId: 'thread-arch-review', agentId: createAgentId('claude-opus') };
const WORKSPACE = resolve('/srv/projects/clowder');
const isWindows = process.platform === 'win32';

describe('checkWorkspaceMatch (happy path)', () => {
  it('fires a warn when the resolved workingDirectory differs from the expected workspace', () => {
    const { logger, events } = capturing();
    const fired = checkWorkspaceMatch(logger, CTX, resolve('/tmp/wrong-dir'), WORKSPACE);
    expect(fired).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]?.level).toBe('warn');
    expect(events[0]?.message).toContain('workingDirectory');
    expect(events[0]?.agentId).toBe('claude-opus');
  });

  it('does NOT fire when the workingDirectory matches the expected workspace', () => {
    const { logger, events } = capturing();
    const fired = checkWorkspaceMatch(logger, CTX, WORKSPACE, WORKSPACE);
    expect(fired).toBe(false);
    expect(events).toHaveLength(0);
  });

  it('does NOT fire when no workspace is expected (pre-wire no-cwd behavior)', () => {
    const { logger, events } = capturing();
    const fired = checkWorkspaceMatch(logger, CTX, undefined, undefined);
    expect(fired).toBe(false);
    expect(events).toHaveLength(0);
  });

  // Bug #1 regression: the workspace-wire bug shape — a workspace IS configured
  // (expected non-empty) but the cwd actually forwarded to the provider was
  // dropped to undefined (projectPath never reached InvokeOptions ⇒ silent
  // server-cwd fallback). With genuinely-different actual vs expected sources the
  // probe MUST fire; the prior value-vs-itself wiring could never reach this.
  it('FIRES when a workspace is configured but the forwarded workingDirectory is undefined (broken wire)', () => {
    const { logger, events } = capturing();
    const fired = checkWorkspaceMatch(logger, CTX, undefined, WORKSPACE);
    expect(fired).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]?.level).toBe('warn');
    expect(events[0]?.message).toContain('unset');
  });

  // Bug #2 regression: on win32 the FS is case-insensitive, so a cwd that differs
  // from the configured workspace ONLY by drive/segment case ran in the CORRECT
  // directory — the probe must stay silent (correct wiring), not false-warn.
  it.runIf(isWindows)(
    'stays silent on correct wiring when the path differs only by case (win32)',
    () => {
      const { logger, events } = capturing();
      const expected = resolve('C:/Users/agent/projects/clowder');
      const actual = resolve('c:/users/agent/projects/clowder'); // same real dir on win32
      const fired = checkWorkspaceMatch(logger, CTX, actual, expected);
      expect(fired).toBe(false);
      expect(events).toHaveLength(0);
    },
  );
});

describe('checkReplyNotDuplicated (happy path)', () => {
  it('fires a warn when an agent reply is a verbatim self-duplication', () => {
    const { logger, events } = capturing();
    const sentence = '建议数据库选型采用 SQLite 配合 sqlite-vec 做向量检索。';
    const fired = checkReplyNotDuplicated(logger, CTX, sentence + sentence);
    expect(fired).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]?.message).toContain('self-duplicated');
  });

  it('does NOT fire on a normal (non-doubled) agent reply', () => {
    const { logger, events } = capturing();
    const fired = checkReplyNotDuplicated(
      logger,
      CTX,
      '建议用 Fastify + Socket.io 搭建 API 层，理由是生态成熟且 TS 支持好。',
    );
    expect(fired).toBe(false);
    expect(events).toHaveLength(0);
  });
});

describe('checkToolWritePathInside (happy path)', () => {
  it('fires a warn when a tool write path escapes the workspace', () => {
    const { logger, events } = capturing();
    const fired = checkToolWritePathInside(
      logger,
      CTX,
      resolve('/etc/passwd'),
      WORKSPACE,
      'Write',
    );
    expect(fired).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]?.message).toContain('OUTSIDE workspace');
  });

  it('does NOT fire when the write path resolves inside the workspace', () => {
    const { logger, events } = capturing();
    const fired = checkToolWritePathInside(
      logger,
      CTX,
      'packages/api/src/app-factory.ts',
      WORKSPACE,
      'Edit',
    );
    expect(fired).toBe(false);
    expect(events).toHaveLength(0);
  });
});

describe('checkInvocationProductive (happy path)', () => {
  it('fires a warn when an invocation produces zero output', () => {
    const { logger, events } = capturing();
    const fired = checkInvocationProductive(logger, CTX, {
      textLength: 0,
      toolCallCount: 0,
      errorCount: 0,
    });
    expect(fired).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]?.message).toContain('0 output');
  });

  it('fires a warn on an error spike', () => {
    const { logger, events } = capturing();
    const fired = checkInvocationProductive(logger, CTX, {
      textLength: 40,
      toolCallCount: 1,
      errorCount: 3,
    });
    expect(fired).toBe(true);
    expect(events[0]?.message).toContain('error spike');
  });

  it('does NOT fire on a normal productive invocation', () => {
    const { logger, events } = capturing();
    const fired = checkInvocationProductive(logger, CTX, {
      textLength: 320,
      toolCallCount: 2,
      errorCount: 0,
    });
    expect(fired).toBe(false);
    expect(events).toHaveLength(0);
  });
});
