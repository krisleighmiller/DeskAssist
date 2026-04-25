# Open Questions

These are the live decisions from the current DeskAssist baseline.

Resolved terminology and historical milestone questions are intentionally excluded. If a question does not affect what should happen next, it does not belong here.

## 1. How should scope be explained to users?

Why it matters:

- scope is DeskAssist's strongest differentiator
- the implementation is solid, but the explanation can still feel technical
- unclear scope language undermines trust in AI behavior

Current default:

- keep the current flat scoped-directory model
- keep RW/RO language for now
- improve copy and empty states before changing mechanics

Decision needed:

- what words should the app use for scoped directories, attachments, readable context, and writable context?

Force the decision before:

- adding more scope controls
- adding cross-session chat references
- adding the first standalone non-code context

## 2. What is the smallest useful cross-session chat reference?

Why it matters:

- context and comparison chats are persisted, but isolated
- users need to bring one discussion into another without copying text manually
- doing this badly could become automatic memory or a generic artifact system too early

Current default:

- references should be explicit user actions
- referenced discussions should be readable context, not merged history
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
- richer resume needs a user-level index of recent contexts, files, chats, and comparisons

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

- reopening a context is useful but not enough to feel like true resume
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

## 5. What is the first standalone non-code context?

Why it matters:

- DeskAssist must prove it is broader than project/repo work
- quick capture is useful but still tied to an active workspace
- the first non-code context should validate the product without creating a platform

Current default:

- choose one local, file-backed context type
- likely candidates: journal, daily log, or scratch context
- reuse existing file/editor/scope mechanics where possible

Decision needed:

- which non-code context best validates the product with the least new machinery?

Force the decision before:

- adding capture outside an active workspace
- building integration or inbox behavior

## 6. When should extension boundaries be defined?

Why it matters:

- integrations can quickly pull the product toward platform complexity
- boundaries are useful before integrations, but premature boundary work can become framework creep

Current default:

- defer extension boundary work until scope clarity, cross-session references, home/resume, and the first non-code context are stronger
- model providers are not product extensions

Decision needed:

- what minimal contract is needed before the first external integration?

Force the decision before:

- email, Slack, calendar, reminders, or plugin work

## Summary Defaults

Until changed:

- `context` is the product and implementation term for scoped work units.
- scope stays flat, Python-resolved, and per-directory RW/RO.
- cross-session chat reference should be explicit and provenance-preserving.
- home/resume should graduate from renderer-local recents only when richer resume requires it.
- the first non-code context should be local and file-backed.
- integrations stay deferred until core workspace/context/scope loops are stronger.
# Open Questions

These are the product and architecture decisions most likely to change implementation direction. Resolved terminology and removed-surface questions have been dropped so this file only tracks live decisions.

## 1. How should current AI scope be explained in the UI?

Why it matters:

- scope is the product differentiator
- the implementation is strong, but the user-facing explanation still needs polish

Current implementation:

- scope is a flat list of `ScopedDirectory(path, label, writable)` entries
- context and comparison chat use the same resolved scope shape
- the chat header shows scoped directories with RW/RO state and management actions

Remaining decision:

- decide the clearest labels, empty states, and warnings for users who do not know the storage model

Impact areas:

- [`ui-electron/renderer/src/components/ChatTab.tsx`](../../ui-electron/renderer/src/components/ChatTab.tsx)
- [`ui-electron/renderer/src/components/FileTree.tsx`](../../ui-electron/renderer/src/components/FileTree.tsx)
- [`src/assistant_app/casefile/scope.py`](../../src/assistant_app/casefile/scope.py)

## 2. How should home and resume state be persisted?

Why it matters:

- a home view needs recent contexts, pinned work, and resume targets
- current recents are useful but renderer-local

Current implementation:

- home view exists
- recent and pinned contexts are stored in renderer `localStorage`
- each recent entry references a casefile root plus the last active context id/name
- quick capture opens or creates a file inside the active workspace

Remaining decision:

- keep the localStorage implementation, or graduate to a durable user-level recent-context index

When to decide:

- before expanding home into richer resume or recent work discovery

## 3. What is the minimum useful non-code context?

Why it matters:

- the product vision is broader than repo work
- quick capture is not a standalone context
- adding too much too early would distract from the core

Provisional default:

- validate with one lightweight local context: journal, daily log, or scratch
- avoid external integrations for this step
- reuse the same scope and file mechanics as project contexts

When to decide:

- after home/resume is strong enough to make the new context discoverable and resumable

## 4. Should context chat and comparison chat converge further?

Why it matters:

- the backend now resolves both into the same scoped-directory shape
- the renderer and bridge still have separate command paths and UI flows

Current implementation:

- `ScopeContext` carries a flat list of scoped directories
- comparison metadata lives in `.casefile/comparisons.json`
- both context and comparison chats persist through stable UUID-backed chat logs

Remaining decision:

- keep separate UI/API flows because they are understandable, or introduce one broader scoped-session abstraction

When to decide:

- before deeper work on cross-context navigation or session discovery

## 5. Where should extension boundaries begin?

Why it matters:

- integrations could easily dominate the roadmap
- without boundaries, every integration risks coupling itself to shell and scope logic

Provisional default:

- define contracts only after core shell, context, scope, and resume behavior are stronger
- keep provider integrations separate from product extensions

When to decide:

- before the first serious external integration beyond current model providers

## Summary Defaults

Until the team chooses otherwise:

- `context` is the only product and implementation term for scoped work units
- browser file operations stay in Electron main
- scope remains a flat labeled directory list with per-entry RW/RO permissions
- sessions use stable UUIDs, not path-derived keys
- home and recents use renderer `localStorage` for now
- quick capture remains a file workflow inside an active workspace until Milestone 6 adds a standalone non-code context
- extensions remain deferred until core boundaries are stronger
