# Repository Rules

Codex agents working in this repository must follow these sources:

- `AGENTS.md`: repository-wide operating rules.
- `sop/development.yaml`: canonical machine-readable development SOP.
- `STATUS.md`: current evidence and progress only; it is not a behavior contract.
- `docs/README.md`: documentation authority and navigation.

When a checkout contains the unpublished local `CLAUDE.md`, read it before
making changes as operator-specific supplementary guidance.

Operational rules:

- Keep changes tightly scoped to the user request.
- Preserve unrelated dirty worktree changes.
- Use tests for behavioral changes and run the repository gates before handoff.
- Treat target-design documents as proposals or contracts according to their
  stated status, never as proof that the implementation exists.
