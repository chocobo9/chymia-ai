// Inbound platform message mapping (WeChat / Telegram).
// Source: clowder-design-supplement.md §A10 (PlatformMapping) + §B4 (adapter buffering)
//         + clowder-architecture-design.md §5.8 (PlatformAdapter).

import type { AgentId } from './agent.js';

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

/**
 * PlatformAdapter — WeChat (M13) 与 Telegram (M14) 共同实现的唯一契约。
 *
 * 设计来源：clowder-architecture-design.md §5.8 (PlatformAdapter)。本接口对齐
 * 已 BUILT 的 {@link IncomingPlatformMessage}（M1 权威：text/receivedAt/adapterName/
 * channelId/platformUserId/platformMessageId），而非 §5.8 草案里的 content/timestamp。
 *
 * 生命周期：start() 注册 webhook（M13 公众号）或启动长轮询（M14 Telegram，§7.8）；
 * stop() 拆除；sendMessage() 把 agent 回复发回平台；onMessage() 注册入站回调
 * （adapter 收到平台消息 → 归一化为 IncomingPlatformMessage → 调用 handler，
 * handler 内部走 submitPlatformMessage 进入路由管线）。
 */
export interface PlatformAdapter {
  /** 适配器名称（与 IPlatformMappingStore 的 adapterName 一致，如 'wechat' | 'telegram'）。 */
  readonly name: string;
  /** 启动适配器（webhook 注册 / 长轮询等）。 */
  start(): Promise<void>;
  /** 停止适配器（释放轮询/监听资源）。 */
  stop(): Promise<void>;
  /**
   * 发送一条消息到平台会话。
   * @param channelId 平台侧会话/频道 ID（由 getChannelId 反解得到）。
   * @param content 文本内容。
   * @param agentId 可选——标注该回复来自哪个 agent（多 agent 时区分发送格式）。
   */
  sendMessage(channelId: string, content: string, agentId?: AgentId): Promise<void>;
  /**
   * 注册入站消息回调。adapter 收到并归一化平台消息后调用 handler。
   * handler 返回的 Promise resolve 表示该消息已被系统受理（已入路由管线）。
   */
  onMessage(handler: (message: IncomingPlatformMessage) => Promise<void>): void;
}

/**
 * PlatformMappingType — 平台映射记录的类型维度（§A10 表的 `type` 列）。
 * 'thread' = 平台会话 ↔ 内部 threadId；'user' = 平台用户 ↔ 内部 userId。
 */
export type PlatformMappingType = 'thread' | 'user';

/**
 * PlatformMappingRecord — `platform_mappings` 表一行的归一化记录。
 * Source: clowder-design-supplement.md §A10 表结构（adapter_name / platform_id /
 * internal_id / type / created_at）。复合主键 (adapterName, platformId, type)。
 */
export interface PlatformMappingRecord {
  /** 来源 adapter 名称。 */
  readonly adapterName: string;
  /** 平台侧 ID（channelId 或 platformUserId，按 type 区分语义）。 */
  readonly platformId: string;
  /** 解析出的内部 ID（threadId 或 userId）。 */
  readonly internalId: string;
  /** 映射类型。 */
  readonly type: PlatformMappingType;
  /** 创建时间 epoch ms。 */
  readonly createdAt: number;
}

/**
 * IPlatformMappingStore — 平台 ID ↔ 内部 ID 的双向解析存储 (A10)。
 *
 * Source: clowder-design-supplement.md §A10。resolveThread/resolveUser 为
 * find-or-create：首次见到的平台 channelId/userId 会被分配并持久化一个内部 ID，
 * 之后稳定复用（同一平台会话始终映射到同一 thread）。getChannelId 为反向查找，
 * 供 adapter 把内部 thread 的回复发回正确的平台会话。
 */
export interface IPlatformMappingStore {
  /**
   * 解析平台会话到内部 threadId（find-or-create）。
   * @returns 已存在或新建的内部 threadId。
   */
  resolveThread(adapterName: string, channelId: string): Promise<string>;
  /**
   * 解析平台用户到内部 userId（find-or-create）。
   * @returns 已存在或新建的内部 userId。
   */
  resolveUser(adapterName: string, platformUserId: string): Promise<string>;
  /**
   * 反向查找：内部 threadId → 平台 channelId。
   * @returns 映射存在时返回平台 channelId，否则 null。
   */
  getChannelId(adapterName: string, threadId: string): Promise<string | null>;
}
