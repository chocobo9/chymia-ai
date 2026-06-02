// packages/api/src/providers/base.ts
// M2: AgentService 接口 + InvokeOptions（re-authored from design §5.1）
//
// 每个 CLI 适配器（Claude / Codex / Gemini）实现 AgentService：
//   - spawn 真实 CLI 进程（非 HTTP API）
//   - stdout 的 NDJSON/stream-json 逐行解析为统一 AgentMessage
//   - 通过 AsyncIterable<AgentMessage> 流式 yield
//
// 设计来源：clowder-architecture-design.md §5.1。

import type { AgentMessage } from '@choco/shared';

/**
 * 多模态内容块（图片等）。
 *
 * 偏差说明：design §5.1 的 InvokeOptions.contentBlocks 引用了 `MessageContent`，
 * 但 M1 frozen shared types 中并不存在该类型（grep 确认）。为不越界改动 M1，
 * 这里在 provider 层本地定义最小可用的多模态块类型；text 路径不依赖它，图片为可选扩展。
 */
export type MessageContent =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'image';
      /** base64 编码的图片数据 */
      readonly data: string;
      /** MIME 类型，如 'image/png' */
      readonly mediaType: string;
    };

/**
 * 单次 CLI 调用的可选项。
 * 所有可变行为（session resume / system prompt / 回调环境变量 / 工作目录 /
 * 取消信号 / 多模态内容 / 模型 / 超时）都通过此结构传入，provider 内部不硬编码这些值。
 */
export interface InvokeOptions {
  /** CLI session resume 标识；存在则以 --resume / experimental-resume 续接历史 */
  readonly sessionId?: string;
  /** 注入的 system prompt（identity + context） */
  readonly systemPrompt?: string;
  /** MCP 回调用环境变量（如 MCP_CONFIG_JSON / 鉴权变量），透传给子进程 env */
  readonly callbackEnv?: Record<string, string>;
  /** CLI 工作目录（通常为 thread.projectPath） */
  readonly workingDirectory?: string;
  /** 取消信号；abort 后 provider 必须 kill 子进程 */
  readonly signal?: AbortSignal;
  /** 多模态内容块（图片等） */
  readonly contentBlocks?: readonly MessageContent[];
  /** 覆盖默认模型（不传则用 provider 默认常量） */
  readonly model?: string;
  /**
   * 进程级超时（毫秒）。不传则用各 provider 的默认常量。
   * 超时后 provider kill 子进程并 yield 一条 error(timeout) 事件。
   */
  readonly timeoutMs?: number;
}

/**
 * Agent CLI 适配器统一接口。
 * 设计来源：clowder-architecture-design.md §5.1。
 */
export interface AgentService {
  /**
   * 调用 CLI agent，返回统一事件流。
   * 实现必须：spawn 真实 CLI、逐行解析 stdout、按序 yield AgentMessage、
   * 在进程退出/超时/abort 时收尾（kill 进程、yield 终止事件）。
   */
  invoke(prompt: string, options?: InvokeOptions): AsyncIterable<AgentMessage>;

  /**
   * 该 provider 是否支持 L0 原生注入（把 system prompt 作为 CLI 原生参数/文件传入，
   * 而非拼进 user prompt）。可选——未实现等价于 false。
   */
  injectsL0Natively?(): boolean;

  /**
   * 该 provider 启动 agent 所 spawn 的 CLI 可执行文件名（如 'claude' / 'codex' /
   * 'gemini'）。可选——供组合根（main.ts）在启动时探测该 CLI 是否安装，从而推导
   * agent 的可用性（available）。返回 undefined / 未实现 = 无法探测 ⇒ 视为可用
   * （fail-open，与注入 fake service 的测试一致）。
   */
  cliCommand?(): string | undefined;
}
