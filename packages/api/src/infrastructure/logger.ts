// Operability — the real structured logger (Pino), wired at the EDGE only.
//
// Mirrors the CatCafe operability SHAPE (reference logger.ts): a Pino instance
// that dual-writes structured JSON to BOTH stdout AND a rolling file under a
// LOG_DIR, at a LOG_LEVEL. Re-authored from our own seams — NOT copied — so it
// satisfies the project's {@link RouteLogger} contract (routing/agent-router.ts)
// plus the slightly richer record-first methods the operability layer needs.
//
// CRITICAL (per task constraint): buildApp() must stay test-safe (no-op logger,
// no file writes). This module is therefore the EDGE composition piece — only
// main.ts constructs a file logger and injects it via buildApp({ logger }). In
// tests, code paths either inject a capturing fake or fall through to the
// app-factory NOOP_LOGGER, so no log files are ever written during the suite.
//
// Rolling strategy: pino-roll is NOT a dependency here (it runs in a worker
// transport that fights tsx path resolution in this monorepo). Instead we use a
// date-stamped destination file (`api-YYYY-MM-DD.log`) opened via
// pino.destination + a pino.multistream fan-out to stdout. New day → new file;
// old files are left on disk (retention/rotation is an ops concern, out of scope
// for this "good-enough" layer).

import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import pino, { type Level as PinoLevel } from 'pino';
import type { RouteLogger } from '@clowder/api/routing/agent-router';

/** Env var naming the directory rolling log files are written under. */
export const LOG_DIR_ENV = 'LOG_DIR';
/** Env var naming the minimum level emitted (pino level: trace…fatal). */
export const LOG_LEVEL_ENV = 'LOG_LEVEL';

/** Default log directory when {@link LOG_DIR_ENV} is unset (relative to cwd). */
export const DEFAULT_LOG_DIR = resolve(process.cwd(), 'data', 'logs', 'api');
/** Default minimum level when {@link LOG_LEVEL_ENV} is unset. */
export const DEFAULT_LOG_LEVEL: PinoLevel = 'info';

/** Levels the operability layer emits at (a subset of pino's levels). */
export type LogLevel = 'info' | 'warn' | 'error';

/**
 * A structured log record: an arbitrary set of fields (the structured payload)
 * plus a human message. Field values are JSON-serializable. No `any`.
 */
export type LogFields = Readonly<Record<string, unknown>>;

/**
 * The operability logger surface. Record-first (fields then message) so callers
 * emit structured events (invocation start/end, tool calls, probe warnings)
 * rather than interpolated strings. Distinct from {@link RouteLogger} (the
 * narrow per-thread routing seam) — {@link routeLoggerFrom} adapts this to that.
 */
export interface StructuredLogger {
  info(fields: LogFields, message: string): void;
  warn(fields: LogFields, message: string): void;
  error(fields: LogFields, message: string): void;
}

/** Options for {@link createFileLogger}. All optional — production reads env. */
export interface FileLoggerOptions {
  /** Directory rolling files are written under. Default: {@link LOG_DIR_ENV} / {@link DEFAULT_LOG_DIR}. */
  readonly logDir?: string;
  /** Minimum level. Default: {@link LOG_LEVEL_ENV} / {@link DEFAULT_LOG_LEVEL}. */
  readonly level?: PinoLevel;
  /** Date provider for the rolling filename (injectable for tests). Default: now. */
  readonly date?: () => Date;
}

/** Resolve the configured log directory from options → env → default. */
function resolveLogDir(opt: string | undefined): string {
  if (opt !== undefined && opt.length > 0) return resolve(opt);
  const fromEnv = process.env[LOG_DIR_ENV];
  if (fromEnv !== undefined && fromEnv.length > 0) return resolve(fromEnv);
  return DEFAULT_LOG_DIR;
}

/** Resolve the configured level from options → env → default. */
function resolveLevel(opt: PinoLevel | undefined): PinoLevel {
  if (opt !== undefined) return opt;
  const fromEnv = process.env[LOG_LEVEL_ENV];
  return fromEnv !== undefined && fromEnv.length > 0 ? (fromEnv as PinoLevel) : DEFAULT_LOG_LEVEL;
}

/** Build the date-stamped log filename (`api-YYYY-MM-DD.log`) for `date`. */
function rollingFileName(date: Date): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return `api-${yyyy}-${mm}-${dd}.log`;
}

/**
 * Build a Pino-backed {@link StructuredLogger} that dual-writes structured JSON
 * to stdout AND a date-rolled file under the resolved LOG_DIR at the resolved
 * LOG_LEVEL. The directory is created if missing. Called ONLY at the edge
 * (main.ts) — never as buildApp's default — so the test suite never writes files.
 */
export function createFileLogger(options: FileLoggerOptions = {}): StructuredLogger {
  const logDir = resolveLogDir(options.logDir);
  const level = resolveLevel(options.level);
  const now = options.date ?? ((): Date => new Date());

  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }

  const filePath = resolve(logDir, rollingFileName(now()));
  const stream = pino.multistream([
    { level, stream: pino.destination({ dest: 1, sync: false }) },
    { level, stream: pino.destination({ dest: filePath, mkdir: true, sync: false }) },
  ]);

  const instance = pino(
    {
      level,
      timestamp: (): string => `,"time":"${new Date().toISOString()}"`,
    },
    stream,
  );

  return wrapPino(instance);
}

/** Wrap a pino.Logger as the project {@link StructuredLogger} surface. */
function wrapPino(instance: pino.Logger): StructuredLogger {
  return {
    info: (fields, message): void => {
      instance.info(fields, message);
    },
    warn: (fields, message): void => {
      instance.warn(fields, message);
    },
    error: (fields, message): void => {
      instance.error(fields, message);
    },
  };
}

/**
 * Adapt a {@link StructuredLogger} to the narrow {@link RouteLogger} seam that
 * AgentRouter / AppServices already accept. This lets main.ts inject the real
 * file logger through the EXISTING `buildApp({ logger })` override without
 * changing any route signatures: a RouteLogger event becomes a structured
 * record `{ threadId, agentId? }` + its message at the event's level.
 */
export function routeLoggerFrom(structured: StructuredLogger): RouteLogger {
  return (event): void => {
    const fields: Record<string, unknown> = { threadId: event.threadId };
    if (event.agentId !== undefined) {
      fields['agentId'] = event.agentId as string;
    }
    if (event.level === 'warn') {
      structured.warn(fields, event.message);
      return;
    }
    structured.info(fields, event.message);
  };
}
