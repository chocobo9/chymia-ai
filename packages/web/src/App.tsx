// M9 App — top-level layout + data wiring for the web client, skinned as the
// .d-choco core workspace: a `ws` shell (header + 3 columns).
//
// Layout: header (brand + live online/idle chip + deferred bell/panel buttons) |
// col-threads (ThreadList) | col-main (ChatContainer + composer ChatInput) |
// col-status (AgentStatus / StatusBar). On mount it loads the agent roster
// (GET /api/agents) and thread list (GET /api/threads) into the stores, and
// opens the Socket.io connection (useSocket) which dispatches live frames into
// the stores. Selecting/creating a thread loads its history and sets it active
// (which drives the room join).
//
// G8: sendMessage POSTs synchronously (resolves post-turn); the transcript fills
// incrementally from agent_event socket frames meanwhile, then reconciles the
// final persisted replies from the POST result.
//
// Overlays opened from the shell: the header bell (NotifInbox), panel button
// (WorkspacePanel), a grid button (MonitorGrid), and the owner gear
// (SettingsOverlay) — see frontend SCOPE.

import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import type { Thread } from '@choco/shared';
import { apiClient, ApiClient } from './lib/api.js';
import { useChatStore } from './stores/chat-store.js';
import { useAgentStore } from './stores/agent-store.js';
import { useSocket, type SocketConnector } from './hooks/useSocket.js';
import { useHealth } from './hooks/useHealth.js';
import { ThreadList } from './components/ThreadList.js';
import { ChatContainer } from './components/ChatContainer.js';
import { ChatInput } from './components/ChatInput.js';
import { AgentStatus } from './components/AgentStatus.js';
import { IconBell, IconPanel, IconHash, IconGrid } from './components/choco/icons.js';
import { NotifInbox, deriveNotifItems } from './components/overlays/NotifInbox.js';
import { WorkspacePanel } from './components/overlays/WorkspacePanel.js';
import { MonitorGrid } from './components/overlays/MonitorGrid.js';
import { SettingsOverlay } from './components/overlays/SettingsOverlay.js';

/** Which exclusive overlay surface (if any) is currently open. */
type OverlaySurface = 'notif' | 'workspace' | 'monitor' | 'settings' | null;

export interface AppProps {
  /** Injectable API client (defaults to the shared one); eases testing. */
  readonly client?: ApiClient;
  /** Injectable socket connector (defaults to socket.io-client). */
  readonly socketConnector?: SocketConnector;
}

/** Web application root. */
export function App(props: AppProps = {}): ReactElement {
  const client = props.client ?? apiClient;

  const setRoster = useAgentStore((s) => s.setRoster);
  const roster = useAgentStore((s) => s.roster);
  const statusById = useAgentStore((s) => s.statusById);
  const setThreads = useChatStore((s) => s.setThreads);
  const threads = useChatStore((s) => s.threads);
  const upsertThread = useChatStore((s) => s.upsertThread);
  const removeThread = useChatStore((s) => s.removeThread);
  const setActiveThread = useChatStore((s) => s.setActiveThread);
  const setMessages = useChatStore((s) => s.setMessages);
  const messagesByThread = useChatStore((s) => s.messagesByThread);
  const addOptimisticUserMessage = useChatStore((s) => s.addOptimisticUserMessage);
  const replaceOptimisticMessage = useChatStore((s) => s.replaceOptimisticMessage);
  const removeMessage = useChatStore((s) => s.removeMessage);
  const reconcileReplies = useChatStore((s) => s.reconcileReplies);
  const activeThreadId = useChatStore((s) => s.activeThreadId);

  const [error, setError] = useState<string | null>(null);
  // Busy/in-flight: true from send until the turn's POST resolves or rejects.
  // Drives the composer's 停止-vs-send swap (停止 shows ONLY while busy).
  const [sending, setSending] = useState(false);
  const [overlay, setOverlay] = useState<OverlaySurface>(null);
  const [resolvedNotifs, setResolvedNotifs] = useState<ReadonlySet<string>>(new Set());

  const onError = useCallback((message: string) => setError(message), []);
  const { cancel } = useSocket({
    activeThreadId,
    connector: props.socketConnector,
    onError,
  });

  // Probe /health whenever an overlay that surfaces connection state is open.
  // Same-origin server hosts both the API and Socket.io, so an ok probe is an
  // honest proxy for "the live socket backend is reachable".
  const healthActive = overlay === 'notif' || overlay === 'monitor' || overlay === 'settings';
  const health = useHealth(client, healthActive);
  const socketConnected = health.state === 'ok';

  const closeOverlay = useCallback(() => setOverlay(null), []);
  const resolveNotif = useCallback(
    (id: string) => setResolvedNotifs((prev) => new Set(prev).add(id)),
    [],
  );

  // Initial load: roster + threads.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [agents, loadedThreads] = await Promise.all([
          client.listAgents(),
          client.listThreads(),
        ]);
        if (cancelled) return;
        setRoster(agents);
        setThreads(loadedThreads);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'load failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, setRoster, setThreads]);

  const selectThread = useCallback(
    async (threadId: string) => {
      setActiveThread(threadId);
      try {
        const messages = await client.getMessages(threadId);
        setMessages(threadId, messages);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'history load failed');
      }
    },
    [client, setActiveThread, setMessages],
  );

  const createThread = useCallback(async () => {
    try {
      const thread = await client.createThread();
      upsertThread(thread);
      setActiveThread(thread.id);
      setMessages(thread.id, []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'create failed');
    }
  }, [client, upsertThread, setActiveThread, setMessages]);

  const renameThread = useCallback(
    async (threadId: string, title: string) => {
      try {
        const updated = await client.renameThread(threadId, title);
        upsertThread(updated);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'rename failed');
      }
    },
    [client, upsertThread],
  );

  const deleteThread = useCallback(
    async (threadId: string) => {
      try {
        await client.deleteThread(threadId);
        // removeThread drops the thread + its messages and clears the active
        // thread when it was the one deleted (the UI then lands on the empty
        // state until another thread is selected).
        removeThread(threadId);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'delete failed');
      }
    },
    [client, removeThread],
  );

  const sendMessage = useCallback(
    async (content: string) => {
      if (activeThreadId === null) return;
      const threadId = activeThreadId;
      // Bug 1: insert the user message optimistically so it shows AT ONCE — not
      // only after the (post-turn, ~10-30s) POST resolves. The agent reply then
      // streams in via agent_event; on POST resolve we swap the temp message for
      // the real persisted one (deduped) and reconcile the replies.
      const tempId = addOptimisticUserMessage(threadId, content, Date.now());
      setSending(true);
      try {
        // POST resolves only after the turn completes (G8); the transcript fills
        // from agent_event frames meanwhile. Reconcile final state from result.
        const result = await client.sendMessage(threadId, { content });
        replaceOptimisticMessage(threadId, tempId, result.userMessage);
        reconcileReplies(result.replies);
      } catch (err) {
        // Bug 1 error path: drop the optimistic message and surface the error.
        removeMessage(threadId, tempId);
        setError(err instanceof Error ? err.message : 'send failed');
      } finally {
        setSending(false);
      }
    },
    [client, activeThreadId, addOptimisticUserMessage, replaceOptimisticMessage, removeMessage, reconcileReplies],
  );

  // Live header chip: online = not-offline agents; idle = idle agents.
  const { online, idle } = useMemo(() => {
    let onlineCount = 0;
    let idleCount = 0;
    for (const agent of roster) {
      const status = statusById[agent.id] ?? agent.status;
      if (status !== 'offline') onlineCount += 1;
      if (status === 'idle') idleCount += 1;
    }
    return { online: onlineCount, idle: idleCount };
  }, [roster, statusById]);

  const activeThread = useMemo(
    () => threads.find((t) => t.id === activeThreadId),
    [threads, activeThreadId],
  );

  // The main-bar branch .tag follows the active thread's branch. Our Thread model
  // has NO `branch` field (out of scope to add), so this is effectively always
  // hidden — honest with the design's "无分支则隐藏". Read it through an optional
  // extension so the day the model gains one it renders without a type change.
  const activeBranch =
    activeThread === undefined
      ? undefined
      : (activeThread as Thread & { branch?: string }).branch;

  // Derived "waiting on you" count for the bell badge (real signals only:
  // blocked/error agents + a down /health probe), minus locally-resolved ones.
  const notifCount = useMemo(
    () =>
      deriveNotifItems(roster, statusById, health).filter((it) => !resolvedNotifs.has(it.id))
        .length,
    [roster, statusById, health, resolvedNotifs],
  );

  const messageCount =
    activeThreadId === null ? 0 : messagesByThread[activeThreadId]?.length ?? 0;

  return (
    <div className="ws d-choco app" data-app-root="true" data-testid="app-root">
      <header className="ws-header">
        <div className="brand">
          <div className="brand-mark">C</div>
          <div className="brand-name">
            Choco<span>multi-agent coding</span>
          </div>
        </div>
        <div className="header-spacer" />
        <div className="h-chip">
          <span className="h-live" /> {online} online · {idle} idle
        </div>
        <button
          type="button"
          className={`icon-btn bell${overlay === 'notif' ? ' on' : ''}`}
          aria-label="待你处理"
          aria-haspopup="dialog"
          aria-expanded={overlay === 'notif'}
          data-testid="bell-button"
          onClick={() => setOverlay((o) => (o === 'notif' ? null : 'notif'))}
        >
          <IconBell />
          {notifCount > 0 && (
            <span className="bell-badge" data-testid="bell-badge">
              {notifCount}
            </span>
          )}
        </button>
        <button
          type="button"
          className={`icon-btn${overlay === 'monitor' ? ' on' : ''}`}
          aria-label="并行监看"
          aria-haspopup="dialog"
          aria-expanded={overlay === 'monitor'}
          data-testid="monitor-button"
          onClick={() => setOverlay((o) => (o === 'monitor' ? null : 'monitor'))}
        >
          <IconGrid />
        </button>
        <button
          type="button"
          className={`icon-btn${overlay === 'workspace' ? ' on' : ''}`}
          aria-label="打开 Workspace"
          aria-haspopup="dialog"
          aria-expanded={overlay === 'workspace'}
          data-testid="workspace-button"
          onClick={() => setOverlay((o) => (o === 'workspace' ? null : 'workspace'))}
        >
          <IconPanel />
        </button>
      </header>

      <div className="ws-body">
        <aside className="col-threads app__sidebar">
          <ThreadList
            onCreateThread={() => void createThread()}
            onSelectThread={(id) => void selectThread(id)}
            onOpenSettings={() => setOverlay('settings')}
            onRenameThread={(id, title) => void renameThread(id, title)}
            onDeleteThread={(id) => void deleteThread(id)}
          />
        </aside>

        <main className="col-main app__main">
          <div className="main-bar">
            <span className="main-mark">
              <IconHash />
            </span>
            <span className="main-title">
              {activeThread?.title ?? (activeThreadId === null ? '未选择会话' : '会话')}
            </span>
            {activeBranch !== undefined && activeBranch.length > 0 && (
              <span className="tag" data-testid="main-branch-tag">
                {activeBranch}
              </span>
            )}
            <div style={{ flex: 1 }} />
            <span className="main-meta">
              {online} agents · {messageCount} messages
            </span>
          </div>

          {error !== null && (
            <div className="app__error" data-testid="app-error" role="alert">
              {error}
              <button type="button" onClick={() => setError(null)} aria-label="关闭错误">
                ×
              </button>
            </div>
          )}

          <ChatContainer />

          <div className="app__composer">
            <ChatInput
              onSend={(content) => void sendMessage(content)}
              disabled={activeThreadId === null}
              busy={sending}
              onCancel={cancel}
            />
          </div>
        </main>

        <aside className="col-status app__status">
          <AgentStatus />
        </aside>
      </div>

      {overlay === 'notif' && (
        <NotifInbox
          onClose={closeOverlay}
          health={health}
          onResolve={resolveNotif}
          resolvedIds={resolvedNotifs}
        />
      )}
      {overlay === 'workspace' && <WorkspacePanel onClose={closeOverlay} client={client} />}
      {overlay === 'monitor' && (
        <MonitorGrid onClose={closeOverlay} health={health} socketConnected={socketConnected} />
      )}
      {overlay === 'settings' && (
        <SettingsOverlay
          onClose={closeOverlay}
          client={client}
          health={health}
          socketConnected={socketConnected}
        />
      )}
    </div>
  );
}
