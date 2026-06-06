// format-task-snapshot — compress a thread's open task lines into a compact
// block injected into the agent's turn context, so the agent is AWARE of the
// long-running tasks instead of re-discovering them each turn.
//
// Aligned to Clowder reference/.../session/formatTaskSnapshot.ts (priority sort
// doing>blocked>todo>done, cap open/done, truncate, sanitize against prompt
// injection, highlight blocked). Re-written for choco's TaskItem (no #320 fields).

import type { TaskItem, TaskStatus } from '@choco/shared';

const STATUS_PRIORITY: Record<TaskStatus, number> = {
  doing: 0,
  blocked: 1,
  todo: 2,
  done: 3,
};

/** Display caps (KD-6/KD-7 from the Clowder spec). */
const MAX_OPEN = 8;
const MAX_DONE = 2;
const MAX_TITLE = 80;
const MAX_WHY = 120;

/** Largest C0 control-char code point to drop (everything below the space 0x20). */
const FIRST_PRINTABLE_CODE = 0x20;

/** Marker the agent can rely on to delimit the (data, not instruction) block. */
const OPEN_MARKER = '[Task Snapshot';
const CLOSE_MARKER = '[/Task Snapshot]';

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 3)}...`;
}

/** Drop C0 control characters (0x00–0x1F) by code point — no literal control bytes in source. */
function stripControlChars(text: string): string {
  let out = '';
  for (const ch of text) {
    if ((ch.codePointAt(0) ?? FIRST_PRINTABLE_CODE) >= FIRST_PRINTABLE_CODE) out += ch;
  }
  return out;
}

/** Sanitize user-writable text for safe embedding (treat as data, not markup). */
function sanitize(text: string): string {
  return stripControlChars(text.replace(/\n/g, ' '))
    .replace(/```[^`]*```/g, '') // fenced code blocks
    .replace(/^#{1,6}\s*/gm, '') // headings
    .replace(/^---+\s*/gm, '') // horizontal rules
    .replace(/^>\s*/gm, '') // blockquotes
    .replace(/\[\/Task Snapshot\]/g, '') // prevent closing-marker spoofing
    .trim();
}

function formatAge(updatedAt: number, now: number): string {
  const diffMs = now - updatedAt;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Build the snapshot block, or '' when there are no tasks (caller then injects
 * nothing). `now` is injectable for deterministic tests.
 */
export function formatTaskSnapshot(tasks: readonly TaskItem[], now: number = Date.now()): string {
  if (tasks.length === 0) return '';

  const counts: Record<TaskStatus, number> = { doing: 0, blocked: 0, todo: 0, done: 0 };
  for (const t of tasks) counts[t.status]++;

  const sorted = [...tasks].sort((a, b) => {
    const pa = STATUS_PRIORITY[a.status];
    const pb = STATUS_PRIORITY[b.status];
    if (pa !== pb) return pa - pb;
    return b.updatedAt - a.updatedAt;
  });

  const open = sorted.filter((t) => t.status !== 'done').slice(0, MAX_OPEN);
  const done = sorted.filter((t) => t.status === 'done').slice(0, MAX_DONE);
  const display = [...open, ...done];

  const countParts: string[] = [];
  if (counts.doing > 0) countParts.push(`${counts.doing} doing`);
  if (counts.blocked > 0) countParts.push(`${counts.blocked} blocked`);
  if (counts.todo > 0) countParts.push(`${counts.todo} todo`);
  if (counts.done > 0) countParts.push(`${counts.done} done`);

  const lines: string[] = [];
  lines.push(`${OPEN_MARKER} — ${tasks.length} tasks (${countParts.join(', ')})]`);

  if (counts.blocked > 0) {
    const blockedTasks = sorted.filter((t) => t.status === 'blocked').slice(0, MAX_OPEN);
    lines.push(`⚠️ 有 ${counts.blocked} 个任务被阻塞，请优先处理或更新状态：`);
    for (const bt of blockedTasks) {
      lines.push(`  → ${truncate(sanitize(bt.title), MAX_TITLE)}`);
    }
    lines.push('');
  }

  const focusId =
    display.find((t) => t.status === 'doing')?.id ?? display.find((t) => t.status === 'blocked')?.id;

  for (const t of display) {
    const prefix = t.id === focusId ? '▸' : ' ';
    const title = truncate(sanitize(t.title), MAX_TITLE);
    const owner = t.ownerCatId !== null ? ` — ${t.ownerCatId as string}` : '';
    const age = formatAge(t.updatedAt, now);
    let line = `${prefix} [${t.status}] ${title}${owner} (${age})`;
    if (t.status === 'blocked' && t.why.length > 0) {
      line += `\n    ⚠ ${truncate(sanitize(t.why), MAX_WHY)}`;
    }
    lines.push(line);
  }

  const omitted = tasks.length - display.length;
  if (omitted > 0) lines.push(`  ... and ${omitted} more tasks`);

  lines.push(CLOSE_MARKER);
  return lines.join('\n');
}
