// @vitest-environment jsdom
//
// M9 QA (dev≠QA): the App-level wiring of the VSCode-style TrustGate. The dev
// file unit-tests the <TrustGate> presentational dialog (renders path, fires
// onDecide, busy disables). This file mounts the FULL <App> and gates the
// show/hide LOGIC around the startup probe:
//   - gate SHOWS only when GET /api/trust says { workspace, trusted:false }
//   - granting (accept) → setTrust(true) → gate disappears
//   - declining (deny)  → setTrust(false) → gate disappears (dismissed/restricted)
//   - NO gate when already trusted, NO gate when workspace is null
//   - FAIL-OPEN: a getTrust() REJECTION never traps the user (app renders, no gate)
//
// Follows the App-mount + real-ApiClient + vi.spyOn pattern from
// g8-incremental.edge.test.tsx: a real ApiClient (fetch stubbed to reject) with
// the mount calls (listAgents/listThreads) and the trust calls (getTrust/setTrust)
// spied per test. A MockSocket satisfies useSocket without a real connection.
//
// dev≠QA: authored by the M9 QA instance; no product code modified.

import '@testing-library/jest-dom';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../../packages/web/src/App.js';
import { ApiClient, type TrustStatus } from '../../packages/web/src/lib/api.js';
import type { SocketLike, SocketConnector } from '../../packages/web/src/hooks/useSocket.js';
import { useChatStore } from '../../packages/web/src/stores/chat-store.js';
import { useAgentStore } from '../../packages/web/src/stores/agent-store.js';
import { ROSTER, makeThread } from './fixtures.js';

/** Minimal socket so useSocket() can attach handlers without a real connection. */
class MockSocket implements SocketLike {
  readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  on(event: string, listener: (...args: unknown[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(listener);
    this.handlers.set(event, list);
    return this;
  }
  off(event: string, listener?: (...args: unknown[]) => void): this {
    if (listener === undefined) {
      this.handlers.delete(event);
      return this;
    }
    this.handlers.set(event, (this.handlers.get(event) ?? []).filter((l) => l !== listener));
    return this;
  }
  emit(): this {
    return this;
  }
  disconnect(): this {
    return this;
  }
}

/**
 * A real ApiClient with the mount-time calls stubbed (roster + threads load) and
 * the trust probe wired to `getTrust`. `setTrust` is given a sensible default
 * (echoes the grant) that individual tests may override.
 */
function makeClient(getTrust: () => Promise<TrustStatus>): ApiClient {
  const client = new ApiClient({
    baseUrl: 'http://test',
    fetchFn: () => Promise.reject(new Error('no network in test')),
  });
  vi.spyOn(client, 'listAgents').mockResolvedValue(ROSTER);
  vi.spyOn(client, 'listThreads').mockResolvedValue([makeThread()]);
  vi.spyOn(client, 'getMessages').mockResolvedValue([]);
  vi.spyOn(client, 'getTrust').mockImplementation(getTrust);
  // Default: a grant echoes trusted:true for that workspace; a decline echoes the
  // (still untrusted) current state — exactly the server contract. Overridable.
  vi.spyOn(client, 'setTrust').mockImplementation((trust: boolean) =>
    Promise.resolve({ workspace: WORKSPACE, trusted: trust }),
  );
  return client;
}

// A realistic Windows-style workspace path. As a plain JS string, `\\` is one
// real backslash — this is the dir agents would run their CLIs in.
const WORKSPACE = 'D:\\proj\\choco-ai\\.workspace';

const connector: SocketConnector = () => new MockSocket();

beforeEach(() => {
  useChatStore.setState({ threads: [], messagesByThread: {}, streamingByThread: {}, activeThreadId: null });
  useAgentStore.setState({ roster: [], statusById: {} });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('App TrustGate wiring — gate visibility (edge)', () => {
  it('SHOWS the gate with the workspace path when getTrust reports an untrusted workspace', async () => {
    const client = makeClient(() => Promise.resolve({ workspace: WORKSPACE, trusted: false }));

    render(<App client={client} socketConnector={connector} />);

    const gate = await screen.findByTestId('trust-gate');
    expect(gate).toBeInTheDocument();
    expect(screen.getByTestId('trust-gate-path')).toHaveTextContent(WORKSPACE);
  });

  it('does NOT show the gate when getTrust reports the workspace is already trusted', async () => {
    const client = makeClient(() => Promise.resolve({ workspace: WORKSPACE, trusted: true }));

    render(<App client={client} socketConnector={connector} />);

    // Wait for the app to settle (roster loaded), then assert the gate never appeared.
    await screen.findByTestId('app-root');
    await waitFor(() => expect(client.getTrust).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('trust-gate')).not.toBeInTheDocument();
  });

  it('does NOT show the gate when no workspace is configured (workspace:null, trusted:true)', async () => {
    const client = makeClient(() => Promise.resolve({ workspace: null, trusted: true }));

    render(<App client={client} socketConnector={connector} />);

    await screen.findByTestId('app-root');
    await waitFor(() => expect(client.getTrust).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('trust-gate')).not.toBeInTheDocument();
  });

  it('does NOT show the gate when workspace is null even if untrusted (nothing to gate)', async () => {
    // Defensive: workspace null must suppress the gate regardless of `trusted`.
    const client = makeClient(() => Promise.resolve({ workspace: null, trusted: false }));

    render(<App client={client} socketConnector={connector} />);

    await screen.findByTestId('app-root');
    await waitFor(() => expect(client.getTrust).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('trust-gate')).not.toBeInTheDocument();
  });
});

describe('App TrustGate wiring — decisions (edge)', () => {
  it('GRANT: clicking 信任此目录 calls setTrust(true) and dismisses the gate', async () => {
    const client = makeClient(() => Promise.resolve({ workspace: WORKSPACE, trusted: false }));

    render(<App client={client} socketConnector={connector} />);
    await screen.findByTestId('trust-gate');

    await userEvent.click(screen.getByTestId('trust-gate-accept'));

    expect(client.setTrust).toHaveBeenCalledWith(true);
    await waitFor(() => expect(screen.queryByTestId('trust-gate')).not.toBeInTheDocument());
  });

  it('DECLINE: clicking 暂不信任 calls setTrust(false) and dismisses the gate (restricted run)', async () => {
    const client = makeClient(() => Promise.resolve({ workspace: WORKSPACE, trusted: false }));

    render(<App client={client} socketConnector={connector} />);
    await screen.findByTestId('trust-gate');

    await userEvent.click(screen.getByTestId('trust-gate-deny'));

    expect(client.setTrust).toHaveBeenCalledWith(false);
    // Declined → dismissed for the session; the gate hides (not trapped).
    await waitFor(() => expect(screen.queryByTestId('trust-gate')).not.toBeInTheDocument());
  });

  it('does NOT call setTrust until the user actually decides (gate is shown but inert otherwise)', async () => {
    const client = makeClient(() => Promise.resolve({ workspace: WORKSPACE, trusted: false }));

    render(<App client={client} socketConnector={connector} />);
    await screen.findByTestId('trust-gate');

    // Merely showing the gate must not have triggered any decision.
    expect(client.setTrust).not.toHaveBeenCalled();
  });
});

describe('App TrustGate wiring — fail-open (adversarial)', () => {
  it('FAIL-OPEN: a getTrust() REJECTION renders the app with NO gate (user not trapped)', async () => {
    const client = makeClient(() => Promise.reject(new Error('trust probe network error')));

    render(<App client={client} socketConnector={connector} />);

    // The app must still come up...
    expect(await screen.findByTestId('app-root')).toBeInTheDocument();
    await waitFor(() => expect(client.getTrust).toHaveBeenCalledTimes(1));
    // ...and the gate must NEVER appear on a probe failure (fail-open).
    expect(screen.queryByTestId('trust-gate')).not.toBeInTheDocument();
  });

  it('FAIL-OPEN: a setTrust() REJECTION still dismisses the gate and surfaces an error (never traps the user)', async () => {
    const client = makeClient(() => Promise.resolve({ workspace: WORKSPACE, trusted: false }));
    vi.spyOn(client, 'setTrust').mockRejectedValue(new Error('trust persist failed'));

    render(<App client={client} socketConnector={connector} />);
    await screen.findByTestId('trust-gate');

    await userEvent.click(screen.getByTestId('trust-gate-accept'));

    // The grant POST failed, but the gate must close (user gets in) and the error surfaces.
    await waitFor(() => expect(screen.queryByTestId('trust-gate')).not.toBeInTheDocument());
    expect(screen.getByTestId('app-error')).toHaveTextContent('trust persist failed');
  });
});
