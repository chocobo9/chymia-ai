# Chymia Historical Target Design — Baseline 1

> Status: **Superseded historical snapshot; canonical rules were split into Module designs on 2026-07-26**
> Canonical index: [Chymia Documentation](../../README.md)
> Obsolete vocabulary warning: `Workspace Safety`, `Acceptance Policy`, and the Module list in this snapshot are historical proposals, not current target Modules.
> Scope: product and system target truth only; this document is not an implementation plan, migration plan, or issue list.
> Last audited: 2026-07-13

## 1. Executive Summary

Chymia is a local, single-developer control platform for running several Coding Agent CLIs against trusted local workspaces. Its core value is not “chat with several models”; it is to turn a coding objective into a durable, inspectable, permission-bounded collaboration whose state survives process failure and whose result can be evaluated against an explicit contract. [USER-DECISION] The user is one Personal Developer, and the core job is local coding work through multiple CLIs.

A Work Item is the coding objective that one Thread exists to complete; it is not the text, patch, report, or commit produced by the Thread. Those outputs are Result Artifacts evaluated by the Work Item's Result Contract. [USER-DECISION]

The current product already has a real Web entry, three real CLI adapters, persistent threads/messages/sessions/tool events, serial and parallel routing, and conditional platform connectors. [CODE-CONFIRMED] `scripts/launch.mjs`, `packages/api/src/main.ts`, `packages/api/src/app-factory.ts#buildApp`, `packages/api/src/routing/agent-router.ts#AgentRouter`, and `packages/api/src/providers/*` form the production path. A gated smoke suite also spawns Claude, Codex, and Gemini successfully. [TEST-CONFIRMED] `tests/providers/real-cli-smoke.integration.test.ts` passed with `RUN_CLI_SMOKE=1` on 2026-07-13.

The current architecture is nevertheless thread-centred and process-memory-centred: there is no durable Work Item/Run owner, invocation authorization and cancellation live in memory, audit is best-effort, restart reconciliation is absent, and several advertised capabilities exist only as types, UI, fake-backed tests, or disconnected stores. [CODE-CONFIRMED] `packages/api/src/invocations/invocation-registry.ts#InvocationRegistry` is a `Map` without lifecycle status; `packages/api/src/socket/handler.ts#handleThreadMessage` drives execution directly. [INFERENCE] A passing fake test cannot close those gaps.

The target has one deep `Work Orchestrator` Module. Its external Interface is deliberately small: `submit(WorkCommand)` for all state-changing intent and `inspect(WorkQuery)` for reads. It owns Work Item, Run, Invocation, command receipt, durable queue, and restart reconciliation. Tracker Integration, Eligibility Policy, Collaboration, Agent Runtime, Workspace Safety, Evaluation, Acceptance Policy, Outbox and Tracker Writer, and Web/Feishu Connector Modules own their distinct state and meet at explicit Seams. SQLite remains the local durability substrate; Coding Agent CLIs and trackers remain true external dependencies.

Chymia should borrow Clowder's mature mechanics—durable invocation identity, idempotent queueing, per-target cancellation, zombie reconciliation, sequence epochs, normalized provider events—and adapt them to a local SQLite and single-user domain. It should own its Work Item/Run semantics, Result Contract, local permission model, and optional tracker binding. It should reject Clowder's multi-person social/CVO domain, Redis requirement, broad connector/runtime surface, and Clowder-specific mission/backlog states. [REFERENCE] `reference/clowder-ai-main/README.zh-CN.md` and its invocation/queue/runtime modules.

## 2. Design Status

This target-design baseline is frozen as the current design truth. “Frozen” means confirmed product decisions and ownership rules cannot be silently reinterpreted by implementation, historical documents, or reference projects; a later change must be explicit and preserve decision history. Items explicitly listed in §27 remain open without making the confirmed baseline provisional.

Confirmed product decisions include: one Personal Developer; Work Item as Chymia's first-class work object; tracker-owned Issue with optional External Issue Binding; Run success separated from Work Item acceptance; all execution ingress through Work Commands; multi-agent collaboration inside a Run; Codex and Google Antigravity CLI as target defaults; and human acceptance for the next iteration's vertical slice. [USER-DECISION]

The target's default supported Coding Agent CLIs are Codex and Google Antigravity CLI. Claude Code is not a target default because the Personal Developer no longer has a subscription. [USER-DECISION] The current roster and production composition still register Claude, Codex, and Gemini and contain no Antigravity Adapter, so this is a target/current divergence rather than a claim about working code. [CODE-CONFIRMED] `packages/api/src/config/agents.yaml`, `packages/api/src/main.ts#resolveCommandByClient`, and `packages/api/src/providers/*`.

Confidence levels used below:

- **High**: traced through a production entry, persistent schema, or observed real effect.
- **Medium**: exercised by a test that reaches the real implementation, or supported by converging code and data.
- **Low**: fake-only, document-only, reference-only, or architectural inference.

No production code, schema, or runtime configuration is changed by this design.

## 3. Evidence Basis and Confidence

Evidence labels are strict:

- `[CODE-CONFIRMED]`: traced through an actual production composition root and call path.
- `[TEST-CONFIRMED]`: a test reaches the relevant real Implementation.
- `[FAKE-ONLY]`: only a fake or substitute closes the tested path.
- `[DOC-CLAIM]`: asserted by a current document but not confirmed by stronger evidence.
- `[REFERENCE]`: observed in Clowder and not automatically valid for Chymia.
- `[INFERENCE]`: target-design conclusion derived from evidence.
- `[ASSUMPTION]`: useful but unconfirmed premise that is not currently blocking.
- `[USER-DECISION]`: a product choice explicitly confirmed by the Personal Developer.
- `[OPEN-DECISION]`: a product choice that still requires the Personal Developer's decision.

### 3.1 Source priority applied

1. `scripts/launch.mjs`, `packages/api/src/main.ts#main`, `packages/api/src/app-factory.ts#buildApp`, registered routes, and runtime handlers.
2. `packages/api/src/storage/sqlite/*`, schema/migrations, provider process spawns, CLI discovery, configuration, and observed `choco.db` data.
3. Tests that start real providers or exercise production Implementations.
4. Fake-backed unit and edge tests.
5. `STATUS.md`, `CLAUDE.md`, `CHYMIA-POSITIONING.md`, `CONTEXT.md`, architecture notes, and ADRs.
6. Comments, names, historical plans, and placeholders.
7. `reference/clowder-ai-main`.

### 3.2 Confirmed production entry and main chain

`pnpm app` → `scripts/launch.mjs` → API `packages/api/src/main.ts#main` and Vite Web `packages/web/src/main.tsx` → `packages/web/src/App.tsx` → HTTP/WebSocket → `packages/api/src/socket/handler.ts#handleThreadMessage` → `packages/api/src/routing/agent-router.ts#AgentRouter` → serial/parallel routing → `packages/api/src/invocations/invoke-single-agent.ts#invokeSingleAgent` → selected Claude/Codex/Gemini CLI Adapter → streamed events, SQLite stores, audit, and socket projection. [CODE-CONFIRMED]

`packages/api/src/main.ts` also conditionally wires WeChat, auto-starts Weixin, and starts Feishu through managers built in `buildApp`. [CODE-CONFIRMED] Their presence conflicts with documents that state Feishu is the sole retained platform. [DOC-CLAIM]

### 3.3 Observed state

The inspected local `choco.db` contained 3 threads, 95 messages, 13 sessions, 520 tool events, 187 audit events, 0 tasks, 0 task progress rows, 0 evidence rows, and 0 platform mappings. [CODE-CONFIRMED] Of 96 unique `agent_invoked` audit identifiers, 89 had a terminal response/error and 7 did not. Three active sessions and 63 audit events referenced deleted threads because `SqliteThreadStore#delete` cascades only messages, tool events, tasks, and task progress. [CODE-CONFIRMED] This is direct evidence of competing lifecycle ownership, not merely untidy data.

### 3.4 Capability closure audit

| Capability | Claimed By | Production Entry | State Owner Today | Persistence | External Effect | Failure / Recovery | Verification | Status |
|---|---|---|---|---|---|---|---|---|
| Web conversation with a real CLI | Web UI, routes, provider code | WebSocket → `handleThreadMessage` | Thread store plus in-memory routing/cancel state | Threads, messages, sessions, tool events | Local CLI process and workspace actions | Errors stream; restart reconciliation absent | Real CLI spawn test plus production call trace | Partial |
| Claude/Codex/Gemini execution | Settings and provider registry | `buildApp` provider registry | Provider Adapter and SessionStore | Session/transcript fragments | Process spawn | Exit/error handled; effect outcome and retry state incomplete | Real smoke test | Partial |
| Serial handoff | UI routing mode and router | `AgentRouter` serial path | Router-local worklist | Conversation/tool facts only | More CLI invocations | Depth limits exist; durable chain recovery absent | Production trace and fake tests | Partial |
| Parallel fan-out | UI routing mode and router | `AgentRouter` parallel path | Router-local promises | Conversation/tool facts only | Concurrent CLI invocations | No durable fan-out barrier or restart recovery | Production trace and tests | Partial |
| Durable execution lifecycle | Invocation/task types and stores | No complete production owner | In-memory registry, router, several stores | Fragmented | CLI spawn/cancel | No authoritative restart reconciliation | Code inspection | Conflicting |
| Invocation callback authorization | MCP/callback routes | Registered routes → `InvocationRegistry` | In-memory registry | None | Callback tool use | Process restart loses authority/idempotency | Production trace | Partial |
| Cancellation | Web/socket routes | Thread/agent controller maps | In-memory AbortControllers | None | Process signal | Lost on restart; terminal race not durable | Production trace and tests | Partial |
| Sessions and resume | Session store and providers | `invokeSingleAgent` session selection | SessionStore | SQLite | Provider resume flag | Known reopen/sealing defects; orphan sessions observed | Code, data, tests | Conflicting |
| Audit and activity visibility | Audit UI and store | Best-effort writes on invoke/respond/error | Audit store | SQLite | None | Audit write failure is not coupled to state | Code and observed rows | Partial |
| Task/issue execution | Task board, schema, positioning | No closed production Work Item/Run entry | Task store/UI | SQLite tables, currently empty | Potential provider work | Fake-backed flows; no durable owner | Data and tests | Fake-only |
| Evidence/memory | Workspace tabs and stores | Read/write routes exist | Several stores | SQLite, currently empty for evidence graph | None | Not tied to Result Contract | Code, data, fake tests | Partial |
| Feishu connector | Main wiring and docs | Feishu manager when configured | Connector-local manager plus thread path | Platform mapping table | Feishu send/receive | Credentials and live delivery not audited here | Production registration; fake tests | Partial |
| WeChat/Weixin connectors | Main wiring/settings | Conditional/auto-start managers | Connector-local state | Configuration/mappings | Platform send/receive | Conflicts with stated scope; live verification absent | Production registration only | Conflicting |
| Telegram | Settings/types/history | No confirmed registered production path | None | Configuration residue | None | None | Code inspection | Dead path |
| Scheduler, community, marketplace, notifications | Web placeholders | No complete production entry | UI-only | None | None | None | UI inspection | Placeholder |
| Workspace trust/read/git | Workspace routes and adapters | Registered workspace routes | Workspace services/config | Local config/files | Filesystem/git | Trust is eligibility, not per-effect authorization | Production trace and tests | Partial |

No core execution capability qualifies as `Complete`: each lacks at least one of durable authoritative lifecycle, real recovery, effect authorization, or observable acceptance.

## 4. Problem Statement

The Personal Developer needs to delegate coding work across several local Coding Agent CLIs without manually reconstructing who is doing what, which workspace they may change, whether an action actually completed, or what should happen after a crash. Chymia must convert a coding objective into a controlled collaboration with durable identity, explicit lifecycle, constrained effects, observable evidence, and a verifiable result.

The problem is orchestration and control over local coding work. It is not model hosting, a generic multi-agent social network, or a thin chat UI.

## 5. Users and Core Jobs

### Primary user

The sole primary user is the **Personal Developer**. [USER-DECISION]

### Core jobs

1. Define or receive one coding objective from the local Web UI, Feishu, or an optional external issue tracker.
2. Select trusted local workspace(s), agents, collaboration mode, Result Contract, and permission profile.
3. Start, observe, pause at safe points, resume, cancel, retry, or terminate work without guessing hidden process state.
4. Let agents collaborate serially or in isolated parallel work while retaining a single authoritative Run record.
5. Review resulting artifacts, validation evidence, errors, and external effects.
6. Recover honestly after Chymia, a CLI, or the machine restarts without editing SQLite by hand.

## 6. Goals and Non-goals

### Goals

- One durable Work Item and Run model across Web, Feishu, callbacks, and optional tracker ingress.
- Real Codex and Google Antigravity CLI execution behind a stable Agent Executor Seam.
- Explicit Result Contract and evidence-based success.
- Unique state ownership, atomic state/audit/outbox recording, restart reconciliation, and idempotent commands.
- Local workspace isolation, leases, permission grants, and auditable external effects.
- Full Personal Developer visibility into agent events and decisions.
- SQLite-first local operation with no mandatory server infrastructure.

### Non-goals

- Multi-tenant organizations, team billing, RBAC administration, or a hosted SaaS control plane.
- Recreating Clowder's CVO/personality, social, game, voice, signal, or community product.
- Making every messaging platform a supported Adapter; Feishu is the recommended single remote ingress.
- Treating an external issue tracker as Chymia's execution-state owner.
- A generic workflow-language editor, public event bus, or plugin marketplace as part of the core.
- Hiding unsafe CLI autonomy behind a workspace-level “trusted” flag.
- Requiring Redis or another remote service for core local use.

## 7. Ubiquitous Language

`CONTEXT.md` is the canonical concise glossary. The target model relies particularly on these distinctions:

- **Work Item**: Chymia-owned boundary for one coding objective.
- **External Issue Binding**: optional reference to a tracker-owned Issue; never a synchronized second owner.
- **Thread**: collaboration and conversation space for one Work Item; not execution state.
- **Run**: one bounded attempt to satisfy a Work Item; terminal Runs never reopen.
- **Agent Invocation**: one activation of exactly one Coding Agent CLI within a Run.
- **Session**: provider continuity for one agent; not work completion.
- **Result Contract**: required artifacts and evidence for Run success.
- **Agent Event**: durable execution fact; a Conversation Projection is only a human-facing view.
- **Human Decision Point**: an intentional stop for judgment, permission, or acceptance; not a generic process pause.

Avoid using “task”, “issue”, “thread”, “session”, and “run” interchangeably.

### 7.1 Canonical terminology resolution

The definitions are based on **ownership, identity, lifecycle, and completion authority**, not on UI labels:

| Term | Owner | Stable identity and lifecycle | Completion authority | Explicitly not |
|---|---|---|---|---|
| Work Item | Chymia / Work Orchestrator | Exists independently of any connector or tracker; contains the objective and acceptance state | Chymia's Result Contract plus configured acceptance policy | Issue, Thread, prompt, generated output |
| External Issue Binding | Chymia / Tracker Integration Module | Maps one Work Item to a tracker identity, observed revision, selected facts, and write-back policy | None; it cannot complete either side | State synchronization or shared lifecycle owner |
| Issue | External tracker | Tracker key, fields, hierarchy, and tracker status | Tracker and its authorized users/automation | Chymia execution record |
| Thread | Chymia / Collaboration Module | Persistent conversation and shared context for exactly one Work Item | None; a final message does not complete work | Work Item or Run |
| Run | Chymia / Work Orchestrator | One immutable execution attempt under pinned inputs/policies | Result Contract verdict determines Run success | Session or entire Work Item history |
| Agent Invocation | Chymia / Work Orchestrator | One activation of one Coding Agent CLI inside a Run | Its own known terminal provider outcome only | Run success or Work Item acceptance |
| Result Artifact | Chymia / Evaluation references | Concrete output such as a patch, report, commit, or evidence | Evaluated as a Result Contract clause | The objective itself |

The ownership test is: **which system can still create, advance, recover, and terminate the object while the other system is unavailable?** A local Web or Feishu request must remain valid when no tracker exists, so Chymia requires its own Work Item. A tracker record must remain valid when Chymia is offline, so the tracker retains its Issue. [INFERENCE]

The canonical issue-driven flow is:

```text
Issue eligibility
  → Create or reuse Work Item command
  → Run
  → Collaboration plus Agent Invocations
  → Result Contract evaluation
  → Run succeeded
  → Work Item awaiting_acceptance
  → Work Item acceptance
  → optional authorized tracker write-back
```

“Issue eligibility” is only a Tracker Integration observation evaluated by Eligibility Policy to propose a Work Command. It does not make the Issue the Run owner. Tracker write-back is an authorized, idempotent External Effect; it is not hidden bidirectional synchronization.

Boundary cases follow directly:

- Work created in Web or Feishu has a Work Item and Thread with no External Issue Binding.
- A bound Issue becoming unavailable or deleted degrades the Binding but does not erase or suspend Chymia history.
- Tracker status `done` does not make a Work Item `satisfied`; Chymia acceptance does not close the Issue unless an authorized write-back succeeds.
- Retrying work creates another Run under the same Work Item, not another Issue and not a reopened Run.
- Splitting an external Issue into Sub-Issues produces separately bindable tracker identities; it does not turn Sub-Issue status into Chymia execution state.

`CHYMIA-POSITIONING.md` currently asserts both “issues first-class work objects” and `project → issue → sub-issue`. [DOC-CLAIM] Under its ordinary tracker meaning, that cannot coexist with offline Web/Feishu work and Chymia-owned execution. The canonical target interpretation is therefore: **Work Item is the first-class Chymia work object; Issue is a first-class external input and human-facing record when bound.** The positioning document remains conflict evidence, not a second glossary.

## 8. Bounded Contexts or Domain Scope

Chymia has four domain scopes:

1. **Work Control** — Work Items, Runs, Invocations, commands, lifecycle, retries, and reconciliation.
2. **Collaboration** — Threads, messages, participants, handoffs, and conversation projections.
3. **Execution Safety** — workspaces, leases, authorization grants, effect intents, and outcomes.
4. **Evaluation** — Result Contracts, evidence, validation outcomes, and acceptance.

Provider protocols, Feishu protocol, SQLite, git, filesystem, and external trackers are integration concerns behind Adapters. They are not bounded contexts and do not own Chymia lifecycle.

## 9. Domain Model

```text
Personal Developer
  └─ owns many Work Items
       ├─ has exactly one canonical Thread
       ├─ has zero or one External Issue Binding per tracker
       ├─ has one Result Contract
       └─ has many Runs (at most one non-terminal by default)
            ├─ has many Agent Invocations
            │    ├─ may use one Agent Session
            │    └─ emits ordered Agent Events
            ├─ holds one or more Workspace Leases
            ├─ requests zero or more External Effects
            └─ produces Evidence and Result Artifacts
```

An external Issue may exist without Chymia, and a Work Item may exist without an Issue. [INFERENCE] This preserves local and Feishu-originated work while preventing a tracker from becoming an accidental execution database.

Serial handoff adds Agent Invocations to the same Run's bounded Worklist. Parallel fan-out creates sibling Invocations from the same immutable starting context. A fan-out branch cannot recursively create another fan-out; a requested handoff is queued for the serial continuation after the barrier.

## 10. Core Invariants

1. Every authoritative record has exactly one owner Module; other Modules hold identifiers or derived projections only.
2. Every accepted state-changing command has a durable command receipt before external execution begins.
3. At most one non-terminal Run exists for a Work Item unless an explicit isolated-experiment policy says otherwise.
4. A terminal Run or Invocation never returns to a non-terminal state. Retry creates a new Run; a provider re-spawn creates a new Invocation.
5. A Run is `succeeded` only when its Result Contract is mechanically satisfied; process exit zero or a “done” message is insufficient.
6. Work Item satisfaction is distinct from Run success and requires the configured acceptance policy, normally the Personal Developer.
7. A Session carries provider continuity only and cannot make a Work Item or Run complete.
8. A mutating Invocation must hold a valid Workspace Lease and Authorization Grant before its external effect begins.
9. State transition, durable event, audit fact, and outbox intent are committed atomically when they describe the same decision.
10. An external effect with unknown outcome is never blindly retried.
11. Every inbound delivery is at-least-once; command idempotency makes duplicate delivery safe.
12. Deleting or archiving a Work Item cannot silently orphan live Sessions, Invocations, effects, or audit facts.
13. Projections, UI state, socket order, and tracker state cannot override authoritative Chymia state.

## 11. Authoritative State

| State | Meaning | Owner Module | Persistence | Created By | Mutated By | Observed By | Recovery Rule |
|---|---|---|---|---|---|---|---|
| Work Item | Stable coding objective and acceptance state | Work Orchestrator | SQLite snapshot + durable events | `submit(CreateWork)` | Validated Work Commands | All read models/connectors | Rebuild snapshot from durable facts; never infer from Thread messages |
| Run | One bounded attempt and its lifecycle | Work Orchestrator | SQLite snapshot + durable events | `submit(StartRun)` | Orchestrator transition rules | UI, connectors, evaluator | Reconcile every non-terminal Run before accepting ingress |
| Invocation | One CLI activation and terminal outcome | Work Orchestrator | SQLite snapshot + durable provider facts | Orchestrator dispatch | Orchestrator from Agent Executor facts | Run projection, audit | Query/reconcile process handle; unresolved becomes `interrupted` or remains `outcome_unknown` |
| Command Receipt | Idempotency identity, payload hash, acceptance/result | Work Orchestrator | SQLite unique `(source, key)` | Any ingress Adapter | Orchestrator only | Caller, audit | Same payload returns original receipt; different payload conflicts |
| Durable Dispatch Queue | Eligible work and retry time | Work Orchestrator | SQLite | Orchestrator | Orchestrator scheduler/reconciler | Runtime projection | Lease expiry makes item re-eligible; no in-memory-only dispatch |
| Dispatch Claim | Exclusive right to dispatch one Work Item/Run, distinct from workspace mutation rights | Work Orchestrator | SQLite owner/expiry/fencing token | Orchestrator transaction | Orchestrator heartbeat/release/reconcile | Scheduler, audit | Expired claim is fenced and reconciled before redispatch |
| Thread and Message Facts | Human/agent collaboration history | Collaboration Module | SQLite append facts + thread metadata | Work Orchestrator or inbound Adapter | Collaboration Interface | UI and prompt builder | Append idempotently; projection can be rebuilt |
| Conversation Projection | Ordered human-readable thread view | Collaboration Module | Rebuildable read model | Durable Agent/Message events | Collaboration projector | UI/connectors | Rebuild from facts using epoch/sequence |
| Agent Session | Provider continuity token/transcript and usability | Agent Runtime Module | SQLite | Agent Executor | Agent Runtime only | Orchestrator by reference | Reconcile; mark `lost` if provider continuity cannot be proved |
| Workspace Binding | Canonical local root and identity | Workspace Safety Module | SQLite/config with stable workspace ID | Personal Developer | Workspace Safety Interface | Orchestrator and executor | Resolve real path; fail closed if identity/path changed |
| Workspace Lease | Exclusive mutation right and fencing token | Workspace Safety Module | SQLite | Orchestrator request | Safety Module lease rules | Executor, audit | Expire/reconcile; stale fencing tokens cannot mutate |
| Authorization Grant | Allowed action classes, scope, expiry, principal | Workspace Safety Module | SQLite immutable grant | Personal Developer/policy | New grant only; no hidden widening | Executor and audit | Fail closed after restart or expiry |
| External Effect | Proposed action, grant, attempt, and outcome | Workspace Safety Module | SQLite effect ledger | Executor via Safety Interface | Safety Module from observed outcome | Orchestrator, audit, user | `outcome_unknown` blocks retry pending reconciliation/decision |
| Result Contract | Required artifacts and evidence | Work Orchestrator | SQLite with Work Item | Create/update Work before Run | Validated pre-Run command | Evaluator and user | Version pinned to Run at start |
| Evidence and Evaluation | Durable observations and contract verdict | Evaluation Module | SQLite/artifact references | Evaluator/authorized agent | Evaluation Interface | Orchestrator, UI | Re-evaluate from immutable evidence; verdict is versioned |
| External Issue Binding | Tracker identity, observed revision/snapshot, health and write-back policy | Tracker Integration Module | SQLite | Binding command | Tracker observation commands | UI/orchestrator/eligibility | Re-fetch tracker; conflict is surfaced, never “kept in sync” silently |
| Eligibility Policy Version | Repository-owned rules mapping observations to Work Commands | Eligibility Policy Module | Versioned repository configuration | Personal Developer | Explicit configuration change | Tracker Integration/Orchestrator/audit | Pin decision to policy version; invalid policy prevents new tracker dispatch |
| Delivery Receipt / Outbox Cursor | Authorized tracker write-back identity and progress | Outbox and Tracker Writer Module | SQLite outbox/receipt | Atomic domain transition | Tracker Writer through Adapter | Tracker Integration/audit | Retry with remote idempotency key; preserve unknown outcome |
| Agent/Provider Configuration | Available CLI, profile, capability, executable | Agent Runtime Module | Local config + discovered facts | User/discovery | Agent Runtime config Interface | Orchestrator/UI | Rediscover; unavailable provider degrades only dependent work |

Current conflicts are explicit: Thread/message state is persistent while Run state is absent; Invocation Registry and cancellation are in-memory; deletion cascades differ by store; audit and Session rows outlive Threads; Task tables compete with Thread routing without owning production execution. [CODE-CONFIRMED] The target does not “keep these synchronized”; it assigns ownership as above.

## 12. Lifecycle and State Machine

### 12.1 Work Item lifecycle

States: `open` (objective defined), `active` (a Run is non-terminal), `blocked` (progress requires an unresolved human/dependency/permission decision), `awaiting_acceptance` (a Run met its Result Contract), `satisfied` (accepted outcome), and `abandoned` (user ended the objective).

| From | To | Trigger | Preconditions | Persistence / Effect | Retry and reopening |
|---|---|---|---|---|---|
| — | open | `CreateWork` | Valid objective, Thread, Result Contract | Atomic Work Item + Thread + receipt | Duplicate command returns original |
| open | active | `StartRun` | No non-terminal Run; valid workspace/grants | Run created before dispatch | Failed start leaves Work Item open |
| active | blocked | Run reaches Human Decision Point or dependency block | No uncontrolled CLI remains active | Persist reason and required decision | Decision starts/resumes controlled work |
| active | awaiting_acceptance | Run `succeeded` | Contract verdict satisfied | Persist verdict and artifacts | Revision creates a new Run |
| active | open | Run terminal but not successful | No other non-terminal Run | Preserve failed/timed-out/canceled/interrupted Run | Retry creates new Run |
| blocked | active | Authorized resume/new Run | Block resolved and prerequisites valid | Persist transition before dispatch | Idempotent command |
| blocked | abandoned | User abandons | Active external effects resolved/unknown surfaced | Terminal | Cannot reopen; create new Work Item |
| awaiting_acceptance | satisfied | User/policy accepts | Contract and evidence version match | Terminal acceptance fact | Cannot reopen; follow-up is new Work Item |
| awaiting_acceptance | active | User requests revision | New Run created | Old Run remains terminal | New attempt only |
| open/awaiting_acceptance | abandoned | User abandons | No live unsafe effect | Terminal | Cannot reopen |

### 12.2 Run lifecycle

States: `queued`, `preparing`, `running`, `awaiting_permission`, `awaiting_human`, `pause_requested`, `paused`, `retry_wait`, `cancellation_requested`, `succeeded`, `failed`, `timed_out`, `canceled`, `interrupted`, and `terminated`.

- Initial state is `queued`. The Orchestrator persists it with a pinned Result Contract, policy, workspace set, and collaboration specification.
- `queued → preparing` occurs when a durable queue lease is acquired. `preparing → running` requires provider capability, Workspace Lease, and Authorization Grant.
- `running → awaiting_permission` happens before a not-yet-authorized effect; no such effect may begin. Grant returns to `running`; denial reaches `failed`, `canceled`, or `awaiting_human` according to command semantics.
- `running → awaiting_human` is a domain stop with no uncontrolled process. A response resumes using a new Invocation.
- `running → pause_requested → paused` is allowed only at a durable safe point. If a CLI cannot checkpoint safely, “pause” is represented as cancellation and a later new Run, not OS-process suspension.
- `running → retry_wait → running` is an automatic bounded retry of the Run's work, but each process re-spawn creates a new Invocation. Backoff and budget are persisted.
- `running/* → cancellation_requested → canceled` records intent before signaling the process. A concurrent successful terminal fact wins only through versioned transition rules and is never overwritten.
- `succeeded` requires a satisfied Result Contract. `failed` means a known terminal failure; `timed_out` means the pinned deadline expired; `interrupted` means a crash or lost process prevented a known clean outcome; `terminated` means safety/policy forcibly ended work.
- All terminal states are immutable. User retry creates a new Run with `retryOfRunId`. `terminated` requires fresh authorization to create another Run.

### 12.3 Invocation lifecycle

States: `queued`, `waiting_workspace`, `waiting_permission`, `starting`, `running`, `cancellation_requested`, `succeeded`, `failed`, `canceled`, `timed_out`, `interrupted`, and `skipped`.

An Invocation is persisted before Agent Executor start. `starting → running` requires a durable process/provider handle. Provider events carry `(invocationId, epoch, sequence or providerEventId)` and are deduplicated. Timeout and cancellation intents are persisted before signaling. `not-found` during reconciliation becomes `interrupted` unless a durable terminal receipt proves another outcome. A terminal Invocation never retries in place.

### 12.4 Session lifecycle

States: `usable`, `sealed`, and `lost`. At most one usable Session exists per `(Thread, Agent, Provider Profile)`, and only one Invocation may lease it at a time. A normal provider completion may keep a Session usable; an explicit context boundary or incompatible profile seals it; unprovable continuity marks it lost. Sealed/lost Sessions never reactivate.

### 12.5 External Effect lifecycle

States: `proposed`, `authorized`, `executing`, `succeeded`, `failed`, `outcome_unknown`, and `compensated`. Authorization records the grant and normalized intent. The effect's idempotency key is persisted before execution. Only effects with provider-supported reconciliation may automatically leave `outcome_unknown`; otherwise user decision is required. Compensation is a new audited effect, not deletion of history.

### 12.6 Completion and acceptance are separate stages

The canonical completion chain is:

```text
Invocation terminal fact
  → Run evaluating
  → structured Evaluation verdict satisfied
  → Run succeeded
  → Work Item awaiting_acceptance
  → Personal Developer / Acceptance Policy decision
  → Work Item satisfied | new Run requested | Work Item abandoned
  → optional authorized tracker write-back
```

Evaluation owns the verdict but cannot mutate Run or Work Item state. Work Orchestrator records `Run succeeded` from a satisfied verdict and records the distinct `Work Item awaiting_acceptance` transition. Acceptance Policy or the Personal Developer owns the acceptance decision; Work Orchestrator persists that decision. Tracker write-back occurs after local acceptance as an independent External Effect and cannot roll back the local acceptance fact.

## 13. Module Ownership

| Module | Owned responsibility and state | Depth / Leverage | Must not own |
|---|---|---|---|
| Work Orchestrator | Work Item, Run, Invocation, command receipt, queue, lifecycle, retries, reconciliation coordination | Hides state machines, concurrency, idempotency, recovery, and ordering behind two entry points; highest Leverage | Conversation storage, provider protocol, workspace authorization implementation |
| Tracker Integration | External Issue Binding, normalized observations, observed revision and binding health | Hides tracker identity/revision semantics behind one tracker Adapter | Work Item, Run, eligibility rules, CLI dispatch, acceptance |
| Eligibility Policy | Versioned repository-owned mapping from Issue observations to idempotent Work Commands | Pure in-process decision Interface; keeps tracker workflow knowledge out of Orchestrator | Direct state mutation, CLI spawn, command receipt |
| Collaboration | Thread, message facts, participants, Worklist semantics, Conversation Projection | Hides append/order/context assembly and replay; stable test surface for collaboration | Run completion or CLI process state |
| Agent Runtime | provider discovery/config, Session, CLI execution normalization | Hides process protocol, parser, resume token, capability differences | Work state, permission decisions, user acceptance |
| Workspace Safety | workspace identity/trust, leases/fencing, grants, effect ledger | Hides path safety, exclusive mutation, effect policy, uncertain outcomes | Agent routing or conversation projection |
| Evaluation | Evidence, validation execution, Result Contract verdict | Hides artifact collection and gate-specific interpretation | Transition authority; it returns facts to Orchestrator |
| Acceptance Policy | Accept, revise or abandon decision under the configured human/policy rule | Keeps satisfaction authority separate from mechanical Evaluation | Run success, Issue state, tracker write-back execution |
| Outbox and Tracker Writer | Authorized tracker write-back outbox, attempts and receipts | Hides at-least-once delivery, idempotency and uncertain outcome handling | Local acceptance, Issue observation, implicit state mirroring |
| Connector | Web and Feishu protocol translation | Keeps platform identity/protocol knowledge local | Direct CLI calls or lifecycle mutation |
| Composition Root | constructs production Implementations and validates readiness | One visible place for Adapter selection | Business workflow or state mutation |

Deleting the Work Orchestrator would scatter lifecycle, idempotency, restart recovery, ordering, and error knowledge back into socket handlers, connectors, routers, and provider code; it is therefore a deep Module rather than a renamed service layer.

## 14. Interfaces and Seams

### 14.1 Work Orchestrator Interface

```ts
interface WorkOrchestrator {
  submit(command: WorkCommand): Promise<CommandReceipt>;
  inspect(query: WorkQuery): Promise<WorkView>;
}
```

`WorkCommand` is a closed domain union such as create work, bind issue, start, provide decision, pause, resume, cancel, retry, terminate, accept, or ingest a verified internal fact. Every command carries command ID, source, idempotency key, principal/provenance, expected version when relevant, and payload hash.

- **Caller knowledge:** domain intent, identity/provenance, expected version, and requested result; not store order, provider flags, or state-transition sequences.
- **Input/output:** one command → durable receipt with accepted/rejected/duplicate/conflict and resulting identifiers; one query → immutable view with source versions.
- **Invariants/order:** the Module validates, persists receipt and transition, and writes outbox before an external effect. Callers never pre-create Invocation rows or call Adapters directly.
- **Errors:** validation, authorization, version conflict, idempotency conflict, unavailable capability, capacity, and transient infrastructure are distinct typed outcomes. Accepted commands do not later become “not accepted”.
- **Idempotency:** same `(source,key,payload hash)` returns the original receipt; key reuse with a different hash is a conflict.
- **Capacity:** bounded queue, one active mutating Run per Work Item and one mutating lease per workspace by default; overload rejects or remains durably queued.
- **Permissions:** principal and provenance are mandatory; authorization is delegated to Workspace Safety.
- **Hidden complexity:** lifecycle graph, storage transactions, retry budget, queue leases, effect coordination, restart reconciliation, cancellation races, and projection emission.
- **Production Adapter:** SQLite-backed Implementation with real Agent Runtime, Safety, Evaluation, and outbox.
- **Test Adapter:** deterministic in-memory/fault-injecting Implementations behind the same Interface; no public store internals.
- **Seam rationale:** every ingress expresses the same work intent, while orchestration policy has one owner. The small Interface maximizes Depth, Leverage, and Locality.

Construction is asynchronous and performs schema/readiness checks, fencing, and non-terminal reconciliation before ingress receives a ready handle. Startup recovery is an Implementation obligation, not a third public workflow method.

### 14.2 Agent Executor Interface

```ts
interface AgentExecutor {
  start(spec: InvocationSpec): Promise<ExecutionHandle>;
  cancel(handle: ExecutionHandle, reason: CancelReason): Promise<CancelReceipt>;
  reconcile(handle: ExecutionHandle): Promise<ExecutionObservation>;
}
```

The caller knows normalized prompt/context, provider profile, Session reference, workspace lease/fencing token, grant, timeout, and Invocation ID. The Implementation hides executable discovery, flags, stream parsing, resume tokens, process trees, and provider quirks. Outcomes distinguish completed, failed, canceled, timed out, running, not found, and unknown. `start` is idempotent by Invocation ID where the provider allows it; otherwise duplicate start is rejected before spawn. Target production Adapters are Codex and Google Antigravity CLI; the test Adapter is scripted/fault-injecting. [USER-DECISION] The current Claude/Codex/Gemini Implementations prove that a multi-Adapter Seam is real, but only Codex is a target Adapter worth carrying forward directly; Antigravity is currently Missing. [CODE-CONFIRMED]

### 14.3 Collaboration Interface

The Collaboration Module exposes append/read/context operations over domain messages and Agent Events with expected sequence. It guarantees immutable fact identity, per-thread epoch/sequence, participant identity, and bounded prompt context. Duplicate facts are no-ops; gaps return a catch-up requirement. It hides message tables, projection layout, and prompt compaction. The Interface is the primary collaboration test surface.

### 14.4 Workspace Safety Interface

The caller proposes an effect intent or requests a lease; the Module returns a scoped grant/lease or a typed denial. It hides canonical path checks, symlink/path escape prevention, git/worktree knowledge, fencing, effect classification, expiry, and outcome reconciliation. Production Adapters use the local filesystem/git/process environment; tests use a controlled virtual workspace. This Seam is necessary because filesystem, process, git-local, and remote-publish effects have different reversibility and control.

### 14.5 Evaluation Interface

The caller supplies a pinned Result Contract and artifact references; the Module returns a versioned verdict and Evidence references. It hides repository SOP parsing, command execution details, artifact hashing, and validation output normalization. It may never directly mark a Run successful.

### 14.6 Collaboration Projection and Outbox Interfaces

Collaboration consumes durable ordered facts and builds the Conversation Projection. Epoch plus sequence supports reconnect and replay without treating in-process promise ordering as durable truth. Separately, Outbox and Tracker Writer consumes authorized write-back intents and returns durable delivery receipts. Delivery is at-least-once; UI/socket/connector code cannot mutate source state.

## 15. Main Runtime or Workflow Semantics

1. At startup and at the start of every scheduler round, reconciliation completes before candidate dispatch.
2. Tracker Integration observes one configured tracker and records normalized Issue snapshots with observed revision. Web/Feishu input bypasses eligibility observation but not Work Commands.
3. Eligibility Policy converts an Issue observation into an idempotent create/reuse, start, pause, cancel or reconcile Work Command; it never spawns a CLI.
4. Work Orchestrator durably accepts/deduplicates every Web, Feishu, tracker, handoff, callback, retry and reconciliation command.
5. Before dispatch, Tracker Integration refreshes the bound Issue. A stale, missing, ineligible or unavailable observation prevents a new tracker-driven Invocation.
6. Orchestrator acquires a durable Dispatch Claim; Workspace Safety acquires the separate deterministic Workspace Lease and Authorization Grant.
7. Starting a Run pins Result Contract, observed Issue revision, collaboration specification, provider profiles, workspace identity, deadline/budgets and policy versions.
8. Agent Runtime emits normalized durable facts. Collaboration owns conversation facts/projection; Orchestrator alone advances Run/Invocation lifecycle.
9. Serial handoff extends the bounded Worklist. Parallel fan-out runs sibling Invocations under a persisted join barrier; mutating parallelism requires isolated worktrees and is outside the next iteration.
10. Evaluation returns a structured verdict. Only a satisfied verdict permits Orchestrator to record `Run succeeded`; it then records the distinct `Work Item awaiting_acceptance` state.
11. Personal Developer/Acceptance Policy submits accept, revise or abandon. Acceptance creates a local terminal fact before any tracker write-back.
12. Outbox and Tracker Writer performs only authorized, idempotent write-back; failure never rolls back local acceptance.

## 16. External Dependencies and Adapters

| Dependency | Classification | Target Adapter / control |
|---|---|---|
| Domain Modules in one process | In-process | Direct typed Interfaces; no network abstraction |
| SQLite and clock/ID generators | Local-substitutable | Production SQLite; deterministic test substitutes |
| Codex and Google Antigravity CLI executables | True external | One Agent Executor Adapter each; capability discovery and honest degradation |
| Local filesystem, shell, git | True external | Workspace Safety-mediated Adapters with leases/grants/effect receipts |
| Feishu API | True external | One Connector Adapter plus durable outbox/receipt |
| External issue tracker | True external and optional | Tracker Adapter owns binding translation, never Chymia lifecycle |
| A self-hosted relay under the user's control | Remote but owned, optional | Explicit Adapter only if deployed; never a core requirement |

Do not introduce Interfaces for hypothetical providers. A second Implementation is not required when the dependency is in-process and stable; a Seam is justified when volatility, substitutability, permissions, or true external control exists.

## 17. Persistence and Recovery

- SQLite is the canonical local store. Lifecycle snapshots, immutable events, command receipts, queue leases, authorization/effect records, and outbox writes sharing one decision commit in one transaction.
- Snapshot tables optimize reads; immutable facts establish transition/audit history. Neither is independently writable by callers.
- On startup, the Orchestrator fences old workers, expires stale queue/workspace leases, reconciles non-terminal Invocations, seals or loses unprovable Sessions, and only then enables ingress.
- A running process that cannot be proven alive or terminal becomes `interrupted`; an external effect whose completion cannot be proven becomes `outcome_unknown`. These are not converted to `failed` for convenience.
- Thread archival preserves referenced execution history. Hard deletion is allowed only after the owning Module proves there is no live Run/Invocation/Session/lease/effect and applies one coherent retention policy.
- Database and artifact schema versions are explicit. Unsupported newer state fails closed rather than starting partially.
- Read models and Conversation Projections are rebuildable. Authorization Grants, effect outcomes, receipts, and acceptance are not disposable projections.

### 17.1 Tracker reconciliation policy

| Observation | Binding state | Work Command / dispatch effect | Local-state rule |
|---|---|---|---|
| Tracker temporarily offline | `degraded` | No new tracker-driven Run or Invocation; current Invocation may reach a safe checkpoint, then no continuation dispatch | Preserve Work Item, Thread, Run, workspace and artifacts |
| Issue no longer eligible | `healthy` with ineligible snapshot | Explicit `PauseRun` for reversible policy loss or `CancelRun` when policy requires termination | Preserve all history; never infer acceptance |
| Issue deleted | `orphaned` | Pause autonomous execution and create a Human Decision Point | Never delete local objects |
| Issue becomes tracker `done` | `healthy` with terminal snapshot | Stop new dispatch; pause/cancel active autonomous execution according to safety; record external/local conflict if contract is unsatisfied | Never mark Run succeeded or Work Item satisfied |
| Issue reopened | refreshed healthy revision | Recompute eligibility; if continuation is authorized, create a new Run | Never reopen a terminal Run |
| Issue revision changes during Run | `conflicted` until decision | Persist version-conflict decision; do not replace Run-pinned input | Continue only under explicit policy/decision |
| Work Item accepted | unchanged | Persist local acceptance, then optionally enqueue authorized write-back | Write-back is not part of local transaction outcome |
| Write-back fails | unchanged | Effect becomes `failed` or `outcome_unknown`; retry idempotently or require reconciliation | Never roll back Work Item acceptance |

## 18. Concurrency and Idempotency

- State transitions use versioned compare-and-set inside SQLite transactions.
- Command identity is unique on `(source, idempotencyKey)` and stores a payload hash.
- Provider facts deduplicate by `(invocationId, providerEventId)` or `(invocationId, epoch, sequence)`.
- A workspace has one mutating lease by default. Concurrent read-only Invocations are allowed; concurrent mutations require distinct isolated worktrees and fencing tokens.
- A Work Item has at most one non-terminal Run by default. Parallel Invocations are children of that Run, not competing Runs.
- Serial handoff has persisted depth and total-invocation budgets. Parallel branches cannot recursively fan out or bypass the persisted join barrier.
- Cancellation, completion, timeout, and crash races are resolved by allowed terminal transitions plus expected version. The first accepted terminal fact is immutable; later facts are recorded as late observations.
- Automatic retry is bounded by persisted attempt count, error class, backoff, and deadline. It creates a new Invocation. User retry of terminal work creates a new Run.
- Inputs and delivery are at-least-once. Exactly-once external effects are not claimed; idempotency keys and outcome reconciliation provide the strongest honest guarantee.

## 19. Permissions and External Side Effects

The Personal Developer is the sole human principal, but Web, Feishu, tracker events, callbacks, and agents are distinct delegated principals with explicit provenance.

Permission classes are at least: observe workspace, edit files, execute commands, mutate local git, publish externally, and manage Chymia state. Workspace trust only makes a root eligible; it does not grant every class.

Before execution, each Run pins a permission profile. Before an effect outside that profile, Workspace Safety creates a Human Decision Point. The CLI Adapter must enforce the effective grant through provider flags, sandboxing, or a mediated tool channel. If a provider cannot enforce the grant, that capability is unavailable rather than silently widened. [CODE-CONFIRMED] The current default `acceptEdits` and Gemini `--yolo` behavior do not meet this target.

Every effect records principal, Work Item/Run/Invocation, normalized intent, target, grant, idempotency key, start, observed outcome, and compensation if any. Commit, push, PR creation, tracker mutation, and remote messages are separate effect classes. Publishing externally always requires explicit policy authorization; a local code-edit grant does not imply it.

## 20. Failure and Degraded Modes

| Failure | Expressed state | User-visible behavior | Recovery rule |
|---|---|---|---|
| Provider unavailable before start | Invocation `skipped` or Run remains `queued/failed` | Named unavailable capability and alternatives | Rediscover or choose another provider; no fake substitution |
| CLI exits with known error | Invocation `failed`; Run retries or fails | Exit/error class and captured evidence | Bounded retry only for classified transient errors |
| Chymia/process crash | Non-terminal state pending reconciliation | “Recovering”, then honest resolved state | Reconcile handle/session/lease; unresolved → `interrupted` |
| Permission denied | Run `awaiting_permission`, `awaiting_human`, or terminal | Exact proposed effect and scope | New grant or explicit cancel; no hidden widening |
| External effect outcome unknown | Effect `outcome_unknown`; Run blocked | Warn against duplicate action | Reconcile remote/local state or user decides |
| Session cannot resume | Session `lost` | Continuity lost, prior transcript preserved | New Session/Invocation with explicit context reconstruction |
| Workspace lease lost | Invocation cancellation/interruption | Mutation safety warning | Fence stale worker; new Run/Invocation after verification |
| Projection/socket gap | Source state unchanged | Client catches up from sequence | Rebuild/catch up; never infer execution failure |
| Feishu unavailable | Outbox retained, connector degraded | Local Web remains usable; delivery lag visible | Idempotent delivery retry |
| Evaluation gate fails | Run `failed` or Work Item remains active | Failed contract clause and evidence | Revision/retry creates new Run |

Degradation is capability-specific. Loss of Feishu does not prevent local Web work; loss of one provider does not invoke a fake; inability to enforce permissions disables that provider/action combination.

## 21. Observability, Audit and Replay

- Every accepted/rejected command, state transition, grant/denial, effect, provider lifecycle fact, evaluation verdict, user decision, and delivery outcome has a durable correlated record.
- Required lifecycle/audit writes are atomic with state; “best effort” is reserved for optional diagnostic telemetry.
- Correlation keys include Work Item, Run, Invocation, Session, Thread, command, effect, principal, provider, workspace, epoch, and sequence.
- Human views distinguish authoritative state, derived projection, and raw diagnostic output.
- Replay rebuilds projections and explains decisions; it does not re-execute external effects.
- Redaction rules protect credentials and sensitive prompt/tool output while preserving event identity and outcome.
- Capacity signals include queue age, active leases, provider availability, reconciliation backlog, event gaps, retry counts, unknown effects, and delivery lag.

## 22. Evaluation and Acceptance Criteria

Each Work Item has a versioned Result Contract chosen before a Run. For coding work its clauses may require a patch or other artifact, repository gates, scoped diff, clean effect ledger, and a human-readable report. A diagnostic Work Item may instead require an evidence-backed conclusion. The contract describes results, not implementation steps.

Evaluation must use real repository state and real commands where the contract requires them. Fake provider output, route status, UI rendering, type existence, or CLI exit zero cannot by themselves satisfy it. Evidence records command identity, environment, time, output digest, artifact digest, and verdict.

Acceptance is separate. Explicit Personal Developer accept/revise is confirmed for the next vertical slice. [USER-DECISION] Whether a later narrowly defined policy may auto-accept fully mechanical work with no unknown external effect remains open. [OPEN-DECISION]

## 23. Borrow / Adapt / Own / Reject Analysis

| Judgment | Clowder mechanism or concept | Chymia target judgment |
|---|---|---|
| Borrow | Durable invocation identity/status, idempotency keys, per-target cancellation, zombie reconciliation | These are business-neutral reliability mechanics. [REFERENCE] Clowder invocation queue/tracker/reconcile modules |
| Borrow | Epoch plus sequence for ordered thread/runtime delivery | Use for reconnect/catch-up and late-event handling. [REFERENCE] `ThreadSequencer` and frontend runtime ledger |
| Borrow | Provider event normalization and Session continuity | Retain protocol-specific parsing behind Agent Runtime |
| Adapt | Redis-backed queue/leases | Preserve semantics but implement local durable ownership with SQLite; Redis is not required |
| Adapt | Serial collaboration, parallel fan-out, A2A handoff | Use bounded Worklist/Run semantics; reject recursive uncontrolled fan-out |
| Adapt | Invocation state machine | Use Chymia's Run/Invocation split and immutable terminal attempts; do not copy status names blindly |
| Adapt | Backlog/Mission execution and review mechanics | Replace tracker/mission semantics with Work Item, Result Contract, and acceptance |
| Adapt | MCP callback authorization and invocation tracking | Persist authority and idempotency; current in-memory registry is insufficient |
| Own | Single-user local Work Item/Run domain | This is Chymia's primary product boundary |
| Own | Optional External Issue Binding | Chymia owns execution even when a tracker owns an Issue |
| Own | Result Contract, local workspace grants, effect ledger, and recovery semantics | These determine safe usable coding work |
| Own | Unified Web/Feishu/tracker ingress through Work Orchestrator | Prevent protocol-specific competing control flows |
| Reject | Full Clowder clone, Redis mandate, hosted/multi-tenant assumptions | Adds infrastructure and reverses control away from a personal local tool |
| Reject | CVO/personality/social/game/voice/signal/community product semantics | Does not serve the stated coding job |
| Reject | Clowder Backlog/Mission status and lease words as Chymia domain states | Their lifecycle reflects Clowder's product, not Chymia's invariants |
| Reject | Broad connector/marketplace/scheduler surface without proven need | Low Leverage and expands permission/recovery surface |

## 24. Chymia / Clowder Divergence Analysis

| Difference | Classification | Evidence and target judgment |
|---|---|---|
| One Personal Developer, local workspaces, two default CLIs | Intentional simplification | [USER-DECISION] Codex and Antigravity are the target defaults; Own |
| Target defaults are Codex and Antigravity rather than Claude/Codex/Gemini | Domain adaptation | [USER-DECISION] Reflects the Personal Developer's actual subscriptions and preferred tools; current roster is legacy target divergence |
| SQLite local durability instead of mandatory Redis | Intentional simplification | [CODE-CONFIRMED] Current substrate; Adapt mature queue semantics |
| Work Item may start without external tracker | Domain adaptation | [INFERENCE] Required by existing Web/Feishu ingress; Own, pending §27 confirmation |
| Positioning calls Issue the first-class work object | Conflicting definition | [DOC-CLAIM] `CHYMIA-POSITIONING.md` conflicts with the Work Item/Issue ownership test; target gives Chymia execution ownership and the tracker Issue ownership |
| Thread is collaboration, Run is execution | Domain adaptation | [INFERENCE] Separates durable conversation from attempt lifecycle |
| No durable Run/Invocation owner or startup reconciliation | Accidental degradation | [CODE-CONFIRMED] Current registry/controllers are in memory; replace |
| Best-effort audit and incomplete terminal pairs | Accidental degradation | [CODE-CONFIRMED] 7 observed invoked IDs lacked terminal event; replace |
| Session/audit rows orphaned by Thread deletion | Accidental degradation | [CODE-CONFIRMED] Store-local cascades and observed data; replace ownership behavior |
| Task/evidence/UI types without live execution data | Incomplete implementation | [CODE-CONFIRMED] Tables/routes exist; observed rows are zero; use as reference, not completion evidence |
| Issue-runner and autonomous acceptance claims | Incomplete implementation | [DOC-CLAIM] Positioning exceeds production closure; target semantics defined here |
| Feishu plus still-wired WeChat/Weixin and Telegram residue | Legacy residue / conflicting scope | [CODE-CONFIRMED] main wiring; [DOC-CLAIM] Feishu-only decision; target recommends Feishu-only |
| Cat/choco names, Clowder-shaped types/comments, unused state machine | Legacy residue | [CODE-CONFIRMED] Not target domain evidence |
| Missing Clowder social/CVO/runtime breadth | Intentional simplification | [REFERENCE] Restoring it would add dependencies unrelated to personal coding; Reject |

Restoring Clowder wholesale would make Chymia inherit Clowder's product semantics, Redis/queue operational assumptions, connector breadth, and internal control model. It would turn a local personal platform into a downstream branch whose domain choices are controlled elsewhere. The correct reference Seam is mechanical: queueing, reconciliation, ordering, provider normalization, and cancellation—not the product lifecycle.

## 25. Current-to-Target Mapping

| Current Area | Current Responsibility | Evidence of Actual Use | Target Responsibility | Decision | Rationale |
|---|---|---|---|---|---|
| `scripts/launch.mjs`, `packages/api/src/main.ts#main` | Starts Web/API and wires connectors | Production entry | Composition Root only | Reference only | Real entry evidence, but current root embeds broad readiness/connector concerns |
| `CHYMIA-POSITIONING.md` issue-first terminology | Treats tracker Issue and Issue hierarchy as the future work boundary | Document claim only; not a closed production path | Work Item is Chymia's boundary; Issue is optional external binding | Reference only | Useful historical intent for issue-driven ingress, but its ownership terminology conflicts with the canonical target |
| `packages/api/src/app-factory.ts#buildApp` | Constructs stores, registry, router, routes, managers | Production composition | Composition Root constructs target Modules | Reference only | Keep assembly knowledge, not current ownership topology |
| `socket/handler.ts#handleThreadMessage` | Unified message-to-agent execution | Main production chain | Connector → Work Orchestrator command | Preserve behaviour | Unified ingress is correct; direct lifecycle execution is not |
| `routing/agent-router.ts#AgentRouter` | Agent selection, serial/parallel collaboration | Production chain | Work Orchestrator + Collaboration Worklist | Preserve behaviour | Modes are valuable; in-memory control flow cannot own durable Run state |
| Codex Adapter/parser | Spawn and normalize Codex | Real smoke test and production registration | Codex Agent Runtime Adapter | Preserve implementation | It remains a target default; permission/reconcile wrapper still required |
| Gemini Adapter/parser | Spawn and normalize Gemini CLI | Real smoke test and production registration | No target default responsibility | Reference only | It proves provider normalization mechanics but Antigravity is a distinct CLI/runtime and must not be represented as Gemini |
| Claude Adapter/parser and relay | Spawn Claude Code and provide Claude fallback | Real smoke test and production registration | No target default responsibility | Reference only | The Personal Developer has no Claude subscription; retain only as protocol evidence, not target scope |
| Antigravity Agent Runtime Adapter | Absent | No repository symbol, config, or production registration | Google Antigravity CLI Adapter | Missing | Target default named by the Personal Developer; requires its own executable/protocol/capability contract |
| `invoke-single-agent.ts#invokeSingleAgent` | Prompt/session/process/event coordination | Production chain | Orchestrator coordinates; Agent Runtime executes | Preserve behaviour | Correct observable flow, overly broad ownership and non-durable sequencing |
| SQLite Thread/Message/Tool stores | Conversation and tool persistence | Production reads/writes, live data | Collaboration facts and projections | Preserve behaviour | Data assets are valuable; deletion and cross-store ownership must not constrain target |
| SessionStore and session schema | Provider continuity | Production chain, live rows | Agent Runtime Session | Preserve behaviour | Correct concept and data; lifecycle/lease/recovery semantics are incomplete |
| `InvocationRegistry` | Callback authority and duplicate tracking | Registered production routes | Durable Invocation/command/effect authority | Replace | In-memory, no lifecycle state, lost on restart |
| In-memory cancellation controller maps | Thread/agent cancellation | Socket production path | Durable intent + Agent Executor cancellation | Replace | Cannot reconcile after restart or resolve terminal races |
| `routing/state-machine.ts#MultiMentionStateMachine` | Proposed routing state machine | No confirmed production composition | Bounded Worklist semantics | Reference only | Useful ideas but not authoritative production state |
| Socket thread sequencer | In-process ordering | Production socket path | Projection epoch/sequence/catch-up | Preserve behaviour | Ordering matters; promises alone do not provide durable replay |
| Audit store/events | Invoke/respond/error/session-seal visibility | Live rows and Audit UI | Atomic audit facts and activity projection | Replace | Best-effort and incomplete lifecycle cannot be canonical audit |
| Task/TaskProgress stores and UI | Planned execution tracking | Schema/routes/UI; live rows zero | Work Item/Run views | Reference only | Names and fake-backed paths do not establish ownership |
| Evidence/memory stores and UI | Persist/query evidence concepts | Routes and tests; live evidence zero | Evaluation Module | Reference only | Concept is useful, production acceptance closure is absent |
| Workspace read/git/sandbox/trust utilities | Local inspection and eligibility | Registered routes and tests | Workspace Safety Adapters | Preserve implementation | Reuse verified low-level behavior; trust alone is insufficient authorization |
| Feishu manager/Adapter | Remote ingress/delivery | Production wiring; live delivery not proven | Feishu Connector + outbox | Preserve behaviour | Desired remote channel; must use unified commands and durable delivery |
| WeChat/Weixin/Telegram | Additional connector surface | Some production wiring, conflicting docs | No target core responsibility | Replace | Recommended explicit rejection as legacy residue |
| Scheduler/community/marketplace/notification UI | Placeholder product areas | UI only | None in target core | Reference only | No closed user job or production state |
| Existing `choco.db` messages/tool/audit/session data | Validated local history | Observed non-empty data | Preserved facts/artifacts under target owners | Preserve behaviour | Preserve business evidence; do not preserve orphaning or competing ownership |
| Durable Work Item/Run owner | Absent | No production state owner | Work Orchestrator | Missing | Core target responsibility has no valid Implementation |
| Result Contract and acceptance | Absent/informal | No production closure | Work Orchestrator + Evaluation | Missing | Required to distinguish response from usable result |
| Workspace lease/grant/effect ledger | Absent/partial flags | No authoritative records | Workspace Safety | Missing | Required for concurrency, permission, audit, and recovery |
| Startup reconciliation and durable outbox | Absent | No production path | Orchestrator + Projection/Delivery | Missing | Required for restart and at-least-once integration |

These decisions classify current assets; they do not prescribe an order of change.

## 26. Rejected Alternatives

### Alternative A: Explicit CRUD-style Orchestrator

An Interface with `createWork`, `createRun`, `enqueueInvocation`, `setStatus`, `recordEvent`, `retry`, and similar methods appears clear but exposes transition order and lets callers assemble invalid lifecycle combinations. Its Depth and Leverage are low, state ownership leaks, tests must know Implementation sequencing, and changes scatter across callers. Rejected.

### Alternative B: Public workflow graph/event reactor

A generic workflow graph with public event append/subscribe APIs is extensible, but it makes provider/workflow mechanics part of the product Interface, creates an event-schema compatibility burden, weakens state ownership, and encourages UI/connectors to drive lifecycle. It is appropriate only if user-authored workflows become a proven core job. Rejected for the canonical core.

### Alternative C: Verb-rich domain facade

`dispatch`, `cancel`, `retry`, `inspect`, `pause`, `accept`, and related verbs optimize common calls and have good immediate readability. However every new transition expands the Interface and duplicates common provenance/idempotency/version rules. It is better than CRUD but shallower than a closed `WorkCommand` union. Rejected in favor of `submit/inspect`.

### Alternative D: One actor per Thread

A Thread actor localizes in-process ordering but conflates conversation with execution, complicates restart identity, and makes multi-workspace/parallel Run coordination cross actors. Rejected; Thread sequencing is a Collaboration/Projection concern while Run lifecycle belongs to Work Orchestrator.

### Alternative E: External Issue as mandatory top-level owner

This gives tracker visibility but excludes legitimate local/Feishu work, imports remote availability and status semantics, and creates two competing execution-state authorities. Rejected by the confirmed decision now recorded as [WORK-ISSUE-AUTHORITY-001](../../architecture/tracker-integration/design.md#10-accepted-work-item-and-issue-authority-decision) in favor of Chymia Work Item plus optional External Issue Binding.

### Alternative F: Restore Clowder wholesale

This maximizes copied completeness but minimizes Chymia's control over its domain and adds unrelated infrastructure/product surface. Mature mechanisms are borrowed at explicit Seams instead. Rejected.

## 27. Open Decisions

Only decisions that materially affect product behavior remain here:

1. **Remote ingress scope.** [OPEN-DECISION] Existing documents say Feishu only, while production still wires WeChat/Weixin. Recommendation and current target: Web + Feishu, with optional tracker Adapter; reject WeChat/Weixin/Telegram until a real personal workflow justifies them.
2. **Long-term default acceptance policy.** [OPEN-DECISION] The next vertical slice is confirmed as explicit human accept/revise with no default auto-accept. Whether a future fully mechanical Result Contract may auto-accept remains open.
3. **First concrete tracker.** [OPEN-DECISION] The next iteration supports exactly one tracker. Linear is the recommended first Adapter because the Symphony reference and existing positioning evidence already define its revision, eligibility and handoff semantics; selecting GitHub would require an explicit label/project-field workflow.

Work Item/Issue ownership, provider scope, and explicit human acceptance for the next vertical slice are confirmed and are not Open Decisions. [USER-DECISION]

The confirmed Work Item/Issue authority rule is recorded as [WORK-ISSUE-AUTHORITY-001](../../architecture/tracker-integration/design.md#10-accepted-work-item-and-issue-authority-decision) in the responsible Module design. Other decisions require an ADR only when they are confirmed and meet the irreversibility, surprise and trade-off tests.

## 28. Definition of “Usable”

Chymia is usable only when one Personal Developer can demonstrate all of the following without manual database repair or hidden internal intervention:

1. Open the real Web UI, select a canonically identified trusted local workspace, and create a Work Item with a Thread and Result Contract.
2. Start one real Run using an installed Codex or Google Antigravity CLI; its real process and provider identity are observable.
3. See durable Work Item, Run, Invocation, Session, Agent Events, tool/effect activity, artifacts, and evaluation evidence through a reconnectable view.
4. Have every mutating command execute under a valid Workspace Lease and Authorization Grant; an ungranted effect visibly waits or fails closed.
5. Receive an unambiguous successful result only after real artifacts and validation satisfy the pinned Result Contract; otherwise receive a typed failure/block and actionable evidence.
6. Cancel a running Invocation and obtain one durable terminal outcome without a later event silently reversing it.
7. Restart Chymia during real work and obtain honest reconciliation: continued, safely resumed, interrupted, failed, or outcome unknown—never a fabricated success or disappearance.
8. Retry failed/interrupted work as a new Run while preserving prior history and preventing duplicate commands/effects.
9. Use local Web even when Feishu or an optional tracker is unavailable; remote delivery backlog and degradation are visible.
10. Accept or request revision of the result, with acceptance preserved as the Work Item's terminal business fact.

Passing unit tests, receiving HTTP 200, rendering a route, importing a Module, spawning a fake agent, or opening the UI does not satisfy this definition.

---

### Canonical reading rule

This document is preserved only as a dated design snapshot. For current target behavior, follow the [documentation index](../../README.md), [architecture overview](../../architecture/overview.md), and owning Module design; the [domain context](../../domain/CONTEXT.md) is authoritative for concise terminology.
