// packages/api/src/providers/codex/codex-service.ts
// M2: CodexAgentService —— spawn 真实 `codex` CLI，逐行喂 parser，yield AgentMessage
//
// 设计来源：extraction §2.2（codex exec --json；session resume = experimental-resume）
// + design §5.1。从设计写 WHAT，不复制源码。

import type { AgentId, AgentMessage } from '@choco/shared';
import type { AgentService, InvokeOptions, MessageContent } from '../base.js';
import { spawnCliLineStream } from '../cli-spawn.js';
import { finalizeStream } from '../claude/claude-service.js';
import { existsSync } from 'node:fs';
import { resolve, join, dirname, parse } from 'node:path';
import {
  createCodexParserState,
  parseCodexLine,
  CODEX_PROVIDER,
  type CodexParserState,
} from './codex-parser.js';

// ── CLI 接入常量（来源：extraction §2.2「Codex 集成」 + codex-cli 0.136 实测） ──
const CODEX_CLI_COMMAND = 'codex';
/** 非交互子命令：`codex exec [OPTIONS] [PROMPT]`。 */
const CODEX_EXEC_SUBCOMMAND = 'exec';
/** JSON 流式输出 flag。 */
const CODEX_JSON_FLAG = '--json';
/**
 * Session-resume 子命令。codex-cli 0.136 是 `codex exec resume [OPTIONS]
 * [SESSION_ID] [PROMPT]` —— `resume` 是 `exec` 的子命令、session id 是它的第一个
 * 位置参数。旧的 `experimental-resume <id>` 形式已移除：再传它会让 codex 把 id 当成
 * 多余的位置参数 → "unexpected argument '<uuid>'"（实测 0.136）。
 */
const CODEX_RESUME_SUBCOMMAND = 'resume';
/** model 选择 flag */
const CODEX_MODEL_FLAG = '--model';
/** 默认进程超时：10 分钟。来源：coding agent 长任务经验默认，可被 options 覆盖 */
const CODEX_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
/** 默认模型占位（codex 用账户默认时留空），可被 options.model 覆盖 */
const CODEX_DEFAULT_MODEL = '';
/**
 * callbackEnv 中携带「codex MCP `--config` 注入参数列表（JSON 序列化的 string[]）」的
 * 约定 key。由 app-factory 经 providers/mcp-config.ts:buildCodexMcpConfigArgs 生产。
 * 与 claude 的 'MCP_CONFIG_JSON' 区分（两边格式不互通）。字面量必须与 producer 端
 * （mcp-config.ts MCP_CODEX_CONFIG_ARGS_KEY）一致——wiring 测试守此契约防漂移。
 */
const MCP_CODEX_CONFIG_ARGS_KEY = 'MCP_CODEX_CONFIG_ARGS';

export interface CodexServiceDeps {
  readonly agentId: AgentId;
  readonly command?: string;
  readonly defaultModel?: string;
  readonly defaultTimeoutMs?: number;
  readonly now?: () => number;
}

/** 把多模态 text block 附加到 prompt 文本（图片由上层 image bridge 处理） */
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

/**
 * 判断 workingDirectory 是否落在 git 仓库内（向上遍历找 .git，到根为止）。
 * 对齐 Clowder CodexAgentService.isGitRepositoryPath。
 */
export function isGitRepositoryPath(workingDirectory: string): boolean {
  let current = resolve(workingDirectory);
  for (;;) {
    if (existsSync(join(current, '.git'))) return true;
    const root = parse(current).root;
    if (current === root) return false;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * codex 0.137 在非 git / 非受信目录拒跑（exit 1：「Not inside a trusted directory and
 * --skip-git-repo-check was not specified」）。cwd 非 git 仓时补 --skip-git-repo-check。
 * 对齐 Clowder CodexAgentService.buildGitRepoArgs（repoCheckDir = workingDirectory ?? cwd）。
 */
function buildGitRepoArgs(workingDirectory?: string): string[] {
  const repoCheckDir = workingDirectory ?? process.cwd();
  return isGitRepositoryPath(repoCheckDir) ? [] : ['--skip-git-repo-check'];
}

/**
 * Build the prompt text piped via stdin (NOT an argv positional). codex `exec`
 * reads PROMPT from stdin when the positional is `-` after a `--` end-of-options
 * marker (see buildArgs), so the long turn prompt never enters argv. Aligned to
 * Clowder CodexAgentService (promptArgs ['--','-'] + stdin) — fixes BOTH the Windows
 * CreateProcess ~32K limit (`spawn ENAMETOOLONG`) and the cross-process argv exposure
 * (ps / proc cmdline leaking cross-thread history).
 *
 * Codex 无原生 system prompt 注入（injectsL0Natively=false）：仅「会话首轮」（无 sessionId /
 * 未 resume）才把身份 system prompt 前置拼入。RESUME 时会话已带身份，再每轮前置会让模型把人设
 * 当成用户反复发的同一句话 → 重复计数 / 身份死循环（gemini 上真机实测，codex 同构，预防性同修）。
 */
export function buildStdinPrompt(
  prompt: string,
  options: InvokeOptions | undefined,
): string {
  const withSystem =
    options?.systemPrompt && options?.sessionId === undefined
      ? `${options.systemPrompt}\n\n${prompt}`
      : prompt;
  return appendContentText(withSystem, options?.contentBlocks);
}

export function buildArgs(
  options: InvokeOptions | undefined,
  defaultModel: string,
): string[] {
  // Fresh: `codex exec --json … -- -`. Resume: `codex exec resume <SESSION_ID>
  // --json … -- -` — the `resume` subcommand + positional session id MUST come
  // right after `exec`, before the flags (codex-cli 0.136).
  const args: string[] = [CODEX_EXEC_SUBCOMMAND];
  if (options?.sessionId) {
    args.push(CODEX_RESUME_SUBCOMMAND, options.sessionId);
  }
  args.push(CODEX_JSON_FLAG);
  // codex 0.137 受信目录门：非 git 仓 cwd 必须显式 --skip-git-repo-check，否则 exit 1。
  args.push(...buildGitRepoArgs(options?.workingDirectory));
  const model = options?.model ?? defaultModel;
  if (model) {
    args.push(CODEX_MODEL_FLAG, model);
  }
  // MCP 工具桥 (consumer)：app-factory 把 provider-correct 的 `--config
  // mcp_servers.choco.*` flag 列表（TOML key=value，非 Claude JSON）JSON 序列化进
  // callbackEnv，这里原样 splice 进 argv（对齐 Clowder CodexAgentService 的 ...catCafeMcpArgs）。
  const mcpArgsRaw = options?.callbackEnv?.[MCP_CODEX_CONFIG_ARGS_KEY];
  if (mcpArgsRaw) {
    args.push(...(JSON.parse(mcpArgsRaw) as string[]));
  }
  // `--` 终止选项解析；`-` 让 codex 从 stdin 读取 PROMPT（对齐 Clowder promptArgs）。
  // prompt 经 stdin（buildStdinPrompt），绝不进 argv。
  args.push('--', '-');
  return args;
}

export class CodexAgentService implements AgentService {
  private readonly agentId: AgentId;
  private readonly command: string;
  private readonly defaultModel: string;
  private readonly defaultTimeoutMs: number;
  private readonly now: () => number;

  constructor(deps: CodexServiceDeps) {
    this.agentId = deps.agentId;
    this.command = deps.command ?? CODEX_CLI_COMMAND;
    this.defaultModel = deps.defaultModel ?? CODEX_DEFAULT_MODEL;
    this.defaultTimeoutMs = deps.defaultTimeoutMs ?? CODEX_DEFAULT_TIMEOUT_MS;
    this.now = deps.now ?? Date.now;
  }

  /** 本 provider spawn 的 CLI 可执行文件名（供启动期可用性探测，§A）。 */
  cliCommand(): string {
    return this.command;
  }

  /** Codex 不支持原生 system prompt 文件注入；由上层拼入 prompt */
  injectsL0Natively(): boolean {
    return false;
  }

  async *invoke(
    prompt: string,
    options?: InvokeOptions,
  ): AsyncIterable<AgentMessage> {
    const model = options?.model ?? this.defaultModel;
    const args = buildArgs(options, this.defaultModel);
    const stdinPrompt = buildStdinPrompt(prompt, options);
    const { lines, exit } = spawnCliLineStream({
      command: this.command,
      args,
      stdin: stdinPrompt,
      cwd: options?.workingDirectory,
      env: options?.callbackEnv,
      timeoutMs: options?.timeoutMs ?? this.defaultTimeoutMs,
      signal: options?.signal,
    });

    let state: CodexParserState = createCodexParserState();
    const deps = { agentId: this.agentId, now: this.now, model };

    for await (const line of lines) {
      const result = parseCodexLine(line, state, deps);
      state = result.state;
      for (const msg of result.messages) {
        yield msg;
      }
    }

    const info = await exit;
    yield* finalizeStream(info, {
      agentId: this.agentId,
      provider: CODEX_PROVIDER,
      model,
      now: this.now,
    });
  }
}
