# Legacy Docs

These files are retained as historical record only. They describe earlier framings of this project and earlier migration work. **They do not describe the current product or architecture.**

For current state, see:

- [`../../plans/analyst-workbench/README.md`](../../plans/analyst-workbench/README.md) — current product spec.
- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — current technical architecture.
- [`../../plans/MILESTONES.md`](../../plans/MILESTONES.md) — current execution plan.

## Contents

- `ARCHITECTURE_OLD.md` — the previous "vendor-agnostic desktop AI assistant for chat" architecture doc. Superseded when the product was reframed around the workspace-first analyst workbench thesis.
- `MIGRATED_FROM_LEGACY.md` — record of code already migrated from the `py-gpt` donor codebase. Useful for tracing provenance of `assistant_app/security/policy.py`, `assistant_app/providers/*`, `assistant_app/tools/*`, `assistant_app/filesystem/helpers.py`. The `py-gpt` source is now archived at `../../../_Archive/py-gpt/`.
- `MIGRATION_BACKLOG.md` — the triage table of `py-gpt` modules considered for further migration. **Frozen.** No further migrations are planned without an explicit decision; relevant items are already imported, the rest are out of scope for the new product direction.

## Why These Are Kept

- `MIGRATED_FROM_LEGACY.md` documents code provenance and the tests that cover migrated behavior. Useful when changing those modules.
- `ARCHITECTURE_OLD.md` and `MIGRATION_BACKLOG.md` are kept so anyone (human or agent) wondering "why was X built this way?" can see the prior framing rather than guessing.
