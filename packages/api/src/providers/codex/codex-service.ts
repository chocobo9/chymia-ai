// packages/api/src/providers/codex/codex-service.ts
// M2: CodexAgentService —— spawn 真实 `codex` CLI，逐行喂 parser，yield AgentMessage
//
// 设计来源：extraction §2.2（codex exec --json；session resume = experimental-resume）
// + design §5.1。从设计写 WHAT，不复制源码。

import type { AgentId, AgentMessage } from '@clowder/shared';
import type { AgentService, InvokeOptions, MessageContent } from '../base.js';
import { spawnCliLineStream } from '../cli-spawn.js';
import { finalizeStream } from '../claude/claude-service.js';
import {
  createCodexParserState,
  parseCodexLine,
  CODEX_PROVIDER,
  type CodexParserState,
} from './codex-parser.js';

// ── CLI 接入常量（来源：extraction §2.2「Codex 集成」） ──
const CODEX_CLI_COMMAND = 'codex';
/** 固定子命令 + JSON 输出，来源 extraction §2.2（codex exec --json） */
const CODEX_BASE_ARGS: readonly string[] = ['exec', '--json'];
/** session resume 子命令，来源 extraction §2.2（experimental-resume <id>） */
const CODEX_RESUME_SUBCOMMAND = 'experimental-resume';
/** MCP 配置注入 flag，来源 补充 §C3（--config 注入） */
const CODEX_CONFIG_FLAG = '--config';
/** model 选择 flag */
const CODEX_MODEL_FLAG = '--model';
/** 默认进程超时：10 分钟。来源：coding agent 长任务经验默认，可被 options 覆盖 */
const CODEX_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
/** 默认模型占位（codex 用账户默认时留空），可被 options.model 覆盖 */
const CODEX_DEFAULT_MODEL = '';
/** callbackEnv 中携带 MCP 配置 JSON 的约定 key（来源：补充 §C3） */
const MCP_CONFIG_ENV_KEY = 'MCP_CONFIG_JSON';

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

function buildArgs(
  prompt: string,
  options: InvokeOptions | undefined,
  defaultModel: string,
): string[] {
  const args = [...CODEX_BASE_ARGS];
  if (options?.sessionId) {
    args.push(CODEX_RESUME_SUBCOMMAND, options.sessionId);
  }
  const model = options?.model ?? defaultModel;
  if (model) {
    args.push(CODEX_MODEL_FLAG, model);
  }
  const mcpConfig = options?.callbackEnv?.[MCP_CONFIG_ENV_KEY];
  if (mcpConfig) {
    args.push(CODEX_CONFIG_FLAG, mcpConfig);
  }
  // Codex 无原生 system prompt 注入（injectsL0Natively=false）：前置拼入 prompt。
  const withSystem = options?.systemPrompt
    ? `${options.systemPrompt}\n\n${prompt}`
    : prompt;
  const effectivePrompt = appendContentText(withSystem, options?.contentBlocks);
  // Codex `exec` 接受 prompt 作为末位位置参数。
  args.push(effectivePrompt);
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

  /** Codex 不支持原生 system prompt 文件注入；由上层拼入 prompt */
  injectsL0Natively(): boolean {
    return false;
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
