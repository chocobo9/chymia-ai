// packages/api/src/providers/cli-spawn.ts
// M2: 通用 CLI spawn + 逐行流工具
//
// 职责：spawn 一个子进程，把 stdout 拆成完整文本行（NDJSON 友好），以
// AsyncIterable<string> 形式逐行吐出；同时收集 stderr、暴露退出码、支持
// abort 与超时 kill。所有参数（cmd / args / cwd / env / timeout / 输入）由
// 调用方传入，本模块不硬编码任何 CLI 名称、参数或超时值（CLAUDE §3.3）。
//
// NDJSON edge case 处理（设计 §7.1 / extraction §2.2）：
//   - 跨 chunk 切分的半行：用 buffer 累积，仅在遇到 '\n' 时切出完整行。
//   - 多字节 UTF-8（中文）跨 chunk：用 StringDecoder 做有状态解码，绝不在
//     字节边界处截断字符。
//   - 空行 / 纯空白行：原样吐出，由上层 parser 决定忽略（parser 对空行返回 null）。
//   - 进程结束时 buffer 残留的最后一行（无结尾换行）：flush 出去。
//
// Pattern from Clowder spawn 层（spawn 与行缓冲 / parser 分离），此处独立 re-author。
//
// Windows shim handling: on win32 a CLI is often a PATH shim (e.g. `gemini.cmd` /
// `gemini.ps1` from an npm install) rather than a `.exe`. Node's native
// `child_process.spawn(cmd)` (no shell) only resolves `.exe`, so a shim throws
// `spawn ENOENT` even though the PATHEXT-aware availability probe found it. We
// spawn via `cross-spawn` (the de-facto standard, used by npm/jest): it resolves
// `.cmd`/`.bat` shims and escapes argv correctly for cmd.exe on win32, and is a
// pure pass-through on POSIX — so a free-text prompt arg is never mis-quoted (the
// reason we do NOT use a bare `shell: true`). Same resolve→shim-aware-spawn intent
// as Clowder's hand-rolled cli-spawn-win, via a battle-tested lib (no escaping to
// hand-maintain). Dep rationale (CLAUDE.md §2.3): correct Windows shim spawning.

import crossSpawn from 'cross-spawn';
import { StringDecoder } from 'node:string_decoder';

/** spawn 参数（全部外部化，无默认硬编码值） */
export interface CliSpawnParams {
  /** 可执行文件名或路径，如 'claude' / 'codex' / 'gemini' */
  readonly command: string;
  /** 命令行参数数组 */
  readonly args: readonly string[];
  /** 工作目录；不传则继承当前进程 cwd */
  readonly cwd?: string;
  /** 追加/覆盖的环境变量；与 process.env 合并 */
  readonly env?: Record<string, string>;
  /** 写入子进程 stdin 的内容；不传则不写并立即 end stdin */
  readonly stdin?: string;
  /** 进程超时（毫秒）；到时 kill 并使流以 timeout 结束。必须由调用方给出 */
  readonly timeoutMs: number;
  /** 外部取消信号 */
  readonly signal?: AbortSignal;
}

/** 进程终止原因 */
export type CliExitReason = 'exit' | 'timeout' | 'aborted' | 'spawn_error';

/** 流结束时的进程结果摘要 */
export interface CliExitInfo {
  readonly reason: CliExitReason;
  /** 正常退出时的退出码（信号 kill 时可能为 null） */
  readonly code: number | null;
  /** 终止信号（如 'SIGTERM'），无则 null */
  readonly signal: NodeJS.Signals | null;
  /** 累积的 stderr 文本（用于错误分类） */
  readonly stderr: string;
  /** spawn 自身失败（ENOENT 等）时的错误 */
  readonly spawnError?: Error;
}

/** 逐行流的产物：每一行 + 最终一次 exit 信息 */
export interface CliLineStream {
  /** 逐行 yield stdout（不含换行符）。迭代结束后 exit 已 resolve */
  readonly lines: AsyncIterable<string>;
  /** stdout 流结束 + 进程收尾后 resolve 的退出信息 */
  readonly exit: Promise<CliExitInfo>;
}

/**
 * spawn 子进程并返回逐行 stdout 流。
 */
export function spawnCliLineStream(params: CliSpawnParams): CliLineStream {
  const mergedEnv: NodeJS.ProcessEnv = { ...process.env, ...params.env };

  const child = crossSpawn(params.command, [...params.args], {
    cwd: params.cwd,
    env: mergedEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let resolveExit!: (info: CliExitInfo) => void;
  const exit = new Promise<CliExitInfo>((resolve) => {
    resolveExit = resolve;
  });

  let stderrBuf = '';
  let exitSettled = false;
  let timedOut = false;
  let aborted = false;

  const stderrDecoder = new StringDecoder('utf8');
  if (child.stderr) {
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += stderrDecoder.write(chunk);
    });
  }

  // 超时：到时 kill。实际终止原因在 close 时按标志判定。
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
  }, params.timeoutMs);
  // 不让定时器阻止进程退出
  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  const onAbort = (): void => {
    aborted = true;
    child.kill('SIGTERM');
  };
  if (params.signal) {
    if (params.signal.aborted) {
      onAbort();
    } else {
      params.signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  const settleExit = (info: CliExitInfo): void => {
    if (exitSettled) {
      return;
    }
    exitSettled = true;
    clearTimeout(timer);
    if (params.signal) {
      params.signal.removeEventListener('abort', onAbort);
    }
    stderrBuf += stderrDecoder.end();
    resolveExit({ ...info, stderr: stderrBuf });
  };

  child.once('error', (err: Error) => {
    settleExit({
      reason: 'spawn_error',
      code: null,
      signal: null,
      stderr: stderrBuf,
      spawnError: err,
    });
  });

  child.once('close', (code: number | null, signal: NodeJS.Signals | null) => {
    const reason: CliExitReason = timedOut
      ? 'timeout'
      : aborted
        ? 'aborted'
        : 'exit';
    settleExit({ reason, code, signal, stderr: stderrBuf });
  });

  function waitForClose(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (exitSettled) {
        resolve();
        return;
      }
      const check = (): void => {
        if (exitSettled) {
          resolve();
        }
      };
      child.once('close', check);
      child.once('error', check);
    });
  }

  // 把 stdout 转成完整行的 async generator。
  async function* iterateLines(): AsyncGenerator<string, void, unknown> {
    const stdout = child.stdout;
    if (!stdout) {
      await waitForClose();
      return;
    }

    const decoder = new StringDecoder('utf8');
    let buffer = '';

    try {
      // Node stream 实现了 Symbol.asyncIterator，逐 chunk 读取。
      for await (const chunk of stdout as AsyncIterable<Buffer>) {
        buffer += decoder.write(chunk);
        let newlineIdx = buffer.indexOf('\n');
        while (newlineIdx !== -1) {
          // 去掉行尾 \n 以及可能的 \r（Windows CRLF）。
          let line = buffer.slice(0, newlineIdx);
          if (line.endsWith('\r')) {
            line = line.slice(0, -1);
          }
          yield line;
          buffer = buffer.slice(newlineIdx + 1);
          newlineIdx = buffer.indexOf('\n');
        }
      }
    } finally {
      // flush 解码器残留的多字节字符。
      buffer += decoder.end();
    }

    // flush 最后一行（无结尾换行）。
    if (buffer.length > 0) {
      const last = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer;
      yield last;
    }

    await waitForClose();
  }

  // 写 stdin（如有），然后关闭，让 CLI 开始处理。
  if (child.stdin) {
    if (typeof params.stdin === 'string') {
      child.stdin.write(params.stdin, 'utf8');
    }
    child.stdin.end();
  }

  return { lines: iterateLines(), exit };
}
