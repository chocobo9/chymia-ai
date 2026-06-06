import { extname, isAbsolute, relative, sep } from 'node:path';
import { createHash } from 'node:crypto';

const SENSITIVE_FILE_NAMES = new Set(['.env', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519']);
const SENSITIVE_EXTENSIONS = new Set(['.key', '.pem', '.p12', '.pfx']);
const SENSITIVE_SEGMENTS = new Set(['.git', 'secrets']);
const TEXT_EXTENSIONS = new Set([
  '.c',
  '.css',
  '.csv',
  '.h',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.md',
  '.mjs',
  '.py',
  '.sql',
  '.svg',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.xml',
  '.yaml',
  '.yml',
]);

const MIME_BY_EXTENSION = new Map<string, string>([
  ['.css', 'text/css'],
  ['.csv', 'text/csv'],
  ['.html', 'text/html'],
  ['.js', 'text/javascript'],
  ['.jsx', 'text/javascript'],
  ['.json', 'application/json'],
  ['.md', 'text/markdown'],
  ['.mjs', 'text/javascript'],
  ['.svg', 'image/svg+xml'],
  ['.ts', 'text/typescript'],
  ['.tsx', 'text/typescript'],
  ['.txt', 'text/plain'],
  ['.xml', 'application/xml'],
  ['.yaml', 'application/yaml'],
  ['.yml', 'application/yaml'],
]);

export function toWorkspaceRelative(root: string, abs: string): string {
  return relative(root, abs).split(sep).join('/');
}

export function isPathInsideRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

export function isSensitiveWorkspacePath(path: string): boolean {
  const normalized = path.split('\\').join('/');
  const segments = normalized.split('/').filter(Boolean);
  for (const segment of segments) {
    const lower = segment.toLowerCase();
    if (SENSITIVE_SEGMENTS.has(lower)) return true;
    if (lower === '.env' || lower.startsWith('.env.')) return true;
  }
  const base = segments.at(-1)?.toLowerCase() ?? '';
  if (SENSITIVE_FILE_NAMES.has(base)) return true;
  if (SENSITIVE_EXTENSIONS.has(extname(base))) return true;
  return false;
}

export function isSafeWorkspaceFile(root: string, abs: string): boolean {
  if (!isPathInsideRoot(root, abs)) return false;
  return !isSensitiveWorkspacePath(toWorkspaceRelative(root, abs));
}

export function safeUploadFilename(filename: string): string | null {
  if (filename.length === 0 || filename.includes('/') || filename.includes('\\')) return null;
  if (filename === '.' || filename === '..') return null;
  if (filename.includes('\0') || filename.includes(':')) return null;
  if (isSensitiveWorkspacePath(filename)) return null;
  return filename;
}

export function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

export function looksBinary(buffer: Buffer): boolean {
  if (buffer.includes(0)) return true;
  const sample = buffer.subarray(0, Math.min(buffer.length, 1024));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte < 7 || (byte > 14 && byte < 32)) suspicious += 1;
  }
  return sample.length > 0 && suspicious / sample.length > 0.08;
}

export function mimeForPath(path: string, binary = false): string {
  if (binary) return 'application/octet-stream';
  return MIME_BY_EXTENSION.get(extname(path).toLowerCase()) ?? 'text/plain';
}

export function isSearchableTextPath(path: string): boolean {
  return TEXT_EXTENSIONS.has(extname(path).toLowerCase());
}
