// workspace-routes — the browser-initiated "surface a file the agent wrote"
// route. The web diff-block shows two affordances on a file edit ("打开" =
// open the file with its default app; "所在文件夹" = reveal it in the OS file
// manager); both POST here. Mirrors Clowder's POST /api/workspace/reveal, plus
// an 'open' action.
//
// Security: the requested path is resolved against the SAME sandbox root that
// read_file/search_files use (the workspace fileRoot) via resolvePathInRoot — a
// path climbing out (`..`) or an absolute path outside the workspace is rejected
// 403, so a malicious/buggy agent diff cannot make the user open an arbitrary
// host file. The OS launch itself is an injected seam (OsOpener) using execFile
// with array args (no shell), and is only reachable on the local single-user API.

import { createReadStream } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppServices } from '@choco/api/infrastructure/app-services';
import { resolvePathInRoot } from '@choco/api/infrastructure/path-sandbox';
import { defaultOsOpener, type OsOpener } from '@choco/api/infrastructure/os-open';
import {
  isSafeWorkspaceFile,
  looksBinary,
  mediaMimeForPath,
  mimeForPath,
  safeUploadFilename,
  sha256Hex,
  toWorkspaceRelative,
} from '@choco/api/infrastructure/workspace-security';

/** Default cap on a previewed file's size — HTML viz files are small; guards huge reads. */
const DEFAULT_MAX_PREVIEW_BYTES = 2 * 1024 * 1024; // 2 MiB
/** Cap on a streamed media file (image/audio/video preview). */
const MAX_RAW_MEDIA_BYTES = 10 * 1024 * 1024; // 10 MiB

/** Options for {@link registerWorkspaceRoutes}. */
export interface WorkspaceRoutesOptions {
  /** Sandbox root every reveal/open/read path is resolved within (the agent workspace). */
  readonly fileRoot: string;
  /** Injectable OS-open seam (defaults to the real execFile-based opener). */
  readonly opener?: OsOpener;
  /** Max bytes GET /api/workspace/file will return (defaults to {@link DEFAULT_MAX_PREVIEW_BYTES}). */
  readonly maxPreviewBytes?: number;
}

/** Body of POST /api/workspace/reveal. `action` defaults to 'reveal'. */
const RevealBodySchema = z.object({
  path: z.string().min(1),
  action: z.enum(['open', 'reveal']).optional(),
});

/** Query of GET /api/workspace/file. */
const FileQuerySchema = z.object({ path: z.string().min(1) });
const UploadBodySchema = z.object({
  directory: z.string().optional(),
  filename: z.string().min(1).max(255),
  contentBase64: z.string().min(1),
  overwrite: z.boolean().optional(),
});

/**
 * Register the workspace file routes on `app`. Currently one route:
 *   POST /api/workspace/reveal  { path, action? } → open/reveal a workspace file.
 */
export function registerWorkspaceRoutes(
  app: FastifyInstance,
  services: AppServices,
  options: WorkspaceRoutesOptions,
): void {
  const { logger } = services;
  const fileRoot = resolve(options.fileRoot);
  const opener = options.opener ?? defaultOsOpener;
  const maxPreviewBytes = options.maxPreviewBytes ?? DEFAULT_MAX_PREVIEW_BYTES;

  app.post('/api/workspace/reveal', async (request, reply) => {
    const body = RevealBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });
    }

    const resolved = resolvePathInRoot(fileRoot, body.data.path);
    if (resolved === null) {
      // Path traversal / absolute path escaping the workspace sandbox.
      return reply.code(403).send({ error: 'path_outside_root' });
    }

    try {
      await stat(resolved);
    } catch {
      // ENOENT / EACCES — do not leak the absolute path or errno detail.
      return reply.code(404).send({ error: 'file_not_found' });
    }

    const action = body.data.action ?? 'reveal';
    try {
      await opener(resolved, action);
      return reply.send({ ok: true, action });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger({
        level: 'warn',
        message: `workspace ${action} failed for "${body.data.path}": ${reason}`,
        threadId: '',
      });
      return reply.code(500).send({ error: 'open_failed' });
    }
  });

  // GET /api/workspace/file?path=… — return a workspace file's TEXT content for
  // the in-app preview (e.g. rendering an agent-written HTML viz in a sandboxed
  // iframe). Same fileRoot sandbox as reveal/read_file; size-capped.
  app.get('/api/workspace/file', async (request, reply) => {
    const query = FileQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: 'invalid_query', issues: query.error.issues });
    }

    const resolved = resolvePathInRoot(fileRoot, query.data.path);
    if (resolved === null) {
      return reply.code(403).send({ error: 'path_outside_root' });
    }

    try {
      if (!isSafeWorkspaceFile(fileRoot, resolved)) return reply.code(403).send({ error: 'sensitive_path' });
      const buffer = await readFile(resolved);
      const binary = looksBinary(buffer);
      if (buffer.byteLength > maxPreviewBytes && !binary) {
        return reply.code(413).send({ error: 'file_too_large', maxBytes: maxPreviewBytes });
      }
      const content = binary ? '' : buffer.toString('utf8');
      return reply.send({
        path: toWorkspaceRelative(fileRoot, resolved),
        content,
        sha256: sha256Hex(buffer),
        size: buffer.byteLength,
        mime: mimeForPath(resolved, binary),
        truncated: false,
        binary,
      });
    } catch {
      return reply.code(404).send({ error: 'file_not_found' });
    }
  });

  // GET /api/workspace/file/raw?path=… — stream a workspace MEDIA file (image /
  // audio / video) with its real content-type, so the preview can render an <img>/
  // <video> instead of the binary placeholder. Same fileRoot sandbox + sensitive
  // denylist as GET /file; media-only (text/binary non-media → 400) and size-capped.
  // Aligned to Clowder workspace.ts GET /api/workspace/file/raw.
  app.get('/api/workspace/file/raw', async (request, reply) => {
    const query = FileQuerySchema.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ error: 'invalid_query', issues: query.error.issues });
    }

    const resolved = resolvePathInRoot(fileRoot, query.data.path);
    if (resolved === null) return reply.code(403).send({ error: 'path_outside_root' });
    if (!isSafeWorkspaceFile(fileRoot, resolved)) return reply.code(403).send({ error: 'sensitive_path' });

    const mime = mediaMimeForPath(resolved);
    if (mime === null) return reply.code(400).send({ error: 'not_media' });

    let fileStat;
    try {
      fileStat = await stat(resolved);
    } catch {
      return reply.code(404).send({ error: 'file_not_found' });
    }
    if (fileStat.isDirectory()) return reply.code(400).send({ error: 'is_directory' });
    if (fileStat.size > MAX_RAW_MEDIA_BYTES) {
      return reply.code(413).send({ error: 'file_too_large', maxBytes: MAX_RAW_MEDIA_BYTES });
    }

    reply.header('Content-Type', mime);
    reply.header('Content-Length', fileStat.size);
    reply.header('Cache-Control', 'private, max-age=60');
    return reply.send(createReadStream(resolved));
  });

  // POST /api/workspace/upload - JSON/base64 upload for the browser Workspace panel.
  app.post('/api/workspace/upload', async (request, reply) => {
    const body = UploadBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: body.error.issues });
    }

    const filename = safeUploadFilename(body.data.filename);
    if (filename === null) return reply.code(400).send({ error: 'invalid_filename' });

    const directory = body.data.directory ?? '';
    const dir = directory.length > 0 ? resolvePathInRoot(fileRoot, directory) : fileRoot;
    if (dir === null) return reply.code(403).send({ error: 'path_outside_root' });

    const target = resolve(dir, filename);
    if (!isSafeWorkspaceFile(fileRoot, target)) return reply.code(403).send({ error: 'sensitive_path' });

    let content: Buffer;
    try {
      content = Buffer.from(body.data.contentBase64, 'base64');
    } catch {
      return reply.code(400).send({ error: 'invalid_base64' });
    }
    if (content.byteLength === 0) return reply.code(400).send({ error: 'empty_upload' });
    if (content.byteLength > maxPreviewBytes) {
      return reply.code(413).send({ error: 'file_too_large', maxBytes: maxPreviewBytes });
    }

    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, { flag: body.data.overwrite === true ? 'w' : 'wx' });
      return reply.send({
        ok: true,
        path: toWorkspaceRelative(fileRoot, target),
        size: content.byteLength,
        sha256: sha256Hex(content),
      });
    } catch (err) {
      const code = err instanceof Error && 'code' in err ? (err as NodeJS.ErrnoException).code : undefined;
      if (code === 'EEXIST') return reply.code(409).send({ error: 'file_exists' });
      return reply.code(500).send({ error: 'upload_failed' });
    }
  });
}
