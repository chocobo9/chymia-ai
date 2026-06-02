// NotifInbox (待你处理) — a "waiting on you" popover opened from the header bell.
//
// DERIVED-LIVE (never fabricated): items come from real signals only —
//   • block  : any roster agent whose live status is 'error' (it is blocked and
//              likely needs your attention) → one block item per such agent.
//   • system : if the GET /health probe reports the API as down → one system item.
// When there is no real signal we show the honest empty state ("没有待处理的事…").
// There is no persisted notification feed backend yet, so we do NOT invent
// decision/PR-review items.
//
// Ported visual from choco-panels.jsx NotifInbox + directions.css `.notif-*`.

import { useMemo, type ReactElement } from 'react';
import type { AgentStatus } from '@choco/shared';
import { useAgentStore } from '../../stores/agent-store.js';
import type { AgentRosterEntry } from '../../lib/api.js';
import type { HealthInfo } from '../../hooks/useHealth.js';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss.js';
import { shortName } from '../choco/primitives.js';

/** A single derived inbox item. */
export interface NotifItem {
  readonly id: string;
  readonly kind: 'block' | 'system' | 'decision' | 'review';
  readonly title: string;
  readonly sub: string;
  readonly action: string;
  readonly accent: string;
}

interface NotifGlyph {
  readonly glyph: string;
  readonly color: string;
}

const NOTIF_GLYPH: Readonly<Record<NotifItem['kind'], NotifGlyph>> = {
  decision: { glyph: '◆', color: 'var(--brand)' },
  block: { glyph: '!', color: 'var(--st-error)' },
  review: { glyph: '⤴', color: 'var(--st-working)' },
  system: { glyph: '▾', color: 'var(--st-thinking)' },
};

/** Build the derived inbox items from live agent status + health. */
export function deriveNotifItems(
  roster: readonly AgentRosterEntry[],
  statusById: Readonly<Record<string, AgentStatus>>,
  health: HealthInfo,
): readonly NotifItem[] {
  const items: NotifItem[] = [];
  for (const entry of roster) {
    const status = statusById[entry.id] ?? entry.status;
    if (status === 'error') {
      items.push({
        id: `block:${entry.id}`,
        kind: 'block',
        title: `${shortName(entry)} 卡住了`,
        sub: '该 agent 进入阻塞状态，可能需要你授权或介入。',
        action: '查看',
        accent: entry.color.primary,
      });
    }
  }
  if (health.state === 'down') {
    items.push({
      id: 'system:health',
      kind: 'system',
      title: '本地 API 不可达',
      sub: '健康探测失败，后端可能已停止或正在重启。',
      action: '重试',
      accent: 'var(--st-thinking)',
    });
  }
  return items;
}

export interface NotifInboxProps {
  readonly onClose: () => void;
  readonly health: HealthInfo;
  /** Resolve (dismiss) one item — wired to the shell's local dismiss set. */
  readonly onResolve: (id: string) => void;
  /** Ids already resolved (filtered out of the rendered list). */
  readonly resolvedIds: ReadonlySet<string>;
}

/** The bell popover. */
export function NotifInbox(props: NotifInboxProps): ReactElement {
  const { onClose, health, onResolve, resolvedIds } = props;
  const roster = useAgentStore((s) => s.roster);
  const statusById = useAgentStore((s) => s.statusById);

  useOverlayDismiss(true, onClose);

  const items = useMemo(
    () => deriveNotifItems(roster, statusById, health).filter((it) => !resolvedIds.has(it.id)),
    [roster, statusById, health, resolvedIds],
  );

  return (
    <>
      <div className="notif-scrim" data-testid="notif-inbox-scrim" onClick={onClose} />
      <div
        className="notif-pop"
        data-testid="notif-inbox"
        role="dialog"
        aria-modal="false"
        aria-label="待你处理"
      >
        <div className="notif-h">
          <b>待你处理</b>
          <span className="notif-n" data-testid="notif-count">
            {items.length}
          </span>
        </div>
        <div className="notif-list">
          {items.map((it) => {
            const g = NOTIF_GLYPH[it.kind];
            return (
              <div
                key={it.id}
                className="notif-item"
                data-testid="notif-item"
                data-kind={it.kind}
                style={{ '--ac': it.accent } as React.CSSProperties}
              >
                <span
                  className="notif-ic"
                  style={{
                    color: g.color,
                    background: `color-mix(in oklab, ${g.color} 14%, transparent)`,
                  }}
                >
                  {g.glyph}
                </span>
                <div className="notif-main">
                  <div className="notif-tt">{it.title}</div>
                  <div className="notif-sub">{it.sub}</div>
                </div>
                <button type="button" className="notif-act" onClick={() => onResolve(it.id)}>
                  {it.action}
                </button>
              </div>
            );
          })}
          {items.length === 0 && (
            <div className="notif-empty" data-testid="notif-inbox-empty">
              没有待处理的事，喘口气。
            </div>
          )}
        </div>
      </div>
    </>
  );
}
