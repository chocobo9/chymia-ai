// M9 ThreadList — the LEFT column (.col-threads) in the .d-choco design: a
// "新建会话" button, the thread list (each row: # mark, title, a meta line, and
// per-participant accent dots), and the owner footer (.cvo, gear deferred).
// Selecting a thread sets it active in the chat store (drives the socket room
// join); creating one is delegated to the container (which calls the API).
//
// Per-thread management (Claude-Design update): hovering/activating a row swaps
// the participant dots+badge for a ⋯ kebab button. The kebab opens a popover
// (重命名 / 删除会话, dismissed by an outside-click scrim or Escape). 重命名 turns
// the title into an inline input (.thread.editing / .thread-edit); Enter or the
// check commits, Escape/blur cancels, empty/whitespace never commits. 删除 opens a
// confirm modal; confirming delegates the delete to the container. Both the
// rename and delete actions are delegated to the container (App) so they reuse
// the injectable API client + store + the shared error path.
//
// Threads come from the chat store (seeded by GET /api/threads, kept fresh by
// thread_update socket frames); participant accent colors come from the roster.
// Preserves the wiring/a11y hooks: data-testid="thread-list"/"new-thread-button"
// /"thread-item"/"thread-list-empty", data-thread, aria-current. New testids:
// thread-kebab / thread-menu / thread-rename-input / thread-delete-confirm.

import {
  useCallback,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from 'react';
import type { Thread } from '@choco/shared';
import { useChatStore } from '../stores/chat-store.js';
import { useAgentStore } from '../stores/agent-store.js';
import type { AgentRosterEntry } from '../lib/api.js';
import {
  IconPlus,
  IconHash,
  IconGear,
  IconMore,
  IconPencil,
  IconTrash,
  IconCheck,
  IconClose,
} from './choco/icons.js';
import { shortName } from './choco/primitives.js';
import { useOverlayDismiss } from '../hooks/useOverlayDismiss.js';

/** Fallback label for a thread with no title yet. */
const UNTITLED_LABEL = '未命名会话';

/** Vertical gap (px) below the kebab where the popover anchors — design default. */
const MENU_OFFSET_Y = 4;

/** An open kebab menu: which thread + the viewport anchor (kebab bottom-right). */
interface MenuAnchor {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

export interface ThreadListProps {
  /** Create a new thread (delegated to the container, which calls the API). */
  readonly onCreateThread: () => void;
  /** Select a thread (delegated so the container can load its history). */
  readonly onSelectThread: (threadId: string) => void;
  /** Open the settings overlay (owner gear); optional so existing callers work. */
  readonly onOpenSettings?: () => void;
  /** Rename a thread (delegated: client.renameThread + store upsert + errors). */
  readonly onRenameThread?: (threadId: string, title: string) => void;
  /** Delete a thread (delegated: client.deleteThread + store remove + errors). */
  readonly onDeleteThread?: (threadId: string) => void;
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
  const { onCreateThread, onSelectThread, onOpenSettings, onRenameThread, onDeleteThread } = props;
  const threads = useChatStore((s) => s.threads);
  const activeThreadId = useChatStore((s) => s.activeThreadId);
  const roster = useAgentStore((s) => s.roster);

  // Local UI state for the kebab menu / inline rename / delete confirm. State
  // names mirror the design's Workspace component (menu/editId/draft/confirmId).
  const [menu, setMenu] = useState<MenuAnchor | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const editRef = useRef<HTMLInputElement | null>(null);

  const closeMenu = useCallback(() => setMenu(null), []);
  // Escape closes whichever transient surface is open (menu first, then confirm).
  useOverlayDismiss(menu !== null, closeMenu);
  const cancelDelete = useCallback(() => setConfirmId(null), []);
  useOverlayDismiss(confirmId !== null, cancelDelete);

  const openMenu = useCallback((event: ReactMouseEvent<HTMLButtonElement>, thread: Thread) => {
    event.stopPropagation();
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({ id: thread.id, x: rect.right, y: rect.bottom + MENU_OFFSET_Y });
  }, []);

  const startRename = useCallback((thread: Thread) => {
    setMenu(null);
    setEditId(thread.id);
    setDraft(threadLabel(thread));
    // Focus + select after the input mounts.
    window.setTimeout(() => {
      editRef.current?.focus();
      editRef.current?.select();
    }, 20);
  }, []);

  const cancelRename = useCallback(() => setEditId(null), []);

  const commitRename = useCallback(() => {
    const value = draft.trim();
    // Empty/whitespace never commits — just leave edit mode (no change).
    if (value.length > 0 && editId !== null) {
      onRenameThread?.(editId, value);
    }
    setEditId(null);
  }, [draft, editId, onRenameThread]);

  const onEditKey = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commitRename();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        cancelRename();
      }
    },
    [commitRename, cancelRename],
  );

  const askDelete = useCallback((thread: Thread) => {
    setMenu(null);
    setConfirmId(thread.id);
  }, []);

  const doDelete = useCallback(() => {
    if (confirmId !== null) onDeleteThread?.(confirmId);
    setConfirmId(null);
  }, [confirmId, onDeleteThread]);

  const menuThread = menu === null ? undefined : threads.find((t) => t.id === menu.id);
  const confirmThread = confirmId === null ? undefined : threads.find((t) => t.id === confirmId);

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
          const isEditing = thread.id === editId;
          return (
            <div
              key={thread.id}
              role="button"
              tabIndex={isEditing ? -1 : 0}
              className={`thread thread-list__item${isActive ? ' active' : ''}${
                isEditing ? ' editing' : ''
              }`}
              data-testid="thread-item"
              data-thread={thread.id}
              aria-current={isActive ? 'true' : undefined}
              onClick={() => {
                if (!isEditing) onSelectThread(thread.id);
              }}
              onKeyDown={(e) => {
                if (!isEditing && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault();
                  onSelectThread(thread.id);
                }
              }}
            >
              <span className="thread-mark">
                <IconHash />
              </span>
              <div className="thread-main">
                {isEditing ? (
                  <input
                    ref={editRef}
                    type="text"
                    className="thread-edit"
                    data-testid="thread-rename-input"
                    aria-label="重命名会话"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={onEditKey}
                    onBlur={commitRename}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <>
                    <div className="thread-title">{threadLabel(thread)}</div>
                    <div className="thread-meta">{meta}</div>
                  </>
                )}
              </div>
              {!isEditing && (
                <>
                  <div className="thread-dots">
                    {dots.map((dot) => (
                      <span key={dot.id} className="dot" style={{ background: dot.color }} />
                    ))}
                  </div>
                  <button
                    type="button"
                    className="thread-kebab"
                    data-testid="thread-kebab"
                    aria-label="更多操作"
                    aria-haspopup="menu"
                    onClick={(e) => openMenu(e, thread)}
                  >
                    <IconMore />
                  </button>
                </>
              )}
              {isEditing && (
                <button
                  type="button"
                  className="thread-kebab"
                  data-testid="thread-rename-commit"
                  aria-label="确认重命名"
                  // Commit on mousedown so it fires before the input's blur cancels focus.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    commitRename();
                  }}
                  onClick={(e) => e.stopPropagation()}
                >
                  <IconCheck />
                </button>
              )}
            </div>
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

      {menu !== null && menuThread !== undefined && (
        <>
          <div
            className="thread-menu-scrim"
            data-testid="thread-menu-scrim"
            onClick={closeMenu}
            aria-hidden="true"
          />
          <div
            className="thread-pop"
            data-testid="thread-menu"
            role="menu"
            style={{ top: menu.y, left: menu.x }}
          >
            <button type="button" role="menuitem" onClick={() => startRename(menuThread)}>
              <IconPencil />
              <span>重命名</span>
            </button>
            <button
              type="button"
              role="menuitem"
              className="danger"
              onClick={() => askDelete(menuThread)}
            >
              <IconTrash />
              <span>删除会话</span>
            </button>
          </div>
        </>
      )}

      {confirmThread !== undefined && (
        <div className="modal-scrim" onClick={cancelDelete}>
          <div
            className="modal sm"
            data-testid="thread-delete-confirm"
            role="dialog"
            aria-modal="true"
            aria-label="删除会话"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-h">
              <b>删除会话</b>
              <button
                type="button"
                className="set-close"
                aria-label="关闭"
                onClick={cancelDelete}
              >
                <IconClose />
              </button>
            </div>
            <div className="modal-body">
              <p className="thread-delete-text">
                确定删除「<strong>{threadLabel(confirmThread)}</strong>
                」？此操作不可撤销，会话内的全部消息记录会一并移除。
              </p>
            </div>
            <div className="modal-foot">
              <button type="button" className="set-btn ghost" onClick={cancelDelete}>
                取消
              </button>
              <button
                type="button"
                className="set-btn danger"
                data-testid="thread-delete-confirm-button"
                onClick={doDelete}
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
