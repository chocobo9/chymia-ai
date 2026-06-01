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
import { apiClient, ApiClient } from './lib/api.js';
import { useChatStore } from './stores/chat-store.js';
import { useAgentStore } from './stores/agent-store.js';
import { useSocket, type SocketConnector } from './hooks/useSocket.js';
import { useHealth } from './hooks/useHealth.js';
import { ThreadList } from './components/ThreadList.js';
import { ChatContainer } from './components/ChatContainer.js';
import { ChatInput } from './components/ChatInput.js';
import { AgentStatus } from './components/AgentStatus.js';
import { IconBell, IconPanel, IconHash, IconStop, IconGrid } from './components/choco/icons.js';
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
  const setActiveThread = useChatStore((s) => s.setActiveThread);
  const setMessages = useChatStore((s) => s.setMessages);
  const messagesByThread = useChatStore((s) => s.messagesByThread);
  const addMessage = useChatStore((s) => s.addMessage);
  const reconcileReplies = useChatStore((s) => s.reconcileReplies);
  const activeThreadId = useChatStore((s) => s.activeThreadId);

  const [error, setError] = useState<string | null>(null);
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

  const sendMessage = useCallback(
    async (content: string) => {
      if (activeThreadId === null) return;
      try {
        // POST resolves only after the turn completes (G8); the transcript fills
        // from agent_event frames meanwhile. Reconcile final state from result.
        const result = await client.sendMessage(activeThreadId, { content });
        addMessage(result.userMessage);
        reconcileReplies(result.replies);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'send failed');
      }
    },
    [client, activeThreadId, addMessage, reconcileReplies],
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

  const cancelButton =
    activeThreadId !== null ? (
      <button
        type="button"
        className="cancel app__cancel"
        data-testid="cancel-button"
        onClick={cancel}
      >
        <IconStop /> 停止
      </button>
    ) : null;

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
              cancelSlot={cancelButton}
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
        <SettingsOverlay onClose={closeOverlay} health={health} socketConnected={socketConnected} />
      )}
    </div>
  );
}
