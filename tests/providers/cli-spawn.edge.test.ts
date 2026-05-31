// tests/providers/cli-spawn.edge.test.ts
// M2 QA (edge + adversarial): cli-spawn line stream. QA != dev.
// Gates spawnCliLineStream against design §7.1 / extraction §2.2 (parser/spawn
// split, NDJSON line buffering, multi-byte UTF-8 decode) and §5.1 lifecycle
// (timeout kill, abort, stderr capture + non-zero exit). Uses node itself as a
// deterministic fake CLI; byte-level writes with a micro-delay force separate
// stdout 'data' events to exercise the StringDecoder + line-buffer seam.

import { describe, it, expect } from 'vitest';
import { spawnCliLineStream, type CliExitInfo } from '@clowder/api/providers/cli-spawn';

const NODE = process.execPath;
const TEN_SECONDS = 10_000;

async function collect(lines: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of lines) {
    out.push(line);
  }
  return out;
}

function runNode(script: string): { lines: AsyncIterable<string>; exit: Promise<CliExitInfo> } {
  return spawnCliLineStream({ command: NODE, args: ['-e', script], timeoutMs: TEN_SECONDS });
}

describe('spawnCliLineStream — line assembly seam (edge)', () => {
  it('assembles one NDJSON line that arrives split across two stdout chunks', async () => {
    // A single JSON line written in two halves with a gap forcing two 'data' events.
    const full = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'split-line-1' }) + '\n';
    const cut = Math.floor(full.length / 2);
    const script =
      `const a = ${JSON.stringify(full.slice(0, cut))};` +
      `const b = ${JSON.stringify(full.slice(cut))};` +
      `process.stdout.write(a);` +
      `setTimeout(() => process.stdout.write(b), 30);`;
    const { lines } = runNode(script);
    const collected = await collect(lines);
    expect(collected).toHaveLength(1);
    expect(JSON.parse(collected[0])).toMatchObject({ type: 'system', session_id: 'split-line-1' });
  });

  it('preserves a multi-byte UTF-8 Chinese char split across a chunk boundary (no mojibake)', async () => {
    // Build the line as UTF-8 bytes and cut INSIDE a 3-byte char so chunk 1 ends
    // mid-character. StringDecoder must hold the partial bytes until the next chunk.
    const payload = '世界你好，验证多字节边界';
    const line = JSON.stringify({ type: 'content', text: payload }) + '\n';
    const script =
      `const buf = Buffer.from(${JSON.stringify(line)}, 'utf8');` +
      `let cut = Math.floor(buf.length / 2);` +
      // advance to a lead byte (0b11xxxxxx), then step +1 to land on a continuation byte.
      `while (cut < buf.length && (buf[cut] & 0xc0) !== 0xc0) { cut++; }` +
      `if (cut + 1 < buf.length) { cut++; }` +
      `process.stdout.write(buf.subarray(0, cut));` +
      `setTimeout(() => process.stdout.write(buf.subarray(cut)), 30);`;
    const { lines } = runNode(script);
    const collected = await collect(lines);
    expect(collected).toHaveLength(1);
    expect(JSON.parse(collected[0]).text).toBe(payload);
  });

  it('flushes a trailing line that has no terminating newline on process exit', async () => {
    const noNewline = JSON.stringify({ type: 'content', text: '无换行收尾' });
    const script = `process.stdout.write(${JSON.stringify(noNewline)});`;
    const { lines } = runNode(script);
    const collected = await collect(lines);
    expect(collected).toEqual([noNewline]);
  });

  it('strips a CRLF \\r so Windows-style line endings do not leak into parsed JSON', async () => {
    const obj = JSON.stringify({ type: 'thought', text: 'crlf 安全' });
    const script = `process.stdout.write(${JSON.stringify(obj + '\r\n')});`;
    const { lines } = runNode(script);
    const collected = await collect(lines);
    expect(collected).toEqual([obj]);
    expect(collected[0].endsWith('\r')).toBe(false);
  });

  it('yields blank lines verbatim and never drops surrounding real lines', async () => {
    const a = JSON.stringify({ type: 'content', text: '第一' });
    const b = JSON.stringify({ type: 'content', text: '第二' });
    const script = `process.stdout.write(${JSON.stringify(a + '\n\n   \n' + b + '\n')});`;
    const { lines } = runNode(script);
    const collected = await collect(lines);
    expect(collected).toEqual([a, '', '   ', b]);
  });
});

describe('spawnCliLineStream — process lifecycle (adversarial)', () => {
  it('kills a child that never exits at timeoutMs and reports reason "timeout"', async () => {
    const script = `setTimeout(() => {}, 60000); setInterval(() => {}, 1000);`;
    const { lines, exit } = spawnCliLineStream({ command: NODE, args: ['-e', script], timeoutMs: 250 });
    await collect(lines);
    const info = await exit;
    expect(info.reason).toBe('timeout');
  });

  it('kills a running child via AbortSignal and reports reason "aborted"', async () => {
    const controller = new AbortController();
    const script = `setInterval(() => {}, 1000);`;
    const { lines, exit } = spawnCliLineStream({
      command: NODE,
      args: ['-e', script],
      timeoutMs: TEN_SECONDS,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 120);
    await collect(lines);
    const info = await exit;
    expect(info.reason).toBe('aborted');
  });

  it('captures stderr and the non-zero exit code when the child fails', async () => {
    const script = `process.stderr.write('fatal: codex auth token missing\\n'); process.exit(7);`;
    const { lines, exit } = runNode(script);
    await collect(lines);
    const info = await exit;
    expect(info.reason).toBe('exit');
    expect(info.code).toBe(7);
    expect(info.stderr).toContain('codex auth token missing');
  });

  it('handles large output (>1000 NDJSON lines) without dropping any line', async () => {
    const script =
      `for (let i = 0; i < 1200; i++) {` +
      `  process.stdout.write(JSON.stringify({ type: 'content', text: '块' + i }) + '\\n');` +
      `}`;
    const { lines, exit } = runNode(script);
    const collected = await collect(lines);
    const info = await exit;
    expect(collected).toHaveLength(1200);
    expect(JSON.parse(collected[0]).text).toBe('块0');
    expect(JSON.parse(collected[1199]).text).toBe('块1199');
    expect(info.code).toBe(0);
  });

  it('round-trips real Chinese content provided on the child stdin', async () => {
    const sample = '来自标准输入的中文校验内容';
    const script =
      `let d = ''; process.stdin.on('data', c => d += c);` +
      `process.stdin.on('end', () => process.stdout.write(d));`;
    const { lines } = spawnCliLineStream({
      command: NODE,
      args: ['-e', script],
      stdin: `${sample}\n`,
      timeoutMs: TEN_SECONDS,
    });
    const collected = await collect(lines);
    expect(collected).toContain(sample);
  });
});
