# Chymia Domain Context

> Status: canonical ubiquitous language
> Last sharpened: 2026-07-27

Chymia lets one developer direct coding-agent CLIs to complete durable coding
objectives against local projects. This glossary contains Chymia domain
language only; general architecture and implementation mechanisms are defined
in the responsible Module design.

## People and agents

**Personal Developer**:
The one person who creates work, grants authority, observes agent activity, and
accepts or revises results.
_Avoid_: tenant, organization admin, team administrator

**Coding Agent CLI**:
An external command-line coding agent that Chymia can invoke, currently targeted
as Codex or Google Antigravity CLI.
_Avoid_: model, agent process, provider

**Agent Profile**:
A Chymia configuration that gives a Coding Agent CLI a stable identity, role,
capability expectations, and invocation settings.
_Avoid_: model, session, process

**Agent Team**:
The Agent Profiles available to participate in the same Thread.
_Avoid_: model ensemble, provider list

## Work and collaboration

**Local Project**:
The developer-selected local codebase or directory against which a Thread's
coding objective is performed.
_Avoid_: workspace, External Project, thread path

**Thread**:
The persistent top-level record for one coding objective. It contains the
objective, visible collaboration, participants and acceptance decision, and may
have multiple Runs.
_Avoid_: Issue, prompt, Run, Session

**Run**:
One bounded attempt to satisfy a Thread's coding objective. Retrying creates a
new Run under the same Thread.
_Avoid_: Thread, Session, Agent Invocation

**Agent Invocation**:
One requested activation of one Agent Profile within a Run; it is the smallest
unit Chymia can queue, cancel, observe, and audit.
_Avoid_: message, process, Run

**Session**:
Provider-supported conversational continuity for one Agent Profile in one
Thread. A Session may be reused by later Agent Invocations.
_Avoid_: Run, process, transcript

**Agent Turn**:
One visible contribution made by an Agent Profile in a Thread.
_Avoid_: Agent Invocation, Session

**Worklist**:
The bounded, ordered set of Agent Profile contributions requested for one Run.
_Avoid_: Issue backlog, implementation plan

**Serial Handoff**:
Ordered collaboration in which a later Worklist participant receives an earlier
participant's accepted contribution.
_Avoid_: retry, Parallel Fan-Out

**Parallel Fan-Out**:
Independent Agent Invocations that begin from the same accepted context and do
not hand work to one another inside that fan-out.
_Avoid_: Serial Handoff, duplicate delivery

## Results and acceptance

**Evidence**:
Durable, provenance-bearing information used to evaluate or review work.
_Avoid_: unverified agent claim, raw chat history

**Result Artifact**:
A concrete output attributed to a Run, such as a patch, commit, test result,
investigation report, or tracker comment.
_Avoid_: Thread, best-effort answer

**Result Contract**:
The required Result Artifacts and Evidence against which a Run is evaluated.
_Avoid_: prompt, agent exit code, informal done signal

**Evaluation Verdict**:
A structured determination of whether a Run's Result Artifacts and Evidence
satisfy its pinned Result Contract.
_Avoid_: Thread Acceptance, agent self-report

**Thread Acceptance**:
The Personal Developer's explicit decision that a successful Run satisfies the
Thread's coding objective.
_Avoid_: Run success, Issue completion, tracker write-back

## Tracker integration

**Issue**:
An engineering work record for which an external tracker is authoritative.
_Avoid_: Thread, prompt, local task

**Issue Observation**:
A revision-specific set of Issue facts observed by Chymia from the
authoritative external tracker.
_Avoid_: mirrored Issue, Thread state

**External Issue Binding**:
The optional association between one Thread and one Issue maintained by an
external tracker, including external identity and selected write-back rules.
_Avoid_: synchronized lifecycle, mirrored Thread

**Issue Eligibility**:
The current determination that an Issue Observation may propose a particular
Thread command; eligibility never executes that command itself.
_Avoid_: dispatch, Issue status mirror
