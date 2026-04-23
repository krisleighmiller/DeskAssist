# DeskAssist Product Roadmap

## Vision

DeskAssist is a unified workspace for people whose thinking is fragmented across code, notes, research, communications, experiments, and everyday life.

It is a second-brain workbench for messy real-world work: a place where a user can move between projects and personal context without changing apps or losing their train of thought.

DeskAssist is **not** just a repo chat tool, not just a note-taking app, and not just an assistant sidebar. Its long-term purpose is to become an always-open workspace where a power user can:

- switch quickly between active contexts
- keep related artifacts together without forcing them into one rigid structure
- control exactly what AI can see and compare
- capture notes and thoughts without breaking flow
- eventually connect outside systems such as email, messaging, task streams, and life logs

## Product Thesis

Current tools are optimized for one mode at a time:

- IDEs optimize for code
- chat apps optimize for conversation
- knowledge tools optimize for notes
- personal assistants optimize for lightweight reminders and automation

But real work is mixed-mode. A user may need to:

- review a codebase
- compare two agent attempts
- jot a note in a journal
- return to a repo
- ask an AI about one subdirectory only
- compare a draft with an earlier version
- collect notes for later synthesis

DeskAssist exists to support that kind of fragmented, high-context workflow inside one environment.

## Product Positioning

### One-sentence positioning
DeskAssist is a unified context-switching workspace with scoped AI for people doing messy, multi-mode work.

### Internal framing
A second brain for users whose work does not stay in one mode.

### Differentiator
The core differentiator is not simply “AI plus files.” It is:

**deliberate control over context inside a unified workspace**

This means users can:

- keep many related contexts open in one place
- restrict AI to a narrow slice of material
- compare multiple related scopes without changing workspaces
- preserve continuity across code, notes, research, and personal artifacts

## Target Users

### Primary users
- power users working across code, notes, and research
- technical users comparing experiments, branches, drafts, or agent outputs
- people who maintain many partial thoughts and ongoing projects at once
- users frustrated by having to split life, work, and AI interactions across many separate tools

### Early ideal user profile
A technically comfortable user who:

- works on multiple projects in parallel
- values context retention and organization
- wants scoped AI access instead of full-workspace exposure
- often switches between structured work and informal capture
- is willing to learn a strong workflow if it delivers real leverage

## Product Principles

1. **Continuity over fragmentation**  
   The user should be able to stay in one environment while moving between modes of work.

2. **Context is the product**  
   The value comes from handling context well: scoping it, switching it, comparing it, and preserving it.

3. **AI must be controllable**  
   Users should always know what the model can see, what it cannot see, and how to change that.

4. **Artifacts should be first-class**  
   Files, notes, prompts, chats, diffs, and comparisons are all artifacts in the same workspace, not disconnected features.

5. **The shell should reduce friction**  
   Layout, resizing, navigation, and switching must feel reliable and boring in the best way.

6. **Extensions should not define the core**  
   Integrations and life-tracking features are future multipliers, not the foundation.

## Product Architecture

### Layer 1: Shell
The always-open desktop environment.

Responsibilities:
- layout
- panes and resizing
- window state
- navigation
- persistence of active state

### Layer 2: Contexts
The units the user moves between.

Examples:
- workspace
- repo
- folder/subdirectory
- lane
- compare session
- note/journal area
- chat thread

### Layer 3: Artifacts
The objects inside contexts.

Examples:
- files
- directories
- notes
- prompts
- attachments
- links
- diffs
- chat transcripts

### Layer 4: Capabilities
The actions the system supports.

Examples:
- browse
- open
- edit
- compare
- chat
- narrow scope
- widen scope
- search
- capture

### Layer 5: Extensions / Integrations
Optional systems that expand the workspace.

Examples:
- email
- Slack
- text messages
- calendar/task integrations
- health logs
- reminders
- automation plugins

## MVP Definition

### MVP statement
DeskAssist v1 is a unified desktop workspace where a user can switch between contexts, open files and folders, and have AI conversations scoped to exactly the material they choose.

### What MVP is not
The MVP is not:
- a full personal assistant platform
- a messaging hub
- a health tracker
- a general automation engine
- a complete replacement for every app the user already has

The MVP proves the core interaction model first.

## Core Loops

These are the loops that must work cleanly before the product expands.

### Loop 1: Resume and switch context
- open DeskAssist
- see recent or active contexts
- jump back into current work
- switch to another context quickly
- return without losing place

### Loop 2: Narrow AI scope
- select a folder, file set, lane, or comparison target
- clearly see active scope
- ask the AI about only that material
- widen or change scope as needed

### Loop 3: Compare related artifacts
- choose two scopes or artifacts
- compare them in a stable, easy-to-understand way
- discuss the comparison in a scoped conversation

### Loop 4: Capture without breaking flow
- jot a note or thought quickly
- attach it to the right context or keep it as scratch
- return immediately to the prior task

## Current State Assessment

### What exists now
- desktop shell
- workspace/casefile structure
- lane model
- file browser
- scoped chat concept
- compare capability
- notes/prompts/inbox as attached ideas

### Current issues
- shell behavior is rough enough to distract from the product idea
- resizing and layout weaken the experience
- file browser lacks expected actions
- lane creation is not integrated naturally into browsing flow
- notes and prompts feel partly redundant with files
- the UI exposes internal concepts more clearly than user value
- documentation does not yet explain the product from a user perspective

### Key diagnosis
The product has a strong underlying idea, but the current implementation overrepresents one subsystem: repo-aware scoped work. That subsystem is valuable, but it is only part of the larger second-brain vision.

## Strategic Direction

### Product center of gravity for v1
**Unified context-switching workspace with scoped AI**

This should be the center of the product for the next phase.

### Why this center
It preserves the soul of the broader vision while remaining focused enough to build well.

It includes:
- code and non-code contexts
- fast switching
- scoped AI conversations
- notes/capture as part of workflow continuity

It does not require building a full life-management platform immediately.

## Roadmap

## Phase 1: Stabilize the shell
**Goal:** Make the existing app reliable enough that the core idea can be felt.

### Objectives
- fix resizing and layout behavior
- improve third-column usability
- make panel behavior predictable
- persist and restore layout state sensibly
- reduce visual clutter where possible

### Features / tasks
- sane panel minimum widths
- drag resizing that behaves correctly
- collapsible side panels or sections
- remembered pane sizes and open tabs
- clearer hierarchy between browser, editor, and context/chat panel
- better handling for smaller window sizes

### Success criteria
- the UI feels stable instead of fragile
- common actions do not require fighting the layout
- the chat/context area remains usable at multiple sizes

## Phase 2: Make browser-driven workflow complete
**Goal:** The file browser becomes a real control surface, not just a viewer.

### Objectives
- support basic file operations
- allow users to create contexts directly from selected artifacts
- reduce friction between browsing and scoped work

### Features / tasks
- create file
- create folder
- rename
- delete or move
- add/open files from browser into editor
- create lane from current selection
- attach selected artifact to current lane/context
- start compare flow from browser selection

### Success criteria
- users can perform basic workspace management without leaving the app
- lane setup no longer requires awkward detours
- compare and scope actions feel like natural extensions of browsing

## Phase 3: Clarify scoped-context workflows
**Goal:** Make the product’s key differentiator obvious and easy to use.

### Objectives
- make current scope visible at all times
- make lane meaning understandable
- simplify mental model around scope and compare

### Features / tasks
- explicit “current scope” display in chat/context area
- simple controls for narrow / widen / switch scope
- clear empty states explaining what lanes are for
- better compare setup and compare-state visibility
- lightweight onboarding copy for lanes and comparisons

### Success criteria
- a new user can understand what AI currently sees
- users can intentionally switch between X, Y, and X+Y style conversations
- the scoped AI concept feels like a product feature, not a hidden mechanic

## Phase 4: Introduce a true workspace home
**Goal:** Shift the app from “technical shell” to “second-brain workspace.”

### Objectives
- give the user a meaningful place to land
- support resume, recency, and quick capture
- represent mixed-mode work more clearly

### Features / tasks
- home/dashboard view
- recent contexts
- pinned workspaces/projects
- resume last active chat or lane
- quick note / quick capture box
- recent comparisons
- recent artifacts
- jump targets for journal, notes, repos, and active work

### Success criteria
- opening DeskAssist answers “what should I do now?”
- users can move from capture to active work quickly
- the product starts to feel like a real daily environment

## Phase 5: Unify artifacts
**Goal:** Reduce conceptual clutter by treating notes, prompts, chats, and files as related artifact types.

### Objectives
- stop making semi-redundant tabs compete as separate feature silos
- make notes and prompts more useful through integration

### Features / tasks
- redefine notes as quick-capture or context-bound artifacts
- redefine prompts as reusable artifacts with insertion/apply behavior
- better insertion into chat composer
- pin/favorite prompt artifacts
- link notes/prompts to contexts, lanes, or workspaces
- improve artifact discoverability from browser or home

### Success criteria
- notes and prompts feel necessary, not redundant
- users understand where artifacts live and how they relate
- fewer concepts need separate top-level real estate

## Phase 6: Add one non-code personal context
**Goal:** Validate the broader “work + life” vision without exploding scope.

### Recommended first choice
Journal / daily log / scratch context

### Why this first
- lightweight
- broadly useful
- naturally tests fast context switching
- does not require external integrations

### Features / tasks
- quick daily entry
- open/edit journal context like any other area
- link journal items to projects or contexts where appropriate
- allow AI chat over selected journal entries or a bounded slice

### Success criteria
- users can move between project work and personal capture fluidly
- DeskAssist starts to prove it is more than a repo tool

## Phase 7: Extension framework foundation
**Goal:** Prepare for broader assistant/integration features without letting them dominate early product design.

### Objectives
- define extension boundaries
- make integrations optional
- prevent every new capability from touching core architecture directly

### Features / tasks
- extension/plugin interface definition
- permissions and configuration model
- registration/discovery model
- background service boundaries where needed

### Success criteria
- future integrations can be added without destabilizing the shell
- the core product remains coherent without any extensions enabled

## Later Expansion Areas

These belong after the core loops are strong.

### Communications and assistant integrations
- email monitoring
- text/SMS support
- Slack integration
- calendar/task views
- reminder and follow-up flows

### Personal tracking
- calorie tracking
- runs/workouts
- health logs
- habit tracking

### Advanced AI / agent workflows
- agentic task execution
- multi-agent orchestration
- richer compare across outputs
- automated synthesis across artifacts
- proactive context suggestions

### Knowledge and search improvements
- cross-context search
- semantic retrieval across selected artifacts
- summaries and rollups
- timeline/history views

## What to Avoid Right Now

### Avoid feature-surface growth disguised as bug fixing
Use this filter for every change:

**Does this improve a core loop, or does it expand the product surface?**

If it expands the surface and is not essential, defer it.

### Avoid making everything a top-level destination
Top-level navigation should be earned by heavy, recurring workflows.

### Avoid building integrations before the shell and context model are excellent
Integrations can easily consume the roadmap without proving the base product.

## Documentation Roadmap

### Immediate documentation needs
- product overview: what DeskAssist is and who it is for
- mental model: workspaces, contexts, lanes, artifacts, compare
- quick start for everyday use
- “scoped AI” explanation
- browser-based workflow guide

### Longer-term docs
- extension architecture
- integration guides
- advanced workflows
- casefile and artifact organization best practices

## Milestones

### Milestone A: Reliable daily shell
DeskAssist can be used daily for browsing, editing, chatting, and switching contexts without layout friction.

### Milestone B: Browser-to-lane workflow complete
A user can create, scope, and compare work directly from the browser.

### Milestone C: Second-brain home experience
A user can open DeskAssist, resume work, capture thoughts, and switch between active contexts naturally.

### Milestone D: Unified artifact model
Notes and prompts feel integrated into the workspace rather than bolted on.

### Milestone E: First non-code context validated
DeskAssist proves it can support both project work and personal capture in one environment.

## Suggested Prioritization Summary

### Now
- shell stability
- resizing/layout cleanup
- browser actions
- lane creation from browser
- compare entry points
- explicit current-scope display
- minimal user-facing docs

### Next
- home/dashboard
- resume/recent contexts
- quick capture
- unify notes/prompts as artifacts
- improve scope UX and onboarding

### Later
- journal/daily log context
- extension system
- email/slack/text integrations
- personal tracking modules
- advanced agentic workflows

## Final Product Direction

DeskAssist should not try to win by being a slightly worse version of Cursor, ChatGPT, Obsidian, and a personal assistant all at once.

It should win by doing something those tools do not do well together:

**keeping messy, real, multi-mode work continuous inside one controllable workspace**

That is the strategic core. Everything else should reinforce it.

