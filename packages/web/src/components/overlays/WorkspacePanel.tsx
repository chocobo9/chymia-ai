// WorkspacePanel (Workspace) — a docked right surface opened from the header
// panel button (and the StatusBar's 查看日志 / expand affordances). Five tabs
// matching the Claude-Design:
//   开发 (FILES/CHANGES/GIT/TERM) · 记忆 · 调度 · 任务 · 社区.
//
// WIRING (live vs honest-empty):
//   • 记忆 — LIVE: queries GET evidence search (WorkspaceMemory).
//   • 开发 / 调度 / 任务 / 社区 — HONEST PLACEHOLDER: there is no file-listing /
//     git / scheduler / tasks / community backend, so we render the design's
//     STRUCTURE with a clearly-marked "未接入 / 即将上线" note. We do NOT present
//     the design's mock FILES / SCHED / issues arrays as if they were live.
//
// Ported visual from choco-wsp.jsx WorkspacePanel + directions.css `.wsp-*`.

import { useState, type ReactElement } from 'react';
import type { ApiClient } from '../../lib/api.js';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss.js';
import {
  IconClose,
  IconMenu,
  IconSearch,
  IconLock,
  IconCode,
  IconMemory,
  IconClock,
  IconCheckSquare,
  IconCommunity,
  IconGrid,
} from '../choco/icons.js';
import { WorkspaceMemory } from './WorkspaceMemory.js';
import { WorkspaceTasks } from './WorkspaceTasks.js';
import { WorkspaceDev } from './WorkspaceDev.js';
import { WorkspaceAudit } from './WorkspaceAudit.js';

/** The workspace tabs. */
export type WorkspaceTab = 'dev' | 'mem' | 'sched' | 'tasks' | 'audit' | 'comm';

const TABS: readonly { readonly id: WorkspaceTab; readonly label: string; readonly icon: ReactElement }[] =
  [
    { id: 'dev', label: '开发', icon: <IconCode /> },
    { id: 'mem', label: '记忆', icon: <IconMemory /> },
    { id: 'sched', label: '调度', icon: <IconClock /> },
    { id: 'tasks', label: '任务', icon: <IconCheckSquare /> },
    { id: 'audit', label: '审计', icon: <IconGrid /> },
    { id: 'comm', label: '社区', icon: <IconCommunity /> },
  ];

interface SoonProps {
  readonly title: string;
  readonly note: string;
}

/** Honest "not yet wired" placeholder shared by the unbacked tabs. */
function SoonPane(props: SoonProps): ReactElement {
  return (
    <div className="wsp-soon" data-testid="wsp-soon">
      <span className="wsp-soon-badge">未接入</span>
      <div className="wsp-soon-t">{props.title}</div>
      <div className="wsp-soon-s">{props.note}</div>
    </div>
  );
}

function tabBody(tab: WorkspaceTab, client: ApiClient, searchQuery: string): ReactElement {
  switch (tab) {
    case 'mem':
      return <WorkspaceMemory client={client} initialQuery={searchQuery} />;
    case 'dev':
      return <WorkspaceDev client={client} />;
    case 'sched':
      return (
        <SoonPane
          title="调度尚未接入"
          note="定时任务调度器还没有后端支撑。接通后可在对话里 @ 任意 agent 创建定时任务，例如「每天早上 9 点检查新闻」。"
        />
      );
    case 'tasks':
      return <WorkspaceTasks client={client} />;
    case 'audit':
      return <WorkspaceAudit client={client} />;
    case 'comm':
      return (
        <SoonPane
          title="社区尚未接入"
          note="Issues / Pull Requests 聚合需要外部仓库集成。接通 GitHub 后这里会显示真实的社区动态。"
        />
      );
  }
}

export interface WorkspacePanelProps {
  readonly onClose: () => void;
  readonly client: ApiClient;
  /** Initial tab (default 'dev'); the StatusBar expand can deep-link a tab. */
  readonly startTab?: WorkspaceTab;
}

/** The docked Workspace panel. */
export function WorkspacePanel(props: WorkspacePanelProps): ReactElement {
  const { onClose, client, startTab = 'dev' } = props;
  const [tab, setTab] = useState<WorkspaceTab>(startTab);
  // Global search: the only real search backend is evidence (the 记忆 tab), so
  // submitting here jumps to 记忆 and runs the evidence search with the query.
  const [globalQuery, setGlobalQuery] = useState('');
  const [searchQuery, setSearchQuery] = useState('');

  const submitGlobalSearch = (): void => {
    const q = globalQuery.trim();
    if (q.length === 0) return;
    setTab('mem');
    setSearchQuery(q);
  };

  useOverlayDismiss(true, onClose);

  return (
    <div className="wsp-scrim" data-testid="workspace-panel-scrim" onClick={onClose}>
      <div
        className="wsp"
        data-testid="workspace-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Workspace"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="wsp-head">
          <span className="wsp-menu" aria-hidden="true">
            <IconMenu />
          </span>
          <b>Workspace</b>
          <span className="wsp-grow" />
          <button type="button" className="icon-btn sm" aria-label="锁定面板" disabled title="即将上线">
            <IconLock />
          </button>
          <button type="button" className="icon-btn sm" onClick={onClose} aria-label="关闭 Workspace">
            <IconClose />
          </button>
        </div>

        <form
          className="wsp-search"
          data-testid="wsp-search-form"
          onSubmit={(e) => {
            e.preventDefault();
            submitGlobalSearch();
          }}
        >
          <IconSearch />
          <input
            placeholder="搜索全部…"
            aria-label="搜索 Workspace"
            value={globalQuery}
            onChange={(e) => setGlobalQuery(e.target.value)}
            data-testid="wsp-search-input"
          />
          <span className="wsp-all">All</span>
        </form>

        <div className="wsp-tabs" role="tablist" aria-label="Workspace 标签">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={tab === t.id ? 'on' : ''}
              data-testid={`wsp-tab-${t.id}`}
              onClick={() => setTab(t.id)}
            >
              {t.icon}
              <span>{t.label}</span>
            </button>
          ))}
        </div>

        <div className="wsp-body" data-testid="workspace-panel-body">
          {tabBody(tab, client, searchQuery)}
        </div>
      </div>
    </div>
  );
}
