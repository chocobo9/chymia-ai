// M5-amend QA — SqliteToolEventLog edge + adversarial coverage (independently authored).
//
// Authored by the M5-amend QA subagent (CLAUDE.md §0.5.3). Machine gate for the
// NEW A6 surface: id uniqueness under rapid append, readByThread timeline order
// (incl. same-timestamp ties), readByInvocation isolation across threads/agents,
// unknown thread/invocation → [], durationMs-undefined round-trip, toolInput JSON
// round-trip (nested + unicode), and large toolResult payloads.
//
// Fresh `new Database(':memory:')` per test (hermetic). Real tool names only
// (read_file / evidence_search / post_message / run_tests) — no placeholders.

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { createAgentId, type AgentId } from '@clowder/shared';
import { SqliteToolEventLog } from '@clowder/api/stores/sqlite-tool-event-log';

const CLAUDE: AgentId = createAgentId('claude-opus');
const CODEX: AgentId = createAgentId('codex-gpt');
const GEMINI: AgentId = createAgentId('gemini-pro');

describe('SqliteToolEventLog append id uniqueness (adversarial)', () => {
  let db: Database.Database;
  let log: SqliteToolEventLog;

  beforeEach(() => {
    db = new Database(':memory:');
    log = new SqliteToolEventLog(db);
  });

  it('mints unique ids across 200 rapid appends in the same thread (no PK collision)', async () => {
    const ids = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const ev = await log.append({
        invocationId: 'inv-burst',
        threadId: 'thread-burst',
        agentId: CLAUDE,
        toolName: 'evidence_search',
        toolInput: JSON.stringify({ query: `检索片段 ${i}` }),
        timestamp: 1_700_000_000_000 + i,
      });
      ids.add(ev.id);
    }

    expect(ids.size).toBe(200);
    expect(await log.readByThread('thread-burst')).toHaveLength(200);
  });

  it('persists rows correctly under concurrent (Promise.all) appends — no lock error', async () => {
    await Promise.all(
      Array.from({ length: 64 }, (_unused, i) =>
        log.append({
          invocationId: `inv-${i % 4}`,
          threadId: 'thread-concurrent',
          agentId: i % 2 === 0 ? CLAUDE : CODEX,
          toolName: 'read_file',
          timestamp: 1_700_000_700_000 + i,
        }),
      ),
    );

    expect(await log.readByThread('thread-concurrent')).toHaveLength(64);
  });
});

describe('SqliteToolEventLog read ordering + isolation (edge)', () => {
  let db: Database.Database;
  let log: SqliteToolEventLog;

  beforeEach(() => {
    db = new Database(':memory:');
    log = new SqliteToolEventLog(db);
  });

  it('readByThread returns same-timestamp events in a stable (id ASC) order', async () => {
    // Three events sharing one timestamp: ORDER BY timestamp ASC, id ASC must give
    // a deterministic sequence across repeated reads (no arbitrary row order).
    const sharedTs = 1_700_000_800_000;
    const e1 = await log.append({
      invocationId: 'inv-tie',
      threadId: 'thread-tie',
      agentId: CLAUDE,
      toolName: 'read_file',
      timestamp: sharedTs,
    });
    const e2 = await log.append({
      invocationId: 'inv-tie',
      threadId: 'thread-tie',
      agentId: CLAUDE,
      toolName: 'evidence_search',
      timestamp: sharedTs,
    });
    const e3 = await log.append({
      invocationId: 'inv-tie',
      threadId: 'thread-tie',
      agentId: CLAUDE,
      toolName: 'post_message',
      timestamp: sharedTs,
    });
    const expectedIdOrder = [e1.id, e2.id, e3.id].sort();

    const first = (await log.readByThread('thread-tie')).map((e) => e.id);
    const second = (await log.readByThread('thread-tie')).map((e) => e.id);

    expect(first).toEqual(expectedIdOrder);
    expect(second).toEqual(expectedIdOrder); // stable across reads
  });

  it('readByThread isolates one thread from another (no cross-thread bleed)', async () => {
    await log.append({
      invocationId: 'inv-a',
      threadId: 'thread-alpha',
      agentId: CLAUDE,
      toolName: 'read_file',
      timestamp: 1_700_000_900_000,
    });
    await log.append({
      invocationId: 'inv-b',
      threadId: 'thread-beta',
      agentId: CODEX,
      toolName: 'run_tests',
      timestamp: 1_700_000_900_010,
    });

    expect(await log.readByThread('thread-alpha')).toHaveLength(1);
    expect((await log.readByThread('thread-alpha'))[0]?.toolName).toBe('read_file');
    expect(await log.readByThread('thread-beta')).toHaveLength(1);
  });

  it("readByInvocation never returns another invocation's events (strict filter)", async () => {
    // Same thread + same agent, two invocations interleaved by timestamp.
    await log.append({
      invocationId: 'inv-A',
      threadId: 'thread-shared',
      agentId: CLAUDE,
      toolName: 'read_file',
      timestamp: 1_700_001_000_000,
    });
    await log.append({
      invocationId: 'inv-B',
      threadId: 'thread-shared',
      agentId: CLAUDE,
      toolName: 'evidence_search',
      timestamp: 1_700_001_000_010,
    });
    await log.append({
      invocationId: 'inv-A',
      threadId: 'thread-shared',
      agentId: CLAUDE,
      toolName: 'post_message',
      timestamp: 1_700_001_000_020,
    });

    const a = await log.readByInvocation('inv-A');
    const b = await log.readByInvocation('inv-B');

    expect(a.map((e) => e.toolName)).toEqual(['read_file', 'post_message']);
    expect(a.every((e) => e.invocationId === 'inv-A')).toBe(true);
    expect(b).toHaveLength(1);
    expect(b[0]?.toolName).toBe('evidence_search');
  });

  it('returns [] for an unknown thread and an unknown invocation (no throw)', async () => {
    await log.append({
      invocationId: 'inv-present',
      threadId: 'thread-present',
      agentId: GEMINI,
      toolName: 'read_file',
      timestamp: 1_700_001_100_000,
    });

    expect(await log.readByThread('thread-absent')).toEqual([]);
    expect(await log.readByInvocation('inv-absent')).toEqual([]);
  });
});

describe('SqliteToolEventLog field round-trip fidelity (edge + adversarial)', () => {
  let db: Database.Database;
  let log: SqliteToolEventLog;

  beforeEach(() => {
    db = new Database(':memory:');
    log = new SqliteToolEventLog(db);
  });

  it('an unpaired tool_use round-trips with durationMs OMITTED (not null/0)', async () => {
    await log.append({
      invocationId: 'inv-unpaired',
      threadId: 'thread-unpaired',
      agentId: CLAUDE,
      toolName: 'read_file',
      toolInput: JSON.stringify({ path: 'packages/api/src/routing/state-machine.ts' }),
      timestamp: 1_700_001_200_000,
    });

    const [row] = await log.readByThread('thread-unpaired');

    // The optional field must be absent — a null/0 would falsely imply a 0ms call.
    expect(row).toBeDefined();
    expect('durationMs' in (row as object)).toBe(false);
    expect(row?.durationMs).toBeUndefined();
    expect(row?.toolResult).toBeUndefined();
  });

  it('preserves durationMs === 0 (a genuine zero, distinct from "unpaired")', async () => {
    // Adversarial: 0 is falsy. A naive `value || null` write would drop a real 0ms
    // duration. It must round-trip as 0, not vanish.
    await log.append({
      invocationId: 'inv-zero',
      threadId: 'thread-zero',
      agentId: CODEX,
      toolName: 'post_message',
      durationMs: 0,
      timestamp: 1_700_001_300_000,
    });

    const [row] = await log.readByThread('thread-zero');

    expect(row?.durationMs).toBe(0);
  });

  it('round-trips a nested + unicode toolInput JSON string byte-for-byte', async () => {
    const toolInput = JSON.stringify({
      path: 'docs/clowder-架构设计.md',
      filters: { stage: '设计评审', tags: ['路由', 'A2A', '🧵'] },
      note: '检索“数据库选型”相关证据，含 emoji 💾 与引号 "quoted"',
    });

    await log.append({
      invocationId: 'inv-json',
      threadId: 'thread-json',
      agentId: CLAUDE,
      toolName: 'evidence_search',
      toolInput,
      timestamp: 1_700_001_400_000,
    });

    const [row] = await log.readByThread('thread-json');

    expect(row?.toolInput).toBe(toolInput);
    // And the stored string is still valid JSON that parses back to the original.
    expect(JSON.parse(row?.toolInput ?? 'null')).toEqual(JSON.parse(toolInput));
  });

  it('round-trips a large (>64KB) toolResult payload without truncation', async () => {
    // A real tool result can be a big file dump. Build a >64K-code-unit CJK+code
    // string (the chunk is 49 UTF-16 code units; 2000× ⇒ ~98K, well over 65536).
    const chunk = '// 评审 routing 层：检测 ping-pong 循环，A2A worklist 扩展。\n';
    const big = chunk.repeat(2000);
    expect(big.length).toBeGreaterThan(64 * 1024);

    await log.append({
      invocationId: 'inv-big',
      threadId: 'thread-big',
      agentId: CLAUDE,
      toolName: 'read_file',
      toolResult: big,
      timestamp: 1_700_001_500_000,
    });

    const [row] = await log.readByThread('thread-big');

    expect(row?.toolResult).toBe(big);
    expect(row?.toolResult?.length).toBe(big.length);
  });

  it('re-brands agentId back to AgentId on read (raw TEXT column → branded type)', async () => {
    const appended = await log.append({
      invocationId: 'inv-brand',
      threadId: 'thread-brand',
      agentId: GEMINI,
      toolName: 'run_tests',
      timestamp: 1_700_001_600_000,
    });

    const [row] = await log.readByInvocation('inv-brand');

    expect(row?.agentId).toBe(GEMINI);
    expect(row?.agentId).toBe(appended.agentId);
  });
});
