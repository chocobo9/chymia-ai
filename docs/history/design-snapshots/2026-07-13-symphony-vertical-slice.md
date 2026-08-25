# Chymia Next Iteration Design: Symphony-style Issue-driven Vertical Slice

> Status: **Superseded historical snapshot; its rules were distributed to owning Module designs on 2026-07-26**
> Canonical index: [Chymia Documentation](../../README.md)
> Date: 2026-07-13
> Scope: one end-to-end issue-driven execution and acceptance loop; this is a design contract, not a production implementation or file-by-file plan.

## 1. Outcome

The next iteration proves one narrow proposition:

> A tracker-owned Issue can safely and idempotently cause Chymia to create or reuse a locally owned Work Item, execute one bounded multi-agent Run in an isolated workspace, verify a Result Contract, obtain explicit human acceptance, and optionally write back to the Issue without losing or fabricating state across process restart.

The slice borrows Symphony's reconciliation-first scheduling, pre-dispatch refresh, separated claim states, deterministic workspace, continuation, and external eligibility control. [REFERENCE] [Symphony research](../../research/external/2026-07-13-openai-symphony-issue-driven.md). It does not borrow Symphony's Issue ownership, in-memory orchestration truth, one-Issue/one-runner restriction, unbounded retry, agent-controlled completion, or prompt-only validation.

The governing product rule is accepted: Chymia is authoritative for Work Item and its execution/acceptance lifecycle; the tracker is authoritative for Issue. [USER-DECISION] The accepted decision now lives in the responsible Module design as [WORK-ISSUE-AUTHORITY-001](../../architecture/tracker-integration/design.md#10-accepted-work-item-and-issue-authority-decision).

## 2. Alignment Audit

### 2.1 Confirmed boundaries already aligned

| Confirmed boundary | Frozen target status | Iteration interpretation |
|---|---|---|
| Work Item is Chymia's first-class work object | Aligned | Every tracker observation becomes a Work Command before local state changes |
| Issue and external hierarchy remain tracker-owned | Aligned | One optional Binding; no mirrored Issue lifecycle table |
| Thread is collaboration, not execution | Aligned | One persistent Thread per Work Item across Runs |
| Retry creates a new Run | Aligned | `attempt_no` increases; terminal Run is immutable |
| Run success differs from Work Item satisfaction | Aligned | Evaluation verdict precedes Run success; human acceptance follows |
| All ingress uses Work Commands | Aligned | Tracker, Web, Feishu, handoff, callback, retry and reconciliation have no spawn bypass |
| Multi-agent collaboration occurs within Run | Aligned | Bounded serial Worklist in this slice; one active Run per Work Item |
| Workspace mutation requires lease and grant | Aligned | Dispatch Claim and Workspace Lease are separate persisted authorities |
| Write-back is an external effect | Aligned | Local acceptance commits before delivery; failure cannot roll it back |

### 2.2 Conflicts found and resolved in the frozen target

1. **Evidence-label conflict.** `[USER-DECISION]` previously meant both confirmed and pending. It now means confirmed; `[OPEN-DECISION]` means pending.
2. **Conversation Projection owner conflict.** The target previously assigned it to Projection and Delivery; the confirmed boundary assigns it to Collaboration. Collaboration is now the unique owner.
3. **Tracker Adapter/state-owner conflict.** An Adapter cannot own durable Binding state. Tracker Integration owns Binding, observations and observed revision; the single tracker Adapter owns protocol translation only.
4. **Tracker write-back owner conflict.** Tracker Integration observes; Outbox and Tracker Writer owns delivery attempts/receipts and invokes the Adapter. Neither can mutate local acceptance.
5. **Lease name conflict.** Dispatch Claim prevents duplicate orchestration; Workspace Lease controls workspace access. They are independently fenced and cannot substitute for each other.
6. **Completion-stage ambiguity.** `Run succeeded`, `Work Item awaiting_acceptance`, and `Work Item satisfied` are now explicit separate facts.
7. **Historical positioning conflict.** `CHYMIA-POSITIONING.md` remains evidence of the earlier Issue-first framing and is `Reference only`; it is not restored as glossary truth.

### 2.3 Remaining open product choices

- **First concrete tracker.** [OPEN-DECISION] Exactly one Adapter is in scope. Linear is recommended because Symphony and the historical positioning already supply concrete eligibility, revision and handoff semantics. GitHub requires a separately confirmed labels/project-fields workflow.
- **Repository-specific finite budgets.** [ASSUMPTION] The workflow configuration must explicitly set maximum Run attempts, total deadline, per-Invocation timeout/token budget and a finite backoff schedule. Missing or unbounded values make autonomous dispatch invalid; the design does not invent universal numeric defaults.

Neither choice changes state ownership or the Orchestrator Interface.

## 3. Scope

### 3.1 Included vertical slice

1. One tracker Adapter, External Issue Binding, normalized Issue Observation and observed revision.
2. Issue observation → Eligibility Policy → idempotent Work Command.
3. SQLite-owned Work Item, Run, Invocation, command receipt, Dispatch Claim, retry schedule and reconciliation facts.
4. Database enforcement of at most one non-terminal Run per Work Item.
5. Durable Dispatch Claim with owner, expiry, heartbeat and fencing token.
6. Deterministic isolated workspace and separate Workspace Lease/fencing token.
7. Issue refresh immediately before dispatch.
8. Honest Run and Invocation terminal states.
9. Classified, finite retry with maximum attempt, deadline and token budget.
10. Startup reconciliation before readiness or new dispatch.
11. A minimum Result Contract: scoped diff, configured repository gates and clean/known External Effect ledger.
12. Independent structured Evaluation Verdict.
13. Run success followed by Work Item `awaiting_acceptance`.
14. Explicit Personal Developer accept, revise or abandon.
15. Authorized, idempotent, audited tracker write-back through an outbox.
16. Kill-and-restart verification at every externally significant transaction boundary.
17. A minimal bounded multi-agent Worklist: one mutating Implementer Invocation followed by one read-only Reviewer Invocation; mechanical Evaluation remains independent of both.

The two agent roles may initially use separate profiles of the same available Coding Agent CLI. Provider diversity is not required to prove collaboration ownership; replacing one role with Antigravity later crosses the existing Agent Executor Seam.

### 3.2 Explicitly excluded

- Multiple trackers or tracker failover.
- Multiple Orchestrator instances or HA leader election.
- Full Sub-Issue DAG scheduling or dependency propagation.
- Parallel mutating Invocations, merge ownership or automatic merge.
- Automatic PR creation/merge.
- Default automatic Work Item acceptance.
- Full Mission Control/dashboard.
- Connector/community/marketplace work unrelated to this loop.
- A generic workflow language or user-authored execution graph.

## 4. Canonical Runtime Flow

```text
Startup
  → fence prior worker epoch
  → reconcile effects/outbox, claims, leases, invocations, runs and bindings
  → ready

Scheduler round
  → reconcile before dispatch
  → observe tracker Issues
  → persist Issue Observation + observed revision
  → Eligibility Policy decision
  → submit idempotent CreateOrReuseWork / StartRun / PauseRun / CancelRun / Reconcile WorkCommand
  → acquire durable Dispatch Claim
  → refresh Issue immediately before dispatch
  → pin revision, Result Contract, workflow, budgets and workspace identity to Run
  → acquire Workspace Lease + Authorization Grant
  → Implementer Invocation
  → Reviewer Invocation
  → structured Evaluation Verdict
  → Run succeeded
  → Work Item awaiting_acceptance
  → Personal Developer accepts, requests revision, or abandons
  → optional authorized tracker write-back intent
  → durable outbox delivery receipt
```

Web and Feishu begin at `submit WorkCommand`; they do not require Issue Observation or Eligibility Policy. Tracker observation never calls Agent Runtime directly.

## 5. Module and Interface Design

### 5.1 Module ownership

| Module | Owned state/responsibility in this slice | Interface leverage | Forbidden ownership |
|---|---|---|---|
| Tracker Integration | Binding, Issue Observation, observed revision, binding health | Normalizes one true external tracker and detects revision identity | Work Item/Run, eligibility rules, dispatch, acceptance |
| Eligibility Policy | Repository-owned policy/version and deterministic decision | Converts tracker facts plus local view into one proposed Work Command | Database mutation, CLI spawn, command receipt |
| Work Orchestrator | Work Item, Run, Invocation, command receipt, Dispatch Claim, retry schedule, lifecycle/reconciliation | One command/query Interface hides transactions, state machines, fencing, retries and races | Tracker protocol, workspace mutation policy, verdict calculation |
| Collaboration | Thread, messages, participants, bounded Worklist, Conversation Projection | Preserves one collaboration history across Runs | Run success, acceptance, process state |
| Workspace Safety | workspace identity, Workspace Lease, fencing token, grant, External Effect ledger | Makes filesystem/process/git effects explicit and recoverable | Dispatch Claim, Work lifecycle |
| Agent Runtime | CLI discovery/spawn/resume/termination, Session, normalized provider/process facts | Hides Codex/Antigravity protocol variation | Run success, acceptance, Issue write-back |
| Evaluation | Result Contract clauses, Artifact/Evidence verification, Evaluation Verdict | One structured verdict hides repository gate execution and evidence normalization | Work Item acceptance, Issue mutation |
| Acceptance Policy | accept/revise/abandon decision | Separates subjective/product acceptance from mechanical verification | Run verdict, tracker delivery |
| Outbox and Tracker Writer | write-back intent, delivery attempt, idempotency and receipt | Hides at-least-once delivery and uncertain remote outcome | Local acceptance or implicit mirror |

### 5.2 Work Orchestrator Interface

The frozen external Interface remains:

```ts
interface WorkOrchestrator {
  submit(command: WorkCommand): Promise<CommandReceipt>;
  inspect(query: WorkQuery): Promise<WorkView>;
}
```

The iteration's closed `WorkCommand` union includes:

- `CreateOrReuseWorkFromIssue`
- `StartRun`
- `PauseRun`
- `ResumeRunAtCheckpoint`
- `CancelRun`
- `RecordInvocationFact`
- `RequestEvaluation`
- `RecordEvaluationVerdict`
- `ScheduleRetry`
- `ReconcileWork`
- `AcceptWorkItem`
- `ReviseWorkItem`
- `AbandonWorkItem`
- `RequestTrackerWriteBack`

All commands carry `commandId`, `source`, `idempotencyKey`, `payloadHash`, `principal`, `provenance`, and relevant expected versions. The Interface does not expose `createRunRow`, `setStatus`, `spawn`, store order, or outbox operations.

### 5.3 Tracker observation and eligibility Interfaces

```ts
interface TrackerReader {
  observeCandidates(cursor?: ObservationCursor): Promise<ObservationPage>;
  refresh(issueId: ExternalIssueId): Promise<IssueObservation>;
}

interface EligibilityPolicy {
  decide(observation: IssueObservation, local: EligibilityView): EligibilityDecision;
}
```

`TrackerReader` is a true-external Seam with one production Adapter and a protocol-faithful test Adapter. Errors distinguish offline, unauthorized, rate-limited, not found and malformed response. `EligibilityPolicy` is an in-process Module, not a remote Adapter; it returns a decision containing command type, reason, policy version and deterministic idempotency seed.

### 5.4 Agent Runtime and Evaluation Interfaces

Agent Runtime returns only process/provider facts: started, event, completed, failed, canceled, timed out, not found or unknown. A normal exit may complete an Invocation but has no Interface path to declare Run success.

Evaluation accepts the pinned Result Contract, workspace/artifact references and effect ledger version, then returns `satisfied`, `unsatisfied`, or `indeterminate` with clause-level Evidence. Only `satisfied` permits the Orchestrator transition to Run `succeeded`; `indeterminate` is never coerced to success.

### 5.5 Dependency classification

| Dependency | Classification | Seam rule |
|---|---|---|
| Eligibility and state transition calculation | In-process | Direct deterministic Interface; no transport Adapter |
| SQLite, filesystem test workspace and clock | Local-substitutable | Use real SQLite/temp workspace/deterministic clock in Module-interface tests |
| Configured tracker | True external | Inject TrackerReader/Writer Adapters; protocol failure is explicit |
| Codex/Antigravity CLI | True external | Agent Executor Adapter with real smoke/e2e verification |
| Local filesystem, process and git | True external effects | Workspace Safety mediates and records grants/outcomes |

## 6. State Machines

### 6.1 Binding health

| State | Meaning | Allowed next states |
|---|---|---|
| `healthy` | Latest observation succeeded and revision is usable | degraded, orphaned, conflicted |
| `degraded` | Tracker is temporarily unavailable or stale beyond policy | healthy, orphaned, conflicted |
| `orphaned` | Tracker reports Issue deleted/not found with confirmed identity | healthy only through explicit rebind/decision |
| `conflicted` | Run-pinned revision and later observation require a decision | healthy, orphaned |

Binding health never changes Work Item satisfaction directly.

### 6.2 Dispatch Claim lifecycle

```text
unclaimed → claimed → running → released
                    ↘ retry_queued → claimed
```

- `claimed` means a durable scheduling right was obtained; it does not mean Run started.
- `running` means a non-terminal Run is attached to the claim.
- `retry_queued` contains finite `next_attempt_at`, attempt number and budget/deadline references.
- `released` is final for that claim generation. Redispatch creates a new generation/fencing token.
- Expiry never directly spawns replacement work; reconciliation first resolves the prior Run/Invocation/effect outcome.

### 6.3 Work Item lifecycle

```text
open → active → awaiting_acceptance → satisfied
  ↘       ↘              ↘
 blocked ←─────────────── revise (new Run)
  └──────────────────────→ abandoned
```

- `active` requires exactly one non-terminal Run.
- A terminal failed/timed-out/canceled/interrupted Run returns the Work Item to `open` or `blocked`; retry scheduling is Dispatch Claim state, not a fake non-terminal Run.
- `awaiting_acceptance` requires a `succeeded` Run and pinned satisfied Evaluation Verdict.
- `satisfied` requires an acceptance fact; Issue status cannot produce it.

### 6.4 Run lifecycle

States are `queued`, `preparing`, `running`, `pause_requested`, `paused`, `cancellation_requested`, `evaluating`, `succeeded`, `failed`, `timed_out`, `canceled`, and `interrupted`.

| From | To | Trigger / precondition |
|---|---|---|
| — | queued | `StartRun` accepted; unique active-Run constraint holds |
| queued | preparing | Dispatch Claim plus refreshed eligible Issue (for tracker-driven work) |
| preparing | running | Deterministic workspace, Workspace Lease, grant and first Invocation persisted |
| running | pause_requested | Explicit Work Command caused by eligibility/human/policy change |
| pause_requested | paused | Current Invocation reaches a durable safe checkpoint and no process/effect remains uncontrolled |
| paused | running | Same pinned revision/policies remain valid and checkpoint is resumable |
| running | cancellation_requested | Explicit cancel/termination policy |
| cancellation_requested | canceled | Process/effect outcome reconciled as canceled |
| running | evaluating | Worklist exhausted with all required Invocation outcomes/evidence present |
| evaluating | succeeded | Evaluation Verdict is `satisfied` |
| evaluating | failed | Verdict is `unsatisfied` or a known non-retryable evaluation error |
| any non-terminal | timed_out | Pinned Run deadline exhausted |
| any non-terminal | interrupted | Process crash/restart leaves clean outcome unprovable |

Terminal states never reopen. A paused Run resumes only when its pinned revision and checkpoint remain valid. Issue reopening, changed pinned inputs, failed terminal Runs and user revision requests create a new Run.

### 6.5 Invocation lifecycle

States are `queued`, `waiting_workspace`, `waiting_permission`, `starting`, `running`, `cancellation_requested`, `succeeded`, `failed`, `timed_out`, `canceled`, `interrupted`, and `skipped`.

One CLI exit zero permits Invocation `succeeded` only. The Orchestrator next dispatches the bounded Worklist step or requests Evaluation. A provider re-spawn is a new Invocation linked by `retry_of_invocation_id`; it never rewrites the prior terminal row.

### 6.6 Write-back lifecycle

```text
proposed → authorized → queued → delivering
  → succeeded | failed | outcome_unknown
```

`failed` is safe to retry only when the tracker response proves no effect or the remote idempotency key is supported. `outcome_unknown` blocks automatic duplication until remote reconciliation or human decision. No write-back state can reverse Work Item `satisfied`.

## 7. Reconciliation Policy

### 7.1 Startup order

The Orchestrator is not ready for ingress or dispatch until it has:

1. validated schema and finite workflow configuration;
2. allocated a new worker epoch/fencing generation;
3. reconciled executing/outcome-unknown External Effects and outbox deliveries;
4. fenced or renewed expired Dispatch Claims and Workspace Leases;
5. reconciled every non-terminal Invocation against its process/provider handle;
6. reconciled every non-terminal Run from Invocation and Evaluation facts;
7. reconciled succeeded Runs missing their deterministic `awaiting_acceptance` transition;
8. refreshed Binding health where the tracker is reachable;
9. exposed readiness and only then allowed a scheduler round.

Invalid tracker/workflow configuration prevents new tracker dispatch but does not skip reconciliation of already running local work.

### 7.2 Every scheduler round

Reconciliation precedes candidate observation and dispatch. After candidate selection, the exact Issue is refreshed again before Run dispatch. The refresh revision is pinned to the Run. A mismatch causes a version-conflict decision, not silent prompt replacement.

### 7.3 External Issue changes

| Observation | Eligibility decision | Work Command / effect | Required local outcome |
|---|---|---|---|
| Tracker offline | Unknown/degraded | No new tracker-driven Run/Invocation | Current Invocation may reach safe checkpoint; preserve all local state |
| Issue ineligible, reversible | Ineligible | `PauseRun` | Persist reason/checkpoint; no continuation dispatch |
| Issue ineligible, policy-terminal | Ineligible | `CancelRun` | Honest canceled/interrupted outcome; preserve artifacts/history |
| Issue deleted | Orphaned | `PauseRun` + Human Decision Point | Binding orphaned; no local deletion |
| Issue tracker state `done` | Terminal externally | Stop dispatch; pause/cancel as safety requires | Never auto-succeed/satisfy; record conflict if Result Contract incomplete |
| Issue reopened | Re-evaluate | `StartRun` only if eligible/authorized | New Run; old Run remains terminal |
| Revision changed before dispatch | Re-evaluate latest | Replace candidate command with new idempotency seed or no-op | No stale spawn |
| Revision changed during Run | Conflict | `ReconcileWork` | Keep pinned inputs; explicit continue/pause/cancel decision |
| Work Item accepted | Not an eligibility mutation | enqueue optional write-back intent | Local terminal fact commits independently |
| Write-back failure | No local lifecycle change | retry or Human Decision Point | Effect failed/unknown; acceptance preserved |

### 7.4 Safe checkpoint

A safe checkpoint exists only when the current Invocation has a durable terminal/checkpoint fact, no unrecorded process remains active, all begun External Effects have known or explicitly unknown outcomes, workspace state is durable, and the next Worklist position is persisted. “The agent stopped streaming” is not a checkpoint.

## 8. Retry and Error Classification

| Error class | Automatic retry | Required response |
|---|---|---|
| Tracker offline/rate limited | Observation retry only | Degrade Binding; do not create new Run |
| Stale revision / eligibility changed | No blind retry | Refresh, recompute policy, issue new command identity |
| Transient CLI/provider launch | Yes, within configured Invocation budget | New Invocation; preserve failed one |
| Workspace preparation transient | Yes, within Run deadline | Reconcile workspace/lease before retry |
| Permission denied or missing grant | No | Human Decision Point |
| Result Contract unsatisfied | No automatic same-Run retry | Run failed; revise/retry creates new Run |
| Process lost after restart | No blind spawn | Invocation/Run interrupted unless provider handle proves state |
| External Effect outcome unknown | No | Remote/manual reconciliation |
| Invalid workflow/configuration | No | Block new tracker dispatch; surface configuration error |

Repository-owned workflow configuration must supply finite `max_run_attempts`, `max_invocations_per_run`, `run_deadline`, per-Invocation idle/deadline/token budgets, and a finite list/capped function of retry delays. Exhaustion produces a durable terminal/blocked state and Human Decision Point, never another timer.

## 9. Deterministic Workspace and Multi-agent Rules

The workspace key is derived from stable local identities, conceptually `hash(source_workspace_id, work_item_id)`, never from mutable Issue title/identifier. The Work Item owns the reusable isolated workspace identity; each Run pins its baseline and obtains a fresh Workspace Lease/fencing token. Continuation and new Runs may reuse the durable workspace only after reconciliation proves it safe.

The slice's bounded Worklist is:

```text
Implementer Invocation (mutating, exclusive Workspace Lease)
  → Reviewer Invocation (read-only or separately granted; cannot accept work)
  → Evaluation Module (mechanical Result Contract verdict)
```

The Reviewer contribution is Evidence, not a completion authority. No two mutating Invocations run concurrently. Parallel fan-out remains a target capability but is not part of this slice; when added, sibling Invocations require a persisted join barrier, and mutating branches require separate worktrees/leases plus an explicit merge owner.

Independently deliverable work should become tracker Sub-Issues, each optionally bound to a separate Work Item. Chymia does not interpret the tracker hierarchy as an internal scheduler in this iteration.

## 10. Core Logical Data Model

This is an ownership and constraint model, not a prescribed file layout.

| Record | Minimum fields | Owner | Required constraints |
|---|---|---|---|
| `work_items` | id, objective, state, thread_id, current_contract_version, version, created/updated/accepted_at | Work Orchestrator | unique thread_id; terminal acceptance immutable |
| `external_issue_bindings` | id, work_item_id, tracker_kind, external_issue_id, external_key, observed_revision, snapshot_hash/data, health, write_back_policy, observed_at, version | Tracker Integration | unique `(tracker_kind, external_issue_id)`; at most one binding per tracker/Work Item |
| `work_commands` | id, source, idempotency_key, payload_hash, type, principal/provenance, status, result_ref, created_at | Work Orchestrator | unique `(source, idempotency_key)`; different hash is conflict |
| `dispatch_claims` | id/generation, work_item_id, owner_epoch, state, fencing_token, expires_at, heartbeat_at, retry_at, attempt_no | Work Orchestrator | one live generation per Work Item; monotonic fencing token |
| `runs` | id, work_item_id, attempt_no, state, pinned_issue_revision, contract_version, workflow_version, workspace_id, deadline_at, token_budget, error_class, version, timestamps | Work Orchestrator | unique `(work_item_id, attempt_no)`; partial unique one non-terminal Run per Work Item |
| `worklist_entries` | run_id, ordinal, role, agent_profile, access_mode, state, predecessor/join reference | Collaboration | unique `(run_id, ordinal)`; bounded count from pinned workflow |
| `invocations` | id, run_id, worklist_ordinal, retry_of_id, agent_id/profile, session_id, state, process_handle, fencing token refs, token usage, error_class, timestamps, version | Work Orchestrator | terminal immutable; unique dispatch identity |
| `agent_sessions` | id, thread_id, agent/profile, provider continuity ref, state, lease holder, timestamps | Agent Runtime | at most one usable leased session per `(thread, agent, profile)` |
| `workspaces` | id, source_workspace_id, work_item_id, deterministic_key/path, baseline_revision, state | Workspace Safety | unique `(source_workspace_id, work_item_id)`; canonical path under root |
| `workspace_leases` | id, workspace_id, run_id, owner_epoch, access_mode, fencing_token, expires/heartbeat | Workspace Safety | one live mutating lease per workspace; monotonic fencing token |
| `authorization_grants` | id, principal, workspace/effect scope, policy version, expiry | Workspace Safety | immutable scope; expired grant invalid |
| `result_contracts` | work_item_id, version, clause definitions, created_at | Work Orchestrator | immutable once pinned by Run |
| `artifacts` | id, run_id, kind, canonical ref/hash, producer invocation, created_at | Evaluation registry | immutable identity/hash |
| `evidence` | id, run_id, artifact/clause ref, kind, command/environment/output digest, verdict input | Evaluation | immutable provenance |
| `evaluation_verdicts` | id, run_id, contract_version, status, clause results, evidence refs, evaluator version, created_at | Evaluation | one current verdict per evaluation generation; immutable verdict history |
| `external_effects` | id, run/invocation, intent, target, grant, idempotency key, state/outcome, timestamps | Workspace Safety | unique effect identity; unknown outcome blocks duplicate |
| `tracker_outbox` | id, binding_id, accepted fact/version, operation, payload hash, idempotency key, state, attempts, remote receipt | Outbox/Tracker Writer | unique logical write-back; terminal receipt immutable |
| `orchestration_events` | id, aggregate, aggregate_version, type, payload, command_id, timestamp | Owning Module transaction | unique aggregate version/event ID; append only |

Snapshot rows, events, command receipts and outbox intents describing one decision commit atomically. Projection rows are rebuildable and never participate as an alternate owner.

## 11. Transaction and Fencing Rules

1. Command receipt, accepted state transition, durable event and resulting outbox intent commit in one SQLite transaction.
2. `StartRun` obtains/validates Dispatch Claim and inserts Run under the one-active partial unique constraint in one transaction.
3. Invocation row exists before process spawn. The process handle/start fact is a later durable observation; a crash between them reconciles to `interrupted`, never to an invisible spawn retry.
4. Workspace mutation presents both current Dispatch Claim and Workspace Lease fencing tokens. Either stale token rejects the mutation.
5. Evaluation Verdict persists before Orchestrator consumes it. A satisfied verdict causes distinct Run `succeeded` and Work Item `awaiting_acceptance` facts; they may share one local transaction but remain different state transitions and owners of meaning.
6. Acceptance fact and optional tracker outbox intent commit locally together. Remote delivery occurs later and cannot participate in or reverse acceptance.
7. A late process/event from a fenced worker is retained as a late observation but cannot mutate the newer aggregate version.

## 12. Repository-owned Workflow Configuration

The configured workflow pins:

- tracker eligibility mapping: states, labels, assignee and dependency rules;
- policy for ineligible/deleted/done/revision-changed observations;
- bounded Implementer/Reviewer Worklist and role permissions;
- Result Contract clauses and repository gate commands;
- finite attempt, deadline, idle timeout, token and backoff budgets;
- deterministic source workspace and isolation policy;
- acceptance policy, fixed to explicit human acceptance in this slice;
- optional tracker write-back operation, authorization class and idempotency strategy.

The configuration is versioned and pinned to each Run. Invalid or unbounded autonomous configuration fails closed for new dispatch while reconciliation remains operational.

## 13. Minimum Result Contract

The vertical slice's contract contains all three clauses:

1. **Scoped diff:** workspace diff exists when a code change is requested, remains within authorized path/scope, and is captured by hash/reference. A report-only Work Item must instead declare its required report artifact.
2. **Repository gates:** every configured gate runs against the pinned workspace/baseline and records command, environment, exit status and output digest. “Tests passed” text from an agent is not Evidence.
3. **Effect ledger:** every begun external effect has `succeeded`, accepted `failed`, or explicitly surfaced `outcome_unknown`; unknown/unauthorized effects make the verdict `indeterminate` or `unsatisfied`, never satisfied.

Reviewer Evidence may add a clause or support human acceptance, but cannot replace these mechanical clauses. Commit, push, PR and tracker closure are not required Result Artifacts unless explicitly configured and authorized.

## 14. Acceptance Contract

The slice exposes three Personal Developer commands:

- `AcceptWorkItem(expectedRunId, expectedVerdictId)` → Work Item `satisfied`; optional tracker outbox intent.
- `ReviseWorkItem(expectedRunId, revisionRequest)` → preserve succeeded Run and verdict; create a new Run only through a later `StartRun` command.
- `AbandonWorkItem(reason)` → Work Item `abandoned`; no implicit Issue closure.

Stale expected Run/verdict produces a version conflict. Acceptance never comes from Issue `done`, CLI exit, agent text, Reviewer approval alone, or tracker write-back success.

## 15. Verification and Acceptance Criteria

| Scenario | Required observable proof |
|---|---|
| Eligible Issue observed twice | One Binding, one Work Item, one command result and at most one active Run; duplicate returns original receipt |
| Candidate becomes stale before dispatch | Pre-dispatch refresh prevents CLI spawn and records policy/version reason |
| Web/Feishu work without Issue | Work Item/Thread/Run can complete with no Binding or tracker availability |
| Two scheduler rounds race | SQLite uniqueness and Dispatch Claim allow one active Run; loser receives conflict/duplicate, not another process |
| CLI exits zero | Invocation may succeed; Run remains running/evaluating until Worklist and Evaluation complete |
| Implementer then Reviewer | Both are correlated sibling steps in one Run; Reviewer has no mutation/completion authority |
| Result Contract fails | Structured clause/evidence failure; Run not succeeded and Work Item not awaiting acceptance |
| Result Contract passes | Persisted satisfied verdict, Run succeeded fact, then Work Item awaiting_acceptance; no Issue write yet |
| Human accepts | Work Item satisfied locally and optional authorized outbox row exists |
| Human requests revision | Prior Run remains succeeded/terminal; later execution uses a new Run/attempt number |
| Tracker write-back fails | Work Item remains satisfied; effect is failed or outcome_unknown and retry/reconcile is visible |
| Tracker offline | Binding degraded, no new tracker-driven dispatch, active work reaches safe checkpoint, no local deletion |
| Issue ineligible/deleted/done | Correct explicit pause/cancel/conflict command; no fabricated local completion |
| Issue reopened | Eligibility recomputed and any continuation is a new Run |
| Revision changes during Run | Pinned input remains unchanged; explicit version-conflict decision is visible |
| Retry budget exhausted | No further timer/Run; durable blocked/terminal state and Human Decision Point |
| Unauthorized mutation | No effect begins; denial and required permission are visible |
| Late fenced event | Recorded for audit but cannot change current Invocation/Run state |

“Observable proof” means assertions through Module Interfaces plus SQLite facts and real external receipts where applicable. Fake-only tests cannot prove the real tracker/CLI/effect path.

## 16. Kill-and-Restart Matrix

The acceptance suite terminates Chymia at each cut point and restarts the real composition root against the same SQLite/workspace:

| Kill point | Required restart result |
|---|---|
| After command receipt, before Work Item/Run transition | Transaction shows both or neither; duplicate command is safe |
| After Dispatch Claim, before Run insert | Claim reconciles/releases; no invisible active Run |
| After Run/Invocation insert, before CLI spawn | Invocation becomes interrupted/skipped by reconciliation; no duplicate blind spawn |
| After CLI spawn, before process-handle fact | Reconcile by durable handle where possible; otherwise interrupted, never success |
| During Implementer/Reviewer stream | Preserve events/artifacts; process resolves to running/terminal/interrupted honestly |
| After effect begins, before outcome receipt | Effect becomes reconciled result or outcome_unknown; never automatic duplicate |
| After Evaluation Verdict, before lifecycle consumption | Startup consumes verdict idempotently; one Run success/awaiting-acceptance transition |
| After Run succeeded, before Work Item projection/update | Reconciliation creates the missing deterministic awaiting-acceptance transition without rerunning CLI |
| After acceptance, before outbox delivery | Acceptance persists; outbox delivers once logically |
| After remote write succeeds, before receipt persists | Reconcile by remote idempotency/revision or mark outcome_unknown; never assume failure and duplicate |

Passing requires no lost authoritative state, no fabricated success, no duplicate Work Item/Run for one idempotency identity, and no repeated external side effect without reconciliation.

## 17. Current-to-Iteration Mapping

| Current asset | Iteration use | Decision |
|---|---|---|
| Real Codex Adapter/parser and CLI smoke | Agent Runtime production path | Preserve implementation behind Agent Executor; add durable ownership outside it |
| Claude/Gemini Implementations | Protocol/recovery reference only | Reference only; not target defaults |
| `InvocationRegistry` and cancellation maps | Callback auth/in-memory cancellation evidence | Replace with durable Invocation/command/effect authority |
| SQLite Thread/Message/Session/Tool stores | Existing conversation/session/evidence assets | Preserve behaviour/data; do not reuse their lifecycle ownership mistakes |
| Task/TaskProgress tables | Fake-backed planned task tracking | Reference only; do not rename them into Work Item/Run |
| Existing retry classifier | Error-classification evidence | Preserve behaviour where semantics match; target retry creates immutable new Invocation/Run records |
| Workspace trust/read/git utilities | Low-level path/workspace behavior | Preserve implementation where verified; add distinct lease/grant/effect ownership |
| Audit events | Existing visibility | Replace best-effort lifecycle audit with atomic orchestration facts |
| Historical positioning document | Historical Issue-first intent | Reference only; WORK-ISSUE-AUTHORITY-001 and the target glossary prevail |
| Work Item/Run/Binding/claim/outbox/evaluation ownership | No valid production owner | Missing; defined by this iteration design |

## 18. Rejected Alternatives

- **Issue as the local aggregate:** rejected by confirmed ownership and offline Web/Feishu behavior.
- **Bidirectional state mirror:** rejected because it creates competing completion owners and irreconcilable offline writes.
- **Tracker callback directly spawning CLI:** rejected because it bypasses command idempotency, claims, leases and recovery.
- **One in-memory claim set:** rejected because restart and duplicate-process safety require durable fencing.
- **One Issue assigned to several independent runners:** rejected; collaboration belongs to one Run's bounded Worklist.
- **CLI exit or agent “done” as completion:** rejected; only structured Evaluation may permit Run success.
- **Tracker `done` as Work Item acceptance:** rejected; tracker controls eligibility/handoff, not Chymia completion.
- **Infinite exponential backoff:** rejected; finite budgets and Human Decision Points prevent poison work.
- **Prompt-only tests/review/effect discipline:** rejected; they must be structured Evidence and ledger facts.
- **Full tracker UI/DAG/dashboard first:** rejected because it does not prove lifecycle, recovery or completion correctness.

## 19. Iteration Definition of Done

This iteration design is satisfied only when the complete real path demonstrates:

1. one real configured tracker observation and pre-dispatch refresh;
2. one real Coding Agent CLI Run in a deterministic isolated workspace;
3. multiple bounded Invocations in one Run without competing Issue claims;
4. SQLite-authoritative command, Binding, claim, Run, Invocation, lease, verdict, acceptance and outbox facts;
5. a mechanically evaluated minimum Result Contract;
6. distinct Run success and human Work Item acceptance;
7. an authorized write-back or an honestly degraded/failed/unknown receipt;
8. every reconciliation scenario in §7;
9. every kill-and-restart cut point in §16;
10. continuation without database repair, hidden state edits, duplicate external effects or fabricated completion.

Unit tests, fake agents, an HTTP 200, UI rendering, CLI exit zero, or a tracker status change alone do not satisfy the iteration.

---

### Design maxim

Symphony tells Chymia when autonomous work should run or stop. Chymia owns what a Run is, how agents collaborate inside it, whether its Result Contract is satisfied, and whether the Work Item is truly accepted.
