// M8 callback-auth — authenticate MCP→API callbacks.
//
// Source: clowder-design-supplement.md §C1 ("MCP 回调... API server 用
// invocationId + callbackToken 鉴权") + §C3 (MCP run model). The MCP server
// sends two headers; we verify them against the M3 InvocationRegistry.
//
//   X-Invocation-Id   the invocation this callback belongs to
//   X-Callback-Token  the secret minted at invocation create()
//
// verify() returns the four M3 failure classes; any failure → 401. On success
// the live InvocationRecord is returned so handlers know the (threadId, agentId,
// userId) the callback acts on. Pure verification helper + a Fastify preHandler.

import type {
  FastifyReply,
  FastifyRequest,
  preHandlerHookHandler,
} from 'fastify';
import type { InvocationRecord, VerifyResult } from '@choco/shared';
import type { InvocationRegistry } from '@choco/api/invocation/invocation-registry';

/** Canonical header names the MCP server must send (lowercased by Fastify). */
export const INVOCATION_ID_HEADER = 'x-invocation-id';
export const CALLBACK_TOKEN_HEADER = 'x-callback-token';

/** Outcome of a callback auth attempt (discriminated on `ok`). */
export type CallbackAuthResult =
  | { readonly ok: true; readonly record: InvocationRecord }
  | { readonly ok: false; readonly status: 401; readonly reason: string };

/**
 * Read a single header value, collapsing the string | string[] | undefined that
 * Fastify exposes into a single string (or undefined when absent/empty).
 */
function readHeader(
  headers: FastifyRequest['headers'],
  name: string,
): string | undefined {
  const raw = headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Verify a callback request's auth headers against the InvocationRegistry.
 * Missing headers and every {@link VerifyResult} failure map to a 401 with the
 * specific reason (so logs/clients can distinguish unknown/invalid/expired/stale).
 */
export function authenticateCallback(
  headers: FastifyRequest['headers'],
  registry: InvocationRegistry,
): CallbackAuthResult {
  const invocationId = readHeader(headers, INVOCATION_ID_HEADER);
  const callbackToken = readHeader(headers, CALLBACK_TOKEN_HEADER);

  if (invocationId === undefined || callbackToken === undefined) {
    return { ok: false, status: 401, reason: 'missing_credentials' };
  }

  const result: VerifyResult = registry.verify(invocationId, callbackToken);
  if (!result.ok) {
    return { ok: false, status: 401, reason: result.reason };
  }
  return { ok: true, record: result.record };
}

/**
 * Build a Fastify preHandler that enforces callback auth and, on success,
 * stashes the verified InvocationRecord on `request` for the route handler.
 * On failure it replies 401 and ends the request.
 */
export function buildCallbackAuthPreHandler(
  registry: InvocationRegistry,
): preHandlerHookHandler {
  return async function callbackAuthPreHandler(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const auth = authenticateCallback(request.headers, registry);
    if (!auth.ok) {
      await reply.code(auth.status).send({ error: 'unauthorized', reason: auth.reason });
      return;
    }
    setInvocationRecord(request, auth.record);
  };
}

/** Symbol-free request decoration key for the verified record. */
const INVOCATION_RECORD_KEY = 'chocoInvocationRecord';

interface RequestWithInvocation extends FastifyRequest {
  [INVOCATION_RECORD_KEY]?: InvocationRecord;
}

/** Attach the verified InvocationRecord to a request (set by the preHandler). */
export function setInvocationRecord(
  request: FastifyRequest,
  record: InvocationRecord,
): void {
  (request as RequestWithInvocation)[INVOCATION_RECORD_KEY] = record;
}

/** Read the verified InvocationRecord a successful preHandler attached. */
export function getInvocationRecord(
  request: FastifyRequest,
): InvocationRecord | undefined {
  return (request as RequestWithInvocation)[INVOCATION_RECORD_KEY];
}
