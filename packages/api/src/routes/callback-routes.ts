// M8 callback-routes — the MCP→API seam (the boundary M10 calls).
//
// Source: clowder-design-supplement.md §C1 (callback endpoints) + §C3 (MCP run
// model: MCP server receives a tool call → HTTP POST to these endpoints → API
// authenticates with invocationId + callbackToken → executes → returns result),
// arch §5.7 (tool params) + 补充 E E3.5 (session callbacks map to ISessionStore).
//
//   POST /api/callback/evidence_search     → search shared evidence
//   POST /api/callback/evidence_upsert      → write one evidence item (M6 upsert)
//   POST /api/callback/post_message         → agent posts a message (A2A); may fan
//                                             the post out to targetAgents via M4
//   POST /api/callback/read_file            → read a project file (sandboxed)
//   POST /api/callback/search_files         → content-search project files (sandboxed)
//   POST /api/callback/list_session_chain   → the authed thread's session chain
//   POST /api/callback/read_session_digest  → a session's digest (thread-owned)
//   POST /api/callback/read_session_events  → a session's transcript (thread-owned)
//   POST /api/callback/sop_advance_stage    → agent proposes its thread's next SOP stage
//
// Every callback is gated by buildCallbackAuthPreHandler (X-Invocation-Id +
// X-Callback-Token → M3 InvocationRegistry.verify; any failure → 401). On
// success the verified InvocationRecord (threadId / agentId / userId) is read via
// getInvocationRecord — the callback acts on behalf of THAT invocation, so the
// body need not (and must not be trusted to) re-supply identity. Session reads are
// additionally scoped to the record's threadId: an agent may only read sessions
// that belong to its own thread (cross-thread reads → 404).

import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { resolvePathInRoot } from '@choco/api/infrastructure/path-sandbox';
import { z } from 'zod';
import type {
  AgentId,
  AgentMessage,
  EvidenceItem,
  EvidenceKind,
  EvidenceSearchMode,
  StoredMessage,
} from '@choco/shared';
import type { AppServices } from '@choco/api/infrastructure/app-services';
import {
  buildUnavailableNotice,
  noticeToAgentEvent,
} from '@choco/api/routing/unavailable-notice';
import {
  buildCallbackAuthPreHandler,
  getInvocationRecord,
} from '@choco/api/routes/callback-auth.js';
import { advanceStageWithEval } from '@choco/api/sop/advance-stage.js';

const EVIDENCE_KINDS = [
  'feature',
  'decision',
  'plan',
  'session',
  'lesson',
  'thread',
  'discussion',
  'research',
  'pack-knowledge',
] as const satisfies readonly EvidenceKind[];

const SEARCH_MODES = ['lexical', 'semantic', 'hybrid'] as const satisfies readonly EvidenceSearchMode[];

const EvidenceSearchBodySchema = z
  .object({
    query: z.string().min(1),
    mode: z.enum(SEARCH_MODES).optional(),
    kind: z.enum(EVIDENCE_KINDS).optional(),
    limit: z.coerce.number().int().positive().optional(),
  })
  .strict();

// arch §5.7 evidence_upsert params: { anchor, kind, title, summary }. status is
// NOT an agent-facing param (an agent writes "live" knowledge); we default it to
// 'active'. Identity is irrelevant to evidence (it is shared), so no record fields
// are consulted here beyond auth. `.strict()` rejects any smuggled extra field.
const EvidenceUpsertBodySchema = z
  .object({
    anchor: z.string().min(1),
    kind: z.enum(EVIDENCE_KINDS),
    title: z.string().min(1),
    summary: z.string().min(1),
  })
  .strict();

const PostMessageBodySchema = z
  .object({
    content: z.string().min(1),
    /** Optional client-supplied id used for idempotent dedup (M3 claimClientMessageId). */
    clientMessageId: z.string().min(1).optional(),
    /**
     * Optional A2A fan-out (arch §5.7 targetAgents?). When present, the posted
     * message is ROUTED to these agents via the M4 AgentRouter. This is routing,
     * not identity: the message author is still the verified record's agent.
     */
    targetAgents: z.array(z.string().min(1)).nonempty().optional(),
  })
  .strict();

const ReadFileBodySchema = z
  .object({
    /** Project-relative (or absolute, sandbox-checked) path to read. */
    path: z.string().min(1),
  })
  .strict();

// arch §5.7 search_files params: { query, path? }. `query` is the literal
// substring to find; `path` optionally scopes the search to a sub-directory of
// the sandbox root (still sandbox-checked — traversal/escape → 403).
const SearchFilesBodySchema = z
  .object({
    query: z.string().min(1),
    path: z.string().min(1).optional(),
  })
  .strict();

// list_session_chain takes NO body fields — threadId comes from the verified
// record (an agent lists ITS thread's chain; the body must not pick a thread).
// `.strict()` on an empty object rejects any smuggled threadId/identity.
const ListSessionChainBodySchema = z.object({}).strict();

// read_session_digest / read_session_events take only a sessionId; the thread the
// session must belong to comes from the verified record (ownership check below).
const SessionIdBodySchema = z
  .object({
    sessionId: z.string().min(1),
  })
  .strict();

// sop_advance_stage carries only the proposed stageId. The threadId it advances
// comes from the VERIFIED record (an agent advances ITS OWN thread's stage) — the
// body must not smuggle a threadId. `.strict()` rejects any extra field.
const SopAdvanceStageBodySchema = z
  .object({
    stageId: z.string().min(1),
  })
  .strict();

export interface CallbackRoutesOptions {
  /**
   * Filesystem root that read_file / search_files are sandboxed to. Paths
   * escaping this root are rejected (path-traversal guard). No hardcoded default
   * in source — the app-factory passes this from config/env (CLAUDE.md §2.1 no
   * hardcoded paths).
   */
  readonly fileRoot: string;
  /** Max bytes read_file will return (guards against reading huge files). */
  readonly maxFileBytes?: number;
  /** Max matching files search_files returns (bounds the result set). */
  readonly maxSearchFileMatches?: number;
  /** Max line snippets search_files returns per file. */
  readonly maxSnippetsPerFile?: number;
  /** Max bytes search_files reads from any single file before skipping it. */
  readonly maxSearchFileBytes?: number;
}

/** Default cap on read_file response size. */
const DEFAULT_MAX_FILE_BYTES = 256 * 1024; // 256 KiB
/** Default cap on the number of files search_files returns. */
const DEFAULT_MAX_SEARCH_FILE_MATCHES = 50;
/** Default cap on line snippets returned per matching file. */
const DEFAULT_MAX_SNIPPETS_PER_FILE = 20;
/** Default per-file byte cap for search_files (skip files larger than this). */
const DEFAULT_MAX_SEARCH_FILE_BYTES = 1024 * 1024; // 1 MiB
/** Hard cap on directory recursion depth (defence against pathological trees). */
const MAX_SEARCH_DEPTH = 12;

/** One file's content-search hits returned by search_files. */
interface SearchFileHit {
  /** Sandbox-relative path of the matching file (never the absolute path). */
  readonly path: string;
  /** Up to maxSnippetsPerFile matching lines (1-based line number + text). */
  readonly snippets: ReadonlyArray<{ readonly line: number; readonly text: string }>;
}

/**
 * Register the MCP callback routes on `app`. Each route runs the callback-auth
 * preHandler first; handlers read the verified InvocationRecord for identity.
 */
export function registerCallbackRoutes(
  app: FastifyInstance,
  services: AppServices,
  options: CallbackRoutesOptions,
): void {
  const {
    evidenceStore,
    messageStore,
    threadStore,
    socket,
    invocations,
    sessionStore,
    registry,
    sopService,
    now,
  } = services;
  const preHandler = buildCallbackAuthPreHandler(invocations);
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxSearchFileMatches = options.maxSearchFileMatches ?? DEFAULT_MAX_SEARCH_FILE_MATCHES;
  const maxSnippetsPerFile = options.maxSnippetsPerFile ?? DEFAULT_MAX_SNIPPETS_PER_FILE;
  const maxSearchFileBytes = options.maxSearchFileBytes ?? DEFAULT_MAX_SEARCH_FILE_BYTES;
  const fileRoot = resolve(options.fileRoot);

  app.post('/api/callback/evidence_search', { preHandler }, async (request, reply) => {
    const body = EvidenceSearchBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });
    }
    const { query, mode, kind, limit } = body.data;
    const result = evidenceStore.search(query, {
      ...(mode !== undefined ? { mode } : {}),
      ...(kind !== undefined ? { kind } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return reply.send(result);
  });

  app.post('/api/callback/evidence_upsert', { preHandler }, async (request, reply) => {
    const body = EvidenceUpsertBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });
    }
    const { anchor, kind, title, summary } = body.data;
    // Evidence is shared knowledge: the write does not depend on the caller's
    // identity (only that the caller is an authenticated invocation). An
    // agent-authored write is 'active' (live) knowledge.
    const item: EvidenceItem = {
      anchor,
      kind,
      status: 'active',
      title,
      summary,
      updatedAt: new Date(now()).toISOString(),
    };
    evidenceStore.upsert(item);
    return reply.code(201).send({ anchor: item.anchor, upserted: true });
  });

  app.post('/api/callback/post_message', { preHandler }, async (request, reply) => {
    const record = getInvocationRecord(request);
    if (record === undefined) {
      // Defensive: preHandler guarantees this, but never trust the path implicitly.
      return reply.code(401).send({ error: 'unauthorized', reason: 'no_record' });
    }
    const body = PostMessageBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });
    }

    // targetAgents (when present) must all be known agents — validate BEFORE any
    // side effect so an unknown agent is a clean 400, not a half-applied post.
    const targetAgents = body.data.targetAgents;
    if (targetAgents !== undefined) {
      const unknown = targetAgents.filter((id) => registry.get(id as AgentId) === undefined);
      if (unknown.length > 0) {
        return reply.code(400).send({ error: 'unknown_target_agents', agents: unknown });
      }
    }

    // Idempotency: a retried MCP call carrying the same clientMessageId is a no-op.
    if (body.data.clientMessageId !== undefined) {
      const fresh = invocations.claimClientMessageId(
        record.invocationId,
        body.data.clientMessageId,
      );
      if (!fresh) {
        return reply.code(200).send({ deduped: true });
      }
    }

    const stored = await messageStore.append({
      threadId: record.threadId,
      userId: record.userId,
      agentId: record.agentId,
      content: body.data.content,
      mentions: [],
      origin: 'callback',
      timestamp: now(),
    });

    // Surface the agent's callback message to the room as an agent_event.
    const event: AgentMessage = {
      type: 'text',
      agentId: record.agentId,
      content: body.data.content,
      invocationId: record.invocationId,
      timestamp: stored.timestamp,
    };
    await socket.broadcastAgentEvent(record.threadId, event);
    await threadStore.updateLastActive(record.threadId);

    // A2A fan-out: route the posted content to the named targets through the same
    // M4 AgentRouter seam message-routes uses, then broadcast + persist replies.
    let routedReplies: StoredMessage[] = [];
    if (targetAgents !== undefined) {
      routedReplies = await routeToTargets(services, {
        threadId: record.threadId,
        userId: record.userId,
        content: body.data.content,
        targets: targetAgents.map((id) => id as AgentId),
      });
    }

    return reply.code(201).send({
      messageId: stored.id,
      ...(targetAgents !== undefined ? { routedReplies } : {}),
    });
  });

  app.post('/api/callback/read_file', { preHandler }, async (request, reply) => {
    const body = ReadFileBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });
    }

    const resolved = resolvePathInRoot(fileRoot, body.data.path);
    if (resolved === null) {
      // Path traversal attempt or absolute path escaping the sandbox.
      return reply.code(403).send({ error: 'path_outside_root' });
    }

    try {
      const buffer = await readFile(resolved);
      if (buffer.byteLength > maxFileBytes) {
        return reply.code(413).send({ error: 'file_too_large', maxBytes: maxFileBytes });
      }
      return reply.send({ path: body.data.path, content: buffer.toString('utf8') });
    } catch {
      // ENOENT / EACCES / etc. — do not leak the absolute path or errno detail.
      return reply.code(404).send({ error: 'file_not_found' });
    }
  });

  app.post('/api/callback/search_files', { preHandler }, async (request, reply) => {
    const body = SearchFilesBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });
    }

    // The search root is fileRoot, optionally narrowed to a sandboxed sub-path —
    // same traversal discipline as read_file (escape → 403).
    const searchRoot =
      body.data.path === undefined
        ? fileRoot
        : resolvePathInRoot(fileRoot, body.data.path);
    if (searchRoot === null) {
      return reply.code(403).send({ error: 'path_outside_root' });
    }

    const matches = await searchContent(searchRoot, fileRoot, body.data.query, {
      maxFiles: maxSearchFileMatches,
      maxSnippetsPerFile,
      maxFileBytes: maxSearchFileBytes,
    });
    return reply.send({ query: body.data.query, matches });
  });

  app.post('/api/callback/list_session_chain', { preHandler }, async (request, reply) => {
    const record = getInvocationRecord(request);
    if (record === undefined) {
      return reply.code(401).send({ error: 'unauthorized', reason: 'no_record' });
    }
    const body = ListSessionChainBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });
    }
    // threadId comes from the verified record — an agent lists ITS thread's chain.
    const sessions = sessionStore.listByThread(record.threadId);
    return reply.send({ sessions });
  });

  app.post('/api/callback/read_session_digest', { preHandler }, async (request, reply) => {
    const record = getInvocationRecord(request);
    if (record === undefined) {
      return reply.code(401).send({ error: 'unauthorized', reason: 'no_record' });
    }
    const body = SessionIdBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });
    }
    // Ownership: the session must belong to the record's thread (no cross-thread read).
    const session = sessionStore.getSession(body.data.sessionId);
    if (session === null || session.threadId !== record.threadId) {
      return reply.code(404).send({ error: 'session_not_found' });
    }
    const digest = await sessionStore.getDigest(body.data.sessionId);
    if (digest === null) {
      return reply.code(404).send({ error: 'session_not_found' });
    }
    return reply.send({ sessionId: body.data.sessionId, digest });
  });

  app.post('/api/callback/read_session_events', { preHandler }, async (request, reply) => {
    const record = getInvocationRecord(request);
    if (record === undefined) {
      return reply.code(401).send({ error: 'unauthorized', reason: 'no_record' });
    }
    const body = SessionIdBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });
    }
    // Ownership: same cross-thread guard as read_session_digest.
    const session = sessionStore.getSession(body.data.sessionId);
    if (session === null || session.threadId !== record.threadId) {
      return reply.code(404).send({ error: 'session_not_found' });
    }
    const events = await sessionStore.getTranscript(body.data.sessionId);
    return reply.send({ sessionId: body.data.sessionId, events });
  });

  app.post('/api/callback/sop_advance_stage', { preHandler }, async (request, reply) => {
    const record = getInvocationRecord(request);
    if (record === undefined) {
      return reply.code(401).send({ error: 'unauthorized', reason: 'no_record' });
    }
    const body = SopAdvanceStageBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });
    }
    // The stage must exist in the SOP definition; an unknown stage is a clean 400.
    if (!sopService.hasStage(body.data.stageId)) {
      return reply.code(400).send({ error: 'unknown_sop_stage', stageId: body.data.stageId });
    }
    // Identity is non-spoofable: the thread advanced is the VERIFIED record's
    // thread, never a body-supplied one. Effect surfaces on this thread's NEXT
    // invocation's SOP hint (告示牌, not a gate).
    //
    // SOP-Cycle-2: route through the shared advance helper (same as the PATCH
    // setter) so the OUTGOING stage is evaluated post-hoc and any violation
    // surfaces as an ADVISORY socket/log signal. The transition + this 200
    // response are unchanged — the eval is additive, advisory, and best-effort
    // (never throws). The advancing agent (record.agentId) is the trace's author.
    await advanceStageWithEval(services, record.threadId, body.data.stageId, record.agentId);
    return reply.send({ stageId: body.data.stageId });
  });
}

/** Options bounding a {@link searchContent} run. */
interface SearchContentOptions {
  readonly maxFiles: number;
  readonly maxSnippetsPerFile: number;
  readonly maxFileBytes: number;
}

/**
 * Bounded content search: walk `searchRoot` (which is inside `sandboxRoot`) and
 * return files whose content contains `query` (case-insensitive substring), with
 * up to maxSnippetsPerFile matching line snippets each. Paths in the result are
 * relative to `sandboxRoot` (never absolute). Depth- and count-bounded so a
 * pathological tree cannot blow up the request.
 */
async function searchContent(
  searchRoot: string,
  sandboxRoot: string,
  query: string,
  options: SearchContentOptions,
): Promise<SearchFileHit[]> {
  const needle = query.toLowerCase();
  const hits: SearchFileHit[] = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (hits.length >= options.maxFiles || depth > MAX_SEARCH_DEPTH) {
      return;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory — skip, never throw to the caller
    }
    for (const entry of entries) {
      if (hits.length >= options.maxFiles) {
        return;
      }
      const abs = join(dir, entry.name);
      // Defence in depth: never follow a symlink that resolves outside the sandbox.
      if (resolvePathInRoot(sandboxRoot, abs) === null) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(abs, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const snippets = await matchFile(abs, needle, options);
      if (snippets.length > 0) {
        hits.push({ path: relative(sandboxRoot, abs).split('\\').join('/'), snippets });
      }
    }
  };

  await walk(searchRoot, 0);
  return hits;
}

/** Scan one file for `needle`, returning up to maxSnippetsPerFile line matches. */
async function matchFile(
  abs: string,
  needle: string,
  options: SearchContentOptions,
): Promise<ReadonlyArray<{ readonly line: number; readonly text: string }>> {
  let size: number;
  try {
    size = (await stat(abs)).size;
  } catch {
    return [];
  }
  if (size > options.maxFileBytes) {
    return []; // too large to scan — skip rather than blow the budget
  }
  let content: string;
  try {
    content = (await readFile(abs)).toString('utf8');
  } catch {
    return [];
  }
  const snippets: Array<{ line: number; text: string }> = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (snippets.length >= options.maxSnippetsPerFile) {
      break;
    }
    const text = lines[i] ?? '';
    if (text.toLowerCase().includes(needle)) {
      snippets.push({ line: i + 1, text });
    }
  }
  return snippets;
}

/** Dependencies + arguments for {@link routeToTargets}. */
interface RouteToTargetsArgs {
  readonly threadId: string;
  readonly userId: string;
  readonly content: string;
  readonly targets: readonly AgentId[];
}

/**
 * Route `content` to the EXPLICIT, already-validated `targets` via the M4
 * AgentRouter's non-spoofable fan-out seam ({@link AgentRouter.routeExplicit}).
 *
 * Security: the targets are passed verbatim — the content is NOT mention-prefixed
 * and the router does NOT re-derive targets by parsing @mentions out of the
 * agent-supplied content. This prevents a content-injection / fan-out escalation
 * where an @mention embedded in `content` would widen the routed/invoked agent
 * set beyond the validated `targetAgents` (frozen contract: addressing is
 * non-spoofable). Each streamed event is broadcast to the thread room; each
 * agent's accumulated reply is persisted as a 'stream' StoredMessage (mirroring
 * message-routes), and the persisted replies are returned so the caller (and M10)
 * can see the fan-out result.
 */
async function routeToTargets(
  services: AppServices,
  args: RouteToTargetsArgs,
): Promise<StoredMessage[]> {
  const { router, registry, messageStore, threadStore, socket, now } = services;

  // §C: an A2A fan-out target whose CLI is unavailable is skipped by routeExplicit
  // (never spawn-failed). Surface a VISIBLE notice for it (Clowder `cat_disabled`
  // with alternatives) so the fan-out is not silently narrowed.
  const { available, unavailable } = router.partitionAvailability(args.targets);
  if (unavailable.length > 0) {
    const notice = buildUnavailableNotice({
      unavailable,
      alternatives: router.availableAlternatives([...unavailable, ...available]),
      resolve: (id) => registry.get(id),
    });
    if (notice !== undefined) {
      await socket.broadcastAgentEvent(args.threadId, noticeToAgentEvent(notice, now()));
    }
  }

  const controller = socket.registerCancel(args.threadId);
  const accumulators = new Map<AgentId, { text: string; lastTimestamp: number }>();
  try {
    for await (const event of router.routeExplicit(args.targets, args.content, args.threadId, {
      signal: controller.signal,
    })) {
      await socket.broadcastAgentEvent(args.threadId, event);
      const acc = accumulators.get(event.agentId) ?? { text: '', lastTimestamp: event.timestamp };
      acc.lastTimestamp = Math.max(acc.lastTimestamp, event.timestamp);
      if (event.type === 'text' && event.content !== undefined) {
        acc.text += event.content;
      }
      accumulators.set(event.agentId, acc);
    }
  } finally {
    socket.releaseCancelController(args.threadId, controller);
  }

  const persisted: StoredMessage[] = [];
  for (const [agentId, acc] of accumulators) {
    if (acc.text.length === 0) {
      continue; // nothing to persist for an agent that produced no text
    }
    const stored = await messageStore.append({
      threadId: args.threadId,
      userId: args.userId,
      agentId,
      content: acc.text,
      mentions: [],
      origin: 'stream',
      timestamp: acc.lastTimestamp,
    });
    persisted.push(stored);
  }
  await threadStore.updateLastActive(args.threadId);
  return persisted;
}
