// Inbound platform message mapping (WeChat / Telegram).
// Source: clowder-design-supplement.md §A10 (PlatformMapping) + §B4 (adapter buffering).

/**
 * IncomingPlatformMessage — 从平台 adapter 进入系统的归一化入站消息。
 *
 * 设计来源说明：§A10 定义了 IPlatformMappingStore（adapterName + 平台侧 channelId /
 * userId → 内部 threadId / userId 的解析），并未给出独立的入站消息 DTO。本接口按 §A10
 * 的字段语义 + §B4 buffering 流程（adapter 收到平台消息后归一化再入队）重建一个最小、
 * 忠实的入站消息形状，供 M13/M14 adapter 调用 resolveThread/resolveUser 后承载文本。
 */
export interface IncomingPlatformMessage {
  /** 来源 adapter 名称（与 IPlatformMappingStore 的 adapterName 一致，如 'wechat' | 'telegram'） */
  readonly adapterName: string;
  /** 平台侧会话/频道 ID（传入 resolveThread） */
  readonly channelId: string;
  /** 平台侧用户 ID（传入 resolveUser） */
  readonly platformUserId: string;
  /** 平台侧消息 ID（去重/幂等用） */
  readonly platformMessageId: string;
  /** 消息文本 */
  readonly text: string;
  /** 接收时间 epoch ms */
  readonly receivedAt: number;
  /** 原始负载（保留平台原始字段，便于扩展/排错） */
  readonly raw?: Record<string, unknown>;
}
