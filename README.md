# DeskAssist

DeskAssist is a unified context-switching workspace with scoped AI for people doing messy, multi-mode work.

It is not a repo chat app with extra tabs and it is not a generic desktop assistant. It is an always-open workbench where a user can browse and edit files, move between durable contexts, control what the AI can read or write, compare related work, and resume without rebuilding state from memory.

## Current Product Shape

DeskAssist currently centers on these concepts:

- **Workspace**: the running desktop workbench and the place the user returns to.
- **Context**: a durable scoped work unit inside a casefile.
- **Scope**: the exact directories and files the AI can read or write in a chat session.
- **Comparison**: a multi-context chat session over two or more contexts.
- **File**: the durable working object users create, edit, move, save, and discuss.

Implementation terms still matter:

- **Casefile**: the selected storage root plus `.casefile/` metadata.
- **Attachment**: an additional directory associated with a context, with read or write access.

## What Exists Now

DeskAssist already has a stable desktop shell, a casefile-backed workspace, browser-driven file operations, context creation and switching, scoped chat, comparison chat, explicit read/write scope controls, chat persistence, a lightweight home view, pinned recent work, and quick capture into the active workspace.

The app stores context metadata in `.casefile/contexts.json`, comparison session metadata in `.casefile/comparisons.json`, chat history in `.casefile/chats/<session_uuid>.jsonl`, and casefile-wide auto-include context in `.casefile/context.json`.

## Product Principles

1. **Continuity over fragmentation**: the user should be able to stay in one environment while moving between related work.
2. **Context is deliberate**: the user should understand and control what belongs to the current work unit.
3. **AI scope must be visible**: users should know what the model can see and where it can write.
4. **Files are first-class**: ordinary files and directories carry the current durable workflow.
5. **Extensions come later**: integrations should build on the core shell, context, and scope model rather than define it.

## Current Gaps

DeskAssist is broader than a repo workflow, but the first standalone non-code context is not implemented yet. Quick capture currently creates or opens a file inside the active workspace; it is not a switchable journal, daily log, or scratch context.

Home and resume also remain lightweight. Recent and pinned contexts are stored in renderer `localStorage`; they are useful today, but not yet a durable user-level context index.

## Execution Source Of Truth

The canonical V1 execution sequence, milestone scope, and exit criteria live in [`docs/planning/roadmap.md`](docs/planning/roadmap.md).

Use that roadmap for implementation planning. If this README and the roadmap appear to disagree about execution order, the roadmap wins.

## Documentation

- [`docs/README.md`](docs/README.md): documentation guide and reading order
- [`docs/architecture/product-north-star.md`](docs/architecture/product-north-star.md): product north star and user promise
- [`docs/architecture/system-overview.md`](docs/architecture/system-overview.md): current runtime architecture
- [`docs/architecture/domain-model.md`](docs/architecture/domain-model.md): product and implementation vocabulary
- [`docs/architecture/runtime-flows.md`](docs/architecture/runtime-flows.md): major runtime flows
- [`docs/architecture/target-v1-architecture.md`](docs/architecture/target-v1-architecture.md): intended V1 technical shape
- [`docs/planning/roadmap.md`](docs/planning/roadmap.md): canonical execution roadmap
- [`docs/planning/open-questions.md`](docs/planning/open-questions.md): unresolved product and architecture decisions
