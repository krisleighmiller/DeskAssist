# Phase 2 Casefile And Workflow Design

This document completes Phase 2 of the analyst workbench plan.

Phase 1 clarified what parts of the current repo are shell, product identity, and architectural seams. Phase 2 defines what the future product should actually organize around before any major rewrite begins.

The main shift is:

- from feature-first to workflow-first
- from chat-thread persistence to job-centered persistence
- from copy/paste context gathering to attached workspace context
- from responses as the main output to durable artifacts as the main output

## Phase 2 Outcome

Phase 2 is complete when the product can be described without leaning on `Chat`, `Ctrl+K`, `Apply`, or other current Void feature buckets.

The current answer is:

- the product is organized around real work workflows
- the primary durable object is a job-centered casefile
- a `TASK_<X>` directory is the clearest current example of that object
- chat remains useful, but it is not the system of record
- outputs become first-class artifacts that live inside the job casefile instead of being lost in thread history

## Real Workflow Baseline

The design now explicitly reflects the current workflow being supported.

Current workflow:

1. open a task directory such as `TASK_<X>` in Cursor
2. run verification or tests in a terminal outside Cursor
3. discuss the task with Cursor
4. open task-family-specific docs in another editor
5. copy and paste relevant context into chat

Minimum product requirement:

- the analyst workbench must support that workflow at least as well as the current six-window setup

Preferred product improvement:

- reduce context fragmentation by making task docs, execution state, notes, and chat part of one workspace rather than several disconnected apps and windows

## Replace Feature Language With Workflow Language

The current repo still uses feature language such as:

- `Chat`
- `Ctrl+K`
- `Autocomplete`
- `Apply`
- `SCM`

That vocabulary is useful for understanding the current codebase, but it is the wrong top-level product model.

The analyst workbench should instead be described in these workflow buckets:

1. Job setup and orientation
   - open a `TASK_<X>` directory or equivalent job root
   - identify the task family structure
   - detect repo roots, task docs, verification assets, and prior notes

2. Repository analysis
   - inspect structure
   - answer broad or narrow repo questions
   - trace implementation paths
   - compare implementation to plans or intent

3. Run-based review
   - inspect run outputs
   - inspect diffs and test results
   - capture findings and risk
   - preserve unresolved questions

4. Comparison
   - compare repeated runs of the same agent
   - compare different agents on the same task
   - compare outputs, notes, failures, and deliverables across tracks

5. Drafting and synthesis
   - turn analysis into summaries
   - produce investigation notes
   - draft comments, prompts, status updates, and emails

6. Monitoring and triage
   - ingest incoming work later
   - identify what is actionable
   - connect it back to existing work context

7. Automation
   - support repeatable analyst tasks
   - invoke tools in service of the job casefile
   - remain subordinate to context and review rather than replacing them

Decision:

- workflow buckets replace feature buckets in product planning
- feature names can remain as temporary implementation details until later phases

## Primary Object: The Job Casefile

The primary durable object should no longer be described only as a generic casefile or analysis session.

The more accurate current model is:

- a job-centered casefile, usually rooted in a directory like `TASK_<X>`

Why this matters:

- your real workflow is already organized around jobs
- the job is what persists across runs, agents, docs, verification, notes, and comparisons
- the repo is important, but it is often only one part of the larger job

Working definition:

- a job casefile is the persistent container for the context, evidence, execution tracks, findings, drafts, and actions tied to one unit of work

A chat thread may still exist inside a job casefile, but the thread is only one timeline inside a larger object.

## Job Structure

Each job casefile should be able to hold the following.

### 1. Job Identity

Required concept:

- what task or job this work concerns

Minimum fields:

- casefile ID
- job ID or directory identity such as `TASK_<X>`
- title
- task family or workflow family
- created at / last modified at
- status such as active, paused, done, archived

### 2. Repo Scope

Required concept:

- what repository, workspace, branch set, or comparison target this job touches

Minimum fields:

- repo root or workspace identifier
- branch or revision context
- optional comparison target such as another branch, commit range, or diff source

### 3. Execution Tracks

The casefile must support multiple internal tracks because the same job can be worked in different evaluation styles.

The current minimum track types are:

- iteration tracks
  - same agent
  - same task
  - multiple runs such as `Run_1`, `Run_2`, `Run_3`

- comparison tracks
  - same task
  - different agents or prompts
  - side-by-side comparison lanes

Track fields should include:

- track ID
- track type
- agent identity
- prompt or variant identity if relevant
- status
- linked runs
- linked notes and artifacts

### 4. Runs

Each track may contain multiple runs.

A run should be able to hold:

- run ID such as `Run_1`
- workspace path
- test or verification command used
- timestamps
- logs
- result status
- notable failures or observations
- resulting diffs or changed files

This makes the repeated run structure in `AMETHYST` a first-class model element rather than an incidental folder layout.

### 5. Selected Files And Diffs

The job casefile must preserve explicit working context, not just free-form text about it.

It should hold:

- selected files
- selected folders
- selected code ranges
- branch or commit diffs
- review scopes such as "current PR" or "changed files only"
- run-specific diffs where relevant

This is the clearest path for evolving the current staging-selection and checkpoint machinery beyond chat turns.

### 6. Linked Docs Or Notes

The job casefile needs non-code context attachment even before live connectors exist.

It should allow:

- linked local markdown docs
- linked plans or design notes
- task-family instructions
- verification rules
- comparison notes
- prompts or reusable instructions
- later: linked issue exports, inbox items, and external source items

These should be attached objects, not text pasted into a thread and forgotten.

### 7. Findings

Findings should be first-class records rather than assistant messages.

Each finding should be able to include:

- title
- summary
- severity or importance
- supporting evidence
- related files, runs, or diffs
- status such as open, accepted, dismissed, follow-up

This is one of the biggest changes from the current chat-first model.

### 8. Open Questions

Open questions should be tracked explicitly.

Each question should be able to include:

- question text
- why it matters
- linked evidence
- related run or track
- owner or next step
- resolution status

This prevents unresolved issues from disappearing into chat scrollback.

### 9. Drafts

Drafts are work products in progress, not just generated text.

A draft may be:

- a review comment set
- an investigation memo
- an email draft
- a prompt draft
- a status update
- a run summary
- a comparison summary

Drafts should preserve revision history or at least timestamps and source context.

### 10. Next Actions

The job casefile should carry explicit next actions so analysis converts into movement.

Examples:

- investigate a file or subsystem
- rerun a failed track
- compare `Run_2` against `Run_3`
- inspect an agent-specific note set
- draft review comments
- compare code to a plan
- revisit after new evidence arrives

### 11. Citations Or Evidence

Evidence must be a first-class casefile property, not only inline markdown.

Evidence can point to:

- repo files
- code selections
- diffs
- local documents
- run logs
- test output
- agent notes
- later: external source items

The product should prefer grounded records over conversational summaries that cannot be traced back.

## What Persists Between Sessions

Decision:

- the job casefile persists
- ephemeral UI state does not, unless it materially affects ongoing work

Persist these:

- casefile metadata
- job identity
- repo scope
- execution tracks
- runs and their statuses
- selected files, folders, and diffs
- linked notes or docs
- findings
- open questions
- drafts
- next actions
- citations/evidence links
- a lightweight activity history
- optionally one or more associated chat threads

Do not prioritize persisting these as primary artifacts:

- transient composer state
- temporary panel open/closed state
- streaming state
- momentary tool progress
- view focus unless it is part of an explicit "resume work" affordance

Interpretation for current code:

- the existing `chatThreadService` should be treated as a persistence candidate to adapt, not as the future top-level state model
- thread history may become one tab or subrecord within a job casefile

## First-Class Output Types

Outputs should be durable artifacts that can be reviewed, reopened, revised, or exported later.

Phase 2 output set:

1. Repo summary
   - a durable overview of architecture, patterns, and notable areas

2. Review notes
   - a structured findings-oriented artifact for code review or repo review

3. Draft review comments
   - comments prepared for PRs, diffs, or discussion threads

4. Investigation memo
   - a deeper explanation of a bug, architecture question, implementation gap, or risk area

5. Prompt draft
   - a reusable prompt or instruction set generated from accumulated context

6. Email draft
   - a communication artifact derived from the casefile

7. Action list
   - a follow-up artifact that turns findings into explicit next steps

Additional strongly implied artifacts for this workflow:

- run summary
- comparison summary
- verification report

Decision:

- these outputs are part of the product model, not incidental exports from chat
- every major workflow should naturally end in one or more of these artifacts

## Main Editor Area Versus Side Panels

The product should not overload a single sidebar with every mode of work.

Decision:

- the main editor area should hold durable artifacts and deeper work surfaces
- side panels should hold navigation, active context, and lightweight interaction surfaces

### Main Editor Area

Put these in the main editor area:

- job overview pages
- repo summaries
- review notes
- investigation memos
- draft review comment sets
- longer drafting surfaces
- run comparison views
- side-by-side code-and-artifact review surfaces
- verification output and logs when they are part of active analysis

Reason:

- these are durable outputs or high-attention workspaces
- they deserve full-width reading, editing, and comparison space

### Side Panels

Put these in side panels or auxiliary views:

- job list / selector
- active job context summary
- track list
- run list
- findings list
- open questions list
- next actions list
- lightweight chat or ask surface
- evidence inspector / attachment list
- quick access to task-family docs

Reason:

- these are navigation and support surfaces
- they should help orient the user without becoming the entire product

### Resulting Information Architecture

The intended shape is:

- sidebar or auxiliary panel: navigate jobs, tracks, runs, docs, evidence, and quick questions
- main editor area: read, compare, draft, summarize, inspect logs, and decide

This is the strongest break from the current "chat is the product" shape while still keeping the IDE shell.

## What Role Chat Should Play

Decision:

- chat should be a view and a tool
- chat should not be the default interaction model for the whole product
- the job casefile should be the system of record

Practical meaning:

- chat remains useful for asking questions, collecting evidence, and iterating on drafts
- chat transcripts may still be stored
- but findings, drafts, open questions, actions, and run-level observations must be promotable out of chat into structured records

That means:

- chat is one interface into the job casefile
- chat is not the casefile itself

## Support For Both Current Directory Styles

The design must explicitly support both currently observed directory styles.

### `AMETHYST` Style

Primary pattern:

- one job
- one agent lane
- multiple repeated runs

Important surfaces:

- `runs/Run_X/`
- `verify/`
- `deliverable/`
- `snapshots/`
- task requirement docs
- per-run docs and logs

Product interpretation:

- the job casefile should present this as one job with one or more iteration tracks containing multiple runs

### `BOXING_CLAUDE` Style

Primary pattern:

- one job
- multiple agent lanes
- comparison artifacts and agent-specific notes

Important surfaces:

- per-agent notes
- comparison documents
- copied repo artifacts
- trace extraction or supporting tools

Product interpretation:

- the job casefile should present this as one job with multiple comparison tracks, each carrying its own notes, artifacts, and outcomes

### Shared Requirement

Both styles should be representable using the same model:

- job casefile
- tracks
- runs
- artifacts
- findings
- drafts
- evidence

The difference is not the top-level object. The difference is how the internal tracks are arranged.

## Mapping From Current Repo To This Design

These current surfaces look like the best bridges into the Phase 2 model:

- `src/vs/workbench/contrib/void/browser/chatThreadService.ts`
  - strongest current persistence/context candidate
  - should evolve from thread manager into a subordinate conversation layer within a larger job casefile model

- `src/vs/workbench/contrib/void/common/chatThreadServiceTypes.ts`
  - already stores selected files, ranges, checkpoints, tool state, and message history
  - useful as raw material, but too chat-centric to become the final durable model unchanged

- `src/vs/workbench/contrib/void/browser/sidebarPane.ts`
  - currently mounts the product as `Chat`
  - should later become a job navigation and context surface rather than the whole product

- `src/vs/workbench/contrib/void/common/voidSettingsTypes.ts`
  - still encodes feature-first thinking
  - should eventually be redesigned around workflow or capability groupings

- `src/vs/workbench/contrib/void/common/voidSettingsService.ts`
  - persists global settings and per-feature model selection
  - should not be rewritten yet, but future work should stop treating the current feature taxonomy as product truth

## Phase 2 Decisions Summary

1. The top-level planning vocabulary is now workflow-first and explicitly includes job setup, run-based review, and comparison work.
2. The primary durable object is a job-centered casefile, usually rooted in a task directory such as `TASK_<X>`.
3. The job casefile persists structured work context: job identity, repo scope, execution tracks, runs, linked docs, findings, open questions, drafts, next actions, and evidence.
4. The model must support both iteration mode and comparison mode without changing the top-level object.
5. Durable outputs are first-class artifacts: repo summary, review notes, draft review comments, investigation memo, prompt draft, email draft, action list, and workflow-native artifacts like run summaries and comparison summaries.
6. The main editor area is for durable artifacts and deep work; side panels are for navigation, context, docs, runs, and lightweight interaction.
7. Chat is a view/tool inside the product, not the product's default system of record.

## Phase 2 Definition Of Done Check

Phase 2 is complete because:

- the product can now be described without leaning on code-editing shortcuts
- a job/casefile model exists on paper before any major rewrite begins
- workflow buckets, persistence decisions, artifact types, support for both task directory styles, and UI placement decisions are now explicit

This is enough to enter Phase 3 and decide which existing repo features should become the minimum useful analyst workflow.
