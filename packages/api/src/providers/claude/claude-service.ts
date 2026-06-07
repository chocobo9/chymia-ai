// packages/api/src/providers/claude/claude-service.ts
// M2: ClaudeAgentService —— spawn 真实 `claude` CLI，逐行喂 parser，yield AgentMessage
//
// 设计来源：clowder-architecture-design.md §5.1（AgentService）+ extraction §2.2
// （Claude Code spawn 参数 / stream-json / --resume / --system-prompt-file）。
// 从设计写 WHAT，不复制源码。

import type { AgentId, AgentMessage } from '@choco/shared';
import type { AgentService, InvokeOptions, MessageContent } from '../base.js';
import { spawnCliLineStream, type CliExitInfo } from '../cli-spawn.js';
import {
  createClaudeParserState,
  parseClaudeLine,
  isMalformedFormAState,
  CLAUDE_PROVIDER,
  type ParserState,
} from './claude-parser.js';

// ── CLI 接入常量（来源：extraction §2.2「Claude Code 集成」） ──
/** 可执行文件名（PATH 解析）；可被 deps 覆盖以便测试/自定义路径 */
const CLAUDE_CLI_COMMAND = 'claude';
/**
 * 固定 spawn 参数。来源 extraction §2.2：
 * -p（print/非交互）、--output-format stream-json、--include-partial-messages（增量 text_delta）、--verbose。
 * permission mode 单独可注入（见 CLAUDE_PERMISSION_MODE_FLAG / ClaudeServiceDeps.permissionMode）。
 */
const CLAUDE_BASE_ARGS: readonly string[] = [
  '-p',
  '--output-format',
  'stream-json',
  '--include-partial-messages',
  '--verbose',
];
/** permission mode flag，来源 extraction §2.2（原固定 bypassPermissions，现可注入） */
export const CLAUDE_PERMISSION_MODE_FLAG = '--permission-mode';
/**
 * 合法 permission mode 全集 —— **从真实 `claude --help` 校验固定**，不凭记忆。
 * source: `claude --help` `--permission-mode <mode>` (choices: "acceptEdits",
 * "auto", "bypassPermissions", "default", "dontAsk", "plan")，已在
 * `.harness/permmode-dev-help.txt` 验证（实际 CLI 接受 6 个值，比常见的 4 个更宽）。
 * 这是「配置即数据」：唯一可信来源是这条导出的 readonly 元组，不在代码各处硬编码字面量。
 */
export const PERMISSION_MODES = [
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'default',
  'dontAsk',
  'plan',
] as const;

/** 合法 permission mode 的字面量联合类型（编译期守护字面量调用方）。 */
export type ClaudePermissionMode = (typeof PERMISSION_MODES)[number];

/**
 * 运行期 fail-fast 校验：来自 config/env 的 `string` 值在喂给 CLI 前必须落在合法全集内。
 * **不 trim、不强转** —— 空串 ''、纯空白、未知值一律抛错（`?? DEFAULT` 只兜 undefined/null，
 * 不兜 ''）。错误信息点名坏值 + 全部合法值，便于排障。
 * 用 asserts 签名，校验通过后调用点的 `string` 自动收窄为 ClaudePermissionMode。
 */
export function assertValidPermissionMode(
  value: string,
): asserts value is ClaudePermissionMode {
  if (!(PERMISSION_MODES as readonly string[]).includes(value)) {
    throw new Error(
      `Invalid Claude permission mode ${JSON.stringify(value)}; ` +
        `allowed values: ${PERMISSION_MODES.join(', ')}`,
    );
  }
}

/**
 * 默认 permission mode。历史默认 'bypassPermissions'（非交互自动批准所有工具）；现做成
 * 可注入（ClaudeServiceDeps.permissionMode），受控/沙箱场景可改用 'default' / 'plan' 等
 * 不自动批准工具的安全模式。默认保持 'bypassPermissions' 以不改变既有行为。
 */
export const CLAUDE_DEFAULT_PERMISSION_MODE: ClaudePermissionMode = 'bypassPermissions';
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
/**
 * callbackEnv 中携带 MCP 配置 JSON（或 win32 下的配置文件路径）的约定 key
 * （来源：补充 §C3 MCP 运行模型）。导出供 M8 app-factory 的 producer 复用——
 * 唯一可信来源是这一处，绝不在多处复制该字面量（CLAUDE.md §2.1）。
 */
export const MCP_CONFIG_ENV_KEY = 'MCP_CONFIG_JSON';

/** 构造参数：注入 agentId 与可选覆盖 */
export interface ClaudeServiceDeps {
  readonly agentId: AgentId;
  /** 覆盖可执行文件路径（默认 'claude'） */
  readonly command?: string;
  /** 覆盖默认模型 */
  readonly defaultModel?: string;
  /** 默认超时（ms），可被 InvokeOptions.timeoutMs 覆盖 */
  readonly defaultTimeoutMs?: number;
  /**
   * 覆盖 permission mode（默认 'bypassPermissions'；受控/沙箱场景可设 'default' / 'plan' 等不自动批准工具的模式）。
   * 类型收紧为 ClaudePermissionMode：字面量调用方编译期即被守护；config/env 来源的 `string`
   * 仍在 buildArgs/constructor 经 assertValidPermissionMode 运行期兜底。
   */
  readonly permissionMode?: ClaudePermissionMode;
  /** 时间源（测试确定性） */
  readonly now?: () => number;
  /**
   * 注入 spawn 实现（默认真实 {@link spawnCliLineStream}）。测试用 fake 控制
   * lines/exit/kill，以验证 done 时机（逻辑回合结束即收尾，不干等进程退出）。
   */
  readonly spawn?: typeof spawnCliLineStream;
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

/**
 * 构造 `claude` CLI 参数数组（纯函数，导出供单测断言 permission-mode / resume / model 注入）。
 * permissionMode 由调用方传入（service 已应用默认 'bypassPermissions' 或注入覆盖值）。
 */
export function buildArgs(
  prompt: string,
  options: InvokeOptions | undefined,
  defaultModel: string,
  permissionMode: string,
): string[] {
  // 选点校验：buildArgs 是唯一真正 emit `--permission-mode` 的地方，所有构参路径
  // （含直接调用方/测试）都过这里，因此这是 fail-fast 的「保证点」。typo（如 'plna'）/
  // 空串在这里被拦下，绝不静默落到 CLI 而被默默降级、关掉本意的沙箱。
  assertValidPermissionMode(permissionMode);
  const args = [...CLAUDE_BASE_ARGS];
  // `--mcp-config <configs...>` 是 VARIADIC（贪婪吞掉其后所有非 flag 参数，已用真实
  // claude 2.1.159 验证）。必须紧跟一个以 '-' 开头的 flag 来终止它，否则末位的位置参数
  // prompt 会被当成第二个 config 路径吞掉。下方 --permission-mode 无条件 push 且以 '-'
  // 开头，正好终止 variadic；prompt 仍安全地留在末位。因此 mcp-config 必须先于它。
  const mcpConfig = options?.callbackEnv?.[MCP_CONFIG_ENV_KEY];
  if (mcpConfig) {
    args.push(CLAUDE_MCP_CONFIG_FLAG, mcpConfig);
  }
  args.push(CLAUDE_PERMISSION_MODE_FLAG, permissionMode);
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
  // prompt 作为末位位置参数；附加多模态文本说明。
  args.push(`${prompt}${describeContentBlocks(options?.contentBlocks)}`);
  return args;
}

export class ClaudeAgentService implements AgentService {
  private readonly agentId: AgentId;
  private readonly command: string;
  private readonly defaultModel: string;
  private readonly defaultTimeoutMs: number;
  private readonly permissionMode: string;
  private readonly now: () => number;
  private readonly spawnStream: typeof spawnCliLineStream;

  constructor(deps: ClaudeServiceDeps) {
    this.agentId = deps.agentId;
    this.command = deps.command ?? CLAUDE_CLI_COMMAND;
    this.defaultModel = deps.defaultModel ?? CLAUDE_DEFAULT_MODEL;
    this.defaultTimeoutMs = deps.defaultTimeoutMs ?? CLAUDE_DEFAULT_TIMEOUT_MS;
    const permissionMode = deps.permissionMode ?? CLAUDE_DEFAULT_PERMISSION_MODE;
    // 构造期也校验：misconfig 在 service 创建时即失败（更友好），不必等到 invoke。
    // buildArgs 内的校验仍是最终保证（覆盖绕过 constructor 的直接调用方）。
    assertValidPermissionMode(permissionMode);
    this.permissionMode = permissionMode;
    this.now = deps.now ?? Date.now;
    this.spawnStream = deps.spawn ?? spawnCliLineStream;
  }

  /** Claude Code 支持把 system prompt 作为原生参数注入 */
  injectsL0Natively(): boolean {
    return true;
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
    const args = buildArgs(prompt, options, this.defaultModel, this.permissionMode);
    const { lines, exit, kill } = this.spawnStream({
      command: this.command,
      args,
      cwd: options?.workingDirectory,
      env: options?.callbackEnv,
      timeoutMs: options?.timeoutMs ?? this.defaultTimeoutMs,
      signal: options?.signal,
    });

    let state: ParserState = createClaudeParserState();
    const deps = { agentId: this.agentId, now: this.now, model };

    let sawDone = false;
    for await (const line of lines) {
      const result = parseClaudeLine(line, state, deps);
      state = result.state;
      for (const msg of result.messages) {
        if (msg.type === 'done') {
          // F215 AC-B1: form A malformed tool-call 检测——在 done 之前 emit detected 信号 +
          // 显式 error（对齐 Clowder），供 invoke 层 suppress+seal+fresh-retry、route 层接力。
          if (isMalformedFormAState(state)) {
            yield this.makeMalformedDetected(state);
            yield this.makeMalformedError(state);
          }
          yield msg;
          sawDone = true;
        } else {
          yield msg;
        }
      }
      // result/success → 本轮逻辑回合结束。立即停止消费 stdout，不让 `for await` 在
      // cli-spawn 的 `await waitForClose()` 上干等进程关闭（claude 的 MCP 子进程收尾慢）。
      if (sawDone) {
        break;
      }
    }

    if (sawDone) {
      // 逻辑回复已完整产出（done 已 yield）。提前回收进程：SIGTERM + 让 exit 在后台
      // resolve 收尾（清理定时器/监听），不在关键路径 await——这样上游 SessionMutex 立刻
      // 释放、route-serial 立刻接力下一个 agent（修「@all 只有第一个 agent 回」）。
      kill();
      void exit;
      return;
    }

    // 流在没有 result/success 的情况下结束（崩溃 / abort / 非零退出）→ 用退出信息收尾，
    // 由 finalizeStream 区分 error（异常退出）与 done（干净退出但无 result，少见）。
    const info = await exit;
    yield* finalizeStream(info, {
      agentId: this.agentId,
      provider: CLAUDE_PROVIDER,
      model,
      now: this.now,
    });
  }

  /**
   * F215 AC-B1: form A 检测信号（内部 system_info）。invoke 层 suppress 掉它（不给用户），
   * 据此触发 seal + fresh-context 重试；耗尽后 route 层接力到备用模型。
   */
  private makeMalformedDetected(state: ParserState): AgentMessage {
    return {
      type: 'system_info',
      agentId: this.agentId,
      content: JSON.stringify({
        type: 'malformed_toolcall_detected',
        form: 'A',
        ...(state.sessionId ? { sessionId: state.sessionId } : {}),
      }),
      timestamp: this.now(),
      metadata: { provider: CLAUDE_PROVIDER, model: state.model ?? this.defaultModel },
    };
  }

  /**
   * F215 AC-D1: 显式 malformed error（非静默空返回）。errorCode='malformed_toolcall' 供 invoke
   * 层识别并 suppress + 进入 fresh-retry / 接力链。
   */
  private makeMalformedError(state: ParserState): AgentMessage {
    return {
      type: 'error',
      agentId: this.agentId,
      content:
        'malformed_toolcall: Claude 输出无效（仅 thinking，无 text 或工具调用），系统将触发恢复流程',
      errorCode: 'malformed_toolcall',
      timestamp: this.now(),
      metadata: { provider: CLAUDE_PROVIDER, model: state.model ?? this.defaultModel },
    };
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
