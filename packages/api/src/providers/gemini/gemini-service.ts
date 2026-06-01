// packages/api/src/providers/gemini/gemini-service.ts
// M2: GeminiAgentService —— spawn 真实 `gemini` CLI，逐行喂 parser，yield AgentMessage
//
// 设计来源：extraction §2.2（gemini --output-format stream-json；session resume = --resume）
// + design §5.1。从设计写 WHAT，不复制源码。

import type { AgentId, AgentMessage } from '@clowder/shared';
import type { AgentService, InvokeOptions, MessageContent } from '../base.js';
import { spawnCliLineStream } from '../cli-spawn.js';
import { finalizeStream } from '../claude/claude-service.js';
import {
  createGeminiParserState,
  parseGeminiLine,
  GEMINI_PROVIDER,
  type GeminiParserState,
} from './gemini-parser.js';

// ── CLI 接入常量（来源：extraction §2.2「Gemini 集成」） ──
const GEMINI_CLI_COMMAND = 'gemini';
/** 非交互自动批准 + stream-json 输出，来源 extraction §2.2（--yolo + --output-format stream-json） */
const GEMINI_BASE_ARGS: readonly string[] = ['--yolo', '--output-format', 'stream-json'];
/** model 选择 flag，来源 extraction §2.2 */
const GEMINI_MODEL_FLAG = '--model';
/** session resume flag，来源 extraction §2.2（--resume <id>） */
const GEMINI_RESUME_FLAG = '--resume';
/** prompt flag（非交互模式以 -p/--prompt 传入），来源 Gemini CLI 非交互约定 */
const GEMINI_PROMPT_FLAG = '--prompt';
/** MCP 配置注入 flag，来源 补充 §C3（--config 注入） */
const GEMINI_CONFIG_FLAG = '--config';
/** 默认进程超时：10 分钟。来源：coding agent 长任务经验默认，可被 options 覆盖 */
const GEMINI_DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
/** 默认模型；来源：Gemini CLI 默认旗舰模型，可被 options.model 覆盖 */
const GEMINI_DEFAULT_MODEL = 'gemini-2.5-pro';
/** callbackEnv 中携带 MCP 配置 JSON 的约定 key（来源：补充 §C3） */
const MCP_CONFIG_ENV_KEY = 'MCP_CONFIG_JSON';

export interface GeminiServiceDeps {
  readonly agentId: AgentId;
  readonly command?: string;
  readonly defaultModel?: string;
  readonly defaultTimeoutMs?: number;
  readonly now?: () => number;
}

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
  const args: string[] = [];
  const model = options?.model ?? defaultModel;
  if (model) {
    args.push(GEMINI_MODEL_FLAG, model);
  }
  args.push(...GEMINI_BASE_ARGS);
  if (options?.sessionId) {
    args.push(GEMINI_RESUME_FLAG, options.sessionId);
  }
  const mcpConfig = options?.callbackEnv?.[MCP_CONFIG_ENV_KEY];
  if (mcpConfig) {
    args.push(GEMINI_CONFIG_FLAG, mcpConfig);
  }
  // Gemini 无原生 system prompt 注入（injectsL0Natively=false）：前置拼入 prompt。
  const withSystem = options?.systemPrompt
    ? `${options.systemPrompt}\n\n${prompt}`
    : prompt;
  const effectivePrompt = appendContentText(withSystem, options?.contentBlocks);
  args.push(GEMINI_PROMPT_FLAG, effectivePrompt);
  return args;
}

export class GeminiAgentService implements AgentService {
  private readonly agentId: AgentId;
  private readonly command: string;
  private readonly defaultModel: string;
  private readonly defaultTimeoutMs: number;
  private readonly now: () => number;

  constructor(deps: GeminiServiceDeps) {
    this.agentId = deps.agentId;
    this.command = deps.command ?? GEMINI_CLI_COMMAND;
    this.defaultModel = deps.defaultModel ?? GEMINI_DEFAULT_MODEL;
    this.defaultTimeoutMs = deps.defaultTimeoutMs ?? GEMINI_DEFAULT_TIMEOUT_MS;
    this.now = deps.now ?? Date.now;
  }

  /** Gemini CLI 不暴露原生 system prompt 文件注入；由上层拼入 prompt */
  injectsL0Natively(): boolean {
    return false;
  }

  /** 本 provider spawn 的 CLI 可执行文件名（供启动期可用性探测，§A）。 */
  cliCommand(): string {
    return this.command;
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

    let state: GeminiParserState = createGeminiParserState();
    const deps = { agentId: this.agentId, now: this.now, model };

    for await (const line of lines) {
      const result = parseGeminiLine(line, state, deps);
      state = result.state;
      for (const msg of result.messages) {
        yield msg;
      }
    }

    const info = await exit;
    yield* finalizeStream(info, {
      agentId: this.agentId,
      provider: GEMINI_PROVIDER,
      model,
      now: this.now,
    });
  }
}
