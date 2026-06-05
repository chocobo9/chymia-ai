// Audit event-log types.
//
// 对齐 Clowder 的 EventAuditLog 模型（reference: packages/api/src/domains/cats/
// services/orchestration/EventAuditLog.ts + components/audit/AuditEventsTab.tsx）：
// 审计是引擎在生命周期时点 EMIT 的「真实事件追加日志」，不是每次请求从消息现推的
// 视图。每条事件是一条扁平记录：type 判别 + 自由 data 负载，UI 展开时显示 data。
//
// 与上一次重建的唯一区别在 audit-routes.ts：那次把派生逻辑删了导致老 thread 全空；
// 这次路由保留派生作为「事件日志为空时」的回退，新旧都不空。本文件本身不含回退逻辑。

/**
 * AuditEventType — 本项目实际 EMIT 的事件（Clowder 的全集更大；我们只列有生产者的）。
 * type 在存储里是开放字符串（Clowder 约定），新增生产者无需改 schema；此 union 仅
 * 文档化 + 类型守卫已知值。
 *
 * - invoked       一次 agent invocation 开始（CLI spawn 之前）
 * - responded     invocation 结束并产出
 * - error         invocation 结束且有错误
 * - session_seal  一个 session 被封存
 */
export type AuditEventType = 'invoked' | 'responded' | 'error' | 'session_seal';

/**
 * AuditEvent — 审计日志的一行。`data` 携带事件特定负载（如 invoked 的
 * `{ agentId, invocationId, mode }`），UI 展开该行时原样显示。`id` 是日志自身 id，
 * `timestamp` 为 epoch ms。回退派生出来的事件也用这个形状，`data.derived === true`。
 */
export interface AuditEvent {
  readonly id: string;
  /** 事件类型——{@link AuditEventType} 之一（开放字符串，向前兼容）。 */
  readonly type: string;
  /** 事件所属 thread（审计视图按 thread）。 */
  readonly threadId: string;
  readonly timestamp: number;
  /** 事件特定负载，展开行时原样显示。 */
  readonly data: Record<string, unknown>;
}

/**
 * {@link IEventAuditLog.append} 的入参——调用方给 type + thread + data；日志铸造 id、
 * 盖 timestamp（除非传入用于确定性测试）。
 */
export interface AuditEventInput {
  readonly type: string;
  readonly threadId: string;
  readonly data: Record<string, unknown>;
  /** 可选；省略时由日志用 now() 盖戳。 */
  readonly timestamp?: number;
}

/**
 * IEventAuditLog — 审计日志接口。`readByThread` 按 thread 返回事件，newest-first
 * （UI 显示最近的追踪）。
 */
export interface IEventAuditLog {
  append(input: AuditEventInput): Promise<AuditEvent>;
  readByThread(threadId: string, options?: { readonly limit?: number }): Promise<AuditEvent[]>;
}
