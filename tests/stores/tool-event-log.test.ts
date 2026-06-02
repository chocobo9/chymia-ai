import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createAgentId } from '@choco/shared';
import { SqliteToolEventLog } from '@choco/api/stores/sqlite-tool-event-log';

/**
 * M5-amend dev happy-path suite (unit) for the A6 ToolEventLog. QA owns edge +
 * adversarial coverage. Fresh in-memory database per test for isolation. Inputs
 * are real agent ids and real tool names (read_file / evidence_search) — no
 * placeholders.
 */

const CLAUDE = createAgentId('claude-opus');
const CODEX = createAgentId('codex-gpt');

describe('SqliteToolEventLog (unit, happy path)', () => {
  let db: Database.Database;
  let log: SqliteToolEventLog;

  beforeEach(() => {
    db = new Database(':memory:');
    log = new SqliteToolEventLog(db);
  });

  it('append then readByThread returns the event with all fields', async () => {
    const appended = await log.append({
      invocationId: 'inv-arch-001',
      threadId: 'thread-arch-review',
      agentId: CLAUDE,
      toolName: 'read_file',
      toolInput: JSON.stringify({ path: 'packages/api/src/routing/agent-router.ts' }),
      toolResult: '// M4: AgentRouter — the orchestration entry point …',
      durationMs: 42,
      timestamp: 1_700_000_200_000,
    });

    const rows = await log.readByThread('thread-arch-review');

    expect(appended.id).toMatch(/^tool_/);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: appended.id,
      invocationId: 'inv-arch-001',
      threadId: 'thread-arch-review',
      agentId: CLAUDE,
      toolName: 'read_file',
      toolInput: JSON.stringify({ path: 'packages/api/src/routing/agent-router.ts' }),
      toolResult: '// M4: AgentRouter — the orchestration entry point …',
      durationMs: 42,
      timestamp: 1_700_000_200_000,
    });
  });

  it('readByThread returns events in ascending timeline order', async () => {
    await log.append({
      invocationId: 'inv-1',
      threadId: 'thread-build',
      agentId: CLAUDE,
      toolName: 'read_file',
      timestamp: 1_700_000_300_300,
    });
    await log.append({
      invocationId: 'inv-1',
      threadId: 'thread-build',
      agentId: CLAUDE,
      toolName: 'evidence_search',
      timestamp: 1_700_000_300_100,
    });
    await log.append({
      invocationId: 'inv-1',
      threadId: 'thread-build',
      agentId: CLAUDE,
      toolName: 'write_file',
      timestamp: 1_700_000_300_200,
    });

    const rows = await log.readByThread('thread-build');

    expect(rows.map((e) => e.toolName)).toEqual([
      'evidence_search',
      'write_file',
      'read_file',
    ]);
  });

  it('readByInvocation filters to one invocation across threads/agents', async () => {
    await log.append({
      invocationId: 'inv-target',
      threadId: 'thread-x',
      agentId: CLAUDE,
      toolName: 'read_file',
      timestamp: 1_700_000_400_000,
    });
    await log.append({
      invocationId: 'inv-target',
      threadId: 'thread-x',
      agentId: CLAUDE,
      toolName: 'evidence_search',
      timestamp: 1_700_000_400_010,
    });
    // Different invocation, same thread — must be excluded.
    await log.append({
      invocationId: 'inv-other',
      threadId: 'thread-x',
      agentId: CODEX,
      toolName: 'run_tests',
      timestamp: 1_700_000_400_020,
    });

    const targetRows = await log.readByInvocation('inv-target');

    expect(targetRows).toHaveLength(2);
    expect(targetRows.map((e) => e.toolName)).toEqual(['read_file', 'evidence_search']);
    expect(targetRows.every((e) => e.invocationId === 'inv-target')).toBe(true);
  });

  it('records durationMs and omits optional fields when not supplied', async () => {
    await log.append({
      invocationId: 'inv-dur',
      threadId: 'thread-dur',
      agentId: CODEX,
      toolName: 'run_tests',
      durationMs: 1875,
      timestamp: 1_700_000_500_000,
    });

    const [row] = await log.readByInvocation('inv-dur');

    expect(row?.durationMs).toBe(1875);
    expect(row?.toolInput).toBeUndefined();
    expect(row?.toolResult).toBeUndefined();
  });
});
