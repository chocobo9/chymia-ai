// M9 ThreadList — the LEFT column (.col-threads) in the .d-choco design: a
// "新建会话" button, the thread list (each row: # mark, title, a meta line, and
// per-participant accent dots), and the owner footer (.cvo, gear deferred).
// Selecting a thread sets it active in the chat store (drives the socket room
// join); creating one is delegated to the container (which calls the API).
//
// Threads come from the chat store (seeded by GET /api/threads, kept fresh by
// thread_update socket frames); participant accent colors come from the roster.
// Preserves the wiring/a11y hooks: data-testid="thread-list"/"new-thread-button"
// /"thread-item"/"thread-list-empty", data-thread, aria-current.

import type { ReactElement } from 'react';
import type { Thread } from '@clowder/shared';
import { useChatStore } from '../stores/chat-store.js';
import { useAgentStore } from '../stores/agent-store.js';
import type { AgentRosterEntry } from '../lib/api.js';
import { IconPlus, IconHash, IconGear } from './choco/icons.js';
import { shortName } from './choco/primitives.js';

/** Fallback label for a thread with no title yet. */
const UNTITLED_LABEL = '未命名会话';

export interface ThreadListProps {
  /** Create a new thread (delegated to the container, which calls the API). */
  readonly onCreateThread: () => void;
  /** Select a thread (delegated so the container can load its history). */
  readonly onSelectThread: (threadId: string) => void;
  /** Open the settings overlay (owner gear); optional so existing callers work. */
  readonly onOpenSettings?: () => void;
}

function threadLabel(thread: Thread): string {
  return thread.title !== undefined && thread.title.length > 0 ? thread.title : UNTITLED_LABEL;
}

/** Build the meta line + accent dots from a thread's participants + roster. */
function participantInfo(
  thread: Thread,
  roster: readonly AgentRosterEntry[],
): { meta: string; dots: readonly { id: string; color: string }[] } {
  const dots = thread.participants
    .map((id) => roster.find((a) => a.id === (id as string)))
    .filter((a): a is AgentRosterEntry => a !== undefined)
    .map((a) => ({ id: a.id, color: a.color.primary }));
  const names = thread.participants
    .map((id) => {
      const entry = roster.find((a) => a.id === (id as string));
      return entry === undefined ? (id as string) : shortName(entry);
    });
  const meta = names.length > 0 ? names.join(' · ') : '尚无参与者';
  return { meta, dots };
}

/** Render the LEFT thread column. */
export function ThreadList(props: ThreadListProps): ReactElement {
  const { onCreateThread, onSelectThread, onOpenSettings } = props;
  const threads = useChatStore((s) => s.threads);
  const activeThreadId = useChatStore((s) => s.activeThreadId);
  const roster = useAgentStore((s) => s.roster);

  return (
    <div className="col-threads__inner thread-list-wrap">
      <div className="threads-top">
        <button
          type="button"
          className="btn-new thread-list__new"
          data-testid="new-thread-button"
          onClick={onCreateThread}
        >
          <IconPlus />
          <span>新建会话</span>
        </button>
      </div>
      <div className="threads-label">Threads</div>
      <nav className="thread-list" data-testid="thread-list" aria-label="会话列表">
        {threads.map((thread) => {
          const { meta, dots } = participantInfo(thread, roster);
          const isActive = thread.id === activeThreadId;
          return (
            <button
              key={thread.id}
              type="button"
              className={`thread thread-list__item${isActive ? ' active' : ''}`}
              data-testid="thread-item"
              data-thread={thread.id}
              aria-current={isActive ? 'true' : undefined}
              onClick={() => onSelectThread(thread.id)}
            >
              <span className="thread-mark">
                <IconHash />
              </span>
              <div className="thread-main">
                <div className="thread-title">{threadLabel(thread)}</div>
                <div className="thread-meta">{meta}</div>
              </div>
              <div className="thread-dots">
                {dots.map((dot) => (
                  <span key={dot.id} className="dot" style={{ background: dot.color }} />
                ))}
              </div>
            </button>
          );
        })}
        {threads.length === 0 && (
          <div className="thread-empty" data-testid="thread-list-empty">
            暂无会话，点击上方新建。
          </div>
        )}
      </nav>
      <button
        type="button"
        className="cvo cvo-trigger"
        data-testid="owner-gear"
        aria-label="打开设置"
        onClick={onOpenSettings}
      >
        <div className="cvo-mark">U</div>
        <div className="cvo-who">
          <b>You</b>
          <span>project owner</span>
        </div>
        <span className="cvo-gear" aria-hidden="true">
          <IconGear />
        </span>
      </button>
    </div>
  );
}
