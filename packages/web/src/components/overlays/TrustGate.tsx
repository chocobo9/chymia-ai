// TrustGate — the VSCode-style "do you trust this workspace?" startup dialog.
//
// Shown by <App> on load when GET /api/trust reports the agents' workspace is NOT
// trusted. A BLOCKING centered modal (scrim has no click-to-dismiss): the user
// must choose — 信任此目录 (grant: agents may read/write + auto-run tools here, and
// gemini's headless auto-approve turns on) or 暂不信任 (run restricted; claude/codex
// still work, gemini refuses). The decision is remembered server-side, so this is
// asked once per workspace — and the SAME dialog backs the future packaged desktop
// app (it reuses the same /api/trust endpoints, no terminal prompt needed).
//
// Presentational: all I/O is the parent's via onDecide(grant). `busy` disables the
// buttons while the POST is in flight.

import { type ReactElement } from 'react';

export interface TrustGateProps {
  /** Absolute path of the workspace agents run their CLIs in (shown to the user). */
  readonly workspace: string;
  /** Grant (true) or decline (false) trust. Parent persists it via POST /api/trust. */
  readonly onDecide: (trust: boolean) => void;
  /** True while the trust POST is in flight (disables the buttons). */
  readonly busy?: boolean;
}

/** The blocking workspace-trust dialog. */
export function TrustGate({ workspace, onDecide, busy = false }: TrustGateProps): ReactElement {
  return (
    <>
      {/* No onClick on the scrim: trust is a decision, not a dismissable popover. */}
      <div className="trust-scrim" data-testid="trust-gate-scrim" />
      <div
        className="trust-modal"
        role="dialog"
        aria-modal="true"
        aria-label="是否信任此工作目录"
        data-testid="trust-gate"
      >
        <div className="trust-mark" aria-hidden="true">
          🛡
        </div>
        <h2 className="trust-title">是否信任此工作目录？</h2>
        <p className="trust-body">
          你即将允许 AI agent 在下面这个目录里<b>读写文件、自动执行工具</b>。
          只有你显式信任的目录才会开启自动执行（gemini 等需要「受信目录」才能在无人值守下工作）。
        </p>
        <code className="trust-path" data-testid="trust-gate-path">
          {workspace}
        </code>
        <div className="trust-actions">
          <button
            type="button"
            className="trust-btn trust-btn--grant"
            data-testid="trust-gate-accept"
            disabled={busy}
            onClick={() => onDecide(true)}
          >
            {busy ? '处理中…' : '信任此目录'}
          </button>
          <button
            type="button"
            className="trust-btn trust-btn--deny"
            data-testid="trust-gate-deny"
            disabled={busy}
            onClick={() => onDecide(false)}
          >
            暂不信任（受限运行）
          </button>
        </div>
        <p className="trust-foot">信任一次会被记住，以后启动（含日后的桌面应用）不再询问。</p>
      </div>
    </>
  );
}
