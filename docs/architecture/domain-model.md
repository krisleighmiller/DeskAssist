# Domain Model

This document defines the most important DeskAssist terms and maps the current implementation language to the broader product language in [`../../README.md`](../../README.md).

The main problem this document solves is vocabulary drift.

Today the codebase is organized around `casefile`, `lane`, and `scope`. The README is organized around `workspace`, `context`, `artifact`, and `scoped AI`. Both are useful. The project needs a consistent way to talk about both without pretending they are already the same thing.

## Vocabulary Principle

Use two layers of terminology intentionally:

- product-facing terms describe the experience we want users to understand
- implementation terms describe the storage and runtime model we currently have

The goal is not to erase implementation terms. The goal is to stop letting them define the product by accident.

## Core Terms

## Workspace

User-facing meaning:

A workspace is the always-open DeskAssist environment where a user resumes, switches, captures, browses, chats, and compares.

Current implementation reality:

- the renderer workbench in [`ui-electron/renderer/src/App.tsx`](../../ui-electron/renderer/src/App.tsx)
- one open casefile plus its active lane, open tabs, right-panel state, and terminal sessions

Recommendation:

Use `workspace` as the primary product term for the overall environment. Do not use `casefile` as the top-level user concept unless the UI is intentionally in an advanced or implementation-aware mode.

## Casefile

Implementation meaning:

A casefile is a chosen directory plus its `.casefile/` metadata folder.

Current definition:

- represented by `Casefile` and `CasefileSnapshot` in [`src/assistant_app/casefile/models.py`](../../src/assistant_app/casefile/models.py)
- managed by [`src/assistant_app/casefile/store.py`](../../src/assistant_app/casefile/store.py) and [`src/assistant_app/casefile/service.py`](../../src/assistant_app/casefile/service.py)

What it currently owns:

- lane definitions
- active lane
- lane chat logs
- lane notes
- prompt drafts
- context manifest
- inbox source configuration

Recommendation:

Keep `casefile` as an implementation and power-user term. It is a good storage model and a good on-disk term. It should not be the main product identity of DeskAssist.

## Context

User-facing meaning:

A context is the unit of work the user is currently in or can switch to. It is what the README means by moving between active contexts without losing the thread.

Current implementation reality:

There is not yet one single data structure called `context` that covers the full product meaning. The current system approximates it through a combination of:

- the active casefile
- the active lane
- resolved AI scope
- open editor tabs
- associated notes, prompts, inbox references, and comparison sessions

Recommendation:

Use `context` as the main product-facing umbrella term.

In V1, the practical rule should be:

- a lane is the current implementation of a scoped working context
- a comparison session is a multi-context view
- the future home screen should list contexts, not internal lane records

## Lane

Implementation meaning:

A lane is the current durable unit of scoped work inside a casefile.

Current definition:

- represented by `Lane` in [`src/assistant_app/casefile/models.py`](../../src/assistant_app/casefile/models.py)
- has an id, name, kind, root, optional parent, and optional read-only attachments
- owns a write root and related chat and note history

What a lane does well today:

- establishes a write boundary
- supports inheritance through ancestors
- travels with attachments
- anchors comparison and scoped chat

What a lane does poorly today as a user-facing term:

- it sounds implementation-specific
- it does not naturally describe non-code or mixed-mode work
- it is not obvious to a new user why they should create one

Recommendation:

Treat `lane` as the current implementation of a scoped context.

Short-term guidance:

- acceptable in contributor docs and advanced UI copy
- not ideal as the primary product noun for all users

Longer-term guidance:

- keep the storage concept if it remains useful
- reduce its prominence in first-run UX and broad product framing

## Artifact

User-facing meaning:

An artifact is any durable thing the user works with inside DeskAssist.

Examples from the README:

- files
- directories
- notes
- prompts
- attachments
- diffs
- chat transcripts

Current implementation reality:

Artifacts exist, but they are not yet modeled uniformly. They currently live in separate systems:

- lane-root files through Electron file IO
- notes through `NotesStore`
- prompts through `PromptsStore`
- inbox items through `InboxStore`
- chat logs through casefile chat persistence
- comparison results in memory and comparison logs

Recommendation:

Use `artifact` as a real product and architecture term, not just a roadmap idea.

The current system already has artifact types. What it lacks is a unified artifact model and a consistent discovery surface.

## Scope

Implementation and product meaning:

Scope is the exact material the AI can read for a given conversation.

Current definition:

- resolved by [`src/assistant_app/casefile/scope.py`](../../src/assistant_app/casefile/scope.py)
- serialized through [`src/assistant_app/casefile/service.py`](../../src/assistant_app/casefile/service.py)
- consumed by the bridge in [`src/assistant_app/electron_bridge.py`](../../src/assistant_app/electron_bridge.py)

What scope currently includes:

- one lane write root for lane chat
- read-only overlays for attachments and ancestors
- casefile context files
- multi-lane overlays for comparison chat

Recommendation:

Keep `scope` as both an internal and user-facing term.

This is one of the strongest pieces of DeskAssist's product language because it directly expresses the differentiator: deliberate control over what the AI can see.

## Comparison

User-facing meaning:

A comparison is a multi-context session where related artifacts or lanes can be inspected and discussed together.

Current implementation reality:

- file-level lane comparison is initiated from the `Lanes` tab
- comparison chat opens a synthetic read-only session over multiple lanes
- the session gets its own persistent log keyed by an order-independent synthetic id

Recommendation:

Keep `comparison` as a user-facing capability term.

It already aligns well with both the current implementation and the product vision.

## Attachment

Implementation meaning:

A lane attachment is a read-only directory associated with a lane and mounted into scope under a virtual prefix.

Current definition:

- represented by `LaneAttachment` in [`src/assistant_app/casefile/models.py`](../../src/assistant_app/casefile/models.py)
- resolved into overlays in [`src/assistant_app/casefile/scope.py`](../../src/assistant_app/casefile/scope.py)

Recommendation:

Keep `attachment` as an implementation term and a secondary user-facing term.

It is useful because it explains the current system well, but it should probably be framed as "related material" or "attached context" in broader product copy.

## Inbox Source

Current meaning:

An inbox source is a configured external directory of read-only material that is not owned by any lane.

Current implementation:

- stored in `.casefile/inbox.json`
- managed by [`src/assistant_app/casefile/inbox.py`](../../src/assistant_app/casefile/inbox.py)

Recommendation:

Treat `inbox source` as an implementation and advanced workflow term.

The broader product concept is closer to "external context source" or "reference source." The current `Inbox` tab is useful, but it should not define the long-term product taxonomy.

## Recommended Language Rules

When talking about the product:

- say `workspace` for the overall environment
- say `context` for the unit of resumed or active work
- say `scope` for what the AI can currently read
- say `artifact` for the durable things the user is working with
- say `comparison` for multi-context inspection and conversation

When talking about the current implementation:

- say `casefile` for the on-disk metadata root
- say `lane` for the current scoped work record and write boundary
- say `attachment` for mounted read-only sibling directories
- say `inbox source` for configured external read-only directories

## Practical Mapping

Use this mental mapping when writing docs, UI copy, or code comments:

- workspace: the whole DeskAssist environment for a user
- casefile: the current storage container that backs one workspace area
- context: the user-facing work unit
- lane: the current implementation of a scoped context
- scope: the AI-visible slice of material for a context or comparison
- artifact: any durable thing inside or attached to a context
- comparison: a read-only multi-context session

## Current Implementation Versus Target Framing

Today:

- the code understands lanes and casefiles very well
- the product framing understands contexts and artifacts more clearly than the UI does

Target:

- keep the current storage and scope machinery where it is strong
- move the visible product language toward workspace, context, artifact, and scope
- allow `lane` and `casefile` to remain important implementation concepts without making them the only way users can understand the product

## Domain Model Summary

DeskAssist should be understood as:

- a workspace that holds many contexts
- each context contains or references artifacts
- AI conversations operate over an explicit scope
- the current implementation represents many of those contexts as lanes inside a casefile

That is the cleanest bridge between the current code and the longer-term second-brain workspace vision.
