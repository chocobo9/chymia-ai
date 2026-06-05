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
import type { SqliteEventAuditLog } from '@choco/api/stores/sqlite-event-audit-log';
import type { SqliteEvidenceStore } from '@choco/api/evidence/sqlite-evidence-store';
import type { SqlitePlatformMappingStore } from '@choco/api/stores/platform-mapping-store';
import type { SessionStore } from '@choco/api/invocation/session-store';
import type { SocketManager } from '@choco/api/infrastructure/socket-manager';
import type { SopService } from '@choco/api/sop/sop-service';
import type { AgentOverrideStore } from '@choco/api/config/agent-overrides';
import type { RuntimeRosterStore } from '@choco/api/config/runtime-roster';
import type { AgentConfig } from '@choco/shared';
import type { AgentService } from '@choco/api/providers/base';
import type { AccountStore } from '@choco/api/config/account-store';
import type { AuthCliRunner } from '@choco/api/config/provider-auth';
import type { WeChatConfigStore } from '@choco/api/config/wechat-config-store';
import type { SkillService } from '@choco/api/skills/skill-service';

/**
 * PlatformOutbound — the web→平台 bridge seam. After a turn runs in a thread that
 * is linked to a platform channel (飞书/…), the message pipeline pushes the turn
 * (user message + agent replies) OUT to that channel — EXCEPT the platform the turn
 * came from (echo prevention). No-op for a web-only thread (no platform mapping).
 * The composition root wires the live adapter managers behind it; tests inject a
 * recording fake.
 */
export interface PlatformOutbound {
  deliverToLinkedChannels(input: {
    readonly threadId: string;
    /** The platform the turn originated from (skip it); undefined = web/HTTP. */
    readonly originAdapter?: string;
    /** The texts to mirror, in order (user message first, then each reply). */
    readonly lines: readonly string[];
  }): Promise<void>;
}

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
  /**
   * 审计事件日志（对齐 Clowder EventAuditLog）——引擎在 invoke 缝 emit
   * invoked/responded/error，seal 路由 emit session_seal，审计路由 readByThread 读。
   * 事件日志为空的老 thread 由审计路由回退到派生（不写本日志）。
   */
  readonly eventAuditLog: SqliteEventAuditLog;
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
  /**
   * M-ACCOUNT provider-account store (~/.choco accounts.json + credentials.json).
   * The account routes CRUD it; the invoke seam reads it to inject the agent's
   * provider API key into the CLI spawn env. Secrets never cross the read API
   * (the list returns `hasApiKey` only).
   */
  readonly accountStore: AccountStore;
  /**
   * M11 skill governance — per-skill on/off + the enabled-skill prompt block. The
   * catalog routes read its list + toggle it; the invoke seam injects its block.
   */
  readonly skillService: SkillService;
  /**
   * Provider-auth CLI runner — the seam the OAuth/login routes use to run
   * `claude auth status|login|logout` etc. Default spawns the real CLIs; tests
   * inject a fake that returns canned status + records the commands.
   */
  readonly authRunner: AuthCliRunner;
  /**
   * M13 WeCom adapter config store (~/.choco/wechat.json). The config routes
   * read/write it (secret write-only); the composition root reads it at start to
   * decide whether to wire the WeChat webhook.
   */
  readonly wechatConfigStore: WeChatConfigStore;
  readonly socket: SocketManager;
  /**
   * web→平台 出站桥：回合收尾时把（用户消息 + agent 回复）推到本 thread 关联的平台
   * 频道（飞书），来源平台除外（防回环）。web-only thread 无映射 → no-op。
   */
  readonly platformOutbound: PlatformOutbound;
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
