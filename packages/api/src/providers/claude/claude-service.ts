// packages/api/src/providers/claude/claude-service.ts
// M2: ClaudeAgentService —— spawn 真实 `claude` CLI，逐行喂 parser，yield AgentMessage
//
// 设计来源：clowder-architecture-design.md §5.1（AgentService）+ extraction §2.2
// （Claude Code spawn 参数 / stream-json / --resume / --system-prompt-file）。
// 从设计写 WHAT，不复制源码。

import type { AgentId, AgentMessage } from '@clowder/shared';
import type { AgentService, InvokeOptions, MessageContent } from '../base.js';
import { spawnCliLineStream, type CliExitInfo } from '../cli-spawn.js';
import {
  createClaudeParserState,
  parseClaudeLine,
  CLAUDE_PROVIDER,
  type ParserState,
} from './claude-parser.js';

// ── CLI 接入常量（来源：extraction §2.2「Claude Code 集成」） ──
/** 可执行文件名（PATH 解析）；可被 deps 覆盖以便测试/自定义路径 */
const CLAUDE_CLI_COMMAND = 'claude';
/**
 * 固定 spawn 参数。来源 extraction §2.2：
 * -p（print/非交互）、--output-format stream-json、--include-partial-messages（增量 text_delta）、
 * --verbose、--permission-mode bypassPermissions（非交互自动批准）。
 */
const CLAUDE_BASE_ARGS: readonly string[] = [
  '-p',
  '--output-format',
  'stream-json',
  '--include-partial-messages',
  '--verbose',
  '--permission-mode',
  'bypassPermissions',
];
/** session resume flag，来源 extraction §2.2 */
const CLAUDE_RESUME_FLAG = '--resume';
/** model 选择 flag，来源 extraction §2.2 */
const CLAUDE_MODEL_FLAG = '--model';
/** 原生 system prompt 注入 flag（L0），来源 extraction §2.2（--system-prompt-file 的 inline 等价） */
const CLAUDE_SYSTEM_PROMPT_FLAG = '--append-system-prompt';
/** MCP 回调配置 flag，来源 extraction §2.2（--mcp-config <json>） */
const CLAUDE_MCP_CONFIG_FLAG = '--mcp-config';
/** 携带 prompt 的位置参数前缀（claude -p 接收 prompt 为位置参数）；prompt 末位追加 */
/** 默认进程超时：10 分钟。来源：coding agent 长任务经验默认，可被 InvokeOptions.timeoutMs 覆盖 */
const CLAUDE_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
/** 默认模型；来源：design §4.1 示例 'claude-opus-4-6'，可被 options.model 覆盖 */
const CLAUDE_DEFAULT_MODEL = 'claude-opus-4-6';
/** callbackEnv 中携带 MCP 配置 JSON 的约定 key（来源：补充 §C3 MCP 运行模型） */
const MCP_CONFIG_ENV_KEY = 'MCP_CONFIG_JSON';

/** 构造参数：注入 agentId 与可选覆盖 */
export interface ClaudeServiceDeps {
  readonly agentId: AgentId;
  /** 覆盖可执行文件路径（默认 'claude'） */
  readonly command?: string;
  /** 覆盖默认模型 */
  readonly defaultModel?: string;
  /** 默认超时（ms），可被 InvokeOptions.timeoutMs 覆盖 */
  readonly defaultTimeoutMs?: number;
  /** 时间源（测试确定性） */
  readonly now?: () => number;
}

/** 把多模态 contentBlocks 渲染为附加在 prompt 后的文本说明（图片走 --add-dir 由上层处理） */
function describeContentBlocks(blocks: readonly MessageContent[] | undefined): string {
  if (!blocks || blocks.length === 0) {
    return '';
  }
  const textParts = blocks
    .filter((b): b is Extract<MessageContent, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text);
  return textParts.length > 0 ? `\n${textParts.join('\n')}` : '';
}

function buildArgs(
  prompt: string,
  options: InvokeOptions | undefined,
  defaultModel: string,
): string[] {
  const args = [...CLAUDE_BASE_ARGS];
  if (options?.sessionId) {
    args.push(CLAUDE_RESUME_FLAG, options.sessionId);
  }
  const model = options?.model ?? defaultModel;
  if (model) {
    args.push(CLAUDE_MODEL_FLAG, model);
  }
  // Claude Code 支持原生 system prompt 注入（injectsL0Natively=true）。
  if (options?.systemPrompt) {
    args.push(CLAUDE_SYSTEM_PROMPT_FLAG, options.systemPrompt);
  }
  const mcpConfig = options?.callbackEnv?.[MCP_CONFIG_ENV_KEY];
  if (mcpConfig) {
    args.push(CLAUDE_MCP_CONFIG_FLAG, mcpConfig);
  }
  // prompt 作为末位位置参数；附加多模态文本说明。
  args.push(`${prompt}${describeContentBlocks(options?.contentBlocks)}`);
  return args;
}

export class ClaudeAgentService implements AgentService {
  private readonly agentId: AgentId;
  private readonly command: string;
  private readonly defaultModel: string;
  private readonly defaultTimeoutMs: number;
  private readonly now: () => number;

  constructor(deps: ClaudeServiceDeps) {
    this.agentId = deps.agentId;
    this.command = deps.command ?? CLAUDE_CLI_COMMAND;
    this.defaultModel = deps.defaultModel ?? CLAUDE_DEFAULT_MODEL;
    this.defaultTimeoutMs = deps.defaultTimeoutMs ?? CLAUDE_DEFAULT_TIMEOUT_MS;
    this.now = deps.now ?? Date.now;
  }

  /** Claude Code 支持把 system prompt 作为原生参数注入 */
  injectsL0Natively(): boolean {
    return true;
  }

  async *invoke(
    prompt: string,
    options?: InvokeOptions,
  ): AsyncIterable<AgentMessage> {
    const model = options?.model ?? this.defaultModel;
    const args = buildArgs(prompt, options, this.defaultModel);
    const { lines, exit } = spawnCliLineStream({
      command: this.command,
      args,
      cwd: options?.workingDirectory,
      env: options?.callbackEnv,
      timeoutMs: options?.timeoutMs ?? this.defaultTimeoutMs,
      signal: options?.signal,
    });

    let state: ParserState = createClaudeParserState();
    const deps = { agentId: this.agentId, now: this.now, model };

    for await (const line of lines) {
      const result = parseClaudeLine(line, state, deps);
      state = result.state;
      for (const msg of result.messages) {
        yield msg;
      }
    }

    const info = await exit;
    yield* finalizeStream(info, {
      agentId: this.agentId,
      provider: CLAUDE_PROVIDER,
      model,
      now: this.now,
    });
  }
}

/** 进程收尾参数 */
interface FinalizeDeps {
  readonly agentId: AgentId;
  readonly provider: string;
  readonly model: string;
  readonly now: () => number;
}

/** 进程收尾：按退出原因 yield error（异常）或 done（正常）。三 service 共用。 */
export function* finalizeStream(
  info: CliExitInfo,
  deps: FinalizeDeps,
): Generator<AgentMessage> {
  const base = {
    agentId: deps.agentId,
    timestamp: deps.now(),
    metadata: { provider: deps.provider, model: deps.model },
  } as const;
  const label = deps.provider;

  switch (info.reason) {
    case 'timeout':
      yield { ...base, type: 'error', content: `${label} cli timed out`, errorCode: 'timeout' };
      return;
    case 'aborted':
      yield { ...base, type: 'error', content: `${label} cli aborted`, errorCode: 'aborted' };
      return;
    case 'spawn_error': {
      const detail = info.spawnError?.message ?? 'spawn failed';
      yield {
        ...base,
        type: 'error',
        content: `${label} cli spawn error: ${detail}`,
        errorCode: 'spawn_error',
      };
      return;
    }
    case 'exit':
      if (info.code !== 0 && info.code !== null) {
        const detail = info.stderr.trim() || `exit code ${info.code}`;
        yield { ...base, type: 'error', content: detail, errorCode: `exit_${info.code}` };
        return;
      }
      yield { ...base, type: 'done', isFinal: true };
      return;
  }
}
