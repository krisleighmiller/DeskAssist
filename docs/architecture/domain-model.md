# Domain Model

This document defines the most important DeskAssist terms and maps the current implementation language to the broader product language in [`../../README.md`](../../README.md).

The main problem this document solves is vocabulary drift.

Today the codebase is organized around `casefile`, `context`, and `scope`. The README is organized around `workspace`, `context`, `artifact`, and `scoped AI`. Both are useful. The project needs a consistent way to talk about both without pretending they are already the same thing.

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
- a home surface in [`ui-electron/renderer/src/components/HomeView.tsx`](../../ui-electron/renderer/src/components/HomeView.tsx)
- one open casefile plus its active context, open tabs, right-panel state, comparison sessions, recent-context state, and terminal sessions

Recommendation:

Use `workspace` as the primary product term for the overall environment. Do not use `casefile` as the top-level user concept unless the UI is intentionally in an advanced or implementation-aware mode.

## Casefile

Implementation meaning:

A casefile is a chosen directory plus its `.casefile/` metadata folder.

Current definition:

- represented by `Casefile` and `CasefileSnapshot` in [`src/assistant_app/casefile/models.py`](../../src/assistant_app/casefile/models.py)
- managed by [`src/assistant_app/casefile/store.py`](../../src/assistant_app/casefile/store.py) and [`src/assistant_app/casefile/service.py`](../../src/assistant_app/casefile/service.py)

What it currently owns:

- context definitions
- active context
- comparison session metadata
- context chat logs
- comparison chat logs
- context manifest

Recommendation:

Keep `casefile` as an implementation and power-user term. It is a good storage model and a good on-disk term. It should not be the main product identity of DeskAssist.

## Context

User-facing meaning:

A context is the unit of work the user is currently in or can switch to. It is what the README means by moving between active contexts without losing the thread.

Current implementation reality:

There is not yet one single data structure called `context` that covers the full product meaning. The current system approximates it through a combination of:

- the active casefile
- the active context
- resolved AI scope
- open editor tabs
- associated chat and comparison sessions
- renderer-local recent context records

Recommendation:

Use `context` as the main product-facing umbrella term.

In V1, the practical rule should be:

- a context is the current implementation of a scoped working context
- a comparison session is a multi-context view
- the current home screen lists recent casefiles with their last active context; a fuller context model is still a target, not a complete implementation

## Context

Implementation meaning:

A context is the current durable unit of scoped work inside a casefile.

Current definition:

- represented by `Context` in [`src/assistant_app/casefile/models.py`](../../src/assistant_app/casefile/models.py)
- has an id, stable session id, name, kind, root, optional parent, optional attachments, and a writable flag
- anchors a scoped chat log

What a context does well today:

- establishes a scope and default AI write boundary
- supports UI organization through parents without implying inherited AI scope
- travels with attachments that can be read-only or writable
- anchors comparison and scoped chat

What a context does poorly today as a user-facing term:

- it sounds implementation-specific
- it does not naturally describe non-code or mixed-mode work
- it is not obvious to a new user why they should create one

Recommendation:

Treat `context` as the current implementation of a scoped context.

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
- working files
- attachments
- diffs
- chat transcripts

Current implementation reality:

Artifacts exist, but they are not yet modeled uniformly. They currently live in separate systems:

- context-root files through Electron file IO
- chat logs through casefile chat persistence
- comparison chat logs through casefile chat persistence

Recommendation:

Use `artifact` as a real product and architecture term, not just a roadmap idea.

The current system already has artifact types. What it lacks is a unified artifact model and a consistent discovery surface.

## Scope

Implementation and product meaning:

Scope is the exact material the AI can read and write for a given conversation.

Current definition:

- resolved by [`src/assistant_app/casefile/scope.py`](../../src/assistant_app/casefile/scope.py)
- serialized through [`src/assistant_app/casefile/service.py`](../../src/assistant_app/casefile/service.py)
- consumed by the bridge in [`src/assistant_app/electron_bridge.py`](../../src/assistant_app/electron_bridge.py)

What scope currently includes:

- a flat list of `ScopedDirectory(path, label, writable: bool)` entries
- context root and attachments as independently configurable scoped directories
- casefile context files under `_context`
- multi-context comparison entries under `_scope/<label>/...`

Implementation audit note:

The old hierarchical virtual-prefix model has been removed from the current Python scope resolver. Structural parents are not inherited into AI scope. If a doc still describes that model as current, it is stale.

Remaining target:

- tighten the product language around scoped sessions so users understand the flat directory list without needing implementation terms

Recommendation:

Keep `scope` as both an internal and user-facing term.

This is one of the strongest pieces of DeskAssist's product language because it directly expresses the differentiator: deliberate control over what the AI can see and do.

## Comparison

User-facing meaning:

A comparison is a multi-directory session where related work can be inspected and discussed together. It is not necessarily a diff — it may be synthesis, analysis, or open-ended discussion across any subset of the user's named contexts.

Current implementation reality:

- comparison chat opens a synthetic session over two or more contexts
- the session gets its own persistent log keyed by a stable session UUID
- comparison session metadata is persisted in `.casefile/comparisons.json`

Implementation audit note:

- "comparison" implies a diff or winner/loser framing; the actual need is a flexible multi-scope session that sometimes compares, sometimes synthesizes
- single-context chat and comparison chat still have separate UI and bridge paths, even though they now share the same scoped-directory resolver shape

Current target:

- keep comparison as the user-facing capability term while continuing to reduce separate-session mechanics where that improves clarity

Recommendation:

Keep `comparison` as a user-facing capability term for the multi-directory case, but implement it as the general case of a unified scoped session rather than a separate concept.

## Attachment

Implementation meaning:

A context attachment is a directory associated with a context and mounted into scope under a virtual prefix.

Current definition:

- represented by `ContextAttachment` in [`src/assistant_app/casefile/models.py`](../../src/assistant_app/casefile/models.py)
- resolved into `_scope/<label>/...` scoped directories in [`src/assistant_app/casefile/scope.py`](../../src/assistant_app/casefile/scope.py)
- carries a `mode` field: `read` or `write`

Implementation audit note:

Attachments are no longer always read-only. New attachments default to writable in the data model, and the UI can toggle attachment access between read-only and writable.

Recommendation:

Keep `attachment` as an implementation term for a directory associated with a session. In product copy, prefer "related directory" or "additional context." The read-only assumption should not be baked into the definition.

## Recommended Language Rules

When talking about the product:

- say `workspace` for the overall environment
- say `context` for the unit of resumed or active work
- say `scope` for what the AI can currently read
- say `artifact` for the durable things the user is working with
- say `comparison` for multi-context inspection and conversation

When talking about the current implementation:

- say `casefile` for the on-disk metadata root
- say `context` for the current scoped work record and write boundary
- say `attachment` for mounted sibling directories whose access mode may be read-only or writable

## Practical Mapping

Use this mental mapping when writing docs, UI copy, or code comments:

- workspace: the whole DeskAssist environment for a user
- casefile: the current storage container that backs one workspace area
- context: the user-facing work unit
- context: the current implementation of a scoped context
- scope: the AI-visible slice of material for a context or comparison
- artifact: any durable thing inside or attached to a context
- comparison: a multi-context session with per-directory AI read/write access

## Current Implementation Versus Target Framing

Today:

- the code understands contexts and casefiles very well
- the product framing understands contexts and artifacts more clearly than the UI does

Target:

- keep the current storage and scope machinery where it is strong
- move the visible product language toward workspace, context, artifact, and scope
- allow `context` and `casefile` to remain important implementation concepts without making them the only way users can understand the product

## Domain Model Summary

DeskAssist should be understood as:

- a workspace that holds many contexts
- each context contains or references artifacts
- AI conversations operate over an explicit scope
- the current implementation represents many of those contexts as contexts inside a casefile

That is the cleanest bridge between the current code and the longer-term second-brain workspace vision.
