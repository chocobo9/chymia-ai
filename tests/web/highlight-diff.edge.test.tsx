// @vitest-environment jsdom
//
// Coverage for the two small frontend fixes (2026-06-01):
//   (1) ChatInput @mention dropdown keyboard navigation — typing "@" then Enter
//       must PICK the highlighted agent, not fire a bare "@" message; ↑/↓ move
//       the highlight; Esc dismisses (then Enter sends normally).
//   (2) Code-edit tools (Edit / str_replace / Write) render as a real ± diff
//       with lightweight syntax highlighting, instead of raw escaped JSON.
//
// Distribution: happy ≤50%, edge ≥30%, adversarial ≥20% (CLAUDE.md §2.2). Real
// inputs only — actual Edit tool payloads + real TS/PY code, no placeholders.

import '@testing-library/jest-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatInput } from '../../packages/web/src/components/ChatInput.js';
import { AgentMessage, type AgentMessageView } from '../../packages/web/src/components/AgentMessage.js';
import { Diff } from '../../packages/web/src/components/choco/blocks.js';
import { highlightCode, langFromPath } from '../../packages/web/src/components/choco/highlight.js';
import { renderForToolBlock } from '../../packages/web/src/components/choco/tool-render.js';
import { useAgentStore } from '../../packages/web/src/stores/agent-store.js';
import { ROSTER, CLAUDE } from './fixtures.js';

beforeEach(() => {
  useAgentStore.setState({ roster: ROSTER, statusById: {} });
});
afterEach(cleanup);

/* ========================================================================== *
 * (1) ChatInput @mention keyboard navigation
 * ========================================================================== */
describe('ChatInput @mention keyboard navigation', () => {
  it('typing "@" then Enter PICKS the highlighted agent and does NOT send (the reported bug)', async () => {
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} />);
    const ta = screen.getByTestId('chat-input-textarea') as HTMLTextAreaElement;

    await userEvent.type(ta, '@');
    expect(screen.getByTestId('mention-suggestions')).toBeInTheDocument();
    await userEvent.type(ta, '{Enter}');

    // The bare "@" was NOT submitted — instead the first agent completed in place.
    expect(onSend).not.toHaveBeenCalled();
    expect(ta.value).toBe('@claude ');
  });

  it('ArrowDown moves the highlight, then Enter confirms the moved-to agent', async () => {
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} />);
    const ta = screen.getByTestId('chat-input-textarea') as HTMLTextAreaElement;

    await userEvent.type(ta, '@');
    await userEvent.type(ta, '{ArrowDown}'); // index 0 (@claude) -> 1 (@codex)
    await userEvent.type(ta, '{Enter}');

    expect(onSend).not.toHaveBeenCalled();
    expect(ta.value).toBe('@codex ');
  });

  it('[edge] ArrowUp from the top wraps to the LAST suggestion', async () => {
    render(<ChatInput onSend={vi.fn()} />);
    const ta = screen.getByTestId('chat-input-textarea') as HTMLTextAreaElement;

    await userEvent.type(ta, '@'); // 3 default handles; last is @gemini
    await userEvent.type(ta, '{ArrowUp}');
    await userEvent.type(ta, '{Enter}');

    expect(ta.value).toBe('@gemini ');
  });

  it('[edge] the highlighted row carries aria-selected="true"; the rest are false', async () => {
    render(<ChatInput onSend={vi.fn()} />);
    const ta = screen.getByTestId('chat-input-textarea');
    await userEvent.type(ta, '@');
    await userEvent.type(ta, '{ArrowDown}');

    const options = screen.getAllByRole('option');
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
    expect(options[0]).toHaveAttribute('aria-selected', 'false');
    expect(options[2]).toHaveAttribute('aria-selected', 'false');
  });

  it('[edge] Esc dismisses the dropdown; a following Enter then sends the literal text', async () => {
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} />);
    const ta = screen.getByTestId('chat-input-textarea');

    await userEvent.type(ta, '@cl');
    expect(screen.getByTestId('mention-suggestions')).toBeInTheDocument();
    await userEvent.type(ta, '{Escape}');
    expect(screen.queryByTestId('mention-suggestions')).not.toBeInTheDocument();

    await userEvent.type(ta, '{Enter}');
    // 全体 (no lock) now broadcasts: the literal text is sent with the @all token
    // prepended (F078) — the keyboard behavior under test (Esc → Enter sends) is intact.
    expect(onSend).toHaveBeenCalledWith('@all @cl');
  });

  it('[edge] typing more after Esc re-opens the dropdown (dismiss is per-token)', async () => {
    render(<ChatInput onSend={vi.fn()} />);
    const ta = screen.getByTestId('chat-input-textarea');
    await userEvent.type(ta, '@cl');
    await userEvent.type(ta, '{Escape}');
    expect(screen.queryByTestId('mention-suggestions')).not.toBeInTheDocument();
    await userEvent.type(ta, 'a'); // token "cla" — changed → re-opens
    expect(screen.getByTestId('mention-suggestions')).toBeInTheDocument();
  });

  it('Enter with NO open dropdown still submits (regression)', async () => {
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} />);
    const ta = screen.getByTestId('chat-input-textarea');
    await userEvent.type(ta, '审查这段实现');
    await userEvent.type(ta, '{Enter}');
    // Enter submits as before; 全体 now broadcasts so @all is prepended (F078).
    expect(onSend).toHaveBeenCalledWith('@all 审查这段实现');
  });

  it('[adversarial] Enter while the dropdown is open never reaches onSend even with trailing prose intent', async () => {
    const onSend = vi.fn();
    render(<ChatInput onSend={onSend} />);
    const ta = screen.getByTestId('chat-input-textarea') as HTMLTextAreaElement;
    // A completed mention + space + a fresh "@cod" open token: Enter must pick, not send.
    await userEvent.type(ta, '@claude 先定方案，再 @cod');
    await userEvent.type(ta, '{Enter}');
    expect(onSend).not.toHaveBeenCalled();
    expect(ta.value).toBe('@claude 先定方案，再 @codex ');
  });
});

/* ========================================================================== *
 * (2a) highlightCode + langFromPath (pure)
 * ========================================================================== */
describe('langFromPath', () => {
  it('maps common extensions to a language family', () => {
    expect(langFromPath('src/app.ts')).toBe('js');
    expect(langFromPath('Component.TSX')).toBe('js');
    expect(langFromPath('scripts/build.mjs')).toBe('js');
    expect(langFromPath('train.py')).toBe('py');
    expect(langFromPath('deploy.sh')).toBe('shell');
    expect(langFromPath('config.YAML')).toBe('shell');
    expect(langFromPath('main.go')).toBe('generic');
  });

  it('[edge] a path with no extension falls back to generic', () => {
    expect(langFromPath('Makefile')).toBe('generic');
    expect(langFromPath('/etc/hosts')).toBe('generic');
  });
});

describe('highlightCode', () => {
  it('classifies TS keywords, strings, numbers, and line comments', () => {
    const tokens = highlightCode('const limit = 42; // max retries', 'js');
    const kw = tokens.filter((t) => t.cls === 'kw').map((t) => t.text);
    expect(kw).toContain('const');
    expect(tokens.find((t) => t.cls === 'num')?.text).toBe('42');
    expect(tokens.find((t) => t.cls === 'com')?.text).toBe('// max retries');
  });

  it('classifies a TS string literal', () => {
    const tokens = highlightCode('const name = "Claude";', 'js');
    expect(tokens.find((t) => t.cls === 'str')?.text).toBe('"Claude"');
  });

  it('uses # for Python comments (not //)', () => {
    const tokens = highlightCode('x = 1  # 注释', 'py');
    expect(tokens.find((t) => t.cls === 'com')?.text).toBe('# 注释');
    expect(tokens.find((t) => t.cls === 'num')?.text).toBe('1');
    // In Python `def` is a keyword but `x` is a plain identifier.
    expect(tokens.find((t) => t.text === 'x')?.cls).toBeUndefined();
  });

  it('[edge] an empty line yields no tokens', () => {
    expect(highlightCode('', 'js')).toEqual([]);
  });

  it('[edge] the diff marker prefix stays uncolored (a plain gap), code after it is highlighted', () => {
    const tokens = highlightCode('+ return value', 'js');
    expect(tokens[0]?.cls).toBeUndefined(); // "+ " marker is plain
    expect(tokens.find((t) => t.cls === 'kw')?.text).toBe('return');
  });

  it('[edge] reconstruction invariant: joined token text equals the input exactly', () => {
    const lines = [
      'const s = "a\\tb"; // tab inside',
      '    if (x === 0xFF) { return; }',
      'def fn(a, b):  # py',
      '名字 := "你好世界"  // CJK ident + string',
      ')))   ;;; => <=>',
    ];
    for (const line of lines) {
      const joined = highlightCode(line, 'js').map((t) => t.text).join('');
      expect(joined).toBe(line);
    }
  });

  it('[adversarial] an unterminated string does not throw and preserves the text', () => {
    const line = 'const broken = "no closing quote';
    const tokens = highlightCode(line, 'js');
    expect(tokens.map((t) => t.text).join('')).toBe(line);
    // No string token is emitted (the quote never closes).
    expect(tokens.some((t) => t.cls === 'str')).toBe(false);
  });

  it('[adversarial] a line of only operators/punctuation produces no colored tokens', () => {
    const tokens = highlightCode('=> { } ( ) ; , && || ??', 'js');
    expect(tokens.every((t) => t.cls === undefined)).toBe(true);
  });
});

/* ========================================================================== *
 * (2b) renderForToolBlock — Edit/str_replace/Write → diff
 * ========================================================================== */
describe('renderForToolBlock (code-edit → diff)', () => {
  it('an Edit (old_string/new_string) becomes a diff with content-derived counts', () => {
    const r = renderForToolBlock({
      toolUseId: 't',
      toolName: 'Edit',
      toolInput: {
        file_path: 'src/hello.ts',
        old_string: 'console.log(greet("World"));',
        new_string: 'for (let i = 0; i < 4; i++) {\n  console.log(greet("World"));\n}',
      },
    });
    expect(r.kind).toBe('diff');
    if (r.kind === 'diff') {
      expect(r.file).toBe('src/hello.ts');
      expect(r.lang).toBe('js');
      expect(r.removed).toBe(1);
      expect(r.added).toBe(3);
      expect(r.lines.filter((l) => l.kind === 'del')).toHaveLength(1);
      expect(r.lines.filter((l) => l.kind === 'add')).toHaveLength(3);
    }
  });

  it('a str_replace_editor edit (old_str/new_str) also becomes a diff', () => {
    const r = renderForToolBlock({
      toolName: 'str_replace_editor',
      toolInput: { path: 'app/main.py', old_str: 'x = 1', new_str: 'x = 2\ny = 3' },
    });
    expect(r.kind).toBe('diff');
    if (r.kind === 'diff') {
      expect(r.lang).toBe('py');
      expect(r.removed).toBe(1);
      expect(r.added).toBe(2);
    }
  });

  it('a Write (file_path + content) becomes an all-added diff', () => {
    const r = renderForToolBlock({
      toolName: 'Write',
      toolInput: { file_path: 'src/util.ts', content: 'export const A = 1;\nexport const B = 2;' },
    });
    expect(r.kind).toBe('diff');
    if (r.kind === 'diff') {
      expect(r.removed).toBe(0);
      expect(r.added).toBe(2);
    }
  });

  it('[edge] a deletion edit (old_string present, new_string empty) → removed lines, zero added', () => {
    const r = renderForToolBlock({
      toolName: 'Edit',
      toolInput: { file_path: 'a.ts', old_string: 'const dead = 1;\nconst alsoDead = 2;', new_string: '' },
    });
    expect(r.kind).toBe('diff');
    if (r.kind === 'diff') {
      expect(r.removed).toBe(2);
      expect(r.added).toBe(0);
    }
  });

  it('[edge] a unified-diff payload still parses as before (existing behavior preserved)', () => {
    const r = renderForToolBlock({
      toolName: 'apply_patch',
      toolInput: { path: 'src/x.ts', patch: '--- a\n+++ b\n@@ -1 +1,2 @@\n-old\n+new a\n+new b' },
    });
    expect(r.kind).toBe('diff');
    if (r.kind === 'diff') {
      expect(r.added).toBe(2);
      expect(r.removed).toBe(1);
    }
  });

  it('[adversarial] a path-only write_file (no content) stays a Tool block — never fabricate a diff', () => {
    const r = renderForToolBlock({ toolName: 'write_file', toolInput: { path: 'src/todo.ts' } });
    expect(r.kind).toBe('tool');
  });

  it('[adversarial] a non-edit tool carrying a "content" field is NOT turned into a diff', () => {
    const r = renderForToolBlock({ toolName: 'post_message', toolInput: { content: 'hi team', channel: 'general' } });
    expect(r.kind).toBe('tool');
  });
});

/* ========================================================================== *
 * (2c) Diff + AgentMessage rendering with highlighting
 * ========================================================================== */
describe('Diff renders syntax-highlighted token spans', () => {
  it('colors keywords, strings, numbers and comments inside the diff body', () => {
    const { container } = render(
      <Diff
        file="bootstrap.ts"
        lang="js"
        added={1}
        removed={1}
        lines={[
          { text: '- const a = "old";', kind: 'del' },
          { text: '+ let b = 42; // new', kind: 'add' },
        ]}
      />,
    );
    const cls = (sel: string): string[] =>
      Array.from(container.querySelectorAll(sel)).map((el) => el.textContent ?? '');
    expect(cls('.tk-kw')).toEqual(expect.arrayContaining(['const', 'let']));
    expect(cls('.tk-str')).toContain('"old"');
    expect(cls('.tk-num')).toContain('42');
    expect(cls('.tk-com')).toContain('// new');
  });
});

describe('AgentMessage renders an Edit tool as a highlighted diff (not raw JSON)', () => {
  function editView(): AgentMessageView {
    return {
      agentId: CLAUDE,
      displayName: 'Claude',
      text: '改好了，现在会打印 4 次。',
      thinking: '',
      toolBlocks: [
        {
          toolUseId: 'tool_1',
          toolName: 'Edit',
          toolInput: {
            file_path: 'src/hello.ts',
            old_string: 'console.log(greet("World"));',
            new_string: 'for (let i = 0; i < 4; i++) {\n  console.log(greet("World"));\n}',
          },
        },
      ],
      isStreaming: false,
      color: '#6366f1',
      model: 'Opus',
    };
  }

  it('shows a diff-block with the file header + content-derived stats, and no raw tool-use JSON block', () => {
    const { container } = render(<AgentMessage view={editView()} />);
    const block = screen.getByTestId('diff-block');
    expect(within(block).getByText('src/hello.ts')).toBeInTheDocument();
    expect(within(block).getByText('+3')).toBeInTheDocument();
    expect(within(block).getByText('−1')).toBeInTheDocument();
    // The Edit no longer dumps escaped JSON as a tool-use-block (screenshot-1 bug).
    expect(screen.queryByTestId('tool-use-block')).not.toBeInTheDocument();
    // And the code is highlighted (the `for`/`let` keywords are colored).
    const kw = Array.from(container.querySelectorAll('.tk-kw')).map((el) => el.textContent);
    expect(kw).toEqual(expect.arrayContaining(['for', 'let']));
  });
});
