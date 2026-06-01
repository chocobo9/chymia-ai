// WorkspaceMemory — the 记忆 tab of the WorkspacePanel. This is the ONE
// fully-wired-to-live-backend tab: it queries the M8 evidence search route via
// apiClient.searchEvidence and renders the real EvidenceItem results, with an
// honest empty state when there are none, a loading state while in flight, and a
// degraded badge when the search degraded (e.g. lexical fallback).
//
// The doc-count stats above are NOT fabricated: they reflect the current result
// set (count of returned items) — we never show a made-up "267 文档" number.
//
// Ported visual from choco-wsp.jsx WspMemory + directions.css `.mem-*`.

import { useCallback, useState, type FormEvent, type ReactElement } from 'react';
import type { EvidenceItem, EvidenceKind } from '@clowder/shared';
import type { ApiClient } from '../../lib/api.js';
import { IconSearch } from '../choco/icons.js';

type SearchState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'loading' }
  | {
      readonly phase: 'done';
      readonly items: readonly EvidenceItem[];
      readonly degraded: boolean;
      readonly query: string;
    }
  | { readonly phase: 'error'; readonly message: string };

export interface WorkspaceMemoryProps {
  readonly client: ApiClient;
}

/** Map an evidence kind to one of the design's tag styles. */
function tagClass(kind: EvidenceKind): string {
  if (kind === 'decision' || kind === 'plan') return 'decision';
  if (kind === 'lesson') return 'lesson';
  return 'feature';
}

/** The 记忆 tab — live evidence search. */
export function WorkspaceMemory(props: WorkspaceMemoryProps): ReactElement {
  const { client } = props;
  const [query, setQuery] = useState('');
  const [state, setState] = useState<SearchState>({ phase: 'idle' });

  const runSearch = useCallback(
    async (raw: string) => {
      const trimmed = raw.trim();
      if (trimmed.length === 0) {
        setState({ phase: 'idle' });
        return;
      }
      setState({ phase: 'loading' });
      try {
        const result = await client.searchEvidence(trimmed, { mode: 'hybrid', limit: 10 });
        setState({
          phase: 'done',
          items: result.items,
          degraded: result.meta.degraded,
          query: trimmed,
        });
      } catch (err) {
        setState({ phase: 'error', message: err instanceof Error ? err.message : '检索失败' });
      }
    },
    [client],
  );

  const onSubmit = useCallback(
    (e: FormEvent): void => {
      e.preventDefault();
      void runSearch(query);
    },
    [query, runSearch],
  );

  const resultCount = state.phase === 'done' ? state.items.length : 0;

  return (
    <div className="wsp-pad" data-testid="wsp-memory">
      <form className="mem-search" onSubmit={onSubmit} data-testid="mem-search-form">
        <IconSearch />
        <input
          placeholder="搜索共享记忆 / evidence…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          data-testid="mem-search-input"
          aria-label="搜索共享记忆"
        />
      </form>

      <div className="mem-stats">
        <div className="mem-stat">
          <div className="mem-k">命中</div>
          <div className="mem-v">{resultCount}</div>
        </div>
        <div className="mem-stat">
          <div className="mem-k">模式</div>
          <div className="mem-v" style={{ fontSize: '13px' }}>
            {state.phase === 'done' && state.degraded ? '降级' : 'hybrid'}
          </div>
        </div>
      </div>

      <div className="wsp-sec-t">
        检索结果
        {state.phase === 'done' && state.degraded && (
          <span className="mem-degraded" data-testid="mem-degraded">
            已降级为词法检索
          </span>
        )}
      </div>

      {state.phase === 'idle' && (
        <div className="mem-empty" data-testid="mem-idle">
          输入关键词检索团队共享记忆。
        </div>
      )}
      {state.phase === 'loading' && (
        <div className="mem-loading" data-testid="mem-loading">
          检索中…
        </div>
      )}
      {state.phase === 'error' && (
        <div className="mem-empty" data-testid="mem-error" role="alert">
          检索出错：{state.message}
        </div>
      )}
      {state.phase === 'done' &&
        state.items.map((item) => (
          <div key={item.anchor} className="mem-item" data-testid="mem-item">
            <span className={`mem-tag ${tagClass(item.kind)}`}>{item.kind}</span>
            <div className="mem-text">
              <div className="mem-text-t">{item.title}</div>
              {item.summary !== undefined && item.summary.length > 0 && (
                <div className="mem-text-s">{item.summary}</div>
              )}
            </div>
          </div>
        ))}
      {state.phase === 'done' && state.items.length === 0 && (
        <div className="mem-empty" data-testid="mem-empty">
          没有匹配「{state.query}」的记忆。
        </div>
      )}
    </div>
  );
}
