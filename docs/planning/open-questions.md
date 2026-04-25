# Open Questions

These are the product and architecture decisions most likely to change implementation direction.

Each question includes:

- why it matters
- a provisional default
- when the team should force a decision

The provisional defaults are important. They let the codebase move forward without pretending the questions are already settled.

## 1. Should `lane` remain user-facing?

Why it matters:

- `lane` is the current durable implementation unit for scoped work
- it appears prominently in the UI and codebase
- it is not obviously the right long-term product noun for a mixed-mode workspace

Provisional default:

- keep `lane` as the implementation term
- use `context` as the primary product-facing term
- treat a lane as the current implementation of a scoped context

When to decide:

- before redesigning the home or resume experience
- before rewriting major onboarding or first-run UX

Impact areas:

- [`ui-electron/renderer/src/components/FileTree.tsx`](../../ui-electron/renderer/src/components/FileTree.tsx)
- right-panel information architecture
- user-facing copy across the workbench

## 2. What exactly is a context in V1?

Why it matters:

- the README centers the product on context switching
- the current system has multiple context-like units:
  - active lane
  - comparison session
  - notes area
  - future journal or capture area

Provisional default:

- define `context` as the user-facing work unit
- allow multiple context implementations in V1
- treat lanes as only one kind of context implementation

When to decide:

- before building the home dashboard
- before adding recent-context or pinned-context surfaces

Impact areas:

- workspace home design
- session persistence
- navigation and resume behavior

## 3. How should artifacts be unified?

Why it matters:

- files, chat transcripts, and chat outputs are all durable work objects
- prior notes/prompts/inbox tabs were removed, but their product needs may return through a unified artifact model
- artifact sprawl will keep increasing if the project adds more types without a shared model

Provisional default:

- do not unify persistence yet
- do unify vocabulary and minimum shared metadata
- introduce a lightweight artifact descriptor before introducing a generic artifact database or registry

When to decide:

- before building a workspace home with recent artifacts
- before adding another durable artifact type

Impact areas:

- notes and prompts UX
- browser and home surfaces
- insertion and discoverability flows

## 4. How should the app represent current AI scope in the UI?

Why it matters:

- scope is the product differentiator
- the current implementation is strong, but the user-facing explanation is weak

Updated default (resolved in M2.5 planning):

- remove the separate ContextEditor manifest tab
- context inclusion in chat happens via @mention and drag-drop from the file tree, matching the interaction pattern users already know from other AI IDEs
- the file tree provides a structural color cue (which directories are in the active session's scope)
- a current-scope summary in the chat header becomes the M3 deliverable, built on top of the corrected M2.5 scope model

When to act:

- M2.5 removes the ContextEditor UI and adds @mention/drag-drop
- M3 adds the visible scope summary in the chat panel

Impact areas:

- [`ui-electron/renderer/src/components/ChatTab.tsx`](../../ui-electron/renderer/src/components/ChatTab.tsx)
- [`ui-electron/renderer/src/components/RightPanel.tsx`](../../ui-electron/renderer/src/components/RightPanel.tsx)
- scope serialization surfaces

## 5. Where should browser-driven file operations live?

Why it matters:

- the next phase requires create, delete, and move operations
- the system already splits responsibility between renderer, Electron main, and Python

**Settled (M2 complete):**

- browser file operations (create, delete, move, rename) live in Electron main
- Python remains responsible for casefile and scope logic
- this boundary held cleanly through M2 implementation

Impact areas:

- [`ui-electron/main.js`](../../ui-electron/main.js)
- [`ui-electron/preload.js`](../../ui-electron/preload.js)

## 6. How should home and resume state be persisted?

Why it matters:

- a home view will need recent contexts, pinned work, and resume targets
- some of that state is shell-level, some is casefile-level, and some may be user-level

Provisional default:

- keep layout and UI preferences user-level
- keep lane and prompt durability casefile-level
- introduce a user-level recent-context index that references casefiles and context ids rather than embedding full state

When to decide:

- before implementing the home dashboard

Impact areas:

- renderer shell state
- settings persistence
- any future "resume last active work" flow

## 7. What is the minimum useful non-code context?

Why it matters:

- the product vision is broader than repo work
- adding a non-code context too early could distract from the core
- adding it too late makes the broader vision remain theoretical

Provisional default:

- validate with a journal, daily log, or scratch context
- avoid integrations for this step
- keep it compatible with the same scope and artifact ideas used for project work

When to decide:

- after home and artifact work are strong enough to support it cleanly

Impact areas:

- capture UX
- artifact model
- scope boundaries for non-code material

## 8. Where should extension boundaries begin?

Why it matters:

- future integrations could easily dominate the roadmap
- without boundaries, every new integration risks coupling itself to the shell and core workflow logic

Provisional default:

- start with explicit extension contracts only after shell, context, and artifact boundaries are clearer
- treat inbox-like external sources as early examples, not the final plugin model

When to decide:

- before the first serious external integration beyond current provider support

Impact areas:

- main-process service boundaries
- settings and permissions
- background processing model

## 9. How should the unified scoped session be modeled at the data layer?

Why it matters:

- M2.5 collapses lane chat and N-lane comparison into one concept: a session defined by a user-declared set of directories with per-directory access permissions
- the current data model has two separate shapes (`ScopeContext` for lane chat, a separate comparison model for two-lane comparison) that need to converge into one

Provisional default:

- replace `ScopeContext.write_root` + `read_overlays` with a flat list of `ScopedDirectory(path, label, writable: bool)` entries
- the Python scope engine (`scope.py`) becomes the single resolver for both the single-directory and multi-directory cases
- session history continues to be keyed per-session, but using a stable UUID assigned at session creation rather than derived from casefile root and lane id

When to decide:

- before starting M2.5 implementation

Impact areas:

- [`src/assistant_app/casefile/scope.py`](../../src/assistant_app/casefile/scope.py)
- [`src/assistant_app/casefile/models.py`](../../src/assistant_app/casefile/models.py)
- [`src/assistant_app/casefile/service.py`](../../src/assistant_app/casefile/service.py)
- [`src/assistant_app/chat_service.py`](../../src/assistant_app/chat_service.py)
- session key logic in [`ui-electron/renderer/src/hooks/appModelTypes.ts`](../../ui-electron/renderer/src/hooks/appModelTypes.ts)

## 10. What replaces the `_ancestors` virtual prefix in the scope model?

Why it matters:

- `_ancestors` was modeling a lane parent hierarchy that the product does not actually need
- the AI only needs to know which paths it can access, not the organizational reason they are in scope
- the current naming leaks an implementation concept into the model/tool contract

Provisional default:

- drop `_ancestors` entirely as a virtual prefix
- all directories in a session are presented to the AI as flat labeled roots (e.g. `_scope/ash/`, `_scope/ash_notes/`) or under their natural names
- the system prompt tells the model which roots are readable and which are writable rather than encoding that in path structure

When to decide:

- before starting M2.5 implementation; the virtual path scheme is part of the tool contract and changes must be coordinated between `scope.py`, the system prompt, and the tool registry

Impact areas:

- [`src/assistant_app/casefile/scope.py`](../../src/assistant_app/casefile/scope.py)
- [`src/assistant_app/prompts/charter.md`](../../src/assistant_app/prompts/charter.md)
- [`src/assistant_app/tools/file_tools.py`](../../src/assistant_app/tools/file_tools.py)

## Summary Defaults

Until the team chooses otherwise, the working defaults should be:

- `context` is the primary product term
- `lane` remains the current implementation term
- `scope` stays central and should become more visible
- browser file operations stay in Electron main (settled, M2 complete)
- Notes, Prompts, and Inbox are not right-panel tabs; they are files accessible through the file tree
- context inclusion in chat is via @mention and drag-drop, not a separate manifest UI
- `_ancestors` prefix is being removed; scope is a flat labeled directory list with per-entry R/W permissions
- sessions use stable UUIDs, not path-derived keys
- home and recents should use a user-level index over casefile-backed data
- the first non-code context should be lightweight and local
- extensions should remain deferred until core boundaries are stronger

These defaults keep the project moving in the direction of the README without forcing premature architectural commitments.
