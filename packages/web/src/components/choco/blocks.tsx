// Choco rich message blocks — Think (collapsible reasoning), Tool (tool call,
// collapsible JSON input), Diff (file-edit visualization), Decision (A2A
// choose-one card), and StreamDots reuse. Ported from the Claude-Design handoff
// (choco-core.jsx). All blocks are presentational; they render REAL data passed
// from AgentMessage (no fabricated content). Named exports only.

import { useState, type ReactElement } from 'react';
import { IconChevron, IconTerminal } from './icons.js';
import { StreamDots } from './primitives.js';

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
}

/** File-edit diff visualization (header + +/- stats + colored lines). */
export function Diff({ file, added, removed, lines }: DiffProps): ReactElement {
  return (
    <div className="diff" data-testid="diff-block">
      <div className="diff-h">
        <span className="diff-file">{file}</span>
        <span className="diff-stat">
          <span className="a">+{added}</span> <span className="d">−{removed}</span>
        </span>
      </div>
      <div className="diff-b">
        {lines.map((line, i) => (
          <span key={i} className={`ln${line.kind !== undefined ? ` ${line.kind}` : ''}`}>
            {line.text}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ---------------- Tool ---------------- */

export interface ToolProps {
  /** Tool name (e.g. write_file, run_tests). */
  readonly toolName: string;
  /** Optional short tag (e.g. the provider/runner). */
  readonly tag?: string;
  /** Pretty-printed JSON input (already stringified), or empty if none. */
  readonly inputJson: string;
  /** True while the tool is still running (running indicator vs ✓ 完成). */
  readonly running: boolean;
  /** Accent color for the icon/dots. */
  readonly accent?: string;
}

/** Collapsible tool-call block. Preserves the tool-use testids. */
export function Tool({ toolName, tag, inputJson, running, accent }: ToolProps): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div
      className="tool"
      data-testid="tool-use-block"
      style={accent === undefined ? undefined : ({ '--ac': accent } as React.CSSProperties)}
    >
      <button type="button" className="tool-h" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="tool-ic">
          <IconTerminal />
        </span>
        <span className="tool-name">工具调用: {toolName}</span>
        {tag !== undefined && tag.length > 0 && <span className="tool-tag">{tag}</span>}
        <span className={`tool-st${running ? ' running' : ''}`}>
          {running ? (
            <>
              <StreamDots accent={accent} />
              运行中
            </>
          ) : (
            <>✓ 完成</>
          )}
        </span>
      </button>
      {open && inputJson.length > 0 && (
        <pre className="tool-b" data-testid="tool-use-input">
          {inputJson}
        </pre>
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
