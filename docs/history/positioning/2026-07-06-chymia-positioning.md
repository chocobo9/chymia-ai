# Chymia Positioning Note

> Status: historical positioning; superseded by the canonical Module designs.

This note is for project positioning calibration only. It is not resume copy.

## Core Idea

Chymia is intended to be a local collaboration platform above existing coding agent CLIs.

The project does not try to replace model reasoning or rebuild a coding agent from scratch. Its premise is that Claude, Codex, Gemini, and similar tools are already strong as individual agents, but they remain isolated execution surfaces. Chymia's value is the platform layer that turns those isolated agents into a coordinated engineering workspace.

The useful framing is:

- Model: reasons, writes, reviews, and interprets.
- Agent CLI: acts in the development environment.
- Platform: owns collaboration order, identity, state, routing, context, tools, and human decision points.

## What Chymia Wants To Be

Chymia wants to make multi-agent software development feel like one personal developer operating an AI engineering team, not like manually switching between several chat or CLI windows.

The target workflow is not merely "send a prompt to multiple agents." It is:

1. A user request or external issue enters Chymia.
2. Chymia binds it to a thread as the stable collaboration context.
3. The platform decides whether the next step is discussion, design, implementation, review, clarification, or automation.
4. Agents participate according to role, availability, context, and issue state.
5. Human feedback enters at decision points instead of supervising every token.
6. Results, blockers, evidence, and state survive across turns.

## Clowder Anchor

Clowder is the closest conceptual anchor. Its README describes it as a platform layer that turns isolated AI agents into a team, with persistent identity, cross-model review, shared memory, A2A communication, skills, MCP integration, and collaborative discipline.

In Clowder, thread is positioned as an isolated chat/workspace: one per feature, bug, or topic. Mission Hub sits above that as feature governance, with lifecycle states and linked/dispatched threads. This means thread is a collaboration surface, not the highest-level work object.

Chymia borrows the same architectural premise:

- agent identity matters;
- multi-agent routing is a platform concern;
- shared context and memory must be explicit;
- tool access should be mediated by the platform;
- collaboration needs durable state, not only chat history.

Chymia should not be described as a full Clowder clone in product surface. The intended overlap is the core platform idea, not every feature family.

Source: https://github.com/zts212653/clowder-ai

## Symphony / Linear Anchor

Symphony is a different but relevant anchor. Its public framing is issue-tracker-driven orchestration: Linear-like issues become the control plane for long-running coding agents; active issues map to isolated workspaces or runs; the system can pick up eligible work, monitor progress, restart stalled agents, and move output toward review.

That is not the same as Clowder's thread-centered collaboration model.

For Chymia, the direction is explicit: borrow Symphony's issue-run model as the concrete reference for the next iteration.

- Keep Clowder-like threads as the collaboration space.
- Make issues first-class work objects once the issue layer is introduced.
- Treat Linear issues as stable work boundaries and human-facing records.
- Add Symphony-like autonomous runs only for issues that are clear enough to execute without continuous human supervision.
- Use Symphony as a concrete implementation reference when defining issue-run lifecycle, rather than inventing a vague "issue-driven" workflow from scratch.

The issue lifecycle should be based on Symphony's model: external tracker states drive candidate selection, while Chymia owns an internal orchestration state. Symphony separates tracker states from service claim states (`Unclaimed`, `Claimed`, `Running`, `RetryQueued`, `Released`) and run attempt phases (`PreparingWorkspace`, `BuildingPrompt`, `LaunchingAgentProcess`, `InitializingSession`, `StreamingTurn`, `Finishing`, terminal outcomes).

The work decomposition model should stay simple: project -> issue -> sub-issue. If an issue is too large for one agent run or one reviewable change, Chymia should help split it into sub-issues instead of inventing a separate work hierarchy. This matches existing tracker practice and keeps issue/sub-issue as the unit Chymia can bind to runs, review, evidence, and status.

Sources:

- https://openai.com/index/open-source-codex-orchestration-symphony/
- https://github.com/openai/symphony
- https://linear.app/docs/conceptual-model
- https://linear.app/docs/parent-and-sub-issues
- https://github.com/deusyu/harness-engineering

## Two Modes

Chymia should distinguish two modes instead of merging them into one vague "issue-driven" story.

### Interactive Collaboration Mode

This is the Clowder-like mode.

A thread is the primary space. Humans and agents discuss, design, decide, implement, review, and revise. Agent routing and A2A handoff support collaboration, but humans remain close to the loop.

This mode is appropriate when:

- the issue is ambiguous;
- acceptance criteria are missing;
- architecture trade-offs matter;
- permissions or risky changes require approval;
- agent disagreement is useful.

### Autonomous Issue Runner Mode

This is the Symphony-like future direction.

An external issue is clear enough to become a bounded run. Chymia can let an agent or agent team pick it up, execute in a controlled context, report progress, and return an artifact for human review.

This mode should not be treated as mature just because an agent can run from an issue. It becomes a real mode only when the harness is strong enough: hooks, mechanical gates, audit logs, state transitions, validation rules, and restart or failure handling must constrain the agent run.

This mode is appropriate when:

- the issue has clear scope and acceptance criteria;
- the repository context is known;
- the expected output is a code change, test, PR, patch, or investigation result;
- human intervention is needed mainly at review or blocker points.

## Multi-Agent Event Model

The Clowder lesson that matters most for Chymia is not "call multiple agents." It is that multi-agent collaboration has to be modeled as an evented orchestration system with strict boundaries.

### Collaboration Boundary

Chymia should preserve a hard distinction between serial collaboration and parallel fan-out.

Serial handoff means agents participate in an ordered chain. One agent can hand work to another agent, and the platform keeps that handoff inside the same parent collaboration chain. This is where agent-to-agent communication belongs, because the next agent is consuming the previous agent's output as part of one continuing flow.

Parallel fan-out means multiple agents receive the same starting context and produce independent outputs. Parallel execution should not recursively create more agent handoffs inside each branch. If an agent mentions another agent during a parallel run, that can be logged or surfaced, but it should not mutate the fan-out into an uncontrolled collaboration tree.

This boundary matters because otherwise "multi-agent" becomes accidental recursion: callbacks spawn agents, agents mention agents, each branch creates more work, and the platform loses control over liveness, cancellation, audit, and UI identity.

Clowder reference behavior:

- serial routing maintains a worklist for a collaboration chain;
- serial routing can parse explicit line-start agent mentions and append target agents to that same worklist;
- serial routing preserves previous responses so later agents can see earlier outputs;
- parallel routing merges independent streams, but suppresses or logs agent-to-agent mentions instead of routing them;
- serial done semantics depend on the whole worklist, while parallel done semantics belong to each independent branch.

### Unified Dispatch Boundary

Every source of agent work should enter Chymia through one orchestration path.

Valid sources include:

- a human message in a thread;
- an external issue becoming eligible for execution;
- Feishu or another connector;
- an agent handoff;
- an MCP callback;
- an internal retry or reconciliation event.

The important rule is that none of these sources should directly spawn agents through a side path. They should create orchestration requests that Chymia can queue, deduplicate, limit by depth, relate to a parent run, cancel, observe, and audit.

Clowder's callback A2A history is the cautionary example. The older callback path detected agent mentions and launched independent executions. That created double-fire behavior, uncontrollable child invocations, and recursion risk. The corrected direction is to push callback-discovered targets back into the parent worklist or a unified invocation queue, with fallback standalone execution treated as exceptional.

For Chymia, this means a future Linear issue runner must not directly call an agent CLI. Linear, Feishu, callbacks, human thread messages, and agent handoffs should all enter the same run/invocation state machine.

### Invocation Identity

Chymia needs separate identities for different levels of work.

- Issue or sub-issue: the stable external work item and human-facing record.
- Run: one execution attempt against an issue or thread context.
- Parent invocation: the collaboration chain used for liveness, cancellation, queueing, and audit.
- Agent turn: one visible contribution by one agent inside that chain.
- Session: the resumable lifecycle of a specific agent backend.

This separation is not cosmetic. If the platform uses one ID for everything, it cannot correctly handle same-parent multi-agent handoffs, callback results that arrive after streaming output, replaced invocations, cancellation of one agent versus all agents, or UI bubbles that need stable identity.

The useful Clowder pattern is to track liveness and cancellation at the parent invocation level while rendering individual agent turns with per-turn identity. In other words: the platform can know that one collaboration chain is still active, while the human sees distinct agent contributions inside the thread.

### Event Pipeline

Agent output should not be treated as raw chat text.

The target event pipeline is:

1. Agent provider or AgentService emits agent events: text, reasoning, tool activity, command output, system status, handoff, error, session initialization, completion.
2. Routing enriches those events with invocation identity, agent identity, metadata, audit facts, and completion guarantees.
3. Transport broadcasts events scoped to the thread, with ordering information that lets the client detect missed or restarted streams.
4. The client adapts raw agent events into conversation projection events.
5. A deterministic reducer builds the human-facing thread view.
6. A runtime ledger tracks active, finalized, replaced, stale, and background agent turns.

The frontend should not simply append whatever socket event arrives. It needs stable identity rules and deterministic consumption rules, otherwise the same parent invocation can create duplicated bubbles, late callback results can overwrite the wrong message, background events can appear in the wrong thread, and terminal cleanup can race with streaming chunks.

The Clowder-style stable identity rule is: a conversation item is keyed by thread, actor, canonical invocation identity, and bubble kind. Canonical invocation identity should prefer the per-agent-turn ID and fall back to the parent invocation ID when a turn ID is unavailable.

### Event State Surfaces

Events are complex because several state machines overlap. Chymia should keep them separate instead of collapsing them into one status field.

- External issue state: tracker-visible work status, such as backlog, in progress, review, blocked, or done.
- Run state: Chymia's execution attempt against an issue or thread context, including preparation, execution, finishing, failure, retry, release, and terminal outcomes.
- Invocation state: platform control over one requested agent activation, including queued, running, succeeded, failed, and canceled.
- Agent session state: backend-specific continuity for a particular coding agent CLI.
- Agent turn state: human-visible contribution lifecycle, including streaming, callback merge, replacement, finalization, error, timeout, and stale/background handling.
- Event transport state: thread-scoped ordering, restart epoch, missed-event detection, and catch-up.
- Conversation projection state: deterministic UI state derived from events, including active bubbles, finalized bubbles, rich blocks, tool output, and system status.

The rule is that higher-level state should be derived from lower-level facts only through explicit transitions. For example, an issue should not become done merely because a stream ended; a run should not be terminal merely because one agent turn finalized; and a UI bubble should not be the source of truth for whether an invocation is still active.

### Issue Runner Integration

The future issue-runner should be a producer and consumer of this event model, not a bypass around it.

An issue becoming eligible for execution should create an issue-bound run. That run should create orchestration requests. Those requests should produce invocations and agent turns. Agent turns should produce events. Events should update Chymia's internal state and optionally write selected facts back to Linear or another tracker.

This keeps the issue layer, thread layer, and agent layer aligned:

- issue/sub-issue remains the work boundary;
- thread remains the collaboration surface;
- run remains the execution attempt;
- invocation remains the platform-controlled agent activation;
- events remain the observable source of execution facts;
- conversation projection remains a view, not the execution source of truth.

### Local Clowder Reference Files

These files are the useful implementation references for the multi-agent/event model:

- `reference/clowder-ai-main/packages/api/src/domains/cats/services/agents/routing/route-serial.ts`: serial worklist, A2A handoff, previous-response continuity, final done handling.
- `reference/clowder-ai-main/packages/api/src/domains/cats/services/agents/routing/route-parallel.ts`: independent fan-out, stream merge, suppressed A2A routing in parallel.
- `reference/clowder-ai-main/packages/api/src/domains/cats/services/agents/routing/a2a-mentions.ts`: explicit mention parsing rules and target limits.
- `reference/clowder-ai-main/packages/api/src/routes/callback-a2a-trigger.ts`: callback A2A rewrite away from independent recursive execution.
- `reference/clowder-ai-main/packages/api/src/routes/callback-multi-mention-routes.ts`: multi-mention request lifecycle and callback result aggregation.
- `reference/clowder-ai-main/packages/api/src/domains/cats/services/agents/invocation/InvocationQueue.ts`: per-thread queued invocation requests from user, connector, and agent sources.
- `reference/clowder-ai-main/packages/api/src/domains/cats/services/agents/invocation/InvocationTracker.ts`: per-thread-per-agent active slots and cancellation boundaries.
- `reference/clowder-ai-main/packages/api/src/domains/cats/services/stores/ports/invocation-state-machine.ts`: legal invocation lifecycle transitions.
- `reference/clowder-ai-main/packages/api/src/infrastructure/websocket/SocketManager.ts`: thread-scoped event broadcast and sequence injection.
- `reference/clowder-ai-main/packages/api/src/infrastructure/websocket/ThreadSequencer.ts`: per-thread event ordering and restart epoch.
- `reference/clowder-ai-main/packages/shared/src/types/bubble-pipeline.ts`: conversation projection event and bubble kinds.
- `reference/clowder-ai-main/packages/web/src/hooks/bubble-event-adapter.ts`: raw agent event to projection event mapping.
- `reference/clowder-ai-main/packages/web/src/stores/bubble-reducer.ts`: deterministic bubble state updates.
- `reference/clowder-ai-main/packages/web/src/hooks/thread-runtime-ledger.ts`: runtime ledger for active/finalized/replaced agent turns.
- `reference/clowder-ai-main/packages/web/src/hooks/useAgentMessages.ts`: socket event consumption, catch-up, callback merge, and terminal cleanup.

## Harness Position

Harness is central to Chymia's positioning, but not as a standalone benchmark harness.

The project relies on downloaded or installed coding model CLIs for model capability. Chymia's own leverage is outside the model: multi-agent communication, data flow, context boundaries, state persistence, tool mediation, hooks, audit, and mechanical rules.

That means Chymia's upper bound is shaped by two things:

- internal capability: what the underlying model CLIs can actually do;
- external control: how well Chymia structures agent collaboration, data flow, visibility, and mechanical constraints.

For autonomous issue execution, harness quality is what separates a controlled workflow from a happy-path demo.

Harness must be strict enough to be enforceable by machines. The reference principles are:

- Repo as system of record: if the rule, plan, or decision is not in the repo or tracker, agents cannot reliably use it.
- Map, not manual: short entry files should route agents to deeper docs instead of becoming unverifiable mega-prompts.
- Mechanical enforcement: lint, typecheck, tests, structural checks, hook failures, and CI gates enforce invariants.
- Backpressure over prescription: gates define what outputs are acceptable; agents retain freedom inside those boundaries.
- Fixed result contract: before implementation, the required result artifact, acceptance evidence, and terminal state transitions must be explicit; the agent may choose the approach, but completion cannot be inferred from a plausible-looking narrative.
- Workspace isolation: autonomous runs execute inside issue-scoped workspaces and must not escape workspace root.
- Reconciliation: tracker state changes, terminal states, stale runs, stalls, and retries must be handled by the orchestrator, not left to agent discretion.
- Operator visibility: structured logs and inspectable records are required, not optional decoration.

## Visibility Position

Chymia should prefer full human visibility into agent activity.

Agent-to-agent communication, tool calls, progress, errors, and execution records should be inspectable by the developer. The system can summarize or filter views for usability, but the underlying posture is not to hide agent behavior by default.

## What Is Not The Core Story

Chymia should not primarily be positioned as:

- an AgentOps product;
- a benchmark harness;
- a generic multi-agent chatbot;
- a model research project;
- a pure Linear automation clone;
- a complete Clowder feature clone.

Those framings either narrow the project too much or shift attention away from the platform layer.

## Current Reality Boundary

The positioning should be aspirational but bounded. Some core Chymia mechanisms match the Clowder-inspired platform idea, especially routing, invocation, context assembly, sessions, audit, evidence, workspace surfaces, MCP callback bridging, and Feishu entry points.

However, many product surfaces and future workflow ideas remain incomplete or happy-path. In particular, Chymia should not claim full Symphony-style issue-runner behavior until issue binding, issue/sub-issue decomposition, run lifecycle, workspace isolation, status transitions, reconciliation, retry/stall handling, and human review artifacts exist end to end.

Chymia also should not claim full Clowder-grade multi-agent orchestration until the serial/parallel boundary, unified dispatch entry, invocation identity model, event ordering, callback re-entry, deterministic conversation projection, and cancellation boundaries exist end to end. A project can call several agents without having this model; Chymia's target is the stricter version.

## Working Position

Chymia is a Clowder-inspired local multi-agent software development platform for a personal developer. It sits above real coding agent CLIs and organizes them into a persistent, stateful, tool-aware collaboration workspace. Its current center is thread-based human-agent collaboration; its target next center is first-class issue-bound execution, where Linear-style issues and sub-issues become stable work boundaries and selected issues can become autonomous agent runs under a strict harness.

## Resolved Calibration Decisions

1. Primary user: personal developer.
2. Long-term first-class work object: issue.
3. Thread role: collaboration context bound to a user request or issue, not necessarily the final top-level product object.
4. Autonomous runs: only credible when constrained by hooks, mechanical gates, audit, state checks, and validation paths.
5. Harness: a core part of Chymia's value, because underlying model ability comes from external CLIs.
6. Visibility: all agent behavior should be visible to the human through logs or inspectable records.
7. Work decomposition: project -> issue -> sub-issue.
8. Issue-run lifecycle: explicitly borrow Symphony as the implementation reference for the next iteration.
9. Serial handoff is the only mode that should extend collaboration through agent-to-agent routing; parallel fan-out stays independent.
10. Human input, connector input, issue-runner input, agent handoff, callback, retry, and reconciliation should enter a unified orchestration path.
11. Agent events need stable identity and per-thread ordering before Chymia can safely support complex multi-agent UI and callbacks.
12. The issue runner should create runs and orchestration requests; it should not bypass Chymia's invocation and event system.

## Sharper Remaining Questions

1. Which parts of Symphony's issue/run/workspace lifecycle should Chymia copy directly, and which should adapt to multi-agent collaboration?
2. Which events must be written back to Linear, and which should remain only inside Chymia?
3. What is the minimum completion artifact for an autonomous coding issue: patch, commit, PR, test evidence, or issue comment?
4. Which current Chymia event paths must be upgraded first so issue runs, callbacks, and agent handoffs share the same orchestration model?
