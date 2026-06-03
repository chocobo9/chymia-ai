// M8 AppServices — the DI bundle threaded through every route registrar.
//
// Source: clowder-design-supplement.md §D (constructor injection, no global
// singletons). app-factory.buildApp() constructs the concrete instances and
// passes this bundle to each route module's register function. Tests build it
// (via buildApp overrides) with a temp db + fake AgentService so routes are
// exercised end-to-end without real CLIs.

import type { AgentRouter, RouteLogger } from '@choco/api/routing/agent-router';
import type { AgentRegistry } from '@choco/api/routing/agent-registry';
import type { InvocationRegistry } from '@choco/api/invocation/invocation-registry';
import type { SqliteMessageStore } from '@choco/api/stores/sqlite-message-store';
import type { SqliteThreadStore } from '@choco/api/stores/sqlite-thread-store';
import type { SqliteToolEventLog } from '@choco/api/stores/sqlite-tool-event-log';
import type { SqliteEvidenceStore } from '@choco/api/evidence/sqlite-evidence-store';
import type { SqlitePlatformMappingStore } from '@choco/api/stores/platform-mapping-store';
import type { SessionStore } from '@choco/api/invocation/session-store';
import type { SocketManager } from '@choco/api/infrastructure/socket-manager';
import type { SopService } from '@choco/api/sop/sop-service';
import type { AgentOverrideStore } from '@choco/api/config/agent-overrides';
import type { RuntimeRosterStore } from '@choco/api/config/runtime-roster';
import type { AgentConfig } from '@choco/shared';
import type { AgentService } from '@choco/api/providers/base';

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
  /**
   * M-MEMBER agent-override store — the mutable RUNTIME OVERLAY over the static
   * agents.yaml roster. Routes read it to reflect live member edits
   * (roleDescription/personality/strengths/displayName/name/color) and the agent
   * PATCH route writes through it. The same overlay is layered onto the invoke
   * seam's `resolveConfig` in buildApp, so edits take effect on the NEXT turn's
   * system prompt without a server restart.
   */
  readonly agentOverrides: AgentOverrideStore;
  /**
   * 成员增删 — the persisted store of runtime-ADDED members (base agents.yaml
   * members are NOT here). POST /api/agents appends + hot-registers; DELETE
   * removes + unregisters. `has(id)` tells the routes which members are deletable.
   */
  readonly runtimeRoster: RuntimeRosterStore;
  /**
   * Factory that builds a provider AgentService for a NEW member, curried by the
   * composition root with the live permissionMode/commandByClient. The POST route
   * calls it then registry.register(config, service) so the member is invocable
   * without a restart. In tests it defaults to a no-op (registration-only) service.
   */
  readonly buildMemberService: (config: AgentConfig) => AgentService;
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
