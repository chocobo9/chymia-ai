// tool-render — derives, from a real StreamingToolBlock, whether to render a
// Diff block (file edit) or a generic Tool block, and computes the props for
// either WITHOUT fabricating data. A tool counts as a file edit when its name
// looks like an edit tool AND its input carries a recognizable file path; a
// diff/patch payload (unified-diff text) is parsed into colored lines, otherwise
// we show just the file header (added/removed = 0) so we never invent counts.

import type { StreamingToolBlock } from '../../stores/chat-store.js';
import type { DiffLine } from './blocks.js';
import { langFromPath, type CodeLang } from './highlight.js';

/** Tool names that denote a file mutation. */
const FILE_EDIT_TOOL = /(write|edit|apply_patch|create|str_replace|update)[_-]?(file)?/i;

/** Common keys that carry a file path in tool inputs. */
const PATH_KEYS = ['path', 'file_path', 'filePath', 'filename', 'file', 'target'] as const;

/** Common keys that carry a unified-diff / patch payload. */
const DIFF_KEYS = ['diff', 'patch', 'unified_diff', 'unifiedDiff'] as const;

/** Keys carrying the OLD text of a string-replace edit (Edit / str_replace). */
const OLD_KEYS = ['old_string', 'old_str', 'oldText', 'oldString'] as const;

/** Keys carrying the NEW text of a string-replace edit (Edit / str_replace). */
const NEW_KEYS = ['new_string', 'new_str', 'newText', 'newString'] as const;

/** Keys carrying the FULL file content of a create/write (rendered as all-add). */
const CONTENT_KEYS = ['content', 'contents', 'file_text', 'fileText'] as const;

/** Keys that tend to carry the most telling one-liner for a tool (path > query > command > …). */
const DETAIL_KEYS = [
  'path',
  'file_path',
  'filePath',
  'filename',
  'file',
  'pattern',
  'query',
  'command',
  'cmd',
  'url',
  'description',
] as const;

/** Max characters shown inline as a tool row's detail before truncation (Clowder: TEXT_PREVIEW_MAX_CHARS). */
export const TOOL_DETAIL_MAX_CHARS = 48;

/** Collapse runs of whitespace to single spaces and truncate to a one-liner preview. */
function toOneLine(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function firstString(
  input: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/** Parse a unified-diff/patch string into colored lines + add/remove counts. */
export function parseDiffPayload(payload: string): {
  lines: readonly DiffLine[];
  added: number;
  removed: number;
} {
  const raw = payload.split(/\r?\n/);
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  for (const text of raw) {
    // Skip unified-diff file headers — they aren't content lines.
    if (/^(\+\+\+|---|@@|diff |index )/.test(text)) continue;
    if (text.startsWith('+')) {
      added += 1;
      lines.push({ text, kind: 'add' });
    } else if (text.startsWith('-')) {
      removed += 1;
      lines.push({ text, kind: 'del' });
    } else {
      lines.push({ text });
    }
  }
  return { lines, added, removed };
}

/** Split a multi-line string into lines; an empty string yields zero lines. */
function splitLines(value: string): readonly string[] {
  return value.length === 0 ? [] : value.split(/\r?\n/);
}

interface DiffBody {
  readonly lines: readonly DiffLine[];
  readonly added: number;
  readonly removed: number;
}

/**
 * Build a replace-hunk diff for an Edit/str_replace tool: every old line as a
 * `del`, then every new line as an `add`. Lines keep a leading `- `/`+ ` marker
 * (the highlighter renders the marker as plain text, the code after it colored).
 */
function buildReplaceDiff(oldStr: string, newStr: string): DiffBody {
  const removedLines = splitLines(oldStr);
  const addedLines = splitLines(newStr);
  const lines: DiffLine[] = [
    ...removedLines.map((text) => ({ text: `- ${text}`, kind: 'del' as const })),
    ...addedLines.map((text) => ({ text: `+ ${text}`, kind: 'add' as const })),
  ];
  return { lines, added: addedLines.length, removed: removedLines.length };
}

/** Build an all-added diff for a create/write tool carrying full file content. */
function buildAddDiff(content: string): DiffBody {
  const addedLines = splitLines(content).map((text) => ({ text: `+ ${text}`, kind: 'add' as const }));
  return { lines: addedLines, added: addedLines.length, removed: 0 };
}

export interface DiffRender {
  readonly kind: 'diff';
  readonly file: string;
  /** Language family for syntax highlighting, derived from the file path. */
  readonly lang: CodeLang;
  readonly added: number;
  readonly removed: number;
  readonly lines: readonly DiffLine[];
}

export interface ToolRender {
  readonly kind: 'tool';
  readonly toolName: string;
  readonly inputJson: string;
}

export type BlockRender = DiffRender | ToolRender;

/**
 * Decide how to render a tool block. Returns a Diff render when the block is a
 * file-edit tool that carries a resolvable file path AND real edit content —
 * either a unified-diff/patch payload, a string-replace (old/new), or full file
 * content (create/write). The +/- counts always come from actual content, never
 * fabricated. A file-edit tool with ONLY a path (no content) and every non-edit
 * tool render as a generic Tool block whose body is the pretty-printed JSON.
 */
export function renderForToolBlock(block: StreamingToolBlock): BlockRender {
  const input = block.toolInput;
  if (input !== undefined && FILE_EDIT_TOOL.test(block.toolName)) {
    const file = firstString(input, PATH_KEYS);
    if (file !== undefined) {
      const lang = langFromPath(file);
      const diffPayload = firstString(input, DIFF_KEYS);
      if (diffPayload !== undefined) {
        return { kind: 'diff', file, lang, ...parseDiffPayload(diffPayload) };
      }
      const oldStr = firstString(input, OLD_KEYS);
      const newStr = firstString(input, NEW_KEYS);
      if (oldStr !== undefined || newStr !== undefined) {
        return { kind: 'diff', file, lang, ...buildReplaceDiff(oldStr ?? '', newStr ?? '') };
      }
      const content = firstString(input, CONTENT_KEYS);
      if (content !== undefined) {
        return { kind: 'diff', file, lang, ...buildAddDiff(content) };
      }
    }
  }
  const inputJson = input === undefined ? '' : JSON.stringify(input, null, 2);
  return { kind: 'tool', toolName: block.toolName, inputJson };
}

/**
 * Derive a compact, truncated one-liner detail for a tool row from its REAL
 * input — preferring a telling key (path/pattern/query/command/url/…), else a
 * compact JSON preview. Returns '' when the tool carries no input, so the row
 * shows just its name (never fabricates a detail). Truncated to
 * TOOL_DETAIL_MAX_CHARS with an ellipsis.
 */
export function toolDetailPreview(block: StreamingToolBlock): string {
  const input = block.toolInput;
  if (input === undefined) return '';
  const keyed = firstString(input, DETAIL_KEYS);
  if (keyed !== undefined) return toOneLine(keyed, TOOL_DETAIL_MAX_CHARS);
  const keys = Object.keys(input);
  if (keys.length === 0) return '';
  return toOneLine(JSON.stringify(input), TOOL_DETAIL_MAX_CHARS);
}
