// M9 SessionTranscriptViewer — the click-to-open detail for one archived session.
//
// The Session tab lists the chain; clicking a row opens THIS — the session's actual
// transcript (具体发送了什么), fetched from GET /api/sessions/:id/transcript via
// ApiClient.getSessionTranscript. Each SessionEvent is either a `message` (the agent
// reply text) or a `tool_event` (a tool call + its duration), merged by timestamp.
//
// Aligned to Clowder's SessionEventsViewer (audit/SessionEventsViewer.tsx): click a
// session → see its real messages, not a dead, look-only row. Built on the project's
// own SessionEvent type + the pre-existing .sess-transcript / .sess-ev* design (those
// CSS classes existed with no component wired to them — a dead placeholder made real).

import { useEffect, useState, type ReactElement } from 'react';
import type { SessionEvent } from '@choco/shared';
import type { ApiClient } from '../lib/api.js';

export interface SessionTranscriptViewerProps {
  readonly sessionId: string;
  readonly client: ApiClient;
  /** Resolve an agentId → display name (from the roster). */
  readonly nameOf: (id: string) => string;
  /** Resolve an agentId → its accent color (from the roster). */
  readonly colorOf: (id: string) => string | undefined;
  /** Close the viewer and return to the session list. */
  readonly onClose: () => void;
}

/** Wall-clock HH:MM:SS for a transcript event (local time). */
function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Compact a paired tool-call duration (ms → ms/s/m). */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = Math.round(ms / 1000);
  return sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m${sec % 60}s`;
}

/** One transcript row: a message (agent text) or a tool call. */
function EventRow(props: {
  readonly event: SessionEvent;
  readonly nameOf: (id: string) => string;
  readonly colorOf: (id: string) => string | undefined;
}): ReactElement {
  const { event, nameOf, colorOf } = props;
  const agent = event.agentId as string;
  return (
    <div
      className={`sess-ev${event.isError === true ? ' sess-ev--err' : ''}`}
      data-testid="session-event"
      data-kind={event.kind}
    >
      <span className="sess-ev-time">{formatTime(event.timestamp)}</span>
      {event.kind === 'message' ? (
        <span className="sess-ev-body">
          <b style={{ color: colorOf(agent) }}>{nameOf(agent)}</b> {event.content ?? ''}
        </span>
      ) : (
        <span className="sess-ev-body" title={event.toolInput ?? event.toolResult}>
          <span className="sess-ev-tool">🔧 {event.toolName ?? 'tool'}</span>
          {event.durationMs !== undefined && (
            <span className="sess-ev-dur"> · {formatDuration(event.durationMs)}</span>
          )}
        </span>
      )}
    </div>
  );
}

/**
 * Fetch + render one session's transcript. Owns its own load (like Clowder's
 * SessionEventsViewer) so the parent only tracks WHICH session is open. Re-fetches
 * when `sessionId` changes; a stale in-flight load is ignored via the cancel flag.
 */
export function SessionTranscriptViewer(props: SessionTranscriptViewerProps): ReactElement {
  const { sessionId, client, nameOf, colorOf, onClose } = props;
  const [events, setEvents] = useState<readonly SessionEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    void (async () => {
      try {
        const fetched = await client.getSessionTranscript(sessionId);
        if (!cancelled) setEvents(fetched);
      } catch {
        if (!cancelled) {
          setEvents([]);
          setError(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, client]);

  return (
    <div className="sess-viewer" data-testid="session-transcript">
      <div className="sess-viewer-h">
        <span className="sess-viewer-t" title={sessionId}>
          会话记录 · {sessionId}
        </span>
        <button
          type="button"
          className="sb-chain-act"
          data-testid="session-viewer-close"
          onClick={onClose}
        >
          返回
        </button>
      </div>

      {loading && <div className="sb-audit-empty">加载会话记录…</div>}
      {!loading && error && <div className="sb-audit-empty">会话记录加载失败。</div>}
      {!loading && !error && events.length === 0 && (
        <div className="sb-audit-empty">这个 session 还没有记录。</div>
      )}
      {!loading && !error && events.length > 0 && (
        <div className="sess-transcript">
          {events.map((event) => (
            <EventRow
              key={`${event.kind}:${event.id}`}
              event={event}
              nameOf={nameOf}
              colorOf={colorOf}
            />
          ))}
        </div>
      )}
    </div>
  );
}
