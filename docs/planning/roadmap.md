# DeskAssist Roadmap From Current State

This roadmap starts from the current app baseline in [`../current-state.md`](../current-state.md).

It does not reopen closed milestone history. The question is now: given what DeskAssist already does, what should happen next?

## Current Baseline

DeskAssist currently has:

- a stable Electron desktop shell
- a casefile-backed workspace model
- context creation, switching, update, and removal
- browser-driven file operations
- scoped context chat
- multi-context comparison chat
- flat per-directory scope with read/write access
- persisted context and comparison chat logs
- a lightweight home view with recent and pinned contexts
- quick capture into the active workspace

The main gaps are:

- scope is implemented more clearly than it is explained
- scoped chat discussions cannot be referenced from other scoped chats
- home/resume is lightweight and renderer-local
- there is no standalone non-code context
- extension boundaries are not defined

## Build Rules

- Build from the current app, not from old milestone assumptions.
- Keep `context` as the scoped work unit.
- Keep scope resolution in Python.
- Keep comparison chat governed by the same scope model as context chat.
- Do not introduce integrations before extension boundaries.
- Do not create a new persistence model unless the current roadmap item requires it.
- Prefer focused, user-visible improvements over framework work.

---

## 1. Scope Clarity Pass

### Goal

Make the current scope model obvious to users.

The scope engine already works. The missing work is explanation, presentation, and confidence.

### Includes

- review and improve scope header copy
- improve empty states for context chat and comparison chat
- clarify RW/RO language
- clarify what attachments are in user-facing language
- clarify when write tools require approval
- ensure context and comparison chat explain scope consistently

### Does Not Include

- replacing the scope resolver
- unifying context chat and comparison chat runtime paths
- changing persistence
- building onboarding as a separate system

### Exit Criteria

- A new user can answer what the AI can read right now.
- A new user can answer where the AI may write right now.
- A user can understand how to widen, narrow, or change access without knowing implementation details.
- Context chat and comparison chat use consistent scope language.

---

## 2. Cross-Session Chat Reference Access

### Goal

Allow one scoped chat to reference the discussion from another scoped chat.

This is the missing continuity feature between context chat and comparison chat. Chat logs already persist, but the user cannot explicitly bring one discussion into another session.

### Example

A user discusses Context A in a single-context chat, then opens a comparison chat between Context A and Context B. The user should be able to reference the earlier Context A discussion inside the comparison chat without manually copying text.

### Includes

- list or select prior chat discussions available in the current casefile
- include a chosen discussion as readable context in another chat
- preserve provenance in the prompt or message context
- support context chat and comparison chat as reference sources
- avoid silently merging histories

### Does Not Include

- automatic memory across all chats
- global semantic search over every conversation
- generic artifact database
- exposing every chat log as a top-level navigation destination

### Exit Criteria

- A user can choose a prior scoped discussion and include it in the current chat.
- The current chat can use that discussion as context.
- The UI makes it clear which discussion was referenced.
- The original discussion remains unchanged.
- The referenced discussion is not automatically added to every future chat.

---

## 3. Durable Recent Work And Resume

### Goal

Make home and resume reliable enough to become the user's starting point.

Home exists today, but recent work is renderer-local and resume is shallow.

### Includes

- durable user-level recent-context index
- richer resume targets
- recent context, recent file, recent chat, and recent comparison entries where useful
- restore enough workbench state to make resume feel real
- clear distinction between pinned work and recent work

### Does Not Include

- cloud sync
- account system
- recommendation engine
- integration inbox
- full task management

### Exit Criteria

Opening DeskAssist answers:

- what was I doing?
- what can I resume?
- which contexts or discussions were active recently?

Resume should restore more than a casefile root. It should put the user near the actual work they left.

---

## 4. First Standalone Non-Code Context

### Goal

Prove DeskAssist is broader than project or repo work.

Quick capture currently writes a file inside the active workspace. That is useful, but it is not a standalone non-code context.

### Recommended First Version

Pick one:

- journal
- daily log
- scratch context

### Includes

- a local non-code context that can be opened and resumed like other contexts
- file-backed storage using existing file/editor mechanics where possible
- scoped AI over that context
- capture into that context without needing an active project workspace

### Does Not Include

- email
- Slack
- calendar
- health tracking
- reminders
- plugin system

### Exit Criteria

- A user can switch from project work to the non-code context and back.
- A user can capture into it without opening a project workspace first.
- AI can work over it using the same scope safety model.
- The implementation does not introduce a separate platform subsystem.

---

## 5. Extension Boundaries

### Goal

Define how future integrations can connect without reshaping the core product.

This should come after the core workspace, context, scope, resume, and non-code context loops are stronger.

### Includes

- extension boundary principles
- permission model sketch
- registration/configuration shape
- background service boundary if needed
- examples of allowed and disallowed integration behavior

### Does Not Include

- building all integrations
- marketplace work
- cloud sync
- reworking the shell around integrations

### Exit Criteria

Future integrations can be added without changing the core meaning of workspace, context, scope, comparison, or file work.

## Current Priority Order

1. Scope clarity pass
2. Cross-session chat reference access
3. Durable recent work and resume
4. First standalone non-code context
5. Extension boundaries

This order keeps the product focused on context switching and scoped AI before expanding into broader platform behavior.
