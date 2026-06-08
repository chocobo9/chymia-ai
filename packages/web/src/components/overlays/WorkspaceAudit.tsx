// WorkspaceAudit — the 审计 tab of the WorkspacePanel. Reads the ACTIVE thread's
// audit event log (GET /api/audit/thread) and renders it newest-first: a type
// chip + agent + time per row, click-to-expand to the raw `data` payload (timings,
// prompt digest, session id, …). Aligned to Clowder components/audit/AuditEventsTab.tsx.
//
// New threads show engine-emitted events (invoked/responded/error/session_seal);
// pre-event-log threads fall back to derived events (data.derived=true) so the tab
// is never empty for an old thread.

import { useEffect, useState, type ReactElement } from 'react';
import type { AuditEvent } from '@choco/shared';
import type { ApiClient } from '../../lib/api.js';
import { useChatStore } from '../../stores/chat-store.js';

type LoadState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'loading' }
  | { readonly phase: 'done'; readonly events: readonly AuditEvent[] }
  | { readonly phase: 'error'; readonly message: string };

/** Chinese label for each known audit event type (unknown types show raw). */
const TYPE_LABEL: Readonly<Record<string, string>> = {
  invoked: '调用',
  responded: '回应',
  error: '错误',
  session_seal: '会话封存',
  session_start: '会话开始',
  tool: '工具',
};

/** Map an event type to one of the chip color classes. */
function typeClass(type: string): string {
  if (type === 'error') return 'err';
  if (type === 'session_seal' || type === 'session_start') return 'sess';
  if (type === 'tool') return 'tool';
  if (type === 'responded') return 'ok';
  return 'inv';
}

export interface WorkspaceAuditProps {
  readonly client: ApiClient;
}

/** The 审计 tab — live per-thread audit event log. */
export function WorkspaceAudit(props: WorkspaceAuditProps): ReactElement {
  const { client } = props;
  const threadId = useChatStore((s) => s.activeThreadId);
  const [state, setState] = useState<LoadState>({ phase: 'idle' });
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    if (threadId === null) {
      setState({ phase: 'idle' });
      return;
    }
    let cancelled = false;
    setState({ phase: 'loading' });
    client
      .getAuditEvents(threadId)
      .then((r) => !cancelled && setState({ phase: 'done', events: r.events }))
      .catch(
        (err) =>
          !cancelled &&
          setState({ phase: 'error', message: err instanceof Error ? err.message : '加载失败' }),
      );
    return () => {
      cancelled = true;
    };
  }, [client, threadId]);

  if (threadId === null) {
    return <div className="wsp-pad mem-empty" data-testid="audit-no-thread">选择一个对话查看审计追踪。</div>;
  }
  if (state.phase === 'loading') {
    return <div className="wsp-pad mem-loading" data-testid="audit-loading">加载中…</div>;
  }
  if (state.phase === 'error') {
    return <div className="wsp-pad mem-empty" role="alert" data-testid="audit-error">加载出错：{state.message}</div>;
  }
  if (state.phase === 'idle' || state.events.length === 0) {
    return <div className="wsp-pad mem-empty" data-testid="audit-empty">本对话还没有审计事件。</div>;
  }

  return (
    <div className="wsp-pad" data-testid="wsp-audit">
      {state.events.map((e) => {
        const agentId = typeof e.data['agentId'] === 'string' ? e.data['agentId'] : '';
        const isOpen = expanded === e.id;
        return (
          <div key={e.id} className="audit-row" data-testid="audit-event">
            <button
              type="button"
              className="audit-head"
              aria-expanded={isOpen}
              onClick={() => setExpanded(isOpen ? null : e.id)}
            >
              <span className={`audit-type ${typeClass(e.type)}`} data-testid="audit-type">
                {TYPE_LABEL[e.type] ?? e.type}
              </span>
              <span className="audit-agent">{agentId}</span>
              <span className="audit-time">{new Date(e.timestamp).toLocaleTimeString()}</span>
            </button>
            {isOpen && (
              <pre className="audit-data" data-testid="audit-data">{JSON.stringify(e.data, null, 2)}</pre>
            )}
          </div>
        );
      })}
    </div>
  );
}
