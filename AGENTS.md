# DeskAssist Agent Execution Contract

Use this document at the start of any implementation session for DeskAssist.

Its purpose is to prevent drift, speculative architecture, unnecessary complexity, and circular build sessions.

This document is not a brainstorming prompt.
It is an execution constraint.

---

## Product Definition

DeskAssist V1 is a **unified context-switching workspace with scoped AI**.

It is not being built as:
- a repo-analysis tool with miscellaneous extras
- a generic AI desktop assistant
- a plugin platform
- a personal operating system in V1

The product should help a user:
- switch between active work without losing the thread
- control exactly what the AI can see
- compare related work in one place
- capture thoughts without leaving the workspace

All implementation work must reinforce that direction.

---

## CORE RULE

DO NOT add complexity unless the current milestone explicitly requires it.

If something might be useful later but is not required now, do not build it.

If a requested change crosses milestone boundaries, stop and say so.

DO NOT improvise a larger system.

---

## GLOBAL CONSTRAINTS

These rules apply to every DeskAssist build session:

1. DO NOT introduce new top-level product concepts unless they are explicitly required by the current milestone.
2. DO NOT build future milestones early.
3. DO NOT add integrations, plugins, automation systems, orchestration, or assistant behavior unless the milestone explicitly calls for them.
4. DO NOT invent a new persistence model unless the current milestone cannot be satisfied without it.
5. DO NOT replace working casefile, lane, comparison, or scope mechanics just to improve naming or symmetry.
6. Prefer the smallest implementation that satisfies the milestone exit criteria.
7. Preserve existing runtime boundaries unless a milestone explicitly requires a change.
8. DO NOT broaden a task because it feels architecturally cleaner.
9. DO NOT convert a local UX problem into a framework project.
10. DO NOT create speculative abstractions for future flexibility.

---

## Architectural Guardrails

These are fixed unless explicitly changed:

- Keep the Electron main / preload / renderer / Python bridge split.
- Keep scope resolution in Python.
- Keep comparison chat governed by the same per-directory read/write scope model as lane chat.
- Keep active-lane containment enforcement in Electron main for file operations.
- Treat `lane` as the current implementation of a scoped context, not the product identity.
- Treat `context` as the product-facing work unit.
- DO NOT duplicate scope logic in the renderer.
- DO NOT bypass existing write-approval and safety boundaries.

---

## Milestone Order

Build in this order. DO NOT skip ahead.

### Milestone 1 — Stable Shell
Goal: make the workbench layout reliable.

Includes:
- predictable resizing
- sensible panel minimums
- usable right panel
- terminal/editor/browser coexistence
- layout persistence

Does not include:
- home dashboard
- cross-casefile switching
- journal
- integrations
- artifact unification

### Milestone 2 — Browser Is a Real Control Surface
Goal: make the browser the normal place to begin work.

Includes:
- create file
- create folder
- delete entry
- move or safe relocate flow
- rename works cleanly
- open from browser into editor
- create scoped context from selection
- compare from selection

Does not include:
- new storage systems
- plugin hooks
- generic action framework
- cross-casefile navigation

### Milestone 2.5 — Scope Model Correction
Goal: fix the core scope and session model before building visible scope features on top of it.

Includes:
- remove `_ancestors` virtual prefix; scope becomes a flat labeled list of directories with per-entry permissions
- per-directory read/write permissions (not fixed by structural role)
- unified scoped session model: lane chat and N-lane comparison become one concept
- stable UUID-based session identity
- right panel reduced to chat with conversation tabs only (Notes, Prompts, Inbox removed)
- context inclusion via @mention and drag-drop, replacing the ContextEditor manifest UI

Does not include:
- cross-session reference UI
- polished scope summary display in chat (that is Milestone 3)
- home or resume features
- artifact unification

### Milestone 3 — Scoped AI Is Obvious
Goal: make scope visible and understandable.

Includes:
- current-scope summary in chat (built on the corrected M2.5 model)
- clear session framing (single-directory vs multi-directory)
- better scope language
- narrow / widen / switch scope controls where needed
- empty states that explain scope behavior

Does not include:
- new scope engine
- renderer-side scope duplication
- large onboarding framework

### Milestone 4 — Cross-Context Continuity
Goal: prove DeskAssist is bigger than one active casefile.

Includes:
- switch between casefiles/projects inside DeskAssist
- recent work or recent contexts list
- reopen prior active work
- lightweight user-level persistence for recents

Does not include:
- polished dashboard
- journal
- integrations
- full artifact unification

### Milestone 5 — Home and Resume
Goal: give the app a real starting place.

Includes:
- home view
- recent contexts
- pinned work
- resume last active work
- quick capture entry point

Does not include:
- full life dashboard
- recommendation engine
- integration hub

### Milestone 6 — First Non-Code Context
Goal: validate that DeskAssist supports non-repo work.

Recommended first target:
- journal
- daily log
- scratch context

Does not include:
- email
- Slack
- SMS
- calendar
- health tracking

### Milestone 7 — Artifact Unification
Goal: make notes, prompts, files, chat outputs, and related material feel connected.

Includes:
- lightweight artifact descriptor model
- better discovery
- better insertion into workflows
- fewer isolated storage-shaped tabs

Does not include:
- database rewrite
- total persistence redesign
- unnecessary taxonomy work

### Milestone 8 — Extensions and Integrations
Goal: add clean boundaries for future integrations.

Includes:
- extension boundary
- registration/configuration model
- permissions model

Does not include:
- building all the integrations
- reshaping the core product around extension needs

---

## Required Response Format Before Coding

Before writing code, respond using this exact structure:

### 1. Current milestone
State the milestone number and name.

### 2. Requested task
Restate the requested task in one or two sentences.

### 3. In scope
List only the things that will be changed in this session.

### 4. Out of scope
List the things that will explicitly not be changed.

### 5. Exit criteria
List the exact conditions that will make this session complete.

### 6. Minimal implementation plan
Describe the smallest implementation that satisfies the exit criteria.

### 7. Complexity check
State any new complexity being introduced. If none, say: “No new system-level complexity introduced.”

### 8. Drift check
Answer this directly: “How does this avoid pulling DeskAssist toward repo-analysis-only behavior?”

If you cannot answer those clearly, stop and revise the plan before coding.

---

## Required Behavior During Implementation

While implementing:

- Make only the changes required for the current task.
- DO NOT silently add refactors unrelated to the task.
- DO NOT expand the UI beyond what the task needs.
- DO NOT add generic frameworks or manager classes unless the task genuinely requires them.
- DO NOT rename core product concepts unless explicitly asked.
- If you discover a larger problem, note it separately instead of solving it immediately.

If an implementation choice would create a new subsystem, stop and ask whether that subsystem is actually required by the milestone.

---

## Required Response Format After Coding

After implementation, respond using this exact structure:

### 1. What changed
List the concrete changes made.

### 2. What did not change
List the important things intentionally left alone.

### 3. Exit criteria status
For each exit criterion, state whether it is satisfied.

### 4. New complexity introduced
List any new complexity introduced. If none, say so.

### 5. Follow-up risks
List only real risks or incomplete areas directly related to the implemented task.

### 6. Milestone status
State whether this session:
- fully completes the task,
- partially completes the task,
- or exposed a milestone boundary issue.

---

## Stop Conditions

Stop and ask for confirmation instead of continuing if any of these are true:

- the request crosses into a later milestone
- the task requires a new persistence model
- the task requires a new top-level navigation concept
- the task requires changing runtime boundaries
- the task cannot be completed without redesigning an existing subsystem
- the request conflicts with the current milestone order

DO NOT keep building when a stop condition is triggered.

---

## Anti-Patterns To Avoid

Avoid these recurring failure modes:

### 1. Framework creep
Turning a local feature into a generic framework.

### 2. Storage-driven UX
Exposing implementation/storage concepts as primary product surfaces.

### 3. Premature platforming
Adding integrations, plugin ideas, or automation hooks before the core loops are finished.

### 4. Scope drift by cleanup
Using “cleanup” or “refactor” as an excuse to redesign unrelated behavior.

### 5. Solving future problems now
Adding flexibility for imagined future use cases that are not in the current milestone.

### 6. Repo-analysis gravity
Improving only the casefile/lane analysis path in ways that make the broader context-switching workspace vision harder to reach.

---

## Session Prompt Template

Copy and paste this at the start of a DeskAssist implementation session:

> Follow the DeskAssist Agent Execution Contract exactly.
>
> Current task: [replace with task]
>
> Current milestone: [replace with milestone number and name]
>
> DO NOT introduce new concepts, abstractions, tabs, systems, or persistence unless they are required by this milestone.
> DO NOT solve future milestones early.
> Prefer the smallest implementation that satisfies the task.
>
> Before coding, respond with:
> 1. current milestone
> 2. requested task
> 3. in scope
> 4. out of scope
> 5. exit criteria
> 6. minimal implementation plan
> 7. complexity check
> 8. drift check
>
> After coding, respond with:
> 1. what changed
> 2. what did not change
> 3. exit criteria status
> 4. new complexity introduced
> 5. follow-up risks
> 6. milestone status

---

## Review Filter For Approving Agent Plans

Before approving a plan, verify these questions are answered clearly:

1. Which milestone is this for?
2. Which exit criteria does it satisfy?
3. What is explicitly not being changed?
4. What new complexity is being introduced, and why is it necessary now?
5. How does this avoid narrowing DeskAssist into a repo-analysis-only tool?

If those answers are vague, do not approve the plan yet.

---

## Final Reminder

DeskAssist should be built as a workspace for continuous, messy, multi-mode work.

The agent's job is not to invent a bigger system.
The agent's job is to complete the current milestone with the least added complexity possible.

When in doubt:
- choose the smaller implementation
- choose the more reversible change
- choose the option that protects context switching over subsystem sprawl
- stop instead of improvising

