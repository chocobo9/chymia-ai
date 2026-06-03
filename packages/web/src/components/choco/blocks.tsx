// Choco rich message blocks — Think (collapsible reasoning), Tool (tool call,
// collapsible JSON input), Diff (file-edit visualization), Decision (A2A
// choose-one card), and StreamDots reuse. Ported from the Claude-Design handoff
// (choco-core.jsx). All blocks are presentational; they render REAL data passed
// from AgentMessage (no fabricated content). Named exports only.

import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { IconChevron, IconCheck, IconWrench, IconFolder } from './icons.js';
import { StreamDots } from './primitives.js';
import { highlightCode, type CodeLang } from './highlight.js';

/* ---------------- Think ---------------- */

export interface ThinkProps {
  /** The full thinking text; split into lines for the design's stepped layout. */
  readonly thinking: string;
  /** Accent color (agent's roster color.primary). */
  readonly accent?: string;
}

/** Split thinking prose into non-empty trimmed lines (the "steps"). */
function thinkingLines(thinking: string): readonly string[] {
  return thinking
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** Collapsible reasoning block ("思考过程"). Preserves the thinking testids. */
export function Think({ thinking, accent }: ThinkProps): ReactElement {
  const [open, setOpen] = useState(false);
  const lines = thinkingLines(thinking);
  const stepCount = lines.length > 0 ? lines.length : 1;
  return (
    <div
      className={`think${open ? ' open' : ''}`}
      data-testid="thinking-block"
      style={accent === undefined ? undefined : ({ '--ac': accent } as React.CSSProperties)}
    >
      <button
        type="button"
        className="think-h"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="think-tag">思考过程</span>
        <span className="think-n">{stepCount} 步</span>
        <span className="think-chev">
          <IconChevron />
        </span>
      </button>
      {open && (
        <div className="think-b" data-testid="thinking-body">
          {(lines.length > 0 ? lines : [thinking]).map((line, i) => (
            <span key={i} className="ln">
              {line}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------- Diff ---------------- */

/** One rendered diff line; `kind` drives the add/del highlight. */
export interface DiffLine {
  readonly text: string;
  readonly kind?: 'add' | 'del';
}

export interface DiffProps {
  readonly file: string;
  readonly added: number;
  readonly removed: number;
  readonly lines: readonly DiffLine[];
  /** Language family for syntax highlighting (derived from the file path). */
  readonly lang?: CodeLang;
  /**
   * When provided, the file path becomes a clickable "open file" affordance and a
   * "reveal in folder" button appears — both call this with the chosen action.
   * Omit (e.g. in pure presentational tests) to render the path as plain text.
   */
  readonly onReveal?: (action: 'open' | 'reveal') => void;
  /**
   * Fetch a workspace file's text content. When provided AND the file is a
   * previewable type (HTML), a "预览" toggle renders the content inline in a
   * sandboxed iframe (e.g. an agent-written viz). Omit → no preview affordance.
   */
  readonly onLoadFile?: (path: string) => Promise<string>;
}

/** File extensions we render an inline HTML preview for. */
const PREVIEWABLE_HTML_EXTS: readonly string[] = ['.html', '.htm'];

/** True when `file` is an HTML document we can preview in an iframe. */
function isPreviewableHtml(file: string): boolean {
  const lower = file.toLowerCase();
  return PREVIEWABLE_HTML_EXTS.some((ext) => lower.endsWith(ext));
}

type PreviewState =
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly html: string }
  | { readonly status: 'error'; readonly message: string };

interface FilePreviewProps {
  readonly path: string;
  readonly loadFile: (path: string) => Promise<string>;
}

/**
 * Inline HTML preview: loads the file's content on mount and renders it in a
 * SANDBOXED iframe (`sandbox="allow-scripts"`, no allow-same-origin) so an agent-
 * written page (with its own inline JS/CSS) runs isolated — it cannot reach the
 * app's origin, cookies, or storage. Shows a loading / error line until ready.
 */
function FilePreview({ path, loadFile }: FilePreviewProps): ReactElement {
  const [state, setState] = useState<PreviewState>({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    loadFile(path)
      .then((html) => {
        if (!cancelled) setState({ status: 'loaded', html });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({ status: 'error', message: err instanceof Error ? err.message : '加载失败' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [path, loadFile]);

  if (state.status === 'loading') {
    return (
      <div className="diff-preview diff-preview--msg" data-testid="diff-preview">
        加载预览…
      </div>
    );
  }
  if (state.status === 'error') {
    return (
      <div className="diff-preview diff-preview--msg" data-testid="diff-preview">
        预览失败：{state.message}
      </div>
    );
  }
  return (
    <div className="diff-preview" data-testid="diff-preview">
      <iframe
        className="diff-preview-frame"
        data-testid="diff-preview-frame"
        title="文件预览"
        sandbox="allow-scripts"
        srcDoc={state.html}
      />
    </div>
  );
}

/** Tokenize a diff line into colored spans; empty lines render their raw text. */
function highlightLine(text: string, lang: CodeLang): ReactNode {
  const tokens = highlightCode(text, lang);
  if (tokens.length === 0) return text;
  return tokens.map((t, i) =>
    t.cls === undefined ? (
      <span key={i}>{t.text}</span>
    ) : (
      <span key={i} className={`tk-${t.cls}`}>
        {t.text}
      </span>
    ),
  );
}

/**
 * Diffs longer than this many lines collapse by default, so a large file
 * create/write (e.g. a 574-line all-add) shows just its header instead of
 * dumping the whole file inline. Short edits stay open — they're the
 * substantive content the design keeps prominent.
 */
export const DIFF_COLLAPSE_THRESHOLD = 16;

/** File-edit diff visualization (header + +/- stats + syntax-highlighted lines). */
export function Diff({
  file,
  added,
  removed,
  lines,
  lang = 'generic',
  onReveal,
  onLoadFile,
}: DiffProps): ReactElement {
  const collapsible = lines.length > DIFF_COLLAPSE_THRESHOLD;
  const [open, setOpen] = useState(!collapsible);
  const [previewOpen, setPreviewOpen] = useState(false);
  const canPreview = onLoadFile !== undefined && isPreviewableHtml(file);

  // The filename is a clickable "open file" affordance when reveal is wired (the
  // path the agent wrote), else plain text. (It can't live inside the collapse
  // toggle — nested buttons are invalid — so the toggle is its own chevron button.)
  const fileLabel =
    onReveal !== undefined ? (
      <button
        type="button"
        className="diff-file diff-file-btn"
        data-testid="diff-open-file"
        title="打开文件"
        onClick={() => onReveal('open')}
      >
        {file}
      </button>
    ) : (
      <span className="diff-file">{file}</span>
    );

  return (
    <div className={`diff${open ? ' open' : ''}`} data-testid="diff-block">
      <div className="diff-h">
        {fileLabel}
        <span className="diff-stat">
          <span className="a">+{added}</span> <span className="d">−{removed}</span>
        </span>
        {canPreview && (
          <button
            type="button"
            className={`diff-preview-btn${previewOpen ? ' active' : ''}`}
            data-testid="diff-preview-toggle"
            title="内联预览"
            aria-pressed={previewOpen}
            onClick={() => setPreviewOpen((v) => !v)}
          >
            预览
          </button>
        )}
        {onReveal !== undefined && (
          <button
            type="button"
            className="diff-act"
            data-testid="diff-reveal-file"
            title="打开所在文件夹"
            aria-label="打开所在文件夹"
            onClick={() => onReveal('reveal')}
          >
            <IconFolder />
          </button>
        )}
        {collapsible && (
          <button
            type="button"
            className="diff-chev-btn"
            aria-expanded={open}
            aria-label={open ? '折叠' : '展开'}
            data-testid="diff-toggle"
            onClick={() => setOpen((v) => !v)}
          >
            {!open && <span className="diff-hint">{lines.length} 行 · 点击展开</span>}
            <span className="diff-chev" aria-hidden="true">
              <IconChevron />
            </span>
          </button>
        )}
      </div>
      {open && (
        <div className="diff-b">
          {lines.map((line, i) => (
            <span key={i} className={`ln${line.kind !== undefined ? ` ${line.kind}` : ''}`}>
              {highlightLine(line.text, lang)}
            </span>
          ))}
        </div>
      )}
      {previewOpen && onLoadFile !== undefined && <FilePreview path={file} loadFile={onLoadFile} />}
    </div>
  );
}

/* ---------------- Tool group + rows ---------------- */

/** One tool call, normalized for the compact row + its revealable JSON body. */
export interface ToolRowData {
  /** Stable key (toolUseId or a derived fallback). */
  readonly key: string;
  /** Tool name (e.g. write_file, run_tests, Grep). */
  readonly toolName: string;
  /** Compact, already-truncated one-liner detail (≤ TOOL_DETAIL_MAX_CHARS), or ''. */
  readonly detail: string;
  /** Pretty-printed JSON input (already stringified), or '' if none. */
  readonly inputJson: string;
}

interface ToolRowProps {
  readonly row: ToolRowData;
  /** True while the turn is still streaming (spinner vs ✓ check). */
  readonly running: boolean;
  readonly accent?: string;
}

/**
 * A compact one-liner tool row: [status ✓/spinner] [wrench] [name] [short detail],
 * with the full JSON input revealed behind a per-row chevron (Clowder rowExpanded).
 * Carries data-testid="tool-use-block" (one per call) so the suite's per-tool
 * assertions keep working; the revealed body keeps data-testid="tool-use-input".
 */
function ToolRow({ row, running, accent }: ToolRowProps): ReactElement {
  const [open, setOpen] = useState(false);
  const canExpand = row.inputJson.length > 0;
  return (
    <div className={`tool-row${open ? ' open' : ''}`} data-testid="tool-use-block">
      <button
        type="button"
        className="tool-row-h"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className={`tool-row-st${running ? ' running' : ''}`} aria-hidden="true">
          {running ? <StreamDots accent={accent} /> : <IconCheck />}
        </span>
        <span className="tool-row-ic" aria-hidden="true">
          <IconWrench />
        </span>
        <span className="tool-row-name">{row.toolName}</span>
        {row.detail.length > 0 && <span className="tool-row-detail">{row.detail}</span>}
        {canExpand && (
          <span className="tool-row-chev" aria-hidden="true">
            <IconChevron />
          </span>
        )}
      </button>
      {open && canExpand && (
        <pre className="tool-row-b" data-testid="tool-use-input">
          {row.inputJson}
        </pre>
      )}
    </div>
  );
}

export interface ToolGroupProps {
  /** The tool calls to group (already excludes diffs, which render on their own). */
  readonly rows: readonly ToolRowData[];
  /**
   * True while the turn is still streaming. Drives the DEFAULT open state
   * (Clowder: useState(isStreaming)) — expanded live so you watch progress,
   * then auto-collapsed once the turn completes (unless the user toggled it).
   */
  readonly isStreaming: boolean;
  readonly accent?: string;
}

/**
 * Collapsible tool-call GROUP (Clowder-faithful): one header row
 * ("N 工具调用" + chevron) wrapping compact tool rows instead of a wall of
 * full-width blocks. Default-open mirrors `isStreaming`; on the streaming→done
 * transition it auto-collapses (so a finished 16-tool turn shows one compact
 * line), but a manual toggle wins from then on.
 */
export function ToolGroup({ rows, isStreaming, accent }: ToolGroupProps): ReactElement {
  const [open, setOpen] = useState(isStreaming);
  const userToggled = useRef(false);
  const prevStreaming = useRef(isStreaming);

  useEffect(() => {
    if (!prevStreaming.current && isStreaming) {
      // (Re)entered streaming — expand live and forget any prior manual toggle.
      userToggled.current = false;
      setOpen(true);
    } else if (prevStreaming.current && !isStreaming && !userToggled.current) {
      // Turn just completed — auto-collapse the now-static group.
      setOpen(false);
    }
    prevStreaming.current = isStreaming;
  }, [isStreaming]);

  const count = rows.length;
  return (
    <div
      className={`tool-group${open ? ' open' : ''}`}
      data-testid="tool-group"
      style={accent === undefined ? undefined : ({ '--ac': accent } as React.CSSProperties)}
    >
      <button
        type="button"
        className="tool-group-h"
        aria-expanded={open}
        data-testid="tool-group-toggle"
        onClick={() => {
          userToggled.current = true;
          setOpen((v) => !v);
        }}
      >
        <span className="tool-group-ic" aria-hidden="true">
          <IconWrench />
        </span>
        <span className="tool-group-sum">{count} 工具调用</span>
        {!open && <span className="tool-group-hint">已折叠</span>}
        <span className="tool-group-chev" aria-hidden="true">
          <IconChevron />
        </span>
      </button>
      {open && (
        <div className="tool-group-b">
          {rows.map((row) => (
            <ToolRow key={row.key} row={row} running={isStreaming} accent={accent} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------- Decision ---------------- */

export interface DecisionProps {
  readonly title: string;
  readonly options: readonly string[];
  /** Index of the chosen option, if already resolved. */
  readonly chosenIndex?: number;
  /** Called when the owner picks an option. */
  readonly onPick?: (index: number, option: string) => void;
  readonly accent?: string;
}

/** A2A choose-one decision card (rendered only when the data supports it). */
export function Decision(props: DecisionProps): ReactElement {
  const { title, options, chosenIndex, onPick, accent } = props;
  return (
    <div
      className="decision"
      data-testid="decision-block"
      style={accent === undefined ? undefined : ({ '--ac': accent } as React.CSSProperties)}
    >
      <div className="decision-t">{title}</div>
      {chosenIndex !== undefined && chosenIndex >= 0 ? (
        <div className="decision-done">
          <span className="k">{String.fromCharCode(65 + chosenIndex)}</span>
          已采纳 · {options[chosenIndex]}
        </div>
      ) : (
        <div className="decision-opts">
          {options.map((option, i) => (
            <button
              key={i}
              type="button"
              className="decision-opt"
              data-testid="decision-option"
              onClick={() => onPick?.(i, option)}
            >
              <span className="k">{String.fromCharCode(65 + i)}</span>
              <span>{option}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
