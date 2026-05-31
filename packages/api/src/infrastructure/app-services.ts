// M8 AppServices — the DI bundle threaded through every route registrar.
//
// Source: clowder-design-supplement.md §D (constructor injection, no global
// singletons). app-factory.buildApp() constructs the concrete instances and
// passes this bundle to each route module's register function. Tests build it
// (via buildApp overrides) with a temp db + fake AgentService so routes are
// exercised end-to-end without real CLIs.

import type { AgentRouter, RouteLogger } from '@clowder/api/routing/agent-router';
import type { AgentRegistry } from '@clowder/api/routing/agent-registry';
import type { InvocationRegistry } from '@clowder/api/invocation/invocation-registry';
import type { SqliteMessageStore } from '@clowder/api/stores/sqlite-message-store';
import type { SqliteThreadStore } from '@clowder/api/stores/sqlite-thread-store';
import type { SqliteToolEventLog } from '@clowder/api/stores/sqlite-tool-event-log';
import type { SqliteEvidenceStore } from '@clowder/api/evidence/sqlite-evidence-store';
import type { SessionStore } from '@clowder/api/invocation/session-store';
import type { SocketManager } from '@clowder/api/infrastructure/socket-manager';

/**
 * The wired service bundle shared by all routes. Immutable references — routes
 * read these; they never reassign them.
 */
export interface AppServices {
  readonly router: AgentRouter;
  readonly registry: AgentRegistry;
  readonly invocations: InvocationRegistry;
  readonly messageStore: SqliteMessageStore;
  readonly threadStore: SqliteThreadStore;
  /** A6 tool-event log — the second (durable) sink for tool calls (M5 live-wire). */
  readonly toolEventLog: SqliteToolEventLog;
  readonly evidenceStore: SqliteEvidenceStore;
  /**
   * 补充 E session archive — read surface the session callbacks wrap
   * (list_session_chain / read_session_digest / read_session_events).
   */
  readonly sessionStore: SessionStore;
  readonly socket: SocketManager;
  /**
   * Structured logger for non-fatal route notes (the same {@link RouteLogger}
   * seam M4's AgentRouter uses). Routes log best-effort failures through this
   * instead of swallowing them silently (CLAUDE.md "never silently swallow
   * errors") — e.g. a durable tool-event-feed append that fails must still not
   * break the request, but the failure is logged here.
   */
  readonly logger: RouteLogger;
  /** Clock for route-stamped timestamps (injectable for deterministic tests). */
  readonly now: () => number;
}
