# Analyst Workbench Checklist

This checklist is meant to be worked through over time. It translates `PHASED_PLAN.md` into concrete, reviewable tasks.

Use it as a living planning artifact, not as a strict implementation order if reality changes.

## How To Use This File

- Check items off only when the outcome is real, not when the idea feels plausible.
- If new work does not fit one of these sections, ask whether it belongs in the plan at all.
- Prefer adding notes under the relevant section instead of scattering planning across the repo.

## Phase 0: Stabilize Intent

- [x] Write a one-sentence product thesis you would be willing to show another engineer.
- [x] Write a two-minute explanation of why this is not just Cursor and not just a chatbot with connectors.
- [x] Confirm the primary object in the product is a workspace casefile or analysis session.
- [x] Write 3 to 5 primary workflows.
- [x] Write 3 to 5 explicit non-goals.
- [x] Write the definition of success for repo review.
- [x] Write the definition of success for cross-source analysis.
- [x] Write the definition of success for assistant-style monitoring.

Notes:

- The thesis should describe the job the product helps with, not the list of integrations it might eventually support.
- Phase 0 deliverables now live in `plans/analyst-workbench/README.md` under the product description, thesis, primary object, workflows, non-goals, and definition-of-success sections.

## Phase 1: Preserve The Shell, Decouple The Identity

- [x] Inventory product identity surfaces in the repo.
- [x] Inventory Void-specific architectural seams in the repo.
- [x] Separate "shell we want to keep" from "product assumptions we want to replace."
- [x] Decide whether to temporarily keep `src/vs/workbench/contrib/void` in place during early experiments.
- [x] Decide whether renaming should happen only after the analyst core is proven.
- [x] List packaging and distribution surfaces that will need replacement later.

Concrete inventory targets:

- [x] `product.json`
- [x] `src/vs/code/electron-main/app.ts`
- [x] `src/vs/workbench/workbench.common.main.ts`
- [x] `src/vs/workbench/contrib/void/`
- [x] Linux packaging and desktop assets under `build/`, `resources/`, and `scripts/`
- [x] contributor and build docs that still define the repo as Void

Definition of done:

- [x] You can point to the exact files that define current identity, runtime channels, settings, and packaging.

Notes:

- Phase 1 deliverables now live in `plans/analyst-workbench/PHASE_1_IDENTITY_INVENTORY.md`.
- The current decision is to preserve the shell and temporary `src/vs/workbench/contrib/void/` seam, then defer broad renaming and packaging replacement until Phase 6.

## Phase 2: Reframe The Product Around Analysis

- [x] Replace code-assistant-first language in planning with workflow language.
- [x] Define the structure of a casefile or analysis session.
- [x] Decide what persists between sessions.
- [x] Decide what outputs are first-class artifacts.
- [x] Decide what belongs in the main editor area versus side panels.
- [x] Decide whether chat is a view, a tool, or the default interaction mode.

Casefile design checklist:

- [x] repo scope
- [x] selected files and diffs
- [x] linked docs or notes
- [x] findings
- [x] open questions
- [x] drafts
- [x] next actions
- [x] citations or evidence

Output design checklist:

- [x] repo summary
- [x] review notes
- [x] draft review comments
- [x] investigation memo
- [x] prompt draft
- [x] email draft
- [x] action list

Notes:

- Phase 2 deliverables now live in `plans/analyst-workbench/PHASE_2_CASEFILE_AND_WORKFLOWS.md`.
- The current decision is to organize the product around workflows, make the job-centered casefile the primary durable object, support both repeated-run and multi-agent comparison task layouts, keep chat as a view/tool inside that object, and reserve the main editor area for durable artifacts and deeper analysis work.

## Phase 3: Build The Analyst Core

- [x] Identify the minimum useful repo-analysis workflow.
- [x] Identify the minimum useful code review workflow.
- [x] Decide which existing Void features help those workflows and which distract from them.
- [x] Design a findings surface that is not just chat history.
- [x] Design a review notes surface that can survive beyond a single thread.
- [x] Define how summaries are saved and revisited.
- [x] Decide how diffs, branches, and selected files enter a casefile.
- [x] Keep code-edit generation available without letting it dominate the UX.

Minimum demo for this phase:

- [ ] open a repo
- [ ] ask broad analysis questions
- [ ] save findings
- [ ] produce a review summary
- [ ] revisit the saved context later

Notes:

- Phase 3 planning deliverables now live in `plans/analyst-workbench/PHASE_3_ANALYST_CORE.md`.
- That document defines the minimum repo-analysis and review workflows, identifies the strongest current reuse points and the most distracting current chat-first surfaces, and specifies the first durable analyst artifacts.
- The minimum demo items above remain implementation work. They are intentionally still unchecked until the product behavior exists in the app.

## Phase 4: Add Cross-Source Context

- [x] Decide the first non-code source to support.
- [x] Start with local or static sources before live connectors.
- [x] Define a normalized source item model.
- [x] Define how non-code sources are attached to a casefile.
- [x] Define how citations or evidence should appear across mixed sources.
- [x] Define at least one workflow that requires code plus another source.

Suggested first sources:

- [ ] local markdown docs
- [ ] local notes
- [ ] saved prompt libraries
- [ ] exported issue or task data

Defer until later:

- [ ] broad email automation
- [ ] many live connectors at once
- [ ] connector-specific UX before shared source models exist

Notes:

- Phase 4 planning deliverables now live in `plans/analyst-workbench/PHASE_4_CROSS_SOURCE_CONTEXT.md`.
- That document selects local markdown docs as the first non-code source, defines the normalized `source item`, `summary`, `citation`, and `action candidate` objects, and uses implementation-versus-intent analysis as the first required cross-source workflow.
- The current repo's MCP integration is treated there as a future ingress layer for external capabilities, not as a finished source model.

## Phase 5: Add Monitoring And Triage

- [x] Choose the first monitored source.
- [x] Decide what counts as an actionable incoming item.
- [x] Design a triage view, not just a summary prompt.
- [x] Decide how monitored items become casefiles.
- [x] Decide how monitored items connect back to repos, docs, or drafts.
- [x] Decide what should be automated versus only suggested.

Minimum demo for this phase:

- [ ] ingest one external stream
- [ ] identify action-worthy items
- [ ] attach relevant work context
- [ ] generate a draft or follow-up list

Notes:

- Phase 5 planning deliverables now live in `plans/analyst-workbench/PHASE_5_MONITORING_AND_TRIAGE.md`.
- That document selects a single assigned issue or task queue as the first monitored source, defines the monitored-item and triage model, and treats monitoring as a path into casefiles, drafts, and analyst work rather than as a notification feed.
- The minimum demo items above remain implementation work. They are intentionally still unchecked until a real monitored stream and triage flow exist in the app.

## Phase 6: Rename And Re-Anchor The Product Boundary

- [ ] Choose the new product name and neutral architectural vocabulary.
- [ ] Replace product metadata when the direction is stable.
- [ ] Replace service and channel names when the new boundaries are clear.
- [ ] Replace feature-based model selection with workflow- or capability-based selection.
- [ ] Decide whether to rename or relocate the product contribution root.
- [ ] Update packaging, docs, and runtime naming together rather than piecemeal.

Do not start this phase until:

- [ ] the analyst core feels worth preserving
- [ ] the casefile model is clear
- [ ] the first cross-source workflow is real

## Guardrail Checks

Run these checks before starting any major implementation branch:

- [ ] Does this change deepen repo analysis, review, synthesis, or structured context?
- [ ] Does this make more sense in a workspace/casefile model than in a generic chat app?
- [ ] Does this help the target job more than it copies a familiar coding-agent pattern?
- [ ] Is this still easy to explain in terms of the product thesis?
- [ ] Can this be added without destabilizing the shell unnecessarily?

If most answers are "no", stop and reconsider before building.

## Nice-To-Have Later

- [ ] persona or mode handling for different types of analysis work
- [ ] reusable templates for review reports and investigation memos
- [ ] stronger memory across repos and ongoing workstreams
- [ ] shared source abstractions across docs, prompts, tickets, and email
- [ ] explicit work queue surfaces
