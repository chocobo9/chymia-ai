// Operability dev happy-path: the structured logger module.
//
// Covers (1) the RouteLogger→StructuredLogger adapter level mapping with a
// capturing fake (no file writes), and (2) a real createFileLogger() round-trip
// into an isolated OS temp dir that is cleaned up — proving the dual-write file
// sink actually emits structured JSON records at the configured level. QA owns
// edge/adversarial (rollover boundaries, level filtering, redaction, etc.).

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
  createFileLogger,
  routeLoggerFrom,
  type StructuredLogger,
  type LogFields,
} from '@clowder/api/infrastructure/logger';

interface CapturedRecord {
  readonly level: 'info' | 'warn' | 'error';
  readonly fields: LogFields;
  readonly message: string;
}

/** A capturing StructuredLogger that records calls instead of writing files. */
function capturingLogger(): { logger: StructuredLogger; records: CapturedRecord[] } {
  const records: CapturedRecord[] = [];
  const logger: StructuredLogger = {
    info: (fields, message) => records.push({ level: 'info', fields, message }),
    warn: (fields, message) => records.push({ level: 'warn', fields, message }),
    error: (fields, message) => records.push({ level: 'error', fields, message }),
  };
  return { logger, records };
}

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir === undefined) continue;
    // pino's async file destination may still hold the handle for a tick after
    // the test resolves; a failed best-effort cleanup must not fail the suite
    // (the temp dir is under the OS temp root and is reclaimed by the OS anyway).
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort temp cleanup — handle still held by the async log stream */
    }
  }
});

describe('routeLoggerFrom adapter (happy path)', () => {
  it('maps a warn RouteLogger event to structured.warn with threadId + agentId fields', () => {
    const { logger, records } = capturingLogger();
    const routeLogger = routeLoggerFrom(logger);

    routeLogger({
      level: 'warn',
      message: 'tool-event-feed append failed for tool "read_file": disk full',
      threadId: 'thread-db-review',
      agentId: 'claude-opus' as never,
    });

    expect(records).toHaveLength(1);
    expect(records[0]?.level).toBe('warn');
    expect(records[0]?.message).toContain('tool-event-feed append failed');
    expect(records[0]?.fields).toMatchObject({ threadId: 'thread-db-review', agentId: 'claude-opus' });
  });

  it('maps an info RouteLogger event (no agentId) to structured.info with only threadId', () => {
    const { logger, records } = capturingLogger();
    const routeLogger = routeLoggerFrom(logger);

    routeLogger({
      level: 'info',
      message: 'invocation start (invocationId=inv-7f3a)',
      threadId: 'thread-onboarding',
    });

    expect(records).toHaveLength(1);
    expect(records[0]?.level).toBe('info');
    expect(records[0]?.fields).toEqual({ threadId: 'thread-onboarding' });
  });
});

describe('createFileLogger (happy path)', () => {
  it('dual-writes a structured JSON record to a rolling file under the temp LOG_DIR', () => {
    const dir = mkdtempSync(join(tmpdir(), 'clowder-log-'));
    tempDirs.push(dir);
    const fixedDate = new Date('2026-05-31T00:00:00.000Z');

    const logger = createFileLogger({ logDir: dir, level: 'info', date: () => fixedDate });
    logger.info(
      { invocationId: 'inv-001', agentId: 'claude-opus', durationMs: 1234 },
      'invocation end',
    );

    // pino.destination(sync:false) flushes async — give the write loop a tick.
    return new Promise<void>((done) => {
      setTimeout(() => {
        const files = readdirSync(dir);
        const logFile = files.find((f) => f === 'api-2026-05-31.log');
        expect(logFile).toBeDefined();
        const contents = readFileSync(resolve(dir, logFile as string), 'utf8');
        const lines = contents.trim().split('\n').filter((l) => l.length > 0);
        expect(lines.length).toBeGreaterThanOrEqual(1);
        const record = JSON.parse(lines[lines.length - 1] as string) as Record<string, unknown>;
        expect(record['msg']).toBe('invocation end');
        expect(record['invocationId']).toBe('inv-001');
        expect(record['durationMs']).toBe(1234);
        expect(record['level']).toBe(30); // pino numeric level for 'info'
        done();
      }, 120);
    });
  });
});
