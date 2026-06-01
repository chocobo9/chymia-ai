// M9 App — top-level layout + data wiring for the web client.
//
// Layout: ThreadList (left) | ChatContainer + ChatInput (center) | AgentStatus
// (right). On mount it loads the agent roster (GET /api/agents) and thread list
// (GET /api/threads) into the stores, and opens the Socket.io connection
// (useSocket) which dispatches live frames into the stores. Selecting/creating a
// thread loads its history and sets it active (which drives the room join).
//
// G8: sendMessage POSTs synchronously (resolves post-turn); the transcript fills
// incrementally from agent_event socket frames meanwhile, then reconciles the
// final persisted replies from the POST result.

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { apiClient, ApiClient } from './lib/api.js';
import { useChatStore } from './stores/chat-store.js';
import { useAgentStore } from './stores/agent-store.js';
import { useSocket, type SocketConnector } from './hooks/useSocket.js';
import { ThreadList } from './components/ThreadList.js';
import { ChatContainer } from './components/ChatContainer.js';
import { ChatInput } from './components/ChatInput.js';
import { AgentStatus } from './components/AgentStatus.js';

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
  const setThreads = useChatStore((s) => s.setThreads);
  const upsertThread = useChatStore((s) => s.upsertThread);
  const setActiveThread = useChatStore((s) => s.setActiveThread);
  const setMessages = useChatStore((s) => s.setMessages);
  const addMessage = useChatStore((s) => s.addMessage);
  const reconcileReplies = useChatStore((s) => s.reconcileReplies);
  const activeThreadId = useChatStore((s) => s.activeThreadId);

  const [error, setError] = useState<string | null>(null);

  const onError = useCallback((message: string) => setError(message), []);
  const { cancel } = useSocket({
    activeThreadId,
    connector: props.socketConnector,
    onError,
  });

  // Initial load: roster + threads.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [agents, threads] = await Promise.all([
          client.listAgents(),
          client.listThreads(),
        ]);
        if (cancelled) return;
        setRoster(agents);
        setThreads(threads);
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

  return (
    <div className="app" data-app-root="true" data-testid="app-root">
      <aside className="app__sidebar">
        <ThreadList
          onCreateThread={() => void createThread()}
          onSelectThread={(id) => void selectThread(id)}
        />
      </aside>

      <main className="app__main">
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
          {activeThreadId !== null && (
            <button
              type="button"
              className="app__cancel"
              data-testid="cancel-button"
              onClick={cancel}
            >
              中断
            </button>
          )}
          <ChatInput onSend={(content) => void sendMessage(content)} disabled={activeThreadId === null} />
        </div>
      </main>

      <aside className="app__status">
        <AgentStatus />
      </aside>
    </div>
  );
}
