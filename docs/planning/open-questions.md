# Open Questions

These are the live product and architecture decisions from the current DeskAssist baseline. Resolved terminology and historical milestone questions are intentionally excluded. If a question does not affect what should happen next, it does not belong here.

## 1. How should current AI scope be explained in the UI?

Why it matters:

- scope is DeskAssist's strongest differentiator
- the implementation is solid, but the explanation can still feel technical
- unclear scope language undermines trust in AI behavior

Current implementation:

- scope is a flat list of `ScopedDirectory(path, label, writable)` entries
- focus chat and comparison chat use the same resolved scope shape
- the chat header shows scoped directories with RW/RO state and management actions
- scoped directories are addressable as `_scope/<label>/...`
- bare relative paths resolve inside the primary writable scoped directory when one exists

Current default:

- keep the current flat scoped-directory model
- keep RW/RO language for now
- improve copy and empty states before changing mechanics

Decision needed:

- what words should the app use for scoped directories, related directories, readable scope, and writable scope?

Force the decision before:

- adding more scope controls
- adding cross-session chat references
- adding the first standalone non-code focus

Impact areas:

- [`ui-electron/renderer/src/components/ChatTab.tsx`](../../ui-electron/renderer/src/components/ChatTab.tsx)
- [`ui-electron/renderer/src/components/FileTree.tsx`](../../ui-electron/renderer/src/components/FileTree.tsx)
- [`src/assistant_app/casefile/scope.py`](../../src/assistant_app/casefile/scope.py)

## 2. What is the smallest useful cross-session chat reference?

Why it matters:

- focus and comparison chats are persisted, but isolated
- users need to bring one discussion into another without copying text manually
- doing this badly could become automatic memory or a generic artifact system too early

Current default:

- references should be explicit user actions
- referenced discussions should be readable reference material, not merged history
- the UI should show provenance
- the original discussion should remain unchanged

Decision needed:

- should the first version reference an entire chat, a selected message range, or a generated summary?

Force the decision before:

- building cross-session reference access
- making chat discussions first-class resume targets

## 3. Where should recent work live?

Why it matters:

- home currently uses renderer `localStorage`
- that is enough for a lightweight home view, but weak for a durable workspace product
- richer resume needs a user-level index of recent focuses, files, chats, and comparisons

Current implementation:

- home view exists
- recent and pinned work records are stored in renderer `localStorage`
- each recent entry references a casefile root plus the last active context id/name
- quick capture opens or creates a file inside the active workspace

Current default:

- keep casefile metadata inside `.casefile/`
- add a small user-level recent-work index only when home/resume needs it
- do not move all persistence into a single database

Decision needed:

- what is the smallest durable user-level store for recent work?

Force the decision before:

- expanding home into a richer resume surface
- adding recent chats or comparison sessions to home

## 4. What workbench state should resume restore?

Why it matters:

- reopening a focus is useful but not enough to feel like true resume
- restoring too much state can be brittle
- restoring too little keeps home shallow

Current default:

- restore casefile root and active context today
- next restore active chat/comparison and recent files before attempting full layout/session restoration

Decision needed:

- which state is essential for "I am back where I left off"?

Force the decision before:

- rewriting home
- adding a durable recent-work index

## 5. What is the first standalone non-code focus?

Why it matters:

- DeskAssist must prove it is broader than project/repo work
- quick capture is useful but still tied to an active workspace
- the first non-code focus should validate the product without creating a platform

Current default:

- choose one local, file-backed focus type
- likely candidates: journal, daily log, or scratch focus
- reuse existing file/editor/scope mechanics where possible

Decision needed:

- which non-code focus best validates the product with the least new machinery?

Force the decision before:

- adding capture outside an active workspace
- building integration or inbox behavior

## 6. Should focus chat and comparison chat converge further?

Why it matters:

- the backend now resolves both into the same scoped-directory shape
- the renderer and bridge still have separate command paths and UI flows

Current implementation:

- `ScopeContext` carries a flat list of scoped directories
- comparison metadata lives in `.casefile/comparisons.json`
- both context and comparison chats persist through stable UUID-backed chat logs

Decision needed:

- keep separate UI/API flows because they are understandable, or introduce one broader scoped-session abstraction?

Force the decision before:

- deeper work on cross-focus navigation or session discovery

## 7. When should extension boundaries be defined?

Why it matters:

- integrations can quickly pull the product toward platform complexity
- boundaries are useful before integrations, but premature boundary work can become framework creep

Current default:

- defer extension boundary work until scope clarity, cross-session references, home/resume, and the first non-code focus are stronger
- model providers are not product extensions

Decision needed:

- what minimal contract is needed before the first external integration?

Force the decision before:

- email, Slack, calendar, reminders, or plugin work

## Summary Defaults

Until changed:

- `focus` is the product-facing term for the active or resumable work unit.
- `context` remains the implementation term for the current scoped work record.
- scope stays flat, Python-resolved, and per-directory RW/RO.
- cross-session chat reference should be explicit and provenance-preserving.
- home/resume should graduate from renderer-local recents only when richer resume requires it.
- the first non-code focus should be local and file-backed.
- integrations stay deferred until core workspace/focus/scope loops are stronger.
