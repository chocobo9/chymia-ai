// TrustGate - VSCode-style workspace trust dialog.

import { type ReactElement } from 'react';

export interface TrustGateProps {
  /** Absolute path of the workspace agents run their CLIs in. */
  readonly workspace: string;
  /** Grant (true) or decline (false) trust. Parent persists it via POST /api/trust. */
  readonly onDecide: (trust: boolean) => void;
  /** True while the trust POST is in flight. */
  readonly busy?: boolean;
}

export function TrustGate({ workspace, onDecide, busy = false }: TrustGateProps): ReactElement {
  const isolatedWorkspace = workspace.endsWith('.workspace');

  return (
    <>
      <div className="trust-scrim" data-testid="trust-gate-scrim" />
      <div
        className="trust-modal"
        role="dialog"
        aria-modal="true"
        aria-label="是否信任此工作目录"
        data-testid="trust-gate"
      >
        <div className="trust-mark" aria-hidden="true">
          !
        </div>
        <h2 className="trust-title">是否信任此工作目录？</h2>
        <p className="trust-body">
          信任会允许 AI agent 在下面这个目录内读写文件并自动运行工具。它不会扩大文件系统沙箱，
          agent 仍然只能操作当前 workspace 根目录内的内容。
        </p>
        {isolatedWorkspace && (
          <p className="trust-body">
            当前根目录是 <b>.workspace</b>，agent 不能直接修改父级源码目录。要操作源码，请用源码根目录启动。
          </p>
        )}
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
            {busy ? '处理中...' : '信任此目录'}
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
        <p className="trust-foot">信任决定会被记住；以后启动同一个目录时不再询问。</p>
      </div>
    </>
  );
}
