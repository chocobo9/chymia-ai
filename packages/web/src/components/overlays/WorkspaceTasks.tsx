// WorkspaceTasks — the 任务 tab of the WorkspacePanel, the operable 任务线 board
// (任务). LIVE: loads the active thread's tasks (GET /api/tasks), creates
// (POST), cycles status (PATCH) and deletes (DELETE); the task-store is also kept
// in sync by socket task_created/_updated/_deleted (other clients / the agent /
// 飞书). The open tasks are injected into the agent's turn context server-side,
// so this board is what the agent is aware of — not a decorative widget.
//
// Aligned to Clowder reference/.../components/TaskBoardPanel.tsx + TaskCard.tsx +
// TaskComposer.tsx (four status sections, status-pill cycle, expand for why).
// Re-written with choco's CSS (wsp-*/tsk-*), not Clowder's Tailwind.

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import type { TaskItem, TaskStatus } from '@choco/shared';
import type { ApiClient } from '../../lib/api.js';
import { useChatStore } from '../../stores/chat-store.js';
import { useTaskStore } from '../../stores/task-store.js';
import { useTaskProgressStore } from '../../stores/task-progress-store.js';

/** Board sections, in display order (matches Clowder's TaskBoardPanel). */
const SECTIONS: readonly { readonly key: TaskStatus; readonly label: string; readonly icon: string }[] = [
  { key: 'doing', label: '进行中', icon: '◉' },
  { key: 'blocked', label: '阻塞中', icon: '⊘' },
  { key: 'todo', label: '待办', icon: '○' },
  { key: 'done', label: '已完成', icon: '●' },
];

/** Status pill cycle: tap a pill to advance the task's state. */
const STATUS_CYCLE: Record<TaskStatus, TaskStatus> = {
  todo: 'doing',
  doing: 'blocked',
  blocked: 'done',
  done: 'todo',
};

const STATUS_LABELS: Record<TaskStatus, string> = {
  todo: '待办',
  doing: '进行中',
  blocked: '阻塞中',
  done: '已完成',
};

function formatRelativeTime(timestamp: number): string {
  const minutes = Math.floor((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  return `${Math.floor(hours / 24)}天前`;
}

interface CardProps {
  readonly task: TaskItem;
  readonly onCycle: (task: TaskItem) => void;
  readonly onDelete: (task: TaskItem) => void;
}

/** One task card: title (click to expand), status pill (click to cycle), delete on expand. */
function TaskCard({ task, onCycle, onDelete }: CardProps): ReactElement {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className={`tsk-card ${task.status}`} data-testid="tsk-card">
      <div className="tsk-card-row">
        <button
          type="button"
          className="tsk-title"
          onClick={() => setExpanded((v) => !v)}
          data-testid="tsk-title"
        >
          {task.title}
        </button>
        {task.ownerCatId !== null && <span className="tsk-owner">{task.ownerCatId}</span>}
        <button
          type="button"
          className={`tsk-pill ${task.status}`}
          onClick={() => onCycle(task)}
          data-testid="tsk-pill"
          aria-label={`状态 ${STATUS_LABELS[task.status]}，点击切换`}
        >
          {STATUS_LABELS[task.status]}
        </button>
      </div>
      {expanded && (
        <div className="tsk-detail">
          {task.why.length > 0 && <p className="tsk-why">{task.why}</p>}
          <p className="tsk-meta">
            {formatRelativeTime(task.createdAt)} · {task.createdBy === 'user' ? '用户' : task.createdBy}
          </p>
          <button type="button" className="tsk-del" onClick={() => onDelete(task)} data-testid="tsk-del">
            删除
          </button>
        </div>
      )}
    </div>
  );
}

interface ComposerProps {
  readonly onCreate: (title: string, why: string) => Promise<void>;
  readonly onClose: () => void;
}

/** Inline composer: title + why → POST /api/tasks. */
function TaskComposer({ onCreate, onClose }: ComposerProps): ReactElement {
  const [title, setTitle] = useState('');
  const [why, setWhy] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const canSubmit = title.trim().length > 0 && !submitting;

  const submit = async (): Promise<void> => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError('');
    try {
      await onCreate(title.trim(), why.trim());
      onClose();
    } catch {
      setError('创建失败，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="tsk-composer" data-testid="tsk-composer">
      <input
        className="tsk-composer-title"
        placeholder="任务标题"
        value={title}
        maxLength={200}
        onChange={(e) => setTitle(e.target.value)}
        data-testid="tsk-composer-title"
        aria-label="任务标题"
      />
      <textarea
        className="tsk-composer-why"
        placeholder="为什么需要这个任务？（可选）"
        value={why}
        maxLength={1000}
        rows={2}
        onChange={(e) => setWhy(e.target.value)}
        aria-label="任务原因"
      />
      {error.length > 0 && <p className="tsk-err" role="alert">{error}</p>}
      <div className="tsk-composer-act">
        <button type="button" className="tsk-btn ghost" onClick={onClose}>
          取消
        </button>
        <button
          type="button"
          className="tsk-btn"
          onClick={() => void submit()}
          disabled={!canSubmit}
          data-testid="tsk-composer-submit"
        >
          {submitting ? '创建中…' : '创建任务'}
        </button>
      </div>
    </div>
  );
}

/** Status label for a task-progress snapshot (an agent's live TodoWrite plan). */
const PROGRESS_STATUS_LABEL: Readonly<Record<string, string>> = {
  running: '进行中',
  completed: '已完成',
  interrupted: '已中断',
};

export interface WorkspaceTasksProps {
  readonly client: ApiClient;
}

/** The 任务 tab — the operable task-line board for the active thread. */
export function WorkspaceTasks(props: WorkspaceTasksProps): ReactElement {
  const { client } = props;
  const threadId = useChatStore((s) => s.activeThreadId);
  const tasks = useTaskStore((s) => (threadId !== null ? s.tasksByThread[threadId] : undefined)) ?? [];
  const setTasks = useTaskStore((s) => s.setTasks);
  const upsertTask = useTaskStore((s) => s.upsertTask);
  const removeTask = useTaskStore((s) => s.removeTask);
  const progressSnapshots =
    useTaskProgressStore((s) => (threadId !== null ? s.snapshotsByThread[threadId] : undefined)) ?? [];
  const setProgressSnapshots = useTaskProgressStore((s) => s.setSnapshots);

  const [phase, setPhase] = useState<'idle' | 'loading' | 'error'>('idle');
  const [composerOpen, setComposerOpen] = useState(false);

  // Load (and reload on thread change). A stale response for a thread the user
  // already navigated away from is discarded (cancelled flag).
  useEffect(() => {
    if (threadId === null) return;
    let cancelled = false;
    setPhase('loading');
    client
      .listTasks(threadId)
      .then((loaded) => {
        if (cancelled) return;
        setTasks(threadId, loaded);
        setPhase('idle');
      })
      .catch(() => {
        if (!cancelled) setPhase('error');
      });
    return () => {
      cancelled = true;
    };
  }, [client, threadId, setTasks]);

  // Initial fill of the thread's live task-progress snapshots on open / thread
  // change; the socket task_progress listener keeps them fresh after.
  useEffect(() => {
    if (threadId === null) return;
    let cancelled = false;
    client
      .getTaskProgress(threadId)
      .then((snaps) => {
        if (!cancelled) setProgressSnapshots(threadId, snaps);
      })
      .catch(() => {
        /* progress is best-effort; the board still works without it */
      });
    return () => {
      cancelled = true;
    };
  }, [client, threadId, setProgressSnapshots]);

  const create = useCallback(
    async (title: string, why: string): Promise<void> => {
      if (threadId === null) return;
      const created = await client.createTask({ threadId, title, why });
      upsertTask(created); // socket task_created also arrives → dedup by id
    },
    [client, threadId, upsertTask],
  );

  const cycle = useCallback(
    (task: TaskItem): void => {
      void client
        .updateTask(task.id, { status: STATUS_CYCLE[task.status] })
        .then((updated) => upsertTask(updated))
        .catch(() => {
          /* socket task_updated will sync; transient failure is non-fatal */
        });
    },
    [client, upsertTask],
  );

  const remove = useCallback(
    (task: TaskItem): void => {
      void client
        .deleteTask(task.id)
        .then(() => removeTask(task.threadId, task.id))
        .catch(() => {
          /* socket task_deleted will sync */
        });
    },
    [client, removeTask],
  );

  if (threadId === null) {
    return (
      <div className="wsp-pad" data-testid="wsp-tasks">
        <div className="tsk-empty" data-testid="tsk-empty">
          <div className="wsp-empty-t">先开一个对话</div>
          <div className="wsp-empty-s">任务线挂在对话上。选择或新建一个对话后，就能在这里挂跨多轮跟踪的长期事项。</div>
        </div>
      </div>
    );
  }

  const grouped = SECTIONS.map((section) => ({
    section,
    items: tasks.filter((t) => t.status === section.key),
  }));

  return (
    <div className="wsp-pad" data-testid="wsp-tasks">
      <div className="tsk-head">
        <span className="tsk-head-t">任务 · {tasks.length === 0 ? '暂无任务' : `${tasks.length} 项`}</span>
        <button
          type="button"
          className="tsk-new"
          onClick={() => setComposerOpen(true)}
          data-testid="tsk-new"
        >
          + 新任务
        </button>
      </div>

      {composerOpen && <TaskComposer onCreate={create} onClose={() => setComposerOpen(false)} />}

      {progressSnapshots.length > 0 && (
        <div className="tsk-progress" data-testid="tsk-progress">
          <div className="wsp-sec-t">实时进度</div>
          {progressSnapshots.map((snap) => (
            <div key={snap.agentId as string} className="tprog-cat" data-testid="tprog-snapshot">
              <div className="tprog-head">
                <span className="tprog-agent">{snap.agentId as string}</span>
                <span className={`tprog-status ${snap.status}`}>
                  {PROGRESS_STATUS_LABEL[snap.status] ?? snap.status}
                </span>
              </div>
              {snap.tasks.map((t) => (
                <div key={t.id} className={`tprog-item ${t.status}`} data-testid="tprog-item">
                  <span className="tprog-ic">
                    {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '◐' : '○'}
                  </span>
                  <span className="tprog-txt">{t.activeForm ?? t.subject}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {phase === 'loading' && <div className="mem-loading" data-testid="tsk-loading">加载中…</div>}
      {phase === 'error' && (
        <div className="mem-empty" role="alert" data-testid="tsk-load-error">任务加载失败。</div>
      )}

      {phase !== 'loading' && tasks.length === 0 && !composerOpen ? (
        <div className="wsp-empty" data-testid="tsk-empty">
          <div className="wsp-empty-t">把长期事项挂在线上，不埋回聊天里</div>
          <div className="wsp-empty-s">
            需要跨多轮对话跟踪的事项，用户和 agent 都可以创建任务；打开的任务会被注入 agent 的上下文。
          </div>
          <button type="button" className="tsk-btn" onClick={() => setComposerOpen(true)}>
            创建第一个任务
          </button>
        </div>
      ) : (
        grouped.map(({ section, items }) =>
          items.length === 0 ? null : (
            <div key={section.key} className="tsk-sec" data-testid={`tsk-sec-${section.key}`}>
              <div className={`tsk-sec-h ${section.key}`}>
                <span className="tsk-sec-ic">{section.icon}</span>
                <span>{section.label}</span>
                <span className="tsk-sec-n">{items.length}</span>
              </div>
              {items.map((task) => (
                <TaskCard key={task.id} task={task} onCycle={cycle} onDelete={remove} />
              ))}
            </div>
          ),
        )
      )}
    </div>
  );
}
