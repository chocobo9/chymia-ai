// @vitest-environment jsdom
//
// M9 dev happy-path: the TrustGate dialog renders the workspace path and routes
// both decisions through onDecide, and disables while busy. App-level show/hide +
// fail-open integration is the QA instance's (dev≠QA).

import '@testing-library/jest-dom';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TrustGate } from '../../packages/web/src/components/overlays/TrustGate.js';

afterEach(cleanup);

describe('TrustGate (unit, happy path)', () => {
  it('shows the workspace path and fires onDecide(true) when 信任此目录 is clicked', async () => {
    const onDecide = vi.fn();
    // JS-expression prop (NOT a JSX string attribute) so the backslashes are real
    // escapes — a JSX `"D:\\..."` attribute keeps both backslashes literally.
    const workspace = 'D:\\proj\\choco-ai\\.workspace';
    render(<TrustGate workspace={workspace} onDecide={onDecide} />);

    expect(screen.getByTestId('trust-gate')).toBeInTheDocument();
    expect(screen.getByTestId('trust-gate-path')).toHaveTextContent(workspace);

    await userEvent.click(screen.getByTestId('trust-gate-accept'));
    expect(onDecide).toHaveBeenCalledWith(true);
  });

  it('fires onDecide(false) on 暂不信任, and disables both buttons while busy', async () => {
    const onDecide = vi.fn();
    const { rerender } = render(<TrustGate workspace="/srv/agents/ws" onDecide={onDecide} />);

    await userEvent.click(screen.getByTestId('trust-gate-deny'));
    expect(onDecide).toHaveBeenCalledWith(false);

    rerender(<TrustGate workspace="/srv/agents/ws" onDecide={onDecide} busy />);
    expect(screen.getByTestId('trust-gate-accept')).toBeDisabled();
    expect(screen.getByTestId('trust-gate-deny')).toBeDisabled();
  });
});
