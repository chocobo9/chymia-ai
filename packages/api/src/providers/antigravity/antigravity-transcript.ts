import Database from 'better-sqlite3';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

interface LastConversations {
  readonly [workspace: string]: string | undefined;
}

interface StepPayloadRow {
  readonly step_payload: Buffer | null;
}

const PROMPT_MARKERS = ['Identity:', 'USER_REQUEST', 'ADDITIONAL_METADATA', '@gemini'];
const REASONING_MARKERS = ['**Analyzing the Input**', '**Defining the Persona**'];

export function extractAntigravityTextFromStepPayload(payload: Buffer): string | undefined {
  const chunks = payload
    .toString('utf8')
    .split('')
    .map((char) => (isChunkSeparator(char) ? '\u0000' : char))
    .join('')
    .split('\u0000')
    .map(cleanExtractedChunk)
    .filter((chunk) => chunk.length >= 20);

  let best: { readonly text: string; readonly score: number } | undefined;
  for (const chunk of chunks) {
    const score = scoreCandidate(chunk);
    if (score < 50) continue;
    if (best === undefined || score > best.score) {
      best = { text: chunk, score };
    }
  }
  return best?.text;
}

function isChunkSeparator(char: string): boolean {
  const code = char.charCodeAt(0);
  if (char === '\n' || char === '\r' || char === '\t') return false;
  return (code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f);
}

export function readLatestAntigravityTranscriptText(
  workingDirectory: string,
  appDataDir = defaultAntigravityAppDataDir(),
): string | undefined {
  const dbPaths = resolveConversationDbCandidates(workingDirectory, appDataDir);
  for (const dbPath of dbPaths) {
    const text = readLatestTextFromConversationDb(dbPath);
    if (text !== undefined) return text;
  }
  return undefined;
}

function defaultAntigravityAppDataDir(): string {
  return join(homedir(), '.gemini', 'antigravity-cli');
}

function cleanExtractedChunk(raw: string): string {
  return raw
    .replace(/^[^\p{L}\p{N}#*`>-]+/u, '')
    .replace(/[^\p{L}\p{N}\p{P}\p{S}\s]+$/u, '')
    .trim();
}

function scoreCandidate(text: string): number {
  let score = text.length;
  if (PROMPT_MARKERS.some((marker) => text.includes(marker))) score -= 2_000;
  if (REASONING_MARKERS.some((marker) => text.includes(marker))) score -= 1_000;
  if (text.includes('###') || text.includes('**') || text.includes('```')) score += 500;
  if (text.includes('\n\n')) score += 300;
  return score;
}

function resolveConversationDbCandidates(workingDirectory: string, appDataDir: string): string[] {
  const candidates: string[] = [];
  const cachePath = join(appDataDir, 'cache', 'last_conversations.json');
  const cache = readLastConversations(cachePath);
  const workspaceKeys = [workingDirectory, resolve(workingDirectory)];
  for (const key of workspaceKeys) {
    const conversationId = cache[key];
    if (conversationId !== undefined) {
      candidates.push(join(appDataDir, 'conversations', `${conversationId}.db`));
    }
  }
  const latest = latestConversationDb(appDataDir);
  if (latest !== undefined) candidates.push(latest);
  return [...new Set(candidates)].filter((path) => existsSync(path));
}

function readLastConversations(cachePath: string): LastConversations {
  try {
    return JSON.parse(readFileSync(cachePath, 'utf8')) as LastConversations;
  } catch {
    return {};
  }
}

function latestConversationDb(appDataDir: string): string | undefined {
  const dir = join(appDataDir, 'conversations');
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith('.db'))
      .map((name) => join(dir, name))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  } catch {
    return undefined;
  }
}

function readLatestTextFromConversationDb(dbPath: string): string | undefined {
  try {
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const rows = db
        .prepare('select step_payload from steps order by idx desc')
        .all() as StepPayloadRow[];
      for (const row of rows) {
        if (row.step_payload === null) continue;
        const text = extractAntigravityTextFromStepPayload(row.step_payload);
        if (text !== undefined) return text;
      }
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
  return undefined;
}
