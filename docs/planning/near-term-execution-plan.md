# Near-Term Execution Plan

This plan focuses on the next three implementation phases:

1. shell reliability
2. browser-driven workflow
3. scoped-context UX

These phases are the shortest path to making DeskAssist feel like the product described in [`../../README.md`](../../README.md), without prematurely expanding into integrations or broader assistant behavior.

## Near-Term Objective

By the end of this phase set, DeskAssist should feel like:

- a stable daily workbench
- a place where browsing, editing, chatting, and comparing are part of one flow
- a product where scoped AI is obvious, intentional, and controllable

## Cross-Cutting Constraints

These constraints should shape implementation across all three milestones:

- keep the current Electron main, preload, and Python bridge split
- keep scope resolution in Python, not in the renderer
- avoid large rewrites of casefile storage unless they unlock a specific milestone
- reduce state concentration in [`ui-electron/renderer/src/App.tsx`](../../ui-electron/renderer/src/App.tsx) as work proceeds
- prefer browser- and context-driven entry points over new tab silos

## Milestone 1: Reliable Daily Shell

Outcome:

The shell becomes stable enough that users can evaluate the product idea without fighting the layout.

Primary code areas:

- [`ui-electron/renderer/src/App.tsx`](../../ui-electron/renderer/src/App.tsx)
- [`ui-electron/renderer/src/components/Splitter.tsx`](../../ui-electron/renderer/src/components/Splitter.tsx)
- [`ui-electron/renderer/src/components/RightPanel.tsx`](../../ui-electron/renderer/src/components/RightPanel.tsx)
- [`ui-electron/renderer/src/components/EditorPane.tsx`](../../ui-electron/renderer/src/components/EditorPane.tsx)
- [`ui-electron/renderer/src/components/TerminalsPanel.tsx`](../../ui-electron/renderer/src/components/TerminalsPanel.tsx)
- [`ui-electron/renderer/src/styles.css`](../../ui-electron/renderer/src/styles.css)

Implementation priorities:

- tighten pane sizing constraints and persistence behavior
- improve small-window and narrow-right-panel behavior
- reduce accidental panel state loss
- keep the integrated terminal usable without destabilizing the workbench
- identify renderer state that should move into dedicated hooks or stores

Suggested refactor seams:

- shell layout state
- terminal session state
- per-lane session state
- right-panel selection state

Success criteria:

- pane resizing feels predictable
- the editor never collapses into unusability under normal window sizes
- the right panel remains usable while chatting and editing
- the terminal can be opened and closed without side effects on unrelated workflow state

## Milestone 2: Browser-Driven Workflow Complete

Outcome:

The browser becomes the main entry point for acting on work, not just viewing it.

Primary code areas:

- [`ui-electron/renderer/src/components/FileTree.tsx`](../../ui-electron/renderer/src/components/FileTree.tsx)
- [`ui-electron/renderer/src/App.tsx`](../../ui-electron/renderer/src/App.tsx)
- [`ui-electron/main.js`](../../ui-electron/main.js)
- [`ui-electron/preload.js`](../../ui-electron/preload.js)

Implementation priorities:

- add missing file operations such as create, delete, and move
- improve browser context actions so selection drives useful workflows
- let users create contexts from selected artifacts
- make compare and context actions launchable from browser selections

Specific deliverables:

- create file
- create folder
- delete entry
- move entry or at least a first safe rename-plus-relocate path
- lane creation from current selection
- attach selected artifact to current context
- compare from browser selection

Architectural constraints:

- keep active-lane containment checks in Electron main
- keep cross-lane and overlay reads explicit
- do not let browser convenience actions bypass existing path validation

Success criteria:

- basic workspace management can happen inside DeskAssist
- the browser is the natural place to begin scope and compare workflows
- lane creation feels connected to actual artifacts instead of only to an abstract form

## Milestone 3: Scoped Context UX Becomes Obvious

Outcome:

The user can tell what the AI can currently see and change that scope intentionally.

Primary code areas:

- [`ui-electron/renderer/src/components/ChatTab.tsx`](../../ui-electron/renderer/src/components/ChatTab.tsx)
- [`ui-electron/renderer/src/components/LanesTab.tsx`](../../ui-electron/renderer/src/components/LanesTab.tsx)
- [`ui-electron/renderer/src/components/ContextEditor.tsx`](../../ui-electron/renderer/src/components/ContextEditor.tsx)
- [`ui-electron/renderer/src/App.tsx`](../../ui-electron/renderer/src/App.tsx)
- [`src/assistant_app/casefile/scope.py`](../../src/assistant_app/casefile/scope.py)
- [`src/assistant_app/electron_bridge.py`](../../src/assistant_app/electron_bridge.py)

Implementation priorities:

- visible current-scope summary in the chat area
- better comparison-state visibility
- clearer user explanation of lanes, overlays, and context files
- easier narrow, widen, and switch-scope controls

Specific deliverables:

- current-scope display in chat
- clearer distinction between lane chat and comparison chat
- improved copy for context files, overlays, and compare
- empty states that explain what a lane is doing for the user
- better scope-changing entry points from current work, not only from setup UI

Architectural constraints:

- the UI may summarize scope, but Python remains the source of truth for resolved scope
- avoid creating a second scope model in renderer-only state
- preserve read-only guarantees in comparison sessions

Success criteria:

- a user can answer "what can the AI see right now?" without guesswork
- users can intentionally choose between single-context and multi-context chat
- scope becomes a visible product feature instead of an internal mechanic

## Suggested Sequence Inside The Near-Term Plan

1. Finish shell stability work that removes layout friction.
2. Add browser operations that unblock normal workspace management.
3. Connect browser actions directly into context and compare workflows.
4. Add current-scope visibility and clearer chat framing.
5. Polish copy, empty states, and narrow or widen controls.

## Codebase Health Work To Do Along The Way

This plan is documentation-first, but it implies some hygiene work during implementation:

- extract focused renderer hooks or stores as features are touched
- keep IPC commands coherent and documented through `assistantApi`
- update architecture docs whenever runtime boundaries or terms materially change

## What This Plan Does Not Include Yet

This near-term plan intentionally defers:

- a full home dashboard
- broad artifact unification
- journal or life-log contexts
- extension or plugin infrastructure
- broader automation or multi-agent features

Those areas matter, but they will land better once the workbench, browser flow, and scope UX are strong.

## Near-Term Summary

The next implementation phase should make DeskAssist feel solid, browsable, and intentionally scoped.

That is the smallest set of work that can turn the current codebase from a promising scoped-work system into a convincing V1 product foundation.
