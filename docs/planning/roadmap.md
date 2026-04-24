
# DeskAssist V1 Execution Milestones

## Do not add complexity. Do not skip ahead. Do not redesign the product.

## Purpose

DeskAssist V1 is **not** being built as a repo-analysis tool with miscellaneous extras. It is being built as a **unified context-switching workspace with scoped AI**. The purpose of these milestones is to make implementation follow that product direction without drifting into extra systems, speculative abstractions, or UI inventions that are not required yet.

## Global build rules

These rules apply to every milestone:

* Do not introduce new top-level concepts unless they are explicitly required by the milestone.
* Do not build integrations, plugins, automation systems, or agent orchestration.
* Do not invent new persistence systems unless a milestone explicitly requires them.
* Do not broaden scope because something “might be useful later.”
* Do not replace working casefile/lane/scope mechanics just to make naming prettier.
* Prefer the smallest implementation that satisfies the milestone exit criteria.
* If a milestone is incomplete, do not start the next one.

## Architectural guardrails

These are fixed unless explicitly changed:

* Keep the Electron main / preload / renderer / Python bridge split.
* Keep scope resolution in Python.
* Keep comparison chat governed by the same per-directory read/write scope model as lane chat.
* Keep active-lane containment enforcement in Electron main for filesystem operations.
* Treat `lane` as the current implementation of a scoped context, not the whole product identity.
* Treat `context` as the product-facing work unit.

---

## Milestone 1 — Stable Shell

### Goal

Make the current workbench reliable enough that layout problems stop dominating evaluation.

### This milestone includes

* pane resizing behaves predictably
* sensible minimum widths
* right panel remains usable while editing and chatting
* terminal can open/close without destabilizing unrelated state
* layout state persists sensibly
* obvious panel-collapse/fighting behavior is fixed

### This milestone does **not** include

* home dashboard
* artifact unification
* casefile switching system
* journal
* integrations
* redesign of product concepts

### Exit criteria

This milestone is complete only when:

* the editor does not collapse into unusability in normal use
* the third/chat column remains usable at common window sizes
* resizing does not corrupt layout state
* terminal, editor, browser, and right panel can coexist without fighting each other

This milestone corresponds to the shell reliability work already identified in the docs.

---

## Milestone 2 — Browser Is a Real Control Surface

### Goal

Make the browser the natural place to begin work, not just a tree viewer.

### This milestone includes

* create file
* create folder
* delete entry
* move entry, or a first safe relocate flow
* rename works cleanly
* open from browser into editor
* create scoped context from current selection
* compare from current selection
* attach selected material to current scoped work where already supported by existing mechanics

### This milestone does **not** include

* new storage abstractions
* cross-casefile navigation
* artifact home
* plugin hooks
* generic action framework
* major UI redesign beyond what is needed to support these actions

### Exit criteria

This milestone is complete only when:

* a user can manage normal workspace structure without leaving DeskAssist
* lane/context creation no longer feels detached from actual files
* compare can be started from the browser
* browser actions feel connected to real work rather than to setup screens

This is already the intent of the existing browser-driven workflow docs; the key is to keep it narrow and finish it fully.

---

## Milestone 2.5 — Scope Model Correction

### Goal

Fix the core scope and session model before building the visible scope features that Milestone 3 requires.

### Why this milestone exists

Milestones 1 and 2 are technically functional, but contain design assumptions that do not match the intended product:

* The `_ancestors` virtual prefix introduces a directory hierarchy the product does not need. The AI only needs to know which paths it can access — not why they are in scope or what their structural relationship to each other is.
* The two-lane comparison limit prevents the natural case of discussing any subset of N contexts together.
* Read/write access is fixed by structural role (the lane root is always writable, attachments are always read-only) rather than by user intent. The user may want the root to be read-only and an attachment writable, or vice versa, depending on the work.
* Notes, Prompts, and Inbox tabs add visual and cognitive load without providing capability beyond what the file tree already provides. Notes and prompts are files; the file tree handles files.
* The ContextEditor manifest is a heavier and more opaque version of the @mention and drag-drop context inclusion patterns users already know from other AI IDEs.

These need to be corrected before Milestone 3 can build a useful scope UI on top of them.

### This milestone includes

* Remove the `_ancestors` virtual prefix from the scope model; scope becomes a flat labeled list of directory entries, each with a path, label, and read/write permission
* Per-directory read/write permissions — each directory in a session can be independently marked read-only or read-write, independent of whether it is the lane root or an attachment
* Unified scoped session model — lane chat and N-lane comparison become one concept: a session defined by a user-declared set of directories with declared access; single-directory read-write is the common case, multi-directory replaces the two-lane comparison limit
* Stable UUID-based session identity — sessions are keyed by a persistent UUID assigned at creation, not by casefile root and lane id
* Right panel reduced to chat with conversation tabs only — Notes, Prompts, and Inbox tabs are removed
* Context inclusion via @mention and drag-drop in the chat composer, replacing the separate ContextEditor manifest UI

### This milestone does **not** include

* Cross-session reference UI (pulling a message or thread from one session into another)
* Polished current-scope summary display in chat (that is Milestone 3)
* Home or resume features
* Artifact unification
* Any new storage systems

### Exit criteria

This milestone is complete only when:

* A user can create a scoped session with any number of directories (one or N)
* Each directory in a session can independently be declared read-only or read-write
* The right panel shows only conversation tabs — one per session, named by its directory set
* The `_ancestors` prefix is gone; the AI sees only flat labeled directory roots
* Session conversation history is keyed by stable UUID, not by structural path identity
* A user can include a file in the current conversation via @mention or drag-drop from the file tree
* Notes, Prompts, and Inbox are not present as right-panel tabs

---

## Milestone 3 — Scoped AI Is Obvious

### Goal

Make DeskAssist’s main differentiator visible: the user can tell what the AI can see.

### This milestone includes

* visible current-scope summary in chat
* clear distinction between single-context chat and comparison chat
* better language around overlays, related context, and context files
* narrow / widen / switch scope controls where needed
* empty states that explain what the current scoped context is doing for the user

### This milestone does **not** include

* new scoping engine
* renderer-side duplicate scope logic
* advanced onboarding system
* generic tutorial framework

### Exit criteria

This milestone is complete only when:

* a user can answer “what can the AI see right now?” without guesswork
* a user can tell whether they are in single-context chat or comparison chat
* scope feels like a product feature, not a hidden implementation mechanic

This milestone is directly supported by the current scoped-context UX plan and the open question about how scope should appear in the UI.

---

## Milestone 4 — Cross-Context Continuity

### Goal

Prove that DeskAssist is bigger than one active casefile.

### Why this milestone exists

The current docs say DeskAssist is a context-switching workspace, but current implementation still centers on one active casefile and one active lane at a time. This milestone is the bridge between “good scoped analysis workbench” and “actual second-brain workspace.”

### This milestone includes

* switching between casefiles/projects from inside DeskAssist
* a lightweight recent-contexts or recent-work list
* ability to reopen prior active work without reconstructing state manually
* minimal user-level persistence for recent contexts
* a visible sense that multiple contexts belong to one workspace, even if they are still backed by separate casefiles

### This milestone does **not** include

* polished dashboard
* full artifact unification
* journal implementation
* external integrations
* complex multi-workspace synchronization

### Exit criteria

This milestone is complete only when:

* a user can move between casefiles/projects without treating DeskAssist like a one-root app
* recent work is visible and resumable
* DeskAssist no longer feels mentally bound to one active casefile at a time

This milestone is implied by the target shell/context model and by the user-level recent-context persistence proposed in the docs, but it is not explicit enough in the current plan. It should become explicit.

---

## Milestone 5 — Home and Resume

### Goal

Give the app a proper starting place.

### This milestone includes

* home view
* recent contexts
* pinned work
* resume last active chat/comparison/context
* quick capture entry point
* obvious jump targets into current work

### This milestone does **not** include

* major artifact system rewrite
* inbox/integration hub
* full life dashboard
* speculative recommendation engine

### Exit criteria

This milestone is complete only when opening DeskAssist answers:

* what was I doing?
* what can I resume?
* what should I do next?

This matches the existing product north star and roadmap, but comes after cross-context continuity rather than trying to carry that burden alone.

---

## Milestone 6 — First Non-Code Context

### Goal

Validate that DeskAssist can hold personal or non-repo work without becoming a giant platform.

### Recommended first implementation

* journal
* daily log
* or scratch context

### This milestone includes

* one lightweight non-code context
* ability to switch to it like other contexts
* ability to capture and reopen it
* bounded AI interaction over that context

### This milestone does **not** include

* email
* Slack
* texts
* calendar
* health tracking
* plugin system

### Exit criteria

This milestone is complete only when:

* a user can move from project work to a non-code context and back naturally
* DeskAssist proves it is broader than repo work without requiring integrations

This is already the recommended first non-code validation in the docs.

---

## Milestone 7 — Artifact Unification

### Goal

Make notes, prompts, files, chat outputs, and related material feel like parts of one workspace instead of isolated tabs.

### This milestone includes

* lightweight artifact descriptor model
* clearer distinction between owned artifacts and reference artifacts
* improved insertion of notes/prompts into workflows
* fewer isolated top-level storage silos

### This milestone does **not** include

* generic database rewrite
* full migration of all persistence to one backend
* large taxonomy work beyond what the UI actually needs

### Exit criteria

This milestone is complete only when:

* notes and prompts feel connected to work rather than like special tabs
* artifact discovery is easier
* the UI reflects artifact relationships better than storage subsystem boundaries

This follows the current docs’ recommendation to unify artifacts conceptually before technically.

---

## Milestone 8 — Extensions and Integrations

### Goal

Create boundaries for future integrations without letting them define V1.

### This milestone includes

* extension boundaries
* registration/configuration model
* permissions model
* optional background service boundaries

### This milestone does **not** include

* building all the integrations
* reworking the core shell around extension needs
* productizing a plugin marketplace

### Exit criteria

This milestone is complete only when future integrations can be added without reshaping the core shell/context/scope model.


---

# The sequence, in one line

Build in this order:

**stable shell → browser-driven work → scope model correction → obvious scope → cross-context continuity → home/resume → first non-code context → artifact unification → extension boundaries**

