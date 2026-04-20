# Phased Execution Plan

This plan is deliberately concrete enough to guide implementation work, but still narrow enough that you can adapt it during experiments.

## Phase 0: Stabilize Intent

Goal: stop thinking in terms of "Void, but with extra tools" and define the new product clearly.

Deliverables:

- a one-sentence product thesis
- 3 to 5 primary user workflows
- a short list of non-goals
- an agreed answer to: "what is the primary object in the product?"

Recommended answer for now:

- primary object: a workspace casefile or analysis session
- not primary object: a generic chat thread

Exit criteria:

- you can explain the product in under two minutes
- you can say why it is not just Cursor and not just a chatbot with connectors

## Phase 1: Preserve The Shell, Decouple The Identity

Goal: keep the IDE/workbench shell while mentally and structurally separating from the current Void product identity.

Concrete work:

1. Inventory all product identity surfaces.
   - app name
   - protocol handlers
   - icons
   - data folder names
   - updater naming
   - issue URLs
   - installer assets

2. Inventory all "Void" architectural seams.
   - service names
   - IPC channel names
   - settings types
   - feature names
   - product-specific contribution entry points

3. Decide the future boundary.
   - keep the current location temporarily and rename later
   - or move toward a new neutral workbench contribution namespace

Exit criteria:

- you know exactly what is branding, what is architecture, and what is actual product logic
- you can separate "shell we keep" from "product assumptions we will replace"

## Phase 2: Reframe The Product Around Analysis

Goal: redefine the product model around analysis and review rather than code generation.

Concrete work:

1. Replace feature language in the plan with workflow language.
   Suggested workflow buckets:
   - repository analysis
   - review
   - drafting
   - monitoring
   - automation

2. Design the casefile/session object.
   The most concrete current shape is a job-centered casefile, often rooted in a directory like `TASK_<X>`.
   Each casefile should be able to hold:
   - job identity
   - repo scope
   - execution tracks and runs
   - selected files, diffs, or branches
   - attached docs or notes
   - findings
   - drafts
   - pending questions
   - saved outputs

3. Define first-class output types.
   - review comment set
   - repo summary
   - investigation note
   - email draft
   - prompt draft
   - action list

Exit criteria:

- the product can be described without relying on code-editing shortcuts
- a job/casefile model exists on paper before any major rewrite begins

## Phase 3: Build The Analyst Core

Goal: make repo understanding and review the strongest feature in the product.

Concrete work:

1. Improve repository discussion primitives.
   - broad repo questions
   - architectural tracing
   - branch and diff discussion
   - saved findings and summaries

2. Introduce review-centric surfaces.
   - findings panel
   - review notes panel
   - summary generation
   - open questions list

3. Keep edit/apply support secondary.
   - preserve it
   - do not let it dominate the main UX

Exit criteria:

- the app is already useful even if no code generation happens
- it feels better than a generic assistant for repo review

## Phase 4: Add Cross-Source Context

Goal: let the product reason across code and non-code sources together.

Concrete work:

1. Start with static or local sources first.
   - markdown docs
   - local notes
   - prompt libraries
   - exported issue lists

2. Then add live connectors selectively.
   - email
   - task system
   - document storage
   - chat or ticket systems

3. Normalize sources into common objects.
   - source item
   - summary
   - citation
   - action candidate

Exit criteria:

- a user can ask a single question that spans code plus another work source
- the answer feels grounded rather than conversationally vague

## Phase 5: Add Monitoring And Triage

Goal: support the "personal assistant" side without turning the product into notification soup.

Concrete work:

1. Define monitored sources.
   - inboxes
   - issues
   - alerts
   - review queues

2. Add triage views, not just summaries.
   - what needs action
   - what is blocked
   - what touches code
   - what should be drafted

3. Turn monitoring into workflows.
   - create casefile
   - attach relevant repo context
   - generate draft response
   - create follow-up checklist

Exit criteria:

- the monitoring features lead naturally into analyst work instead of becoming a separate chatbot product

## Phase 6: Rename And Re-Anchor The Product Boundary

Goal: once the product direction is stable, stop building on top of Void naming and assumptions.

Concrete work:

1. Replace product identity in metadata and packaging.
2. Replace Void-specific service and channel naming with neutral names.
3. Replace the current feature model with workflow or capability models.
4. Move or rename the product contribution boundary if needed.

Exit criteria:

- the product no longer reads as "a maintained Void fork"
- the architecture names match your actual product

## Sequencing Guidance

Do these in order:

1. stabilize the product thesis
2. make repo analysis excellent
3. add cross-source reasoning
4. add monitoring and assistant workflows
5. rename and harden the final product boundary

Do not do these too early:

- deep connector work before core repo analysis is strong
- broad rebrands before the product direction is stable
- large code rewrites before the session/casefile model is clear

## Concrete Milestones

### Milestone A: "Better Than Chat"

Success looks like:

- can load a repo and discuss it deeply
- can save findings
- can produce a useful repo review summary

### Milestone B: "Cross-Source Useful"

Success looks like:

- can combine code with docs or notes
- can generate grounded summaries that cite both
- can turn analysis into drafts

### Milestone C: "Analyst Assistant"

Success looks like:

- can monitor at least one external stream
- can create work items from incoming information
- can tie that work back to code or docs without context loss
