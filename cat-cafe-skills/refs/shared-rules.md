# Shared Rules

This project keeps the public operating rules in `AGENTS.md`, the canonical
machine-readable workflow in `sop/development.yaml`, and the current work state
in `STATUS.md`. A local `CLAUDE.md`, when present, is supplementary guidance and
must not be required by tracked repository instructions.

Shared rules for all agents:
- Read the local status before making assumptions about the current phase.
- Prefer existing repository patterns over new abstractions.
- Preserve unrelated user changes in the worktree.
- Verify code changes with the repository gates before handoff.
