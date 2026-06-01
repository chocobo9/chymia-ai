// ConnStrip — the 连接状态 strip from the Claude-Design MonitorGrid. Three cards:
//   • 本地 API  — LIVE: reflects the GET /health probe (ok / down).
//   • Socket    — LIVE-ish: derived from whether the socket is connected; we get
//                 that as a prop from the shell (the App owns the socket).
//   • 上游模型  — HONEST UNKNOWN: the API exposes no upstream-model status probe,
//                 so we never fabricate "降级"; we mark it 未接入.
//
// Ported visual from directions.css `.conn-strip` / `.conn-card`. Named exports.

import type { ReactElement } from 'react';
import type { HealthInfo } from '../../hooks/useHealth.js';

export interface ConnStripProps {
  readonly health: HealthInfo;
  /** Whether the live socket is currently connected (owned by the shell). */
  readonly socketConnected: boolean;
}

type CardStatus = 'ok' | 'warn' | 'unknown';

interface ConnCard {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly status: CardStatus;
}

function probeTime(probedAt: number | undefined): string {
  if (probedAt === undefined) return '探测中…';
  const d = new Date(probedAt);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `最近探测 ${hh}:${mm}`;
}

/** Live connection strip backed by the /health probe + socket state. */
export function ConnStrip(props: ConnStripProps): ReactElement {
  const { health, socketConnected } = props;
  const apiCard: ConnCard = {
    key: 'api',
    label: '本地 API',
    value: health.state === 'ok' ? '畅通' : health.state === 'loading' ? '探测中' : '不可达',
    status: health.state === 'ok' ? 'ok' : health.state === 'loading' ? 'unknown' : 'warn',
  };
  const socketCard: ConnCard = {
    key: 'socket',
    label: 'Socket',
    value: socketConnected ? '畅通' : '未连接',
    status: socketConnected ? 'ok' : 'warn',
  };
  // No upstream-model status source — mark honestly, never fabricate 降级/畅通.
  const upstreamCard: ConnCard = {
    key: 'upstream',
    label: '上游模型',
    value: '未接入',
    status: 'unknown',
  };
  const cards = [apiCard, socketCard, upstreamCard];

  return (
    <div className="conn-strip" data-testid="conn-strip">
      <div className="conn-head">
        <span>连接状态 · Steam &amp; Brew</span>
        <span className="conn-time">{probeTime(health.probedAt)}</span>
      </div>
      <div className="conn-cards">
        {cards.map((c) => (
          <div
            key={c.key}
            className={`conn-card ${c.status === 'unknown' ? '' : c.status}`}
            data-testid="conn-card"
            data-conn={c.key}
            data-status={c.status}
          >
            <div className="conn-k">
              <span className="conn-dot" />
              {c.label}
            </div>
            <div className="conn-v">{c.value}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
