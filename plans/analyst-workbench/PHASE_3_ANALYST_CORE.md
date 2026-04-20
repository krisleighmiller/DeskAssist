# Phase 3 Analyst Core

This document completes the planning portion of Phase 3 of the analyst workbench plan.

Phase 1 clarified what is shell versus identity. Phase 2 defined the workflow-first product model and the job-centered casefile. Phase 3 answers the next question: what is the minimum analyst-first product you can build from this repo before adding cross-source context or a major rename.

The goal is not to make editing disappear. The goal is to make repository understanding, review, and durable synthesis strong enough that the product is already useful even when no code generation happens.

## Phase 3 Outcome

Phase 3 is complete when these questions have clear answers:

- what the minimum useful repo-analysis workflow is
- what the minimum useful code review workflow is
- which existing repo surfaces strengthen those workflows
- which existing repo surfaces would keep the product trapped in chat-first or edit-first behavior
- what durable artifacts should exist besides chat history
- how selected files, diffs, and branches enter a casefile
- how editing remains available without becoming the center of the product

The current answer is:

- the minimum analyst core is a repo-analysis and review workbench, not a better chat pane
- the first durable artifacts should be findings, review notes, summaries, and open questions
- the current chat thread machinery is useful as a persistence bridge, but not as the top-level system of record
- repo structure, selected scope, diffs, and execution evidence should be explicit inputs to analysis artifacts
- edit/apply stays available as a follow-on action from findings and review, not as the primary information architecture

## Minimum Useful Analyst Workflows

Phase 3 should support two workflows before anything else.

### 1. Repository Analysis Workflow

Minimum useful flow:

1. open a workspace or repo
2. get an immediate structural orientation
3. ask broad questions about architecture, ownership, and implementation paths
4. narrow into selected files, folders, or code ranges
5. promote important observations into saved findings or open questions
6. revisit those saved records later without rereading the whole thread

Why this is the minimum:

- the repo must be useful before any edit is proposed
- this is the clearest place to prove the product is deeper than a generic assistant
- it matches the current planning thesis that repo understanding should become the strongest capability

### 2. Code Review Workflow

Minimum useful flow:

1. choose a review scope such as changed files, a branch, a commit range, or a run-specific diff
2. inspect the code and any related evidence
3. capture review findings with severity, evidence, and follow-up status
4. preserve unresolved questions separately from conclusions
5. generate a durable review note or summary artifact
6. optionally draft comments or follow-on edits from that saved review state

Why this is the minimum:

- the repo already contains explicit diff and apply machinery
- review is one of the target jobs named in the product thesis
- review naturally produces durable artifacts rather than one-off assistant replies

## What The Current Repo Already Gives Phase 3

The current repo already contains several strong building blocks for the analyst core.

### `chatThreadService.ts`: Best Persistence Bridge, But Too Thread-Centric

Useful current behavior:

- persists thread history to application storage
- stores staging selections for files, folders, and code ranges
- tracks checkpoints and user/tool edit boundaries
- supports switching, duplication, and resumption of prior work threads

Why it matters:

- it already behaves like ongoing work context rather than stateless chat
- it is the best bridge into a future casefile model

Why it is not enough unchanged:

- the durable object is still a thread
- findings, questions, and summaries do not exist as first-class records
- the thread list is still named and presented like chat history rather than analyst work

Decision:

- adapt `chatThreadService.ts` into a subordinate conversation timeline inside the casefile
- do not treat thread history as the final analyst-core persistence model

### `directoryStrService.ts`: Strong Repo-Orientation Primitive

Useful current behavior:

- renders workspace and folder structure into model-readable strings
- filters noisy directories
- supports targeted folder inspection and broader workspace orientation

Why it matters:

- broad repo questions depend on fast structural orientation
- this is closer to analyst work than most UI-level chat surfaces are

Decision:

- keep this as a core repo-analysis primitive
- later broaden it from prompt support into reusable casefile evidence and scope metadata

### `convertToLLMMessageService.ts`: Strong Analysis Request Assembly

Useful current behavior:

- builds a workspace-aware system message
- includes workspace roots, open files, active file, directory structure, and persistent terminal context
- already distinguishes between chat modes with different tool behavior

Why it matters:

- the core analyst capability still needs a strong grounded request path to the model
- this service is already closer to "analysis request assembly" than to raw prompt concatenation

Current limitation:

- the output is still organized around chat messages and chat modes
- durable artifacts do not flow through this layer as first-class objects yet

Decision:

- keep this service
- evolve it from chat-only message assembly toward analysis request assembly driven by casefile scope, findings, notes, and selected review targets

### `sendLLMMessageService.ts`: Keep As The Model Execution Bridge

Useful current behavior:

- central browser-side bridge for model requests
- already handles provider settings and MCP tool exposure

Why it matters:

- Phase 3 still needs strong model execution
- this is infrastructure, not product identity

Decision:

- keep this service as analyst-core infrastructure
- do not make Phase 3 about renaming it

### `editCodeService.ts`: Strong Secondary Capability

Useful current behavior:

- explicit diff/apply pipeline
- reviewable edit zones
- change tracking and accept/reject flows

Why it matters:

- explicit and reviewable edits fit the analyst vision better than blind automation
- review often ends in a small patch, draft fix, or suggested change

Risk:

- this surface is concrete and mature, so it can pull the product back toward "the thing that edits code"

Decision:

- keep it as a follow-on action from findings, summaries, and review notes
- do not let it define the main workflow or top-level navigation

### `voidSettingsPane.ts`: Proof That Durable Main-Editor Surfaces Fit

Useful current behavior:

- opens a custom editor-pane-backed product surface in the main editor area

Why it matters:

- Phase 2 already decided that durable artifacts belong in the main editor area
- this file proves the repo already has a pattern for custom product-owned editor surfaces

Decision:

- use this pattern later for review notes, summaries, and casefile overview surfaces

## What In The Current Repo Distracts From Phase 3

Several existing surfaces are important to understand, but risky to preserve as product-defining behavior.

### Chat-First Sidebar Framing

Current evidence:

- `sidebarPane.ts` registers the view container title as `Chat`
- `Sidebar.tsx` mounts `SidebarChat` directly as the main product surface
- `SidebarThreadSelector.tsx` presents durable work mainly as past threads

Why this is a problem:

- it makes conversation appear to be the product rather than one tool inside the product
- it hides the future casefile structure behind a single chat pane

Decision:

- Phase 3 should treat the sidebar as future casefile navigation and context support, not as the whole product

### Feature Taxonomy Organized Around Coding-Assistant Modes

Current evidence:

- `voidSettingsTypes.ts` still uses `Chat`, `Ctrl+K`, `Autocomplete`, `Apply`, and `SCM` as the top-level feature taxonomy
- global settings still assume chat is the center through settings like `syncApplyToChat`, `syncSCMToChat`, and `chatMode`

Why this is a problem:

- the taxonomy still encodes the old product thesis
- analyst work should be organized around repo analysis, review, synthesis, and structured context

Decision:

- keep the implementation taxonomy for now
- stop treating it as the product model in Phase 3 planning and future UI design

### Thread History As The Only Durable Container

Current evidence:

- `THREAD_STORAGE_KEY` stores persisted chat threads
- thread duplication and deletion are first-class
- saved findings, open questions, and summaries do not exist beside the thread

Why this is a problem:

- important work can only be revisited by rereading thread history
- review artifacts are not promoted into durable structured records

Decision:

- use thread persistence as a bridge
- add artifact persistence beside or above it rather than deepening chat history alone

### Edit-First And Assistant-First Defaults

Current evidence:

- the sidebar defaults to chat
- global default `chatMode` is `agent`
- existing feature naming gives heavy weight to edit and autocomplete behaviors

Why this is a problem:

- it nudges both design and implementation toward code generation first
- it makes repo understanding look secondary even when the plan says otherwise

Decision:

- preserve these capabilities
- demote them in the eventual information architecture

## Findings Surface Design

Phase 3 needs a findings surface that is not just chat scrollback.

### Purpose

The findings surface should be the durable list of important conclusions or risks discovered during repo analysis or review.

### Minimum Record Shape

Each finding should capture:

- title
- short summary
- severity or importance
- evidence links
- related files, diffs, branches, runs, or documents
- status such as open, accepted, dismissed, or follow-up
- optional draft comment or next action link

### UX Role

The findings surface belongs in a side panel or auxiliary panel because it is:

- navigational
- summary-oriented
- a bridge into deeper artifacts in the editor area

### Interaction Model

Users should be able to:

- promote a chat observation into a finding
- create a finding from a diff or file selection
- attach evidence after the finding exists
- open a finding into a richer review note or memo

### Phase 3 Decision

- findings become the first structured record promoted out of chat
- they should live in the casefile, not only in thread history

## Review Notes Surface Design

Phase 3 also needs a review notes surface that survives beyond a single thread.

### Purpose

The review notes surface is the durable artifact for one review scope.

Typical scopes:

- current branch review
- changed-files review
- commit-range review
- run-specific diff review
- subsystem investigation review

### Minimum Sections

A review note should hold:

- scope definition
- short overview
- findings list
- open questions
- evidence and citations
- next actions
- optional draft comment set

### UX Role

This surface belongs in the main editor area because it is:

- durable
- high-attention
- reviewable and revisable
- potentially side-by-side with code or diffs

### Implementation Direction

The custom editor-pane pattern already used by `voidSettingsPane.ts` is the right structural precedent for future review-note and summary editors.

### Phase 3 Decision

- review notes become a main-editor artifact, not a side effect of chat
- findings panels should point into review notes, not replace them

## How Summaries Are Saved And Revisited

Summaries should not be disposable assistant replies.

### Summary Types

The first summary types for the analyst core should be:

- repo summary
- review summary
- investigation summary
- run or diff summary

### Save Model

Each summary should store:

- title
- summary type
- scope used to produce it
- timestamp
- linked evidence
- source findings or open questions
- originating thread or analysis request, if any

### Revisit Model

Users should be able to reopen summaries from the casefile without reconstructing the original chat state.

That means summaries must be:

- addressable as artifacts
- visible in the casefile
- editable or regenerable from saved scope

### Phase 3 Decision

- summaries are saved artifacts inside the casefile
- thread messages may reference them, but should not be their only home

## How Diffs, Branches, And Selected Files Enter The Casefile

Phase 3 needs explicit scope intake rules.

### Selected Files, Folders, And Ranges

The current staging-selection model in `chatThreadService.ts` already captures:

- files
- folders
- code ranges

Decision:

- reuse this as the first scope-picking bridge into findings, review notes, and summaries

### Diffs And Review Scopes

The current repo already has explicit diff/apply machinery in `editCodeService.ts`.

Decision:

- promote branch and diff scope to first-class casefile inputs
- support review scopes such as current changes, explicit file list, branch comparison, commit range, or run-specific diff

### Repo Orientation

The repo baseline should come from workspace and directory context, not only current chat text.

Decision:

- use `directoryStrService.ts` and workspace context as the casefile's orientation baseline

### Practical Phase 3 Rule

Every saved finding, review note, or summary should preserve the scope that produced it.

That scope may reference:

- a repo root
- a branch or diff target
- selected files or folders
- code ranges
- linked runs or logs

This is the minimum requirement for revisitable analyst work.

## Keep Edit Support Secondary

Edit/apply support remains useful, but it should now be downstream of analysis.

### Correct Role For Edit Support

Good Phase 3 uses:

- draft a fix from a saved finding
- propose a patch from a review note
- create a follow-on edit after a summary identifies a concrete issue

Bad Phase 3 uses:

- treating the edit widget as the main home screen
- measuring product success mainly by code generation speed
- organizing navigation around edit entry points instead of casefile context

### Phase 3 Decision

- preserve `Ctrl+K`, apply, and related edit support
- keep them available as explicit actions launched from analysis or review context
- do not let them define the default navigation, terminology, or primary saved artifacts

## Suggested Phase 3 Implementation Order

The lowest-risk implementation order is:

1. reframe the sidebar from pure chat into casefile context plus findings and open questions
2. add a first saved-finding record type that can be promoted from chat or review scope
3. add a main-editor review note artifact using the existing custom editor-pane pattern
4. add summary generation that saves artifacts instead of only writing assistant replies
5. wire selected files, folders, and diff scopes into those artifacts explicitly
6. keep edit/apply actions available from those artifacts as follow-on actions

This order matches the guardrails:

- additive over rewrite-heavy
- shell-preserving
- analysis-first
- durable-artifact-first

## Mapping From Current Repo To Phase 3 Decisions

The clearest current bridges into the analyst core are:

- `src/vs/workbench/contrib/void/browser/chatThreadService.ts`
  - strongest persistence bridge
  - best place to harvest selected scope and prior discussion
- `src/vs/workbench/contrib/void/common/directoryStrService.ts`
  - strongest repo-orientation primitive
- `src/vs/workbench/contrib/void/browser/convertToLLMMessageService.ts`
  - strongest grounding layer for analysis requests
- `src/vs/workbench/contrib/void/common/sendLLMMessageService.ts`
  - core model execution bridge worth preserving
- `src/vs/workbench/contrib/void/browser/editCodeService.ts`
  - strong secondary review-to-edit capability
- `src/vs/workbench/contrib/void/browser/voidSettingsPane.ts`
  - precedent for durable custom editor surfaces

The clearest current constraints to outgrow are:

- `src/vs/workbench/contrib/void/browser/sidebarPane.ts`
  - still labels the product surface as `Chat`
- `src/vs/workbench/contrib/void/browser/react/src/sidebar-tsx/Sidebar.tsx`
  - still mounts chat as the whole sidebar experience
- `src/vs/workbench/contrib/void/browser/react/src/sidebar-tsx/SidebarThreadSelector.tsx`
  - still treats prior work mainly as thread history
- `src/vs/workbench/contrib/void/common/voidSettingsTypes.ts`
  - still encodes coding-assistant feature taxonomy and chat-centered defaults

## Phase 3 Decisions Summary

1. The minimum analyst core is defined by repo analysis and code review workflows, not by code generation workflows.
2. The first durable analyst artifacts are findings, review notes, summaries, and open questions.
3. `chatThreadService.ts` remains the best current persistence bridge, but it should become one sub-layer inside a casefile rather than the top-level durable object.
4. `directoryStrService.ts`, `convertToLLMMessageService.ts`, and `sendLLMMessageService.ts` are core reuse candidates for grounded analyst workflows.
5. `sidebarPane.ts`, `Sidebar.tsx`, `SidebarThreadSelector.tsx`, and `voidSettingsTypes.ts` still encode chat-first or coding-assistant-first framing that Phase 3 should outgrow.
6. Review notes and summaries belong in the main editor area as durable artifacts; findings and open questions belong in supporting side panels.
7. Selected files, folders, code ranges, diffs, and branch scope must be explicit casefile inputs for any saved analyst artifact.
8. Edit/apply support remains valuable, but only as a secondary action launched from analysis and review context.

## Phase 3 Definition Of Done Check

Phase 3 is complete at the planning layer because:

- the minimum useful repo-analysis workflow is now explicit
- the minimum useful code review workflow is now explicit
- the strongest reusable surfaces and the most misleading current surfaces are now identified
- findings, review notes, summaries, and scope intake rules are now defined before implementation
- the role of editing is preserved without letting it dominate the product model

The implementation demo for this phase still belongs to later product work. What is complete here is the design decision layer needed to build that demo without drifting back into a chat-first coding assistant.
