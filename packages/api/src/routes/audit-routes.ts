// audit-routes — 浏览器侧的 per-thread 审计追踪（M8）。
//
// 对齐 Clowder：审计是引擎 EMIT 的事件日志（invoked/responded/error 在 invoke 缝、
// session_seal 在 seal 路由）。本路由读该日志。
//
// **与上一次重建的关键区别——也是上次炸掉的修复点：**
// 上次重建把派生逻辑整个删了，结果 9df7fb4 之前的老 thread（从没 emit 过事件）在新
// 模型下读出来全空，审计「消失」。本版保留派生作为回退：事件日志里该 thread 没有任何
// 事件时，回退到从消息/工具/session 现推（deriveAuditEvents），并在 data 里标 derived:true。
// 新 thread 走真实事件，老 thread 走派生——新旧都不空。
//
// 逐条 per-message/per-tool 的细节仍在 session transcript
// （GET /api/sessions/:id/transcript）；本路由是「谁在什么时候做了什么」。

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuditEvent } from '@choco/shared';
import type { AppServices } from '@choco/api/infrastructure/app-services';

const ThreadParamsSchema = z.object({ threadId: z.string().min(1) });

/** 事件日志读取上限（newest-first）。 */
const AUDIT_EVENT_LIMIT = 500;
/** 回退派生时扫描的消息上限（一个 thread 的历史很小）。 */
const AUDIT_MESSAGE_LIMIT = 2000;

/** 注册 GET /api/audit/thread/:threadId。 */
export function registerAuditRoutes(app: FastifyInstance, services: AppServices): void {
  const { eventAuditLog } = services;

  app.get('/api/audit/thread/:threadId', async (request, reply) => {
    const params = ThreadParamsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_params' });
    const threadId = params.data.threadId;

    // 1) 事件日志优先：新 thread 在这里拿到引擎 emit 的真实事件。
    const events: AuditEvent[] = await eventAuditLog.readByThread(threadId, {
      limit: AUDIT_EVENT_LIMIT,
    });
    if (events.length > 0) return reply.send({ events });

    // 2) 回退：事件日志里该 thread 没有事件 = 9df7fb4 之前的老 thread。从历史现推，
    //    映射成相同的 AuditEvent 形状（data.derived=true）。老 thread 不再变空。
    const derived = await deriveAuditEvents(services, threadId);
    return reply.send({ events: derived });
  });
}

/**
 * 从已持久化的数据现推审计事件——仅用于事件日志为空的老 thread 的回退。
 * 输出与事件日志同形（AuditEvent[]，newest-first），每条 data.derived=true 以示来源。
 * 这段就是 9df7fb4 派生逻辑的保留版，只是改成输出 AuditEvent 而非旧的 AuditEntry。
 */
async function deriveAuditEvents(services: AppServices, threadId: string): Promise<AuditEvent[]> {
  const { toolEventLog, messageStore, sessionStore } = services;

  const [toolEvents, messages] = await Promise.all([
    toolEventLog.readByThread(threadId),
    messageStore.getByThread(threadId, AUDIT_MESSAGE_LIMIT),
  ]);
  const sessions = sessionStore.listByThread(threadId);

  const out: AuditEvent[] = [];
  let i = 0;

  // agent 回合产出（用户消息跳过）。
  for (const message of messages) {
    if (message.agentId === null) continue;
    const rawToolEvents = message.extra?.['toolEvents'];
    const toolCount = Array.isArray(rawToolEvents) ? rawToolEvents.length : 0;
    out.push({
      id: `derived-msg-${message.timestamp}-${i++}`,
      type: message.origin === 'system' ? 'error' : 'responded',
      threadId,
      timestamp: message.timestamp,
      data: {
        agentId: message.agentId,
        textChars: message.content.length,
        toolCalls: toolCount,
        ...(message.content.length > 0 ? { text: message.content } : {}),
        derived: true,
      },
    });
  }

  // 工具调用。
  for (const event of toolEvents) {
    out.push({
      id: `derived-tool-${event.timestamp}-${i++}`,
      type: 'tool',
      threadId,
      timestamp: event.timestamp,
      data: {
        agentId: event.agentId,
        toolName: event.toolName,
        ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
        ...(event.toolInput !== undefined ? { toolInput: event.toolInput } : {}),
        ...(event.toolResult !== undefined ? { toolResult: event.toolResult } : {}),
        ...(event.invocationId !== undefined ? { invocationId: event.invocationId } : {}),
        derived: true,
      },
    });
  }

  // session 边界。
  for (const session of sessions) {
    out.push({
      id: `derived-sstart-${session.createdAt}-${i++}`,
      type: 'session_start',
      threadId,
      timestamp: session.createdAt,
      data: { sessionId: session.sessionId, agentId: session.agentId, sequenceNo: session.sequenceNo, derived: true },
    });
    if (session.sealedAt !== undefined) {
      out.push({
        id: `derived-sseal-${session.sealedAt}-${i++}`,
        type: 'session_seal',
        threadId,
        timestamp: session.sealedAt,
        data: { sessionId: session.sessionId, agentId: session.agentId, sequenceNo: session.sequenceNo, derived: true },
      });
    }
  }

  // newest-first，与事件日志返回顺序一致。
  out.sort((a, b) => b.timestamp - a.timestamp);
  return out;
}
