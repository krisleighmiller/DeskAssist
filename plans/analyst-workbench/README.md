# Analyst Workbench Plan

> **Scope note (updated).** This document was originally written when these plans lived inside the Void fork as a deliberately deletable side experiment. They are now the **canonical product spec** for the DeskAssist trunk repo. The "you can delete this directory without breaking the repo" framing below is historical. New work is expected to align with this plan, not be insulated from it. See [`../README.md`](../README.md) and [`../MILESTONES.md`](../MILESTONES.md) for current scope.

This directory is intentionally standalone.

- Nothing in `plans/analyst-workbench/` is imported by the app.
- Nothing in this directory is required for builds, tests, packaging, or runtime behavior.
- You should be able to delete `plans/analyst-workbench/` without breaking the repo.

## Why This Exists

The current repo is a strong starting point for an IDE-shaped product, but its existing product model is still centered on AI-assisted code creation. The target direction is different:

- analyst-first, not generation-first
- workspace-first, not chat-first
- code-aware, but not code-only
- useful for review, synthesis, triage, and decision support across multiple work domains

The working product idea is:

> A workspace-first IDE and personal work assistant that understands repositories, connects them to the rest of your work, and helps you review, summarize, draft, triage, and decide.

## Phase 0 Product Description

This product should combine two things that are usually split apart:

- an IDE-quality environment for understanding and discussing code
- a personal assistant that can work across the rest of the job around the code

The target use case is not just coding faster. It is handling work that spans:

- repositories
- documents
- prompts
- mail and inbox items
- tasks and issues
- accumulated memory about ongoing work

The product should treat all of that as part of one workspace. Conversation remains important, but it is only one interface into the workspace rather than the workspace itself.

## Product Thesis

A workspace-first IDE and personal assistant that brings repositories, documents, prompts, inbox items, tasks, and ongoing work memory into one place so you can review, synthesize, draft, and move work forward.

## Why This Is Not Just Cursor

`Cursor`-style tools are strongest when the main job is editing and generating code inside the repo.

This product needs to be stronger when the real job is broader:

- understand the repo before changing it
- compare code to plans, docs, prompts, and other intent sources
- keep notes, findings, drafts, and open questions attached to the work
- turn incoming information into action instead of handling each source in isolation

The primary object is the workspace, not the edit command and not the chat thread. Code editing still matters, but it should support analysis and decision-making rather than define the product.

## Why This Is Not Just A Chatbot With Connectors

General assistant tools become more useful as they connect to more sources, but they often stay too conversational and too shallow for real ongoing work.

This product should be different in three ways:

1. It lives inside an IDE-shaped shell where repos, files, diffs, and review surfaces are first-class.
2. It keeps structured work context over time instead of forcing each task back into a fresh thread.
3. It produces durable artifacts such as findings, summaries, drafts, review notes, and next actions rather than only responses.

Connectors matter, but only as inputs into a grounded workspace model.

## Primary Object

The primary object in the product should be a workspace job casefile or analysis session.

In the current workflow, the clearest concrete example is a task directory such as `TASK_<X>`.

That job casefile should be able to hold:

- repositories and selected code context
- linked documents and prompts
- execution tracks, such as repeated runs or multi-agent comparison lanes
- run history, logs, and verification output
- findings, notes, and open questions
- drafts and summaries
- next actions
- accumulated memory about the ongoing workstream

Chat can remain one interface into that object, but it should not be the system of record.

## Core Outcomes

The product is in the right place when it can do all of the following well:

1. Discuss an entire repository in a way that feels deeper than a generic chatbot.
2. Support review-heavy workflows without forcing code generation to be the main interaction.
3. Pull in non-code context like docs, prompts, notes, inbox items, and tasks when it changes the answer.
4. Keep persistent work context so analysis accumulates instead of restarting from scratch.
5. Produce useful artifacts such as review notes, summaries, drafts, and follow-up actions.

## Primary Workflows

The product should be organized around workflows, not isolated features.

1. Job-centered repository understanding and review
   - open a task or job directory
   - inspect repo structure
   - answer broad and narrow questions
   - compare branches and diffs
   - inspect run outputs and verification state
   - capture findings and open questions

2. Comparison and cross-source analysis
   - compare repeated runs of the same agent
   - compare different agents on the same task
   - connect code to docs, prompts, notes, tickets, and email
   - compare implementation against intent
   - surface inconsistencies, risk, and missing follow-up

3. Operational triage
   - monitor inboxes, issues, or queues
   - identify what needs attention
   - turn incoming context into work items or drafts

4. Drafting and synthesis
   - write review comments
   - write internal summaries
   - draft emails and status updates
   - produce reusable prompt variants or playbooks

5. Ongoing work memory
   - preserve decisions, findings, and unresolved questions across sessions
   - reconnect new incoming work to prior context
   - reduce the need to restate the same project background repeatedly

## Non-Goals

This product should not try to be all of the following at once:

1. A generation-first coding tool whose success is measured mainly by how much code it can write unattended.
2. A generic chat app with a long list of connectors but no strong workspace model.
3. A full replacement for dedicated email, issue-tracking, or document systems.
4. An "everything dashboard" that pulls in feeds without helping turn them into concrete work.
5. A design where the chat thread becomes the only durable container for context.

## Definition Of Success

### Repo Review

Success means you can open a repository, ask both broad and detailed questions, inspect diffs or branches, capture findings, and leave with a review summary or investigation note that would be useful to another engineer.

### Cross-Source Analysis

Success means you can answer a question that spans code plus another work source, show why the answer is grounded, identify mismatches or risks across sources, and turn the result into a usable draft, summary, or action list.

### Assistant-Style Monitoring

Success means the product can watch at least one incoming work stream, identify what is actionable, connect that item to relevant workspace context, and help produce the next draft, checklist, or follow-up without losing continuity.

## Design Principle

Do not let chat become the product.

Chat can remain one interface, but the primary object should be the workspace or casefile described above. The product should feel like an environment for ongoing work, not a better prompt box.

## What To Keep From This Repo

Keep the parts that already support a workbench-shaped experience:

- the VS Code-derived shell and layout
- the dedicated product contribution pattern under `src/vs/workbench/contrib/void`
- any solid repo-aware analysis or tool-routing infrastructure
- the reviewable apply/edit mindset where changes are explicit and inspectable

## What To Replace Early

Replace the parts that would keep the product trapped in "coding agent" mode:

- feature framing based on `Chat`, `Ctrl+K`, `Autocomplete`, and `Apply`
- UX centered on a single chat surface
- settings and state models built only around coding-assistant features
- product naming and service contracts that still encode the Void product identity

## Recommended Near-Term Strategy

1. Use this repo as a stable shell for experimentation.
2. Keep planning and product decisions isolated in this directory until the vision hardens.
3. Prefer additive exploration over deep rewrites at first.
4. Once the product thesis feels stable, translate the plan into a new neutral product boundary inside the app code.

## Phase Status

- Phase 0 is complete in this directory's product description, thesis, workflows, non-goals, and success definitions.
- Phase 1 is complete in `PHASE_1_IDENTITY_INVENTORY.md`, which records the current identity surfaces, Void-specific seams, shell-vs-assumption split, and the decision to defer broad renaming until later.
- Phase 2 is complete in `PHASE_2_CASEFILE_AND_WORKFLOWS.md`, which defines the workflow-first product model, job-centered casefile structure, persistence rules, artifact types, support for both repeated-run and multi-agent comparison layouts, and the role of chat relative to the wider workspace.
- Phase 3 is complete at the planning layer in `PHASE_3_ANALYST_CORE.md`, which defines the minimum analyst workflows, identifies the strongest reusable repo-analysis surfaces, names the current chat-first constraints to outgrow, and specifies findings, review-note, summary, and scope-intake design for the analyst core.
- Phase 4 is complete at the planning layer in `PHASE_4_CROSS_SOURCE_CONTEXT.md`, which selects local markdown docs as the first non-code source, defines the shared source-item and citation model, clarifies how non-code sources attach to the casefile, and treats the current MCP integration as a future ingress layer rather than a finished source model.
- Phase 5 is complete at the planning layer in `PHASE_5_MONITORING_AND_TRIAGE.md`, which selects a single assigned issue or task queue as the first monitored source, defines the monitored-item and triage model, explains how monitored work becomes casefile work, and keeps automation recommendation-first so the product does not turn into notification soup.

## Directory Contents

- `README.md`: high-level product direction and goals
- `PHASED_PLAN.md`: concrete execution phases and milestones
- `CHECKLIST.md`: actionable planning checklist you can work against
- `PHASE_1_IDENTITY_INVENTORY.md`: completed Phase 1 inventory and boundary decisions
- `PHASE_2_CASEFILE_AND_WORKFLOWS.md`: completed Phase 2 workflow and casefile design
- `PHASE_3_ANALYST_CORE.md`: completed Phase 3 analyst-core design grounded in the current repo
- `PHASE_4_CROSS_SOURCE_CONTEXT.md`: completed Phase 4 cross-source-context design grounded in the current repo
- `PHASE_5_MONITORING_AND_TRIAGE.md`: completed Phase 5 monitoring-and-triage design grounded in the current repo
- `CODEBASE_MAP.md`: planning-oriented map of the current repo and likely reuse points
- `REPO_GUARDRAILS.md`: rules for keeping implementation work aligned and removable
