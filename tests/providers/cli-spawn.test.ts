// tests/providers/cli-spawn.test.ts
// M2 dev (happy-path unit): cli-spawn line stream. Uses node itself as a
// controlled child process (no external CLI), deterministic and cross-platform.
// Verifies line splitting, UTF-8 (Chinese) round-trip, stdin, and exit info.

import { describe, it, expect } from 'vitest';
import { spawnCliLineStream } from '@choco/api/providers/cli-spawn';

const NODE = process.execPath;
const TEN_SECONDS = 10_000;

// Real Chinese samples (passed through env / stdin to verify multi-byte UTF-8
// is not truncated at byte boundaries during chunked decode).
const LINE_ONE = '行一';
const LINE_TWO = '中文第二行';
const LINE_THREE = '第三行';
const TRAILING = '尾行无换行';
const STDIN_SAMPLE = '来自标准输入的内容';

async function collect(lines: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of lines) {
    out.push(line);
  }
  return out;
}

describe('cli-spawn (unit, happy path)', () => {
  it('splits stdout into complete lines and reports clean exit', async () => {
    // Arrange — child reads Chinese samples from env and prints them line by line.
    const env = { L1: LINE_ONE, L2: LINE_TWO, L3: LINE_THREE };
    const script =
      'process.stdout.write(process.env.L1 + "\\n" + process.env.L2 + "\\n" + process.env.L3 + "\\n")';
    const { lines, exit } = spawnCliLineStream({
      command: NODE,
      args: ['-e', script],
      env,
      timeoutMs: TEN_SECONDS,
    });

    // Act
    const collected = await collect(lines);
    const info = await exit;

    // Assert
    expect(collected).toEqual([LINE_ONE, LINE_TWO, LINE_THREE]);
    expect(info.reason).toBe('exit');
    expect(info.code).toBe(0);
  });

  it('flushes a trailing line that has no terminating newline', async () => {
    // Arrange — second line has no terminating newline; verify buffer flush.
    const env = { L1: LINE_ONE, TAIL: TRAILING };
    const script = 'process.stdout.write(process.env.L1 + "\\n" + process.env.TAIL)';
    const { lines } = spawnCliLineStream({
      command: NODE,
      args: ['-e', script],
      env,
      timeoutMs: TEN_SECONDS,
    });

    // Act
    const collected = await collect(lines);

    // Assert
    expect(collected).toEqual([LINE_ONE, TRAILING]);
  });

  it('captures stderr and non-zero exit code', async () => {
    // Arrange
    const script = 'process.stderr.write("boom"); process.exit(3)';
    const { lines, exit } = spawnCliLineStream({
      command: NODE,
      args: ['-e', script],
      timeoutMs: TEN_SECONDS,
    });

    // Act
    await collect(lines);
    const info = await exit;

    // Assert
    expect(info.code).toBe(3);
    expect(info.stderr).toContain('boom');
  });

  it('writes provided stdin to the child and round-trips Chinese bytes', async () => {
    // Arrange — child echoes stdin back unchanged.
    const script =
      'let d = ""; process.stdin.on("data", c => d += c); process.stdin.on("end", () => process.stdout.write(d))';
    const { lines } = spawnCliLineStream({
      command: NODE,
      args: ['-e', script],
      stdin: `${STDIN_SAMPLE}\n`,
      timeoutMs: TEN_SECONDS,
    });

    // Act
    const collected = await collect(lines);

    // Assert
    expect(collected).toContain(STDIN_SAMPLE);
  });

  it('reports spawn_error for a non-existent command', async () => {
    // Arrange
    const { lines, exit } = spawnCliLineStream({
      command: 'definitely-not-a-real-binary-xyz',
      args: [],
      timeoutMs: TEN_SECONDS,
    });

    // Act
    await collect(lines);
    const info = await exit;

    // Assert
    expect(info.reason).toBe('spawn_error');
    expect(info.spawnError).toBeInstanceOf(Error);
  });
});
