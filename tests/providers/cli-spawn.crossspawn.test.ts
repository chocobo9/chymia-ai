// tests/providers/cli-spawn.crossspawn.test.ts
// QA (dev != QA): behavioral-parity gate for Fix B — cli-spawn now spawns via
// `cross-spawn` instead of node:child_process `spawn`. cross-spawn resolves
// .cmd/.bat/.ps1 PATH shims on win32 (the reason an npm-installed `gemini` shim no
// longer ENOENTs) and escapes argv for cmd.exe, while being a pure pass-through on
// POSIX. The rest of cli-spawn (line buffering, stderr, timeout, abort, exit reasons)
// is unchanged; the existing cli-spawn.test.ts / cli-spawn.edge.test.ts already gate
// line-assembly, UTF-8, timeout and abort. This file adds ONLY the cross-spawn-specific
// parity + spawn-failure assertions NOT already covered:
//   1) the exact happy parity case from the fix brief (a\nb\n → ['a','b'], exit/0);
//   2) a truly-absent binary STILL surfaces reason 'spawn_error' WITH an ENOENT error
//      (the mechanism gemini relied on — real shims won't ENOENT now, but an absent
//      binary must), asserting the ENOENT code that cross-spawn's enoent hook emits.
//
// NOTE: we deliberately do NOT try to assert win-only .cmd/.ps1 shim resolution from
// here — that is platform/install-dependent and not portably provable in CI;
// cross-spawn is the battle-tested guarantee for it.

import { describe, it, expect } from 'vitest';
import { spawnCliLineStream } from '@choco/api/providers/cli-spawn';

const NODE = process.execPath;
const TEN_SECONDS = 10_000;

async function collect(lines: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const line of lines) {
    out.push(line);
  }
  return out;
}

describe('cli-spawn via cross-spawn — happy-path parity (happy)', () => {
  it('happy: a normal node child writing "a\\nb\\n" still yields lines [a, b] and exits reason "exit" code 0', async () => {
    // The exact parity case from the Fix B brief: the spawn swap must not change the
    // line-splitting or clean-exit behavior for an ordinary child process.
    const { lines, exit } = spawnCliLineStream({
      command: NODE,
      args: ['-e', 'process.stdout.write("a\\nb\\n")'],
      timeoutMs: TEN_SECONDS,
    });

    const collected = await collect(lines);
    const info = await exit;

    expect(collected).toEqual(['a', 'b']);
    expect(info.reason).toBe('exit');
    expect(info.code).toBe(0);
    expect(info.signal).toBeNull();
  });

  it('happy: an argv element containing spaces/quotes is passed to the child as ONE intact argument (no shell re-split)', async () => {
    // cross-spawn escapes for cmd.exe on win32 and is pass-through on POSIX; either way a
    // single free-text argv element (like a chat prompt) must arrive intact, NOT word-split.
    // The child echoes process.argv[1] (the first user arg after `-e <script>`... here we use
    // a dedicated -e that prints its trailing arg) to prove no shell tokenization happened.
    const promptArg = '修复 login 限流：写一个 "token bucket"（含空格和引号）';
    const { lines, exit } = spawnCliLineStream({
      command: NODE,
      // process.argv: [node, '-e'?]. With -e, the eval string is argv[1]'s slot is consumed;
      // user args follow and start at process.argv[1]. We print argv[1] verbatim.
      args: ['-e', 'process.stdout.write(process.argv[1])', promptArg],
      timeoutMs: TEN_SECONDS,
    });

    const collected = await collect(lines);
    const info = await exit;

    expect(collected).toEqual([promptArg]);
    expect(info.code).toBe(0);
  });
});

describe('cli-spawn via cross-spawn — spawn failure still surfaced (adversarial)', () => {
  it('adv: a definitely-absent binary resolves reason "spawn_error" with an ENOENT spawnError through cross-spawn', async () => {
    // This is the mechanism gemini RELIED on: a missing executable must still fail through the
    // same exit path. cross-spawn re-emits ENOENT via its enoent hook; assert reason + code.
    const { lines, exit } = spawnCliLineStream({
      command: 'choco-no-such-cli-xyz',
      args: ['exec', '--json'],
      timeoutMs: TEN_SECONDS,
    });

    await collect(lines);
    const info = await exit;

    expect(info.reason).toBe('spawn_error');
    expect(info.spawnError).toBeInstanceOf(Error);
    // cross-spawn's enoent hook surfaces a Node ENOENT-coded error for an absent command.
    expect((info.spawnError as NodeJS.ErrnoException).code).toBe('ENOENT');
    expect(info.code).toBeNull();
  });

  it('adv: a spawn failure for an absent binary does NOT hang — exit resolves promptly (no stuck stream)', async () => {
    // Guards the failure path against regressing into a hang (the symptom of mis-wired spawn).
    const { lines, exit } = spawnCliLineStream({
      command: 'choco-absolutely-absent-binary-7f3a',
      args: [],
      timeoutMs: TEN_SECONDS,
    });
    await collect(lines); // stream must end on its own
    const info = await exit;
    expect(info.reason).toBe('spawn_error');
  });
});
