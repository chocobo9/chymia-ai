# Tracker Integration Design

> Status: **Canonical target-module draft — under design review**
> Created: 2026-07-26
> Domain terms: [Issue, Issue Observation, External Issue Binding, Issue Eligibility](../../domain/CONTEXT.md)
> Source hierarchy: domain context → this design → [system overview](../overview.md).

## 1. Responsibility and exclusions

Tracker Integration translates between Issues maintained by trackers and Work
Items maintained by Chymia without making the tracker an execution database. It observes Issue
facts, records optional Bindings, determines Issue Eligibility, and performs
only tracker writes already authorized and durably recorded by Work
Orchestration.

It does not maintain Threads, Runs, Agent Invocations, command receipts, local
acceptance, execution retry, Authorization Grants, External Effect/outbox
attempts, or CLI execution.

### Why this is a Module

Deleting Tracker Integration would spread tracker IDs, pagination, revisions,
labels/status mapping, rate limits, stale observations, remote idempotency, and
write uncertainty into Work Orchestration and ingress. Its Interface gives
callers normalized observations and delivery outcomes while hiding protocol
variation. That is its Depth and Leverage.

## 2. Authoritative state

| State | Meaning | Persistence | Recovery |
|---|---|---|---|
| External Issue Binding | Optional association between one Thread and one tracker Issue, including identity and write-back rules | SQLite | survives tracker outage/deletion; never deletes the Thread |
| Issue Observation | Immutable normalized Issue facts at one source revision | SQLite history | refresh creates a new Observation |
| Issue Eligibility decision | Deterministic no-action or proposed Work Command decision tied to Observation, local view, and rule version | SQLite | re-evaluate only against a new Observation or rule version |
| Binding health | `healthy`, `degraded`, `orphaned`, or `conflicted` interpretation | SQLite | changes only from a fresh observation or explicit resolution |
| Delivery interpretation | Meaning of a tracker Adapter receipt for the Binding/revision | SQLite | unknown remains unknown until reconciled or decided |

The tracker remains authoritative for Issue status, hierarchy, and fields. Eligibility rules
are versioned configuration used to produce a durable decision; they are not a
second Issue lifecycle.

## 3. Interface

```ts
interface TrackerIntegration {
  observe(request: ObserveIssues): Promise<IssueObservationPage>;
  propose(request: ProposeIssueAction): Promise<IssueEligibilityDecision>;
  deliver(request: AuthorizedTrackerWrite): Promise<TrackerDeliveryObservation>;
  reconcileDelivery(request: ReconcileTrackerWrite): Promise<TrackerDeliveryObservation>;
}
```

| Operation | Caller must supply | Result | Errors and idempotency |
|---|---|---|---|
| `observe` | tracker identity and optional durable cursor | normalized page plus next cursor | offline, unauthorized, rate-limited, malformed, incomplete; repeated source revision reuses Observation identity |
| `propose` | Binding/Issue identity, read-only Thread view, eligibility-rule version and proposal idempotency key | persisted fresh Observation plus no action or one proposed idempotent execution command | internally refreshes before deciding; not-found differs from transient unavailable; same source revision/local version/rule returns the same proposal |
| `deliver` | existing authorized External Effect/outbox identity, payload hash, remote idempotency key, expected Issue revision | succeeded, failed, conflicted, or unknown delivery observation | cannot accept free-form tracker writes; duplicate compatible request returns/reconciles the same remote operation |
| `reconcileDelivery` | original effect identity and remote correlation facts | terminal or unknown observation | never repeats a write merely because its outcome is unknown |

`propose` hides the required refresh → persist Observation → evaluate ordering;
callers cannot accidentally decide against stale in-memory facts. `deliver`
still requires Work Orchestration to durably authorize the effect first.

## 4. Seam, dependencies, and Adapters

The tracker protocol is True external. Tracker Integration maintains an internal
port implemented by a protocol Adapter:

```ts
interface TrackerPort {
  observe(cursor?: string): Promise<ExternalIssuePage>;
  read(issue: ExternalIssueId): Promise<ExternalIssue>;
  write(request: ExternalTrackerWrite): Promise<ExternalWriteReceipt>;
  reconcileWrite?(request: ExternalTrackerWrite): Promise<ExternalWriteReceipt>;
}
```

Work Orchestration does not call this port. It calls Tracker Integration's
Interface. The port remains inside the Implementation so tracker pagination and
protocol types do not leak into the application.

The first production Adapter remains an open product choice. Linear and GitHub
would be different Adapters only after each protocol and workflow is justified.
A scripted protocol-faithful Adapter is used for rate-limit, deletion, stale
revision, duplicate delivery, and unknown-outcome tests.

Eligibility evaluation is In-process and has one target Implementation. It is
an internal function, not a public seam or an `EligibilityPolicy` Module.

## 5. Invariants and lifecycle

1. Chymia maintains Threads and execution; trackers are authoritative for
   Issues and their status.
2. A Binding associates identities and selected write rules; it never mirrors
   Run or acceptance state.
3. Every tracker-derived command identifies the Observation revision and
   eligibility-rule version that produced it.
4. Observation and eligibility never spawn a CLI or create a Run directly.
5. `propose` records a fresh Observation before autonomous tracker-driven dispatch.
6. Tracker `done` never proves Run success or Thread Acceptance.
7. Local acceptance commits before optional tracker write-back.
8. Tracker outage/deletion never removes local history.
9. Unknown delivery outcomes are not retried blindly.

Binding health:

```text
unbound -> healthy
healthy <-> degraded
healthy -> conflicted -> healthy | orphaned
healthy | degraded -> orphaned
```

- `degraded`: tracker is temporarily unreadable; Issue existence is not
  disproved.
- `orphaned`: deletion/not-found is confirmed.
- `conflicted`: observed revision or binding rules require explicit resolution.

An Issue becoming ineligible may propose pause/cancel/reconcile according to
the configured rules, but the proposed Work Command still passes through Work
Orchestration. Reopening an Issue may propose a new Run; it cannot reopen a
terminal Run.

## 6. Failure and recovery

| Condition | Module result | Recovery |
|---|---|---|
| duplicate webhook/page | existing Observation/decision | return existing identity |
| interrupted pagination | incomplete page with cursor | resume; never infer absent Issues |
| rate limit/offline/auth transient | degraded Binding | back off; local work remains usable |
| confirmed deletion | orphaned Binding | require rebind or explicit decision |
| revision conflict | conflicted Binding | retain pinned local inputs |
| invalid eligibility rules | typed no-dispatch result | fix configuration; local recovery remains available |
| write failure | failed delivery observation | Work Orchestration applies its effect retry rule |
| write outcome unknown | unknown delivery observation | reconcile through Adapter or surface decision |

## 7. Inter-Module Interfaces

| Module | Interaction |
|---|---|
| Work Orchestration | supplies Binding/Issue identity, read-only local view and authorized effect; receives proposed Work Command and tracker observations |
| Collaboration | may display normalized Issue reference; has no tracker lifecycle authority |
| Coding Agent Runtime | no Interface |
| Project Access | no Interface |
| Evaluation | no completion authority flows from tracker state |

## 8. Current-to-target mapping

| Current area | Evidence | Decision |
|---|---|---|
| closed issue-driven production path | absent [CODE-CONFIRMED] | Missing |
| historical Issue-first positioning | document claim only | Reference only |
| `platform_mappings` | schema exists; not a complete Binding lifecycle | Preserve behaviour/data only |
| Feishu connector | real message ingress, not an Issue tracker | Preserve behaviour; do not treat as Tracker Adapter |
| Clowder Community Issue/Backlog | reference mechanisms with different state-authority semantics | Reference only / Adapt selected observation ideas |
| Symphony research | mature refresh/reconciliation mechanisms | Adapt, not tracker-as-execution truth |

## 9. Verification

Tests through Tracker Integration's Interface prove duplicate observation
idempotency, pagination recovery, refresh-before-proposal, deletion,
reopening, revision conflict, outage degradation, remotely idempotent delivery,
and unknown-outcome reconciliation. A real Adapter must prove authentication,
one observation/refresh, and one authorized write before tracker integration is
called usable.

## 10. Accepted Thread and Issue authority decision

**Decision ID:** WORK-ISSUE-AUTHORITY-001
**Status:** accepted
**Date:** 2026-07-13

Chymia maintains Threads and their execution/acceptance
lifecycle. An external tracker is always authoritative for Issues and their
hierarchy/status. External Issue
Binding maps identity and selected write-back rules only.

Rejected alternative: making Issue the Chymia execution aggregate. That would
exclude unbound Web/Feishu work, import remote availability and status semantics
into local recovery, and create competing completion authorities.

## 11. Open decisions

1. First tracker Adapter: Linear is currently recommended; GitHub requires an
   explicit labels/project-fields workflow.
2. Exact eligibility rules and write-back fields remain product decisions for
   the chosen tracker.
3. Whether one Thread may rebind to a replacement Issue after confirmed
   deletion requires explicit user semantics.
