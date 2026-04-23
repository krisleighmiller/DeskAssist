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

- [`ui-electron/renderer/src/components/LanesTab.tsx`](../../ui-electron/renderer/src/components/LanesTab.tsx)
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

- files, notes, prompts, inbox items, and chat outputs are all durable work objects
- the current UI presents them through separate tabs and stores
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

Provisional default:

- always show a current-scope summary in chat
- distinguish clearly between:
  - write root
  - read-only related context
  - comparison scope
  - casefile-wide context files

When to decide:

- during the scoped-context UX phase, not after it

Impact areas:

- [`ui-electron/renderer/src/components/ChatTab.tsx`](../../ui-electron/renderer/src/components/ChatTab.tsx)
- [`ui-electron/renderer/src/components/LanesTab.tsx`](../../ui-electron/renderer/src/components/LanesTab.tsx)
- scope serialization surfaces

## 5. Where should browser-driven file operations live?

Why it matters:

- the next phase requires create, delete, and move operations
- the system already splits responsibility between renderer, Electron main, and Python

Provisional default:

- keep active-lane filesystem operations in Electron main
- keep Python responsible for casefile and scope logic
- only move file operations into Python if they need casefile-aware semantics that Electron main cannot enforce cleanly

Why this default:

- Electron main already owns active-lane containment and low-level file IO
- keeping those operations there avoids unnecessary round-trips and duplicated boundary logic

When to decide:

- before implementing browser create, delete, and move

Impact areas:

- [`ui-electron/main.js`](../../ui-electron/main.js)
- [`ui-electron/preload.js`](../../ui-electron/preload.js)
- browser context menu and file tree logic

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

## Summary Defaults

Until the team chooses otherwise, the working defaults should be:

- `context` is the primary product term
- `lane` remains the current implementation term
- `scope` stays central and should become more visible
- artifacts should be unified conceptually before they are unified technically
- browser file operations stay in Electron main
- home and recents should use a user-level index over casefile-backed data
- the first non-code context should be lightweight and local
- extensions should remain deferred until core boundaries are stronger

These defaults keep the project moving in the direction of the README without forcing premature architectural commitments.
