// packages/api/src/providers/antigravity/antigravity-service.ts
// AntigravityAgentService —— spawn 真实 `agy` (Antigravity) CLI 的 print 模式，drain
// plain-text stdout → 分类 → yield AgentMessage。@gemini / Gemini（clientId `google`）
// 的后端由 `gemini` CLI 换成 `agy`（用户拍板：gemini 不好用，对齐 Clowder 替换）。
//
// 设计来源（对齐对象）：Clowder GeminiAgentService.invokeAntigravityCLI（agy print 路径）。
// 从对齐对象写 WHAT，不复制源码。调用契约（经 `agy --help` 1.0.6 核对）：
//   agy --add-dir <cwd> --dangerously-skip-permissions [--print-timeout Ns]
//       --conversation <sessionId> --print <effectivePrompt>
//
// 与 Clowder gemini-cli 路径的关键差异（也是换 agy 的动机之一）：agy print 是 plain-text
// 一次性输出——无 NDJSON、无 mid-stream `result`/done、且 agy 不注 MCP（无 --config）→ 无
// MCP 子进程拖慢收尾。故收尾就是「drain 全 stdout → await exit → 分类」，await exit 不会卡
// 上游 SessionMutex（不需要 gemini/claude 那套「逻辑回合结束即 kill 提前回收」）。
//
// 不传 `--model`：对齐 Clowder，靠 agy 账号侧选定的默认模型；账号没选时由 parser 的
// missing-model 诊断兜底提示。MCP 工具在 agy 路径不可用（能力变更，agents.yaml
// mcpSupport:true 暂不动，仅记一笔）。

import { randomUUID } from 'node:crypto';
import type { AgentId, AgentMessage, AgentMessageType, MessageMetadata } from '@choco/shared';
import type { AgentService, InvokeOptions, MessageContent } from '../base.js';
import { spawnCliLineStream } from '../cli-spawn.js';
import { classifyAntigravityCliPlainText } from './antigravity-parser.js';
import { readLatestAntigravityTranscriptText } from './antigravity-transcript.js';

/** spawn 的 CLI（默认 `agy`，可经 deps.command / CHOCO_GEMINI_CMD 覆盖为绝对路径）。 */
const AGY_CLI_COMMAND = 'agy';
/** 写入 metadata.provider 的标识。来源：本项目 provider 命名约定（后端真身是 Antigravity）。 */
export const ANTIGRAVITY_PROVIDER = 'antigravity' as const;
/** 默认进程超时：10 分钟（与其它 provider 一致），可被 options.timeoutMs 覆盖。 */
const AGY_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

function appendContentText(
  prompt: string,
  blocks: readonly MessageContent[] | undefined,
): string {
  if (!blocks || blocks.length === 0) {
    return prompt;
  }
  const textParts = blocks
    .filter((b): b is Extract<MessageContent, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text);
  return textParts.length > 0 ? `${prompt}\n${textParts.join('\n')}` : prompt;
}

/** agy `--print-timeout` 取 Go duration 文本（向上取整到秒）；非正超时则不传该 flag。 */
export function formatAgyPrintTimeout(timeoutMs: number): string | undefined {
  if (timeoutMs <= 0) {
    return undefined;
  }
  return `${Math.ceil(timeoutMs / 1000)}s`;
}

/**
 * 纯函数构造 agy print 调用 args。sessionId 由调用方解析（fresh 生成 / resume 沿用），
 * 便于测试确定性。systemPrompt 仅会话首轮（`options.sessionId === undefined`）前置。
 */
export function buildArgs(
  prompt: string,
  options: InvokeOptions | undefined,
  _sessionId: string,
  cwd: string,
  timeoutMs: number,
): string[] {
  const args: string[] = ['--add-dir', cwd, '--dangerously-skip-permissions'];
  const printTimeout = formatAgyPrintTimeout(timeoutMs);
  if (printTimeout) {
    args.push('--print-timeout', printTimeout);
  }
  // 仅首轮注入身份：resume 时会话已带身份，再前置会让 gemini 把人设当「用户反复发的同一句」
  // → 计数重复、索要验证码（0xDEADBEEF）、循环死锁（用户 2026-06-05 真机实测）。保留 8414494 修复。
  const withSystem =
    options?.systemPrompt
      ? `${options.systemPrompt}\n\n${prompt}`
      : prompt;
  const effectivePrompt = appendContentText(withSystem, options?.contentBlocks);
  args.push('--print', effectivePrompt);
  return args;
}

export interface AntigravityServiceDeps {
  readonly agentId: AgentId;
  /** 覆盖 CLI 命令/路径（默认 `agy`）。agy 不在 PATH 时可传绝对路径。 */
  readonly command?: string;
  readonly defaultTimeoutMs?: number;
  readonly now?: () => number;
  /** 注入 fresh 会话 id 生成器（默认 `agy-<uuid>`）——测试用确定性 id。 */
  readonly genId?: () => string;
  /** 注入 spawn 实现（默认真实 {@link spawnCliLineStream}）——测试用 fake 驱动 plain-text 流。 */
  readonly spawn?: typeof spawnCliLineStream;
  readonly transcriptFallback?: (workingDirectory: string) => string | undefined;
}

export class AntigravityAgentService implements AgentService {
  private readonly agentId: AgentId;
  private readonly command: string;
  private readonly defaultTimeoutMs: number;
  private readonly now: () => number;
  private readonly genId: () => string;
  private readonly spawnStream: typeof spawnCliLineStream;
  private readonly transcriptFallback: (workingDirectory: string) => string | undefined;

  constructor(deps: AntigravityServiceDeps) {
    this.agentId = deps.agentId;
    this.command = deps.command ?? AGY_CLI_COMMAND;
    this.defaultTimeoutMs = deps.defaultTimeoutMs ?? AGY_DEFAULT_TIMEOUT_MS;
    this.now = deps.now ?? Date.now;
    this.genId = deps.genId ?? ((): string => `agy-${randomUUID()}`);
    this.spawnStream = deps.spawn ?? spawnCliLineStream;
    this.transcriptFallback = deps.transcriptFallback ?? readLatestAntigravityTranscriptText;
  }

  /** agy 无原生 system-prompt 槽；身份由上层拼入 prompt（仅首轮）。 */
  injectsL0Natively(): boolean {
    return false;
  }

  /** 本 provider spawn 的 CLI 可执行文件名（供启动期可用性探测）。 */
  cliCommand(): string {
    return this.command;
  }

  async *invoke(prompt: string, options?: InvokeOptions): AsyncIterable<AgentMessage> {
    const metadata: MessageMetadata = { provider: ANTIGRAVITY_PROVIDER, model: '' };
    const make = (
      type: AgentMessageType,
      fields: Partial<Omit<AgentMessage, 'type' | 'agentId' | 'timestamp'>>,
    ): AgentMessage => ({ type, agentId: this.agentId, timestamp: this.now(), metadata, ...fields });

    const cwd = options?.workingDirectory ?? process.cwd();
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;
    const sessionId = options?.sessionId ?? this.genId();
    const args = buildArgs(prompt, options, sessionId, cwd, timeoutMs);

    const { lines, exit } = this.spawnStream({
      command: this.command,
      args,
      cwd: options?.workingDirectory,
      env: options?.callbackEnv,
      timeoutMs,
      signal: options?.signal,
    });

    // plain-text 一次性输出：drain 全部 stdout 行 → await exit。
    const stdoutLines: string[] = [];
    for await (const line of lines) {
      stdoutLines.push(line);
    }
    const info = await exit;
    const stdout = stdoutLines.join('\n');

    // agy 没跑起来（未安装等）：会话从未建立 → 不发 session_init，只报错 + done。
    if (info.reason === 'spawn_error') {
      const detail = info.spawnError?.message ?? 'spawn failed';
      yield make('error', { content: `antigravity cli spawn error: ${detail}`, errorCode: 'spawn_error' });
      yield make('done', { isFinal: true });
      return;
    }

    const classified = classifyAntigravityCliPlainText({
      stdout: resolveEffectiveStdout(stdout, info, cwd, this.transcriptFallback),
      stderr: info.stderr,
      resumed: options?.sessionId !== undefined,
    });

    // 收尾分类，顺序对齐 Clowder invokeAntigravityCLI：
    if (info.reason === 'timeout') {
      yield make('error', { content: 'antigravity cli timed out', errorCode: 'timeout' });
    } else if (info.reason === 'aborted') {
      // 用户取消：清前端 loading，不报 provider 失败（即便 agy 已写了错误文本）。对齐 Clowder cancelled。
    } else if (classified.kind === 'error') {
      yield make('error', { content: classified.error, errorCode: classified.errorKind });
    } else if ((info.code !== 0 && info.code !== null) || info.signal !== null) {
      const detail = info.stderr.trim() || `exit code ${info.code ?? 'null'}`;
      yield make('error', { content: detail, errorCode: `exit_${info.code ?? 'signal'}` });
    } else if (classified.kind === 'text') {
      yield make('text', { content: classified.content });
    }
    // classified.kind === 'empty' → 不发文本

    yield make('done', { isFinal: true });
  }
}

function resolveEffectiveStdout(
  stdout: string,
  info: { readonly reason: string; readonly code: number | null; readonly signal: NodeJS.Signals | null },
  cwd: string,
  transcriptFallback: (workingDirectory: string) => string | undefined,
): string {
  if (stdout.trim().length > 0) return stdout;
  if (info.reason !== 'exit' || info.code !== 0 || info.signal !== null) return stdout;
  return transcriptFallback(cwd) ?? stdout;
}
