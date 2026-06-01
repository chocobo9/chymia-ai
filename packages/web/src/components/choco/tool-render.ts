// tool-render — derives, from a real StreamingToolBlock, whether to render a
// Diff block (file edit) or a generic Tool block, and computes the props for
// either WITHOUT fabricating data. A tool counts as a file edit when its name
// looks like an edit tool AND its input carries a recognizable file path; a
// diff/patch payload (unified-diff text) is parsed into colored lines, otherwise
// we show just the file header (added/removed = 0) so we never invent counts.

import type { StreamingToolBlock } from '../../stores/chat-store.js';
import type { DiffLine } from './blocks.js';

/** Tool names that denote a file mutation. */
const FILE_EDIT_TOOL = /(write|edit|apply_patch|create|str_replace|update)[_-]?(file)?/i;

/** Common keys that carry a file path in tool inputs. */
const PATH_KEYS = ['path', 'file_path', 'filePath', 'filename', 'file', 'target'] as const;

/** Common keys that carry a unified-diff / patch payload. */
const DIFF_KEYS = ['diff', 'patch', 'unified_diff', 'unifiedDiff'] as const;

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

export interface DiffRender {
  readonly kind: 'diff';
  readonly file: string;
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
 * Decide how to render a tool block. Returns a Diff render ONLY when the block
 * is a file-edit tool that carries BOTH a resolvable file path AND a real
 * unified-diff/patch payload (so the +/- counts come from actual content, never
 * fabricated). Every other tool — including a plain write_file with just a path
 * — renders as a generic Tool block whose body is the pretty-printed JSON input.
 */
export function renderForToolBlock(block: StreamingToolBlock): BlockRender {
  const input = block.toolInput;
  if (input !== undefined && FILE_EDIT_TOOL.test(block.toolName)) {
    const file = firstString(input, PATH_KEYS);
    const diffPayload = firstString(input, DIFF_KEYS);
    if (file !== undefined && diffPayload !== undefined) {
      const parsed = parseDiffPayload(diffPayload);
      return { kind: 'diff', file, ...parsed };
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
