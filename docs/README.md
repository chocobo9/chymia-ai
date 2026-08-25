# Chymia Documentation

> Status: canonical documentation index
> Last reorganized: 2026-07-27

This index defines where each kind of Chymia truth lives. A document's directory
describes its responsibility; its opening status describes whether it is
canonical, evidential, proposed, superseded, or historical.

## Canonical responsibility

Each kind of documentation truth has one canonical location:

1. Accepted user decisions are authoritative for the product choice they record.
2. [Domain language](domain/CONTEXT.md) is authoritative for the meaning of Chymia-specific
   terms.
3. A Module's `design.md` is authoritative for the state it maintains, its Interface, invariants and
   target behaviour.
4. [Architecture overview](architecture/overview.md) is authoritative for the Module map and
   dependency direction, but not Module-internal behaviour.
5. Current-system audits are authoritative only for evidence about what production code currently
   does.
6. Research, references and history provide evidence only.

If two documents claim the same kind of truth, that is a defect to resolve, not
a hierarchy to paper over. No audit, research paper, UI label, test fake, or
reference project may redefine domain language or which Module uniquely
maintains a target state.

## Canonical design

| Responsibility | Canonical document | Status | Canonicalized |
|---|---|---|---|
| Product scope and Module map | [Architecture overview](architecture/overview.md) | Target draft under review | 2026-07-27 |
| Durable knowledge formation, recall, correction and recovery | [Memory](architecture/memory/design.md) | Target draft under review | 2026-07-27 |
| Work Item, Run, Invocation, commands, claims, recovery and acceptance | [Work Orchestration](architecture/work-orchestration/design.md) | Target draft under review | 2026-07-26 |
| Thread, conversation facts, participants, Worklist and bounded context | [Collaboration](architecture/collaboration/design.md) | Target draft under review | 2026-07-26 |
| CLI process control, protocol normalization and Session continuity | [Coding Agent Runtime](architecture/coding-agent-runtime/design.md) | Target draft under review | 2026-07-26 |
| Local Project identity, confined access and execution-directory preparation | [Project Access](architecture/project-access/design.md) | Target draft; placement policy open | 2026-07-26 |
| Result Contract, Artifacts, Evidence and Evaluation Verdict | [Evaluation](architecture/evaluation/design.md) | Target draft under review | 2026-07-26 |
| Issue observation, eligibility, Binding and tracker protocol | [Tracker Integration](architecture/tracker-integration/design.md) | Target draft under review | 2026-07-26 |
| Ubiquitous language | [Domain context](domain/CONTEXT.md) | Canonical glossary | 2026-07-26 |

Each Module document defines the state that Module uniquely maintains, its
Interface, invariants, lifecycle, failure semantics, recovery rules,
current-to-target mapping, and verification surface.
Cross-Module documents do not duplicate those rules.

## Module design standard

A directory under `architecture/` qualifies as a target Module only when its
design answers all of the following:

1. **Meaning and provenance:** which terms are Chymia domain language, which are
   established engineering mechanisms, and which are target inferences.
2. **Deletion test:** if the Module vanished, what complexity would reappear in
   multiple callers? A grouping whose complexity simply disappears is not a
   Module.
3. **Depth and leverage:** what substantial behaviour is hidden behind a small
   Interface, and which callers receive that leverage.
4. **Authoritative state:** which Module is the unique source of truth for each
   durable fact and is allowed to change it. Inputs, outputs, caches, handles,
   and projections are not mislabeled as authoritative domain state.
5. **Interface:** everything callers must know—inputs, outputs, invariants,
   ordering, errors, idempotency, permissions, and capacity—not only a type
   signature.
6. **Seam and dependencies:** In-process, Local-substitutable, Remote under
   Chymia control, and True external dependencies are distinguished. Internal
   test seams stay inside the Implementation.
7. **Adapters:** an Adapter is named only at a real seam. One concrete
   implementation does not justify a hypothetical public seam.
8. **Exclusions:** neighbouring responsibilities and forbidden state mutations
   are explicit.
9. **Lifecycle and recovery:** state transitions, terminal meanings, retry,
   cancellation, restart behaviour, and unknown outcomes are stated.
10. **Verification:** tests use the same Interface as callers and do not expose
    Implementation details merely for test convenience.

Module names describe responsibility, not a bag of mechanisms. General terms
such as sandbox, lease, fencing, outbox, process, and retry are defined locally
where used; they do not enter the ubiquitous-language glossary unless Chymia
gives them a domain-specific meaning.

## Evidence and non-canonical material

- `audits/current-system/` records what production code actually does.
- `audits/handoffs/` preserves investigation context for later sessions.
- `research/external/` contains source-backed external research.
- `research/references/` records reference adoption assessments. The current
  [Tool, Skill and Memory assessment](research/references/tool-skill-memory-adoption-assessment.md)
  compares Clowder, Golutra, golutra-mcp and EverOS. The
  [Memory implementation alternatives](research/references/memory-implementation-alternatives.md)
  compare Letta MemFS, QMD, Basic Memory, LangMem, Mem0, Graphiti and other
  candidates against Chymia's local Coding Agent requirements. The
  [Waku Agent Memory reuse assessment](research/references/waku-agent-memory-reuse-assessment.md)
  evaluates whether its coherent existing Implementation can be reused
  directly. Both feed the canonical integrated
  [Memory Module design](architecture/memory/design.md).
- `history/` preserves superseded designs, old positioning, alignment programs,
  and naming work. Historical documents are never implementation authority.

## Candidate target Modules under review

- [Candidate Information Location](architecture/search/design.md) defines a
  proposed reusable local search capability for source-backed candidate
  retrieval. It is pending Personal Developer review and is not part of the
  canonical Module map until the Architecture overview and affected Module
  designs are reconciled.

## Governance kept at repository root

`AGENTS.md`, `GEMINI.md`, and `STATUS.md` remain at the repository root because
repository tooling and agent instructions address them directly.
`sop/development.yaml` is the canonical machine-readable development SOP.
An unpublished local `CLAUDE.md`, when present, contains operator-specific
supplementary guidance and is intentionally excluded from the public repository.

## Presentation and visual artifacts

These files are explanatory deliverables, not architecture authority:

- [Progressive architecture source](../outputs/chymia-progressive-architecture.excalidraw),
  [SVG](../outputs/chymia-progressive-architecture.svg), and
  [PNG](../outputs/chymia-progressive-architecture.png), generated by
  [the checked-in script](../outputs/generate-chymia-progressive-architecture.mjs).
- [Architecture presentation](../outputs/chymia-presentation.pptx).
- [Interview architecture presentation](../outputs/chymia-interview-architecture.pptx).

The canonical Module documents above take precedence when a visual artifact is
older or less precise.

## Documentation rules

1. Add a directory only for a confirmed documentation responsibility or a
   confirmed Module with unique state and an Interface.
2. Use established mechanism names such as sandbox, lease, fencing,
   authorization, outbox, and reconciliation, but define their exact local
   meaning in the Module responsible for them rather than promoting them to
   domain terms.
3. Put a rule in exactly one canonical document. Other documents link to its
   heading instead of copying it.
4. Keep dependency navigation in the overview; put behavior in the Module
   uniquely responsible for it and interaction semantics in the two Modules'
   Interfaces.
5. Record an independent decision document only when it is hard to reverse,
   surprising without context, and has a meaningful trade-off. Small local
   decisions belong in the responsible Module's decision record.
6. Do not use English possession shorthand for architecture responsibility.
   State instead which Module is the unique source of truth and may change the
   state; for leases or claims, name the exact Invocation or process that
   currently holds the execution right; for cross-system records, name the
   authoritative system.
7. Prefer stable heading links over line-number references.
