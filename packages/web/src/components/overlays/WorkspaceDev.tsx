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

import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import type {
  ApiClient,
  GitCommitEntry,
  GitShowFile,
  GitStatusView,
  WorkspaceFilePreview,
  WorkspaceInfo,
  WorkspaceSearchResult,
  WorkspaceSearchType,
  WorkspaceDiffView,
  WorkspaceTreeEntry,
} from '../../lib/api.js';
import { parseUnifiedDiff } from '../../lib/parse-diff.js';

/** Classify a file path as streamable media (→ rendered via GET /file/raw) or null. */
function mediaKind(path: string): 'image' | 'video' | 'audio' | null {
  const ext = path.slice(path.lastIndexOf('.')).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif'].includes(ext)) return 'image';
  if (['.mp4', '.webm', '.mov'].includes(ext)) return 'video';
  if (['.mp3', '.wav', '.ogg', '.m4a'].includes(ext)) return 'audio';
  return null;
}

type DevView = 'files' | 'changes' | 'git';

const SUBTABS: readonly { readonly id: DevView; readonly label: string }[] = [
  { id: 'files', label: '文件' },
  { id: 'changes', label: '变更' },
  { id: 'git', label: 'Git' },
];

/** Root key for the tree's children map (the workspace root itself). */
const ROOT_KEY = '';
const SEARCH_TYPES: readonly { readonly id: WorkspaceSearchType; readonly label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'filename', label: 'File' },
  { id: 'content', label: 'Aa' },
];

function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i <= 0 ? '' : path.slice(0, i);
}

function absolutePath(root: string, rel: string): string {
  if (rel.length === 0) return root;
  const slash = root.includes('\\') || /^[A-Za-z]:/.test(root) ? '\\' : '/';
  return `${root.replace(/[\\/]+$/, '')}${slash}${rel.split('/').join(slash)}`;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function lineCount(content: string): number {
  if (content.length === 0) return 0;
  return content.split(/\r?\n/).length;
}

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/* ── 文件: lazy file tree + preview ─────────────────────────────────── */

export function DevFiles({ client }: { client: ApiClient }): ReactElement {
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
      .then((file) => setPreview(file.content))
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

function DevFilesAligned({ client }: { client: ApiClient }): ReactElement {
  const [childrenByPath, setChildrenByPath] = useState<Record<string, readonly WorkspaceTreeEntry[]>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<WorkspaceFilePreview | null>(null);
  const [info, setInfo] = useState<WorkspaceInfo | null>(null);
  const [query, setQuery] = useState('');
  const [searchType, setSearchType] = useState<WorkspaceSearchType>('all');
  const [results, setResults] = useState<readonly WorkspaceSearchResult[]>([]);
  const [error, setError] = useState('');
  const uploadInputRef = useRef<HTMLInputElement | null>(null);

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
    if (typeof client.getWorkspaceInfo === 'function') {
      client.getWorkspaceInfo().then(setInfo).catch(() => setInfo(null));
    }
  }, [client, loadDir]);

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
      .then(setPreview)
      .catch(() =>
        setPreview({
          path,
          content: '(unable to preview this file)',
          sha256: '',
          size: 0,
          mime: 'text/plain',
          truncated: false,
          binary: false,
        }),
      );
  };

  const runSearch = (): void => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setResults([]);
      return;
    }
    client.searchWorkspace(trimmed, searchType).then(setResults).catch(() => setError('搜索失败'));
  };

  const uploadSelectedFile = (file: File): void => {
    const targetDir = selected === null ? ROOT_KEY : dirname(selected);
    fileToBase64(file)
      .then((contentBase64) =>
        client.uploadWorkspaceFile({ directory: targetDir, filename: file.name, contentBase64 }),
      )
      .then((uploaded) => {
        void loadDir(targetDir);
        openFile(uploaded.path);
      })
      .catch(() => setError('上传失败'));
  };

  const root = info?.root ?? '';
  const selectedAbs = selected !== null && root.length > 0 ? absolutePath(root, selected) : '';

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
          title={entry.path}
          onClick={() => (isDir ? toggleDir(entry.path) : openFile(entry.path))}
        >
          <span className="ft-ic">{isDir ? (isOpen ? 'v' : '>') : '-'}</span>
          <span className="ft-name">{entry.name}</span>
        </button>,
      );
      if (isDir && isOpen) rows.push(...renderLevel(entry.path, depth + 1));
    }
    return rows;
  };

  return (
    <div className="wsp-pad" data-testid="dev-files">
      <div className="ft-worktree" data-testid="workspace-root">
        Root <b>{root.length > 0 ? root : 'loading...'}</b>
        {info !== null && !info.trusted && <span className="mem-degraded">untrusted</span>}
      </div>
      {root.endsWith('.workspace') && (
        <div className="wsp-preview-note" role="note">
          当前 agent 只能操作 .workspace，不能直接修改父级源码目录。
        </div>
      )}
      <form
        className="wsp-search dev-search"
        onSubmit={(event) => {
          event.preventDefault();
          runSearch();
        }}
      >
        <input
          value={query}
          aria-label="Search workspace"
          placeholder="Search files"
          onChange={(event) => setQuery(event.currentTarget.value)}
        />
        <div className="dev-search-modes" role="group" aria-label="Search mode">
          {SEARCH_TYPES.map((t) => (
            <button
              key={t.id}
              type="button"
              className={searchType === t.id ? 'on' : ''}
              onClick={() => setSearchType(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button type="submit" className="tsk-btn">Search</button>
        <button type="button" className="tsk-btn ghost" onClick={() => uploadInputRef.current?.click()}>
          Upload
        </button>
        <input
          ref={uploadInputRef}
          type="file"
          className="dev-upload-input"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = '';
            if (file !== undefined) uploadSelectedFile(file);
          }}
        />
      </form>
      {error.length > 0 && <div className="mem-empty" role="alert">{error}</div>}
      {results.length > 0 && (
        <div className="dev-search-results" data-testid="workspace-search-results">
          {results.map((r, index) => (
            <button
              key={`${r.path}:${r.line}:${index}`}
              type="button"
              className="dev-search-result"
              onClick={() => openFile(r.path)}
            >
              <code>{r.path}{r.line > 0 ? `:${r.line}` : ''}</code>
              <span>{r.content}</span>
            </button>
          ))}
        </div>
      )}
      <div className="ft-tree">{renderLevel(ROOT_KEY, 0)}</div>
      {selected !== null && (
        <div className="dev-preview" data-testid="dev-file-preview">
          <div className="dev-preview-head">
            <div>
              <div className="wsp-sec-t">{selected}</div>
              {preview !== null && (
                <div className="dev-file-meta">
                  {formatBytes(preview.size)} · {lineCount(preview.content)} lines · {preview.sha256.slice(0, 8)}
                </div>
              )}
            </div>
            <div className="dev-file-actions">
              <button type="button" onClick={() => void navigator.clipboard?.writeText(selected)}>
                复制相对路径
              </button>
              <button
                type="button"
                disabled={selectedAbs.length === 0}
                onClick={() => void navigator.clipboard?.writeText(selectedAbs)}
              >
                复制绝对路径
              </button>
              <button type="button" onClick={() => void client.revealFile(selected, 'reveal')}>
                在文件夹中显示
              </button>
            </div>
          </div>
          {(() => {
            const kind = mediaKind(selected);
            if (kind !== null) {
              const src = client.workspaceRawUrl(selected);
              if (kind === 'image') return <img className="dev-media" src={src} alt={selected} data-testid="dev-media-image" />;
              if (kind === 'video') return <video className="dev-media" src={src} controls data-testid="dev-media-video" />;
              return <audio src={src} controls data-testid="dev-media-audio" />;
            }
            return (
              <pre className="wsp-term">
                {preview?.binary === true ? '(binary file)' : preview?.content ?? '加载中...'}
              </pre>
            );
          })()}
        </div>
      )}
    </div>
  );
}

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
                <span className="diffl-ln" data-testid="diffl-old">{l.type === 'meta' ? '' : l.oldLine ?? ''}</span>
                <span className="diffl-ln" data-testid="diffl-new">{l.type === 'meta' ? '' : l.newLine ?? ''}</span>
                <span className="diffl-sign">{l.type === 'add' ? '+' : l.type === 'remove' ? '-' : ' '}</span>
                <span className="diffl-txt">{l.content}</span>
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
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filesByHash, setFilesByHash] = useState<Record<string, readonly GitShowFile[]>>({});

  const toggleCommit = (hash: string): void => {
    setExpanded((prev) => (prev === hash ? null : hash));
    if (filesByHash[hash] === undefined) {
      client
        .getGitShow(hash)
        .then((r) => setFilesByHash((prev) => ({ ...prev, [hash]: r.files })))
        .catch(() => setFilesByHash((prev) => ({ ...prev, [hash]: [] })));
    }
  };

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
        <div key={c.hash} className="git-commit-wrap">
          <button
            type="button"
            className="git-row"
            data-testid="git-commit"
            aria-expanded={expanded === c.hash}
            onClick={() => toggleCommit(c.hash)}
          >
            <span className="git-hash">{c.short}</span>
            <span className="git-msg">
              {c.subject}
              <span className="git-meta">
                {c.author} · {relativeDate(c.date)}
              </span>
            </span>
          </button>
          {expanded === c.hash && (
            <div className="git-show-files" data-testid="git-show-files">
              {filesByHash[c.hash] === undefined ? (
                <div className="mem-empty">加载中…</div>
              ) : filesByHash[c.hash].length === 0 ? (
                <div className="mem-empty">（无文件变更）</div>
              ) : (
                filesByHash[c.hash].map((f) => (
                  <div key={f.path} className="git-show-file" data-testid="git-show-file">
                    <code>{f.path}</code>
                    <span className="git-show-stat">{f.summary}</span>
                  </div>
                ))
              )}
            </div>
          )}
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
      {view === 'files' && <DevFilesAligned client={client} />}
      {view === 'changes' && <DevChanges client={client} />}
      {view === 'git' && <DevGit client={client} />}
    </div>
  );
}
