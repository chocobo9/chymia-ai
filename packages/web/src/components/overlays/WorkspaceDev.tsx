// WorkspaceDev — the 开发 tab of the WorkspacePanel. Three read-only sub-views,
// all LIVE against the server's workspace root:
//   文件 — lazy file tree (GET /api/workspace/tree); click a file → preview it.
//   变更 — changed files + unified diff (GET /api/workspace/diff).
//   Git  — branch + working-tree status + commit log (GET /api/workspace/git-*).
// Terminal is a separate follow-up (node-pty) — deliberately not here.
//
// Aligned to Clowder workspace/{WorkspaceTree,ChangesPanel,GitPanel,DiffViewer}.
// Re-written with choco's CSS (ft-*/chg-*/git-*/wsp-subtabs already in the design
// sheet). When the workspace is not a git repo, the git views say so honestly
// (gitAvailable=false) — never a fabricated branch/history.

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import type {
  ApiClient,
  GitCommitEntry,
  GitStatusView,
  WorkspaceDiffView,
  WorkspaceTreeEntry,
} from '../../lib/api.js';
import { parseUnifiedDiff } from '../../lib/parse-diff.js';

type DevView = 'files' | 'changes' | 'git';

const SUBTABS: readonly { readonly id: DevView; readonly label: string }[] = [
  { id: 'files', label: '文件' },
  { id: 'changes', label: '变更' },
  { id: 'git', label: 'Git' },
];

/** Root key for the tree's children map (the workspace root itself). */
const ROOT_KEY = '';

/* ── 文件: lazy file tree + preview ─────────────────────────────────── */

function DevFiles({ client }: { client: ApiClient }): ReactElement {
  const [childrenByPath, setChildrenByPath] = useState<Record<string, readonly WorkspaceTreeEntry[]>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState('');

  const loadDir = useCallback(
    async (path: string): Promise<void> => {
      try {
        const entries = await client.getWorkspaceTree(path);
        setChildrenByPath((prev) => ({ ...prev, [path]: entries }));
      } catch {
        setError('读取目录失败');
      }
    },
    [client],
  );

  useEffect(() => {
    void loadDir(ROOT_KEY);
  }, [loadDir]);

  const toggleDir = (path: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
        if (childrenByPath[path] === undefined) void loadDir(path);
      }
      return next;
    });
  };

  const openFile = (path: string): void => {
    setSelected(path);
    setPreview(null);
    client
      .getWorkspaceFile(path)
      .then((content) => setPreview(content))
      .catch(() => setPreview('（无法预览此文件）'));
  };

  const renderLevel = (parentPath: string, depth: number): ReactElement[] => {
    const entries = childrenByPath[parentPath] ?? [];
    const rows: ReactElement[] = [];
    for (const entry of entries) {
      const isDir = entry.type === 'directory';
      const isOpen = expanded.has(entry.path);
      rows.push(
        <button
          key={entry.path}
          type="button"
          className={`ft-row ${isDir ? 'dir' : ''}`}
          style={{ paddingLeft: `${depth * 14}px` }}
          data-testid={isDir ? 'ft-dir' : 'ft-file'}
          onClick={() => (isDir ? toggleDir(entry.path) : openFile(entry.path))}
        >
          <span className="ft-ic">{isDir ? (isOpen ? '▾' : '▸') : '·'}</span>
          <span className="ft-name">{entry.name}</span>
        </button>,
      );
      if (isDir && isOpen) rows.push(...renderLevel(entry.path, depth + 1));
    }
    return rows;
  };

  return (
    <div className="wsp-pad" data-testid="dev-files">
      {error.length > 0 && <div className="mem-empty" role="alert">{error}</div>}
      <div className="ft-tree">{renderLevel(ROOT_KEY, 0)}</div>
      {selected !== null && (
        <div className="dev-preview" data-testid="dev-file-preview">
          <div className="wsp-sec-t">{selected}</div>
          <pre className="wsp-term">{preview ?? '加载中…'}</pre>
        </div>
      )}
    </div>
  );
}

/* ── 变更: changed files + unified diff ─────────────────────────────── */

function statusClass(status: string): string {
  if (status.startsWith('A') || status === '??') return 'add';
  if (status.startsWith('D')) return 'del';
  return 'mod';
}

function DevChanges({ client }: { client: ApiClient }): ReactElement {
  const [data, setData] = useState<WorkspaceDiffView | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    client
      .getWorkspaceDiff()
      .then((d) => !cancelled && setData(d))
      .catch(() => !cancelled && setData(null))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [client]);

  if (loading) return <div className="wsp-pad mem-loading" data-testid="dev-changes-loading">加载中…</div>;
  if (data === null || !data.gitAvailable) {
    return (
      <div className="wsp-pad mem-empty" data-testid="dev-git-unavailable">
        当前工作区不是 Git 仓库，无变更可显示。
      </div>
    );
  }
  if (data.changedFiles.length === 0) {
    return <div className="wsp-pad mem-empty" data-testid="dev-changes-clean">工作区干净，没有未提交的变更。</div>;
  }

  const fileDiffs = parseUnifiedDiff(data.diff);

  return (
    <div className="wsp-pad" data-testid="dev-changes">
      <div className="chg-sum">{data.changedFiles.length} 个文件有改动</div>
      {data.changedFiles.map((f) => (
        <div key={f.path} className="chg-row" data-testid="chg-row">
          <code>{f.path}</code>
          <span className={`chg-n ${statusClass(f.status)}`}>{f.status || 'M'}</span>
        </div>
      ))}
      {fileDiffs.map((fd) => (
        <div key={fd.path} className="dev-diff" data-testid="dev-diff-file">
          <div className="wsp-sec-t">{fd.path}</div>
          <pre className="dev-diff-body">
            {fd.lines.map((l, i) => (
              <div key={i} className={`diffl ${l.type}`}>
                {l.type === 'add' ? '+' : l.type === 'remove' ? '-' : ' '}
                {l.content}
              </div>
            ))}
          </pre>
        </div>
      ))}
    </div>
  );
}

/* ── Git: branch + status + log ─────────────────────────────────────── */

function relativeDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const mins = Math.floor((Date.now() - t) / 60_000);
  if (mins < 60) return `${Math.max(0, mins)}分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}小时前`;
  return `${Math.floor(hours / 24)}天前`;
}

function DevGit({ client }: { client: ApiClient }): ReactElement {
  const [status, setStatus] = useState<GitStatusView | null>(null);
  const [commits, setCommits] = useState<readonly GitCommitEntry[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    Promise.all([client.getGitStatus(), client.getGitLog()])
      .then(([s, c]) => {
        if (cancelled) return;
        setStatus(s);
        setCommits(c);
      })
      .catch(() => {
        if (!cancelled) setStatus(null);
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [client]);

  if (loading) return <div className="wsp-pad mem-loading" data-testid="dev-git-loading">加载中…</div>;
  if (status === null || !status.gitAvailable) {
    return (
      <div className="wsp-pad mem-empty" data-testid="dev-git-unavailable">
        当前工作区不是 Git 仓库。
      </div>
    );
  }

  const changedCount = status.staged.length + status.unstaged.length + status.untracked.length;

  return (
    <div className="wsp-pad" data-testid="dev-git">
      <div className="git-branch">
        <span className="git-dot" />
        {status.branch.length > 0 ? status.branch : '(detached)'}
        <span className="git-ahead">
          {changedCount === 0 ? '工作区干净' : `${changedCount} 处改动`}
        </span>
      </div>
      {changedCount > 0 && (
        <div className="chg-sum" data-testid="dev-git-status">
          暂存 {status.staged.length} · 未暂存 {status.unstaged.length} · 未跟踪 {status.untracked.length}
        </div>
      )}
      {(commits ?? []).map((c) => (
        <div key={c.hash} className="git-row" data-testid="git-commit">
          <span className="git-hash">{c.short}</span>
          <span className="git-msg">
            {c.subject}
            <span className="git-meta">
              {c.author} · {relativeDate(c.date)}
            </span>
          </span>
        </div>
      ))}
      {(commits ?? []).length === 0 && <div className="mem-empty">还没有提交记录。</div>}
    </div>
  );
}

/* ── Shell ──────────────────────────────────────────────────────────── */

export interface WorkspaceDevProps {
  readonly client: ApiClient;
}

/** The 开发 tab — file tree / changes / git sub-views. */
export function WorkspaceDev(props: WorkspaceDevProps): ReactElement {
  const { client } = props;
  const [view, setView] = useState<DevView>('files');

  return (
    <div data-testid="wsp-dev">
      <div className="wsp-subtabs" role="tablist" aria-label="开发子视图">
        {SUBTABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={view === t.id}
            className={view === t.id ? 'on' : ''}
            data-testid={`dev-subtab-${t.id}`}
            onClick={() => setView(t.id)}
          >
            <span>{t.label}</span>
          </button>
        ))}
      </div>
      {view === 'files' && <DevFiles client={client} />}
      {view === 'changes' && <DevChanges client={client} />}
      {view === 'git' && <DevGit client={client} />}
    </div>
  );
}
