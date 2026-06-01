// M9 ThreadList — sidebar listing threads with a "new thread" action. Selecting
// a thread sets it active in the chat store (which drives the socket room join).
// Threads come from the chat store (seeded by GET /api/threads, kept fresh by
// thread_update socket frames).

import type { ReactElement } from 'react';
import type { Thread } from '@clowder/shared';
import { useChatStore } from '../stores/chat-store.js';

/** Fallback label for a thread with no title yet. */
const UNTITLED_LABEL = '未命名会话';

export interface ThreadListProps {
  /** Create a new thread (delegated to the container, which calls the API). */
  readonly onCreateThread: () => void;
  /** Select a thread (delegated so the container can load its history). */
  readonly onSelectThread: (threadId: string) => void;
}

function threadLabel(thread: Thread): string {
  return thread.title !== undefined && thread.title.length > 0
    ? thread.title
    : UNTITLED_LABEL;
}

/** Render the thread sidebar. */
export function ThreadList(props: ThreadListProps): ReactElement {
  const { onCreateThread, onSelectThread } = props;
  const threads = useChatStore((s) => s.threads);
  const activeThreadId = useChatStore((s) => s.activeThreadId);

  return (
    <nav className="thread-list" data-testid="thread-list" aria-label="会话列表">
      <button
        type="button"
        className="thread-list__new"
        data-testid="new-thread-button"
        onClick={onCreateThread}
      >
        + 新建会话
      </button>
      <ul className="thread-list__items">
        {threads.map((thread) => (
          <li key={thread.id}>
            <button
              type="button"
              className="thread-list__item"
              data-testid="thread-item"
              data-thread={thread.id}
              aria-current={thread.id === activeThreadId ? 'true' : undefined}
              onClick={() => onSelectThread(thread.id)}
            >
              {threadLabel(thread)}
            </button>
          </li>
        ))}
        {threads.length === 0 && (
          <li className="thread-list__empty" data-testid="thread-list-empty">
            暂无会话，点击上方新建。
          </li>
        )}
      </ul>
    </nav>
  );
}
