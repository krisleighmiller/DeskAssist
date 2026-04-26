# DeskAssist

DeskAssist is currently public for development visibility and review.


A formal license has not yet been selected. Until a license is added,
all rights are reserved.


DeskAssist is a unified focus-switching workspace with scoped AI for people doing messy, multi-mode work.

It is not a repo chat app with extra tabs and it is not a generic desktop assistant. It is an always-open workbench where a user can browse and edit files, move between durable focuses, control what the AI can read or write, compare related work, and resume without rebuilding state from memory.

## Current Product Shape

DeskAssist currently centers on these concepts:

- **Workspace**: the running desktop workbench and the place the user returns to.
- **Focus**: a durable unit of active or resumable work.
- **Scope**: the exact directories and files the AI can read or write in a chat session.
- **Comparison**: a multi-focus chat session over two or more focuses.
- **File**: the durable working object users create, edit, move, save, and discuss.

Implementation terms still matter:

- **Casefile**: the selected storage root plus `.casefile/` metadata.
- **Context**: the current implementation record for a scoped focus inside a casefile.
- **Attachment**: an additional directory associated with a context, with read or write access.

## What Exists Now

DeskAssist already has a stable desktop shell, a casefile-backed workspace, browser-driven file operations, context-backed focus creation and switching, scoped chat, comparison chat, explicit read/write scope controls, chat persistence, a lightweight home view, pinned recent work, and quick capture into the active workspace.

The app stores context metadata in `.casefile/contexts.json`, comparison session metadata in `.casefile/comparisons.json`, chat history in `.casefile/chats/<session_uuid>.jsonl`, and casefile-wide context-file manifests in `.casefile/context.json`.

## Product Principles

1. **Continuity over fragmentation**: the user should be able to stay in one environment while moving between related work.
2. **Focus is deliberate**: the user should understand and control what belongs to the current work unit.
3. **AI scope must be visible**: users should know what the model can see and where it can write.
4. **Files are first-class**: ordinary files and directories carry the current durable workflow.
5. **Extensions come later**: integrations should build on the core shell, focus, and scope model rather than define it.

## Current Gaps

DeskAssist is broader than a repo workflow, but the first standalone non-code focus is not implemented yet. Quick capture currently creates or opens a file inside the active workspace; it is not a switchable journal, daily log, or scratch focus.

Home and resume also remain lightweight. Recent and pinned work entries are stored in renderer `localStorage`; they are useful today, but not yet a durable user-level focus index.

## Execution Source Of Truth

The current implementation baseline lives in [`docs/current-state.md`](docs/current-state.md). The canonical V1 execution sequence, roadmap scope, and exit criteria live in [`docs/planning/roadmap.md`](docs/planning/roadmap.md).

Use the current-state baseline for what exists now and the roadmap for implementation planning. If this README and the roadmap appear to disagree about execution order, the roadmap wins.

## Documentation

- [`docs/README.md`](docs/README.md): documentation guide and reading order
- [`docs/current-state.md`](docs/current-state.md): current product, implementation, and gap baseline
- [`docs/architecture/product-north-star.md`](docs/architecture/product-north-star.md): product north star and user promise
- [`docs/architecture/system-overview.md`](docs/architecture/system-overview.md): current runtime architecture
- [`docs/architecture/domain-model.md`](docs/architecture/domain-model.md): product and implementation vocabulary
- [`docs/architecture/runtime-flows.md`](docs/architecture/runtime-flows.md): major runtime flows
- [`docs/architecture/target-v1-architecture.md`](docs/architecture/target-v1-architecture.md): intended V1 technical shape
- [`docs/planning/roadmap.md`](docs/planning/roadmap.md): canonical execution roadmap
- [`docs/planning/open-questions.md`](docs/planning/open-questions.md): unresolved product and architecture decisions
