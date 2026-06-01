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
import type { SqlitePlatformMappingStore } from '@clowder/api/stores/platform-mapping-store';
import type { SessionStore } from '@clowder/api/invocation/session-store';
import type { SocketManager } from '@clowder/api/infrastructure/socket-manager';
import type { SopService } from '@clowder/api/sop/sop-service';

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
   * A10 platform-mapping store — platform channelId/userId ↔ internal thread/user
   * id resolution. SHARED by the M13/M14 adapters (via the submitPlatformMessage
   * ingress) so both resolve identically. Web-only flows do not touch it.
   */
  readonly platformMappingStore: SqlitePlatformMappingStore;
  /**
   * 补充 E session archive — read surface the session callbacks wrap
   * (list_session_chain / read_session_digest / read_session_events).
   */
  readonly sessionStore: SessionStore;
  /**
   * M12 SOP service — the 告示牌 producer/consumer wiring. Routes use it to
   * validate a stageId before writing it (thread-routes PATCH setter, the
   * sop_advance_stage callback); the invoke seam reads it for the prompt hint.
   */
  readonly sopService: SopService;
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
  /**
   * Default agent workspace (the CLI cwd fallback when a thread has no
   * projectPath), externalized via `CHOCO_WORKSPACE` at the composition root.
   * Used by the operability tool-write-escape probe to judge whether a tool's
   * file-write path resolves inside the workspace. Optional — when unset (and the
   * thread has no projectPath) containment cannot be judged, so that probe is a
   * no-op (matching the provider's no-cwd behavior). Never used for routing.
   */
  readonly defaultWorkspace?: string;
}
