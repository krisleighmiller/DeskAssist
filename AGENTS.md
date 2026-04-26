# DeskAssist Agent Execution Contract

Use this document at the start of any implementation session for DeskAssist.

Its purpose is to prevent drift, speculative architecture, unnecessary complexity, and circular build sessions.

This document is not a brainstorming prompt.
It is an execution constraint.

---

## Product Definition

DeskAssist V1 is a **unified focus-switching workspace with scoped AI**.

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
5. DO NOT replace working casefile, context, comparison, or scope mechanics just to improve naming or symmetry.
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
- Keep comparison chat governed by the same per-directory read/write scope model as focus chat.
- Keep casefile containment enforcement in Electron main for ordinary file operations.
- Keep active context root guardrails where the current implementation uses them, such as refusing to trash the active context root.
- Treat `context` as the current implementation of a scoped focus, not the product identity.
- Treat `focus` as the product-facing work unit.
- DO NOT duplicate scope logic in the renderer.
- DO NOT bypass existing write-approval and safety boundaries.

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

## Hygiene And Dead-Code Tooling

Fast checks belong in normal development flow:

- Python: `make lint:py` (Ruff).
- TypeScript/Electron/React: `make lint:ts` (ESLint).

Dead-code scans are advisory and must run as separate commands:

- Python: `make deadcode:py` (Vulture).
- TypeScript/Electron/React: `make deadcode:ts` (Knip).

Run dead-code scans after refactors, before releases, and whenever an agent claims something is unused.

Review all findings in these buckets before changing code:

- safe to remove
- likely dead, manual check needed
- runtime-wired, leave alone for now

Agents must never delete code automatically from Ruff, ESLint, Vulture, or Knip output. Tool output is evidence to inspect, not permission to remove. An agent may only delete code after explaining the specific finding, checking runtime wiring, and receiving or already having explicit user direction for that cleanup.

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
Improving only the casefile/context analysis path in ways that make the broader focus-switching workspace vision harder to reach.

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

