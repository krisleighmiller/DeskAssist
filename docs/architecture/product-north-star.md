# DeskAssist Product North Star

## DeskAssist in Plain English

DeskAssist is a unified workspace for people whose work does not stay in one mode.

It is for users who move constantly between code, drafts, experiments, comparisons, and everyday capture, and who are tired of losing context every time they switch tools.

DeskAssist should feel like an always-open second brain for messy real-world work: a place where a user can keep active focuses in one environment, control exactly what AI can see, and return to work without reconstructing their state from scratch.

This is not a "repo chat app with extra tabs."
It is not a generic "AI desktop assistant."
It is a focus-switching workspace with scoped AI.

## The Problem DeskAssist Solves

Most tools are designed for one mode of work at a time.

- IDEs assume the user is coding.
- chat tools assume the user is conversing.
- personal assistants assume the user wants lightweight reminders or automation.

But real work is mixed.

A user may need to:

- review a codebase
- compare two agent attempts
- open a partial draft
- capture a thought before it disappears
- ask AI about one specific folder and not the rest
- compare version X with version Y and then discuss both together
- switch from project work to a non-code focus and back again without losing the thread

Current tools make those transitions awkward.
They force the user to split context across multiple apps, multiple workspaces, or multiple mental models.

DeskAssist exists to reduce that friction.

## Who DeskAssist Is For

DeskAssist is for power users whose work is fragmented but connected.

Early ideal users include people who:

- work across code, drafts, research, and captures in the same day
- keep multiple attempts, drafts, or experiments alive at once
- need to compare related artifacts without opening separate workspaces
- want AI help, but do not want to give the AI their entire project every time
- need quick capture and fast switching as part of their normal workflow

This is not a mass-market productivity app.
It is a tool for users who already feel the pain of fragmented context and are willing to adopt a strong workflow if it gives them real leverage.

## What Makes DeskAssist Different

DeskAssist should win on two things:

### 1. Continuity
The user should be able to stay in one environment while moving between different kinds of work.

That means DeskAssist should support:

- switching between active focuses
- resuming where the user left off
- quick capture without breaking flow
- keeping related work near each other even when the formats differ

### 2. Controllable AI Context
The AI should not see everything by default.
The user should be able to decide what the AI can read, compare, and act on.

That means DeskAssist should support:

- chatting about one specific folder, draft, or work unit
- widening scope when needed
- comparing multiple selected scopes together
- making current AI scope visible and understandable

This is the product edge.
Not "AI plus files."
But a unified workspace where focus and AI scope are deliberate.

## What DeskAssist Is Not

DeskAssist is not trying to become all of these things at once:

- a full IDE replacement on day one
- a full personal assistant platform on day one
- a messaging hub on day one
- a health tracker on day one
- a giant automation platform on day one
- a replacement for every app the user already has

Those may become future expansion areas.
They are not the definition of V1.

If DeskAssist tries to become a worse version of Cursor, ChatGPT, Obsidian, email, Slack, and a task manager all at once, it will fail.

The product has to earn expansion by first being excellent at its core loops.

## The V1 Bet

DeskAssist V1 is:

**a unified desktop workspace where a user can switch between focuses, work with files, and have AI conversations scoped to exactly the material they choose.**

That is enough for V1.

V1 should prove that DeskAssist can be a reliable daily environment for:

- browsing and editing
- switching between active work
- narrowing and widening AI scope
- comparing related material
- capturing thoughts without leaving the workspace

## The Core User Promise

When a user opens DeskAssist, they should feel:

- I can get back to what I was doing.
- I can move between my active work without losing the thread.
- I can ask AI about exactly what I mean, not everything in sight.
- I can compare related work without awkward workspace gymnastics.
- I can capture a thought and return to work immediately.

That is the promise.
If a feature does not strengthen that promise, it probably does not belong in the core product yet.

## The Product Center Of Gravity

The center of gravity for DeskAssist should be:

**unified focus-switching workspace with scoped AI**

This is the filter that should keep the product from drifting.

DeskAssist is broader than a code tool, but narrower than a full life-operating system in V1.

The product should mature around these capabilities:

1. stable shell
2. strong focus switching
3. visible and controllable AI scope
4. home and resume flow
5. coherent artifacts and capture
6. one validated non-code focus
7. extension boundaries for future integrations

The canonical execution order lives in [`../planning/roadmap.md`](../planning/roadmap.md). If this product north star and the roadmap appear to disagree about sequencing, the roadmap wins.

## What The Home Experience Should Feel Like

DeskAssist should not open into raw implementation concepts.
It should open into purposeful continuity.

A user opening DeskAssist should be able to:

- resume recent work
- jump to active focuses
- quick-capture a thought
- reopen a comparison or chat
- switch from code to draft to comparison without friction

The home experience should answer:

**What am I doing right now, and where do I want to go next?**

If the app opens like a shell full of infrastructure, it is reinforcing the implementation instead of the product.

## Product Language Rules

Use these terms when talking about the product:

- **workspace** = the overall DeskAssist environment
- **focus** = the current or resumable unit of work
- **scope** = what the AI can currently read
- **artifact** = the durable things the user works with
- **comparison** = a multi-focus inspection or discussion session

Use these terms when talking about the implementation:

- **casefile** = the current storage container
- **context** = the current implementation of a scoped focus
- **attachment** = related material added to a scoped context, with read-only or writable access

The goal is not to hide implementation reality.
The goal is to stop implementation terms from accidentally defining the product.

## V1 Success Criteria

DeskAssist V1 is successful if a user can:

- use it daily without fighting the shell
- switch between multiple active focuses naturally
- understand what AI can currently see
- narrow or widen that scope intentionally
- compare related work in one place
- capture thoughts without breaking flow

If V1 achieves those things, DeskAssist will have proved its core value.
Then broader personal assistant and integration features can be added from a position of strength instead of drift.

## Expansion Areas, Later

After the core is strong, DeskAssist may expand into:

- journal or daily log focuses
- full web browser support
- email, messaging, or Slack integrations
- reminder and follow-up flows
- calendar or task views
- life-log modules such as runs, calories, or habits
- more agentic workflows
- extension and plugin systems

These are meaningful future directions.
They are not the product definition of V1.

## Final Direction

DeskAssist should be built as a workspace for continuous, messy, multi-mode work.

It should help users stay oriented while moving between focuses, files, comparisons, and conversations.
It should make AI more useful by making scope explicit and controllable.
And it should grow carefully, without letting every interesting feature turn the product into an unfocused pile of surfaces.

The simplest way to keep DeskAssist on track is this:

**Build the place a messy power user would actually leave open all day.**

Not because it does everything, but because it lets related work stay connected.

