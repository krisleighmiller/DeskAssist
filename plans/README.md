# Plans

This directory holds the **canonical product spec and execution plan** for DeskAssist.

## Read In This Order

1. [`analyst-workbench/README.md`](analyst-workbench/README.md) — product thesis, primary object (the casefile), core workflows, non-goals, definition of success.
2. [`analyst-workbench/PHASED_PLAN.md`](analyst-workbench/PHASED_PLAN.md) — long-form Phase 0–6 plan.
3. [`MILESTONES.md`](MILESTONES.md) — concrete M1–M4 execution plan. This is what is actually being built next.
4. [`analyst-workbench/REPO_GUARDRAILS.md`](analyst-workbench/REPO_GUARDRAILS.md) — what counts as in-scope for a feature.

## Per-Phase Detail

- [`analyst-workbench/PHASE_1_IDENTITY_INVENTORY.md`](analyst-workbench/PHASE_1_IDENTITY_INVENTORY.md)
- [`analyst-workbench/PHASE_2_CASEFILE_AND_WORKFLOWS.md`](analyst-workbench/PHASE_2_CASEFILE_AND_WORKFLOWS.md)
- [`analyst-workbench/PHASE_3_ANALYST_CORE.md`](analyst-workbench/PHASE_3_ANALYST_CORE.md)
- [`analyst-workbench/PHASE_4_CROSS_SOURCE_CONTEXT.md`](analyst-workbench/PHASE_4_CROSS_SOURCE_CONTEXT.md)
- [`analyst-workbench/PHASE_5_MONITORING_AND_TRIAGE.md`](analyst-workbench/PHASE_5_MONITORING_AND_TRIAGE.md)
- [`analyst-workbench/CODEBASE_MAP.md`](analyst-workbench/CODEBASE_MAP.md) — written against the old Void fork; treat as historical context, not current map.
- [`analyst-workbench/CHECKLIST.md`](analyst-workbench/CHECKLIST.md) — actionable planning checklist.

## Note On Scope

`analyst-workbench/README.md` and `analyst-workbench/REPO_GUARDRAILS.md` were originally written when these plans lived inside the Void fork as a deliberately deletable side experiment. **That framing no longer applies.** These plans are now the canonical spec for the trunk repo. The "you should be able to delete this directory without breaking the repo" statement is historical — code is expected to align with these plans, not be insulated from them.
