// @vitest-environment jsdom
//
// WorkspaceDev — the operable 开发 tab (file tree / 变更 / Git). Renders the
// component against a fake /api/workspace/* backend and exercises the real flows:
// lazy tree expand + file preview, the changes diff, and the git log/status view.
// Proves the dev tab DOES things (operable), it isn't a placeholder.

import '@testing-library/jest-dom';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiClient } from '../../packages/web/src/lib/api.js';
import { WorkspaceDev } from '../../packages/web/src/components/overlays/WorkspaceDev.js';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/** A fake workspace: root has src/ + README.md; src/ has index.ts; one diff + one commit. */
function fakeClient(): ApiClient {
  const fetchFn = (input: string | URL | Request): Promise<Response> => {
    const u = new URL(String(input), 'http://test');
    const p = u.pathname;
    const path = u.searchParams.get('path') ?? '';
    if (p === '/api/workspace/tree') {
      if (path === 'src') {
        return Promise.resolve(json({ root: 'src', entries: [{ name: 'index.ts', type: 'file', path: 'src/index.ts' }] }));
      }
      return Promise.resolve(
        json({
          root: '.',
          entries: [
            { name: 'src', type: 'directory', path: 'src' },
            { name: 'README.md', type: 'file', path: 'README.md' },
          ],
        }),
      );
    }
    if (p === '/api/workspace/file') {
      return Promise.resolve(
        json({
          path,
          content: 'export const x = 2;\n',
          sha256: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
          size: 20,
          mime: 'text/typescript',
          truncated: false,
          binary: false,
        }),
      );
    }
    if (p === '/api/workspace/info') {
      return Promise.resolve(json({ root: 'D:\\proj\\choco-ai', trusted: true, rootSource: 'fileRoot', gitAvailable: true, branch: 'main' }));
    }
    if (p === '/api/workspace/search') {
      return Promise.resolve(
        json({
          results: [
            {
              path: 'src/index.ts',
              line: 1,
              content: 'export const x = 2;',
              contextBefore: [],
              contextAfter: [],
              matchType: 'content',
            },
          ],
        }),
      );
    }
    if (p === '/api/workspace/upload') {
      return Promise.resolve(json({ ok: true, path: 'src/upload.txt', size: 5, sha256: 'abc' }));
    }
    if (p === '/api/workspace/git-status') {
      return Promise.resolve(
        json({
          branch: 'main',
          staged: [{ status: 'A', path: 'added.ts' }],
          unstaged: [{ status: 'M', path: 'src/index.ts' }],
          untracked: [],
          gitAvailable: true,
        }),
      );
    }
    if (p === '/api/workspace/git-log') {
      return Promise.resolve(
        json({
          commits: [
            { hash: 'abc123def456', short: 'abc123de', author: '铲屎官', date: '2026-06-05T10:00:00+08:00', subject: '对齐开发 tab' },
          ],
        }),
      );
    }
    if (p === '/api/workspace/diff') {
      return Promise.resolve(
        json({
          changedFiles: [{ status: 'M', path: 'src/index.ts' }],
          diff:
            'diff --git a/src/index.ts b/src/index.ts\n@@ -1 +1 @@\n-export const x = 1;\n+export const x = 2;\n',
          gitAvailable: true,
        }),
      );
    }
    return Promise.resolve(json({ error: 'unhandled' }, 500));
  };
  return new ApiClient({ baseUrl: 'http://test', fetchFn });
}

afterEach(cleanup);

describe('WorkspaceDev — operable 开发 tab', () => {
  it('[files] lists the tree, lazy-expands a directory, and previews a clicked file', async () => {
    render(<WorkspaceDev client={fakeClient()} />);
    // Root entries load.
    expect(await screen.findByText('src')).toBeInTheDocument();
    expect(screen.getByText('README.md')).toBeInTheDocument();
    expect(await screen.findByTestId('workspace-root')).toHaveTextContent('D:\\proj\\choco-ai');

    // Expand src/ → its child appears (lazy-loaded).
    await userEvent.click(screen.getByText('src'));
    expect(await screen.findByText('index.ts')).toBeInTheDocument();

    // Click the file → its content previews.
    await userEvent.click(screen.getByText('README.md'));
    const preview = await screen.findByTestId('dev-file-preview');
    expect(preview).toHaveTextContent('export const x = 2;');
    expect(preview).toHaveTextContent('abcdef01');
  });

  it('[files] searches workspace content and opens a search result', async () => {
    render(<WorkspaceDev client={fakeClient()} />);
    await userEvent.type(await screen.findByLabelText('Search workspace'), 'export');
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    const results = await screen.findByTestId('workspace-search-results');
    expect(results).toHaveTextContent('src/index.ts:1');
    await userEvent.click(screen.getByText('export const x = 2;'));
    expect(await screen.findByTestId('dev-file-preview')).toHaveTextContent('src/index.ts');
  });

  it('[changes] shows changed files and the colored unified diff', async () => {
    render(<WorkspaceDev client={fakeClient()} />);
    await userEvent.click(screen.getByTestId('dev-subtab-changes'));
    expect(await screen.findByTestId('dev-changes')).toBeInTheDocument();
    expect(screen.getByTestId('chg-row')).toHaveTextContent('src/index.ts');
    // The added line is rendered.
    expect(screen.getByTestId('dev-diff-file')).toHaveTextContent('export const x = 2;');
  });

  it('[git] shows the branch, status counts, and the commit log', async () => {
    render(<WorkspaceDev client={fakeClient()} />);
    await userEvent.click(screen.getByTestId('dev-subtab-git'));
    const git = await screen.findByTestId('dev-git');
    expect(git).toHaveTextContent('main');
    await waitFor(() => expect(screen.getByTestId('git-commit')).toHaveTextContent('对齐开发 tab'));
    expect(screen.getByTestId('dev-git-status')).toHaveTextContent('未暂存 1');
  });

  it('[honest] a non-git workspace says so, never a fabricated branch', async () => {
    const fetchFn = (input: string | URL | Request): Promise<Response> => {
      const p = new URL(String(input), 'http://test').pathname;
      if (p === '/api/workspace/git-status') {
        return Promise.resolve(json({ branch: '', staged: [], unstaged: [], untracked: [], gitAvailable: false }));
      }
      if (p === '/api/workspace/git-log') return Promise.resolve(json({ commits: [] }));
      return Promise.resolve(json({ entries: [] }));
    };
    render(<WorkspaceDev client={new ApiClient({ baseUrl: 'http://test', fetchFn })} />);
    await userEvent.click(screen.getByTestId('dev-subtab-git'));
    expect(await screen.findByTestId('dev-git-unavailable')).toBeInTheDocument();
  });
});
