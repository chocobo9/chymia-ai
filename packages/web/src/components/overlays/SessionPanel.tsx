// SessionPanel — the OPERABLE session-chain surface (not a viewer). For the
// active thread it lists each agent's session chain (seq / agent / active|sealed
// / a digest summary), lets you expand a session to read its transcript, and —
// the action — SEAL a live session (force-close it so that agent's next turn
// starts a fresh CLI session). Reads/acts through the same SessionStore the engine
// uses (GET/POST /api/.../sessions); no mock data, no parallel store.

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import type { SessionEvent } from '@choco/shared';
import type { ApiClient, AgentRosterEntry, SessionChainEntry } from '../../lib/api.js';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss.js';
import { IconClose } from '../choco/icons.js';

export interface SessionPanelProps {
  readonly onClose: () => void;
  readonly client: ApiClient;
  /** The thread whose session chain to show. */
  readonly threadId: string;
  /** Roster for agent display name + accent. */
  readonly roster: readonly AgentRosterEntry[];
}

type LoadState = 'loading' | 'loaded' | 'error';

/** Format an epoch-ms span as a compact duration (e.g. "3.8 分" / "12 秒"). */
function formatDuration(ms: number): string {
  if (ms <= 0) return '0 秒';
  if (ms < 60_000) return `${Math.round(ms / 1000)} 秒`;
  return `${(ms / 60_000).toFixed(1)} 分`;
}

/** Format an epoch-ms timestamp as a local HH:MM:SS (best-effort). */
function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString();
}

/** The Session-chain panel. */
export function SessionPanel(props: SessionPanelProps): ReactElement {
  const { onClose, client, threadId, roster } = props;
  const [state, setState] = useState<LoadState>('loading');
  const [sessions, setSessions] = useState<readonly SessionChainEntry[]>([]);
  const [errorMsg, setErrorMsg] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<readonly SessionEvent[]>([]);
  const [transcriptLoading, setTranscriptLoading] = useState(false);
  const [sealingId, setSealingId] = useState<string | null>(null);
  const [reopeningId, setReopeningId] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setState('loading');
    try {
      setSessions(await client.getSessions(threadId));
      setState('loaded');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '加载失败');
      setState('error');
    }
  }, [client, threadId]);

  useEffect(() => {
    void load();
  }, [load]);
  useOverlayDismiss(true, onClose);

  const agentLabel = (id: string): string => roster.find((a) => a.id === id)?.displayName ?? id;
  const agentColor = (id: string): string | undefined => roster.find((a) => a.id === id)?.color.primary;

  const toggleTranscript = async (sessionId: string): Promise<void> => {
    if (expandedId === sessionId) {
      setExpandedId(null);
      return;
    }
    setExpandedId(sessionId);
    setTranscript([]);
    setTranscriptLoading(true);
    try {
      setTranscript(await client.getSessionTranscript(sessionId));
    } catch {
      setTranscript([]);
    } finally {
      setTranscriptLoading(false);
    }
  };

  const seal = async (sessionId: string): Promise<void> => {
    setSealingId(sessionId);
    setErrorMsg(''); // clear any stale action error so a retry starts clean
    try {
      await client.sealSession(sessionId);
      await load();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '封存失败');
    } finally {
      setSealingId(null);
    }
  };

  const reopen = async (sessionId: string): Promise<void> => {
    setReopeningId(sessionId);
    setErrorMsg('');
    try {
      await client.reopenSession(sessionId);
      await load();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '恢复失败');
    } finally {
      setReopeningId(null);
    }
  };

  return (
    <div className="wsp-scrim" data-testid="session-panel-scrim" onClick={onClose}>
      <div
        className="wsp sess-panel"
        data-testid="session-panel"
        role="dialog"
        aria-modal="true"
        aria-label="会话链"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="wsp-head">
          <b>会话链 · Session</b>
          <span className="wsp-grow" />
          <button type="button" className="icon-btn sm" onClick={() => void load()} aria-label="刷新">
            ↻
          </button>
          <button type="button" className="icon-btn sm" onClick={onClose} aria-label="关闭会话链">
            <IconClose />
          </button>
        </div>

        <div className="wsp-body sess-body" data-testid="session-panel-body">
          {state === 'loading' && <div className="sess-msg">加载会话链…</div>}
          {state === 'error' && <div className="sess-msg sess-msg--err">加载失败：{errorMsg}</div>}
          {/* A seal/恢复 action that fails (e.g. a 409 race) must NOT be silent —
              surface it inline so the click is never a no-op to the eye. */}
          {state === 'loaded' && errorMsg !== '' && (
            <div className="sess-msg sess-msg--err" data-testid="session-action-error" role="alert">
              操作失败：{errorMsg}
            </div>
          )}
          {state === 'loaded' && sessions.length === 0 && (
            <div className="sess-msg">该会话还没有 session —— agent 还没在此开过工。</div>
          )}
          {state === 'loaded' &&
            sessions.map((s) => {
              const accent = agentColor(s.agentId);
              const toolTotal = s.digest
                ? Object.values(s.digest.toolCounts).reduce((a, b) => a + b, 0)
                : 0;
              return (
                <div
                  className="sess-card"
                  data-testid="session-card"
                  data-session={s.sessionId}
                  data-status={s.status}
                  key={s.sessionId}
                >
                  <div className="sess-card-h">
                    <span className="sess-seq">#{s.sequenceNo}</span>
                    <span className="sess-agent" style={accent === undefined ? undefined : { color: accent }}>
                      {agentLabel(s.agentId)}
                    </span>
                    <span className={`sess-badge sess-badge--${s.status}`}>
                      {s.status === 'active' ? '进行中' : '已封存'}
                    </span>
                    <span className="wsp-grow" />
                    {s.status === 'active' ? (
                      <button
                        type="button"
                        className="sess-seal-btn"
                        data-testid="session-seal"
                        disabled={sealingId === s.sessionId}
                        onClick={() => void seal(s.sessionId)}
                        title="封存这段会话：下一轮该 agent 会另起一段全新 CLI 会话"
                      >
                        {sealingId === s.sessionId ? '封存中…' : '封存'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="sess-reopen-btn"
                        data-testid="session-reopen"
                        disabled={reopeningId === s.sessionId}
                        onClick={() => void reopen(s.sessionId)}
                        title="恢复这段会话为当前活跃：下一轮该 agent 会 --resume 接着它继续（会先封存它当前活跃的那段）"
                      >
                        {reopeningId === s.sessionId ? '恢复中…' : '恢复'}
                      </button>
                    )}
                  </div>

                  {s.digest !== null && (
                    <div className="sess-digest" data-testid="session-digest">
                      <span className="sess-chip">{s.digest.messageCount} 条消息</span>
                      <span className="sess-chip">{toolTotal} 次工具</span>
                      <span className="sess-chip">{s.digest.filesTouched.length} 个文件</span>
                      {s.digest.errorCount > 0 && (
                        <span className="sess-chip sess-chip--err">{s.digest.errorCount} 错误</span>
                      )}
                      <span className="sess-chip">{formatDuration(s.digest.durationMs)}</span>
                    </div>
                  )}

                  <div className="sess-card-f">
                    <span className="sess-time">开始 {formatTime(s.createdAt)}</span>
                    {s.sealedAt !== undefined && <span className="sess-time">封存 {formatTime(s.sealedAt)}</span>}
                    <span className="wsp-grow" />
                    <button
                      type="button"
                      className="sess-expand"
                      data-testid="session-expand"
                      onClick={() => void toggleTranscript(s.sessionId)}
                    >
                      {expandedId === s.sessionId ? '收起记录' : '查看记录'}
                    </button>
                  </div>

                  {expandedId === s.sessionId && (
                    <div className="sess-transcript" data-testid="session-transcript">
                      {transcriptLoading && <div className="sess-msg">加载记录…</div>}
                      {!transcriptLoading && transcript.length === 0 && (
                        <div className="sess-msg">这段会话没有可显示的记录。</div>
                      )}
                      {!transcriptLoading &&
                        transcript.map((ev) => (
                          <div className={`sess-ev sess-ev--${ev.kind}`} key={`${ev.kind}:${ev.id}`}>
                            <span className="sess-ev-time">{formatTime(ev.timestamp)}</span>
                            {ev.kind === 'tool_event' ? (
                              <span className="sess-ev-body">
                                <span className="sess-ev-tool">🔧 {ev.toolName}</span>
                                {ev.durationMs !== undefined && (
                                  <span className="sess-ev-dur"> · {ev.durationMs}ms</span>
                                )}
                              </span>
                            ) : (
                              <span className={`sess-ev-body${ev.isError === true ? ' sess-ev--err' : ''}`}>
                                {ev.content ?? ''}
                              </span>
                            )}
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              );
            })}
        </div>
      </div>
    </div>
  );
}
