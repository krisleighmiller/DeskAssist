# DeskAssist Current State

This document is the baseline for DeskAssist as it exists now. It is not a history of earlier milestones. Use it to understand what the app can do today, what is incomplete, and what the next roadmap should build from.

## Product Baseline

DeskAssist is currently a desktop workspace for switching focus with scoped AI.

The app can:

- open a workspace-backed casefile
- create and switch between context-backed focuses
- browse, create, edit, rename, move, trash, and restore files
- chat with AI inside one focus
- compare two or more focuses in a multi-focus chat
- control which scoped directories are read-only or writable
- persist context and comparison chat history
- show a lightweight home view with recent and pinned work
- quick-capture into a file inside the active workspace

The app is not yet:

- a full user-level focus registry
- a complete home/resume system
- a standalone non-code focus system
- an integration platform
- a system where one scoped chat can explicitly reference another scoped chat discussion

## Current Core Concepts

**Workspace** is the running DeskAssist workbench.

**Casefile** is the selected directory plus its `.casefile/` metadata folder.

**Focus** is the product-facing unit of active or resumable work.

**Context** is the current implementation record for a scoped focus inside a casefile. A context has an id, stable session id, name, kind, root directory, optional parent, attachments, and a writable flag.

**Scope** is the exact set of directories and context files the AI can read or write in a chat session. Scoped directories are exposed to the model as `_scope/<label>/...`; bare relative paths resolve inside the primary writable scoped directory when one exists.

**Comparison** is a multi-focus chat session over two or more focuses. The current implementation stores those participants as context ids.

**Attachment** is an additional directory associated with a context or comparison. It can be read-only or writable.

## Runtime Shape

DeskAssist currently uses four main runtime layers:

- Electron main process owns desktop capabilities, file IO, menus, watchers, terminals, API key storage, and IPC enforcement.
- Preload exposes the constrained `window.assistantApi` surface to the renderer.
- React renderer owns workbench UI state, open tabs, recent work records, chat session state, comparison session state, and most workflow orchestration.
- Python bridge and domain services own casefile persistence, scope resolution, chat orchestration, provider/tool integration, and scoped filesystem tools.

This split is working and should be preserved unless a future task explicitly changes it.

## Persistence Shape

Each casefile stores metadata under `.casefile/`:

- `contexts.json`: context definitions and active context id
- `comparisons.json`: comparison session metadata
- `chats/<session_uuid>.jsonl`: context and comparison chat logs
- `context.json`: casefile-wide context file manifest

The renderer also stores recent and pinned work records in `localStorage`.

Important limitation: recent work is not yet a durable user-level index. It is a useful local renderer feature, not a full cross-workspace persistence layer.

## Implemented Capabilities

### Shell

The workbench has a stable three-column shape with file tree, editor, right panel chat, and terminal support. Layout state persists. Terminal, editor, browser, and chat can coexist.

Remaining concern: this still needs product QA at common window sizes, but no obvious core shell feature is missing from the current baseline.

### Files And Browser

The file browser is a real control surface. It supports normal file operations and connects file-tree actions to focus workflows.

Implemented:

- open files into editor tabs
- save edited files
- create files and folders
- rename files and folders
- move files and folders
- trash files and folders with undo
- create a context from a directory
- attach a directory to a context
- switch focuses from context-root rows
- start comparison chat from context-root rows
- update or remove contexts from browser actions

### Context-Backed Focuses

Focuses are durable scoped work units. The current implementation stores them as contexts inside a casefile.

Implemented:

- default `main` context on casefile initialization
- context registration
- focus switching through active-context changes
- context rename/update/remove
- parent relationships for UI organization
- attachments with read/write access mode
- stable UUID-backed session identity

Important limitation: context parent relationships are organizational only. They do not imply AI scope inheritance.

### Scope

Scope resolution is one of the strongest implemented parts of the app.

Implemented:

- flat `ScopedDirectory(path, label, writable)` entries
- `_scope/<label>/...` virtual paths for scoped directories
- `_context/...` for casefile context files
- independent read/write access per scoped directory
- Python-owned scope resolution
- scoped filesystem tools
- write-tool approval flow

Important limitation: the user-facing language around scope is still rough. The implementation is stronger than the explanation.

### Focus Chat

Single-focus chat works against the active context's resolved scope.

Implemented:

- provider selection
- persisted chat history by stable session UUID
- assistant charter injection
- casefile context reference injection
- scoped read tools
- write tools gated by explicit approval
- `@` file inclusion
- file drag/drop inclusion
- save assistant response to an allowed writable destination

### Comparison Chat

Comparison chat works over two or more focuses.

Implemented:

- open or reopen comparison sessions by context id set
- stable synthetic comparison id
- persisted comparison metadata
- persisted comparison chat history by stable session UUID
- direct context roots and attachments included in resolved scope
- comparison-level attachments
- per-directory read/write access
- write-tool approval flow

Important limitation: comparison chat and focus chat share the backend scope shape, but still use separate renderer and bridge flows.

### Home And Resume

Home exists, but it is lightweight.

Implemented:

- recent work records
- pinned work records
- resume latest
- reopen recent workspace and preferred active context
- quick capture guidance

Important limitations:

- recent state lives in renderer `localStorage`
- home does not restore full workbench state
- home does not surface recent files, recent chats, or comparison sessions as first-class resume targets
- quick capture requires an active workspace and writes a file inside that workspace

## Known Gaps From The Current Baseline

### 1. Scope UX Clarity

The app can show what the AI can read and write, but the explanation still feels implementation-shaped. The next documentation and UI pass should make scope understandable without requiring the user to know the storage model.

### 2. Cross-Session Chat Reference

Scoped chats are persisted, but they are not addressable as readable reference material from other scoped chats.

Example gap: a user cannot explicitly reference the discussion from a single-focus chat inside a comparison chat.

This belongs to cross-focus continuity. It should not merge chat histories automatically. It should let the user select a prior discussion and include it as readable reference material with clear provenance.

### 3. Durable User-Level Recent Work

Recent and pinned work records currently live in renderer `localStorage`. The app needs a more deliberate user-level index before home/resume can become reliable across workspaces and app lifecycle edge cases.

### 4. Full Resume State

The app can reopen a recent casefile and preferred focus, but it does not restore a complete working state:

- open editor tabs
- focused file
- active chat or comparison
- recent discussion targets
- selected scope changes beyond persisted context metadata

### 5. Standalone Non-Code Focus

Quick capture is a file workflow inside the active workspace. DeskAssist still needs one standalone non-code focus, such as a journal, daily log, or scratch focus, to prove the product is broader than project/repo work.

### 6. Current Architecture Concentration

The renderer still carries a lot of orchestration, especially in and around `App.tsx`. This is manageable today, but future work should extract state by concern only when a concrete feature needs it.

## Current Priority Order

From this baseline, the next work should proceed in this order:

1. Polish scope clarity enough that users can understand what AI can see.
2. Add cross-session chat reference access.
3. Strengthen home/resume with durable recent work and richer resume targets.
4. Add the first standalone non-code focus.
5. Define extension boundaries only after the core workspace/focus/scope loops are stronger.

This is the current baseline for future planning. Older milestone language should not override this document when deciding what the app already does.
