// Choco design primitives — Avatar, StatusDot, StreamDots, plus the status
// label/color map and helpers that derive an agent's display fields (mono
// initials, model badge, accent) from the LIVE roster (AgentRosterEntry), not
// the design mock's hardcoded AGENTS table.
//
// Ported from the Claude-Design handoff (choco-core.jsx atoms). Named exports.

import type { ReactElement } from 'react';
import type { AgentStatus } from '@clowder/shared';
import type { AgentRosterEntry } from '../../lib/api.js';

/** Per-status presentation: label + the CSS var that carries the dot color. */
export interface StatusPresentation {
  readonly label: string;
  /** A CSS custom-property reference (resolved by .d-choco tokens). */
  readonly color: string;
  readonly pulse: boolean;
}

/**
 * STATUS_PRESENTATION — maps the live AgentStatus union to the design's status
 * styling. The colors reference .d-choco tokens so they theme correctly.
 */
export const STATUS_PRESENTATION: Readonly<Record<AgentStatus, StatusPresentation>> = {
  idle: { label: '待命', color: 'var(--st-idle)', pulse: false },
  thinking: { label: '思考中', color: 'var(--st-thinking)', pulse: true },
  working: { label: '工作中', color: 'var(--st-working)', pulse: true },
  error: { label: '阻塞', color: 'var(--st-error)', pulse: false },
  offline: { label: '离线', color: 'var(--st-offline)', pulse: false },
};

/** Resolve a status to its presentation, defaulting to idle for unknown values. */
export function statusPresentation(status: AgentStatus): StatusPresentation {
  return STATUS_PRESENTATION[status] ?? STATUS_PRESENTATION.idle;
}

/** Two-letter mono initials from a name (e.g. "Claude (Opus)" → "CL"). */
export function monoInitials(name: string): string {
  const cleaned = name.replace(/\(.*?\)/g, '').trim();
  const letters = cleaned.replace(/[^\p{L}\p{N}]/gu, '');
  return letters.slice(0, 2).toUpperCase() || '··';
}

/**
 * Short model badge from a roster entry — uses the bracketed model name if the
 * displayName carries one ("Claude (Opus)" → "Opus"), else the agent name.
 */
export function modelBadge(entry: AgentRosterEntry): string {
  const match = /\(([^)]+)\)/.exec(entry.displayName);
  if (match !== null) return match[1];
  return entry.name;
}

/** Short display name — strips the bracketed model ("Claude (Opus)" → "Claude"). */
export function shortName(entry: AgentRosterEntry): string {
  return entry.displayName.replace(/\s*\(.*?\)\s*/g, '').trim() || entry.displayName;
}

export interface AvatarProps {
  /** Agent id (drives the data-agent hook). */
  readonly agentId: string;
  /** Display name used to derive mono initials. */
  readonly name: string;
  /** Accent color (roster color.primary). */
  readonly accent: string;
  /** Smaller variant for compact rows. */
  readonly small?: boolean;
}

/** Round-rect agent avatar with mono initials, accent gradient from --ac. */
export function Avatar(props: AvatarProps): ReactElement {
  const { agentId, name, accent, small = false } = props;
  return (
    <div
      className={`avatar${small ? ' sm' : ''}`}
      data-agent={agentId}
      style={{ '--ac': accent } as React.CSSProperties}
      aria-hidden="true"
    >
      {monoInitials(name)}
    </div>
  );
}

export interface StatusDotProps {
  readonly status: AgentStatus;
}

/** A single status dot (pulses for thinking/working). */
export function StatusDot({ status }: StatusDotProps): ReactElement {
  const s = statusPresentation(status);
  return (
    <span
      className={`sdot${s.pulse ? ' pulse' : ''}`}
      style={{ '--sc': s.color } as React.CSSProperties}
      aria-hidden="true"
    />
  );
}

export interface StreamDotsProps {
  /** Accent color for the bouncing dots. */
  readonly accent?: string;
}

/** Three bouncing dots indicating a live/streaming turn. */
export function StreamDots({ accent }: StreamDotsProps): ReactElement {
  return (
    <span
      className="stream-dots"
      style={accent === undefined ? undefined : ({ '--ac': accent } as React.CSSProperties)}
      data-testid="stream-dots"
      aria-hidden="true"
    >
      <i />
      <i />
      <i />
    </span>
  );
}
