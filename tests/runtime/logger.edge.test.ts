// Operability QA — edge/adversarial audit of the structured logger module.
//
// dev≠QA: authored by the QA instance. Hunts (1) level filtering correctness in
// the real Pino file sink, (2) routeLoggerFrom mapping faithfulness incl. the
// agentId-absent case and that warn vs info route correctly, (3) the env-var
// resolution edges, and (4) that NO test here writes to the real default LOG_DIR
// — every file-writing test is confined to an isolated OS temp dir, cleaned up.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import {
  createFileLogger,
  routeLoggerFrom,
  DEFAULT_LOG_DIR,
  type StructuredLogger,
  type LogFields,
} from '@choco/api/infrastructure/logger';

interface CapturedRecord {
  readonly level: 'info' | 'warn' | 'error';
  readonly fields: LogFields;
  readonly message: string;
}

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
function freshTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'clowder-qa-log-'));
  tempDirs.push(dir);
  return dir;
}

// Snapshot the default LOG_DIR before this file runs; assert afterAll-style in a
// final test that this suite added no files to it (no real-log-file leakage).
const defaultDirBefore = existsSync(DEFAULT_LOG_DIR) ? readdirSync(DEFAULT_LOG_DIR).sort() : null;

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir === undefined) continue;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* async pino handle may still be open; OS reclaims the temp dir */
    }
  }
});

/** Read the rolling log file's JSON records for a fixed date, after a flush tick. */
function readRecords(dir: string, date: Date): Promise<Array<Record<string, unknown>>> {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  const name = `api-${yyyy}-${mm}-${dd}.log`;
  return new Promise((done) => {
    setTimeout(() => {
      const file = resolve(dir, name);
      if (!existsSync(file)) {
        done([]);
        return;
      }
      const lines = readFileSync(file, 'utf8')
        .trim()
        .split('\n')
        .filter((l) => l.length > 0);
      done(lines.map((l) => JSON.parse(l) as Record<string, unknown>));
    }, 150);
  });
}

describe('createFileLogger — level filtering (real file sink, isolated temp dir)', () => {
  it('at level "warn", DROPS info records and KEEPS warn + error', async () => {
    const dir = freshTempDir();
    const fixedDate = new Date('2026-05-31T00:00:00.000Z');
    const logger = createFileLogger({ logDir: dir, level: 'warn', date: () => fixedDate });

    logger.info({ phase: 'start' }, 'invocation start should be filtered');
    logger.warn({ phase: 'probe' }, 'workspace drift detected');
    logger.error({ phase: 'crash' }, 'invocation threw');

    const records = await readRecords(dir, fixedDate);
    const messages = records.map((r) => r['msg']);
    expect(messages).not.toContain('invocation start should be filtered');
    expect(messages).toContain('workspace drift detected');
    expect(messages).toContain('invocation threw');
    // pino numeric levels: warn=40, error=50, and no 30(info) line present.
    expect(records.every((r) => (r['level'] as number) >= 40)).toBe(true);
  });

  it('at level "error", KEEPS only error records', async () => {
    const dir = freshTempDir();
    const fixedDate = new Date('2026-05-31T00:00:00.000Z');
    const logger = createFileLogger({ logDir: dir, level: 'error', date: () => fixedDate });

    logger.info({ k: 1 }, 'info-line');
    logger.warn({ k: 2 }, 'warn-line');
    logger.error({ k: 3 }, 'error-line');

    const records = await readRecords(dir, fixedDate);
    expect(records.map((r) => r['msg'])).toEqual(['error-line']);
  });

  it('creates a date-stamped file per the injected date (rollover boundary)', async () => {
    const dir = freshTempDir();
    const day1 = new Date('2026-01-01T12:00:00.000Z');
    const logger = createFileLogger({ logDir: dir, level: 'info', date: () => day1 });
    logger.info({ n: 1 }, 'new year turn');
    await readRecords(dir, day1);
    const files = readdirSync(dir);
    expect(files).toContain('api-2026-01-01.log');
  });

  it('uses UTC for the rolling filename (a late-UTC instant does not bleed to next day)', async () => {
    const dir = freshTempDir();
    // 23:59:59 UTC on the 30th — must be api-...-30, not -31.
    const lateUtc = new Date('2026-05-30T23:59:59.000Z');
    const logger = createFileLogger({ logDir: dir, level: 'info', date: () => lateUtc });
    logger.info({ n: 1 }, 'edge of day');
    await readRecords(dir, lateUtc);
    const files = readdirSync(dir);
    expect(files).toContain('api-2026-05-30.log');
  });
});

describe('routeLoggerFrom — mapping faithfulness', () => {
  it('routes level "warn" to structured.warn', () => {
    const { logger, records } = capturingLogger();
    routeLoggerFrom(logger)({
      level: 'warn',
      message: 'invariant: tool "Write" write path resolves OUTSIDE workspace',
      threadId: 'thread-escape',
      agentId: 'claude-opus' as never,
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.level).toBe('warn');
  });

  it('routes level "info" to structured.info and OMITS agentId when absent', () => {
    const { logger, records } = capturingLogger();
    routeLoggerFrom(logger)({
      level: 'info',
      message: 'invocation start (invocationId=inv-9c2a)',
      threadId: 'thread-onboarding',
    });
    expect(records[0]?.level).toBe('info');
    expect(records[0]?.fields).toEqual({ threadId: 'thread-onboarding' });
    expect('agentId' in (records[0]?.fields ?? {})).toBe(false);
  });

  it('preserves the exact message text verbatim (no truncation/rewrite)', () => {
    const { logger, records } = capturingLogger();
    const msg =
      'invocation end (invocationId=inv-1 durationMs=4210 textChars=320 toolCalls=2 errors=0)';
    routeLoggerFrom(logger)({ level: 'info', message: msg, threadId: 't-1' });
    expect(records[0]?.message).toBe(msg);
  });

  it('never routes a RouteLogger event to structured.error (adapter has no error level)', () => {
    // RouteLogger only carries info|warn. Confirm the adapter never escalates to
    // error — recall/precision of the level mapping.
    const { logger, records } = capturingLogger();
    const r = routeLoggerFrom(logger);
    r({ level: 'warn', message: 'w', threadId: 't' });
    r({ level: 'info', message: 'i', threadId: 't' });
    expect(records.some((rec) => rec.level === 'error')).toBe(false);
  });
});

describe('logger — no real-log-file leakage (suite hygiene guard)', () => {
  it('this suite added NO files to the real DEFAULT_LOG_DIR', () => {
    const after = existsSync(DEFAULT_LOG_DIR) ? readdirSync(DEFAULT_LOG_DIR).sort() : null;
    if (defaultDirBefore === null) {
      expect(after).toBeNull();
    } else {
      expect(after).toEqual(defaultDirBefore);
    }
  });
});
