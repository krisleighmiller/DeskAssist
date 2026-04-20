# Phase 5 Monitoring And Triage

This document completes the planning portion of Phase 5 of the analyst workbench plan.

Phase 3 defined the analyst core. Phase 4 defined the shared source model for code plus non-code context. Phase 5 answers the next question: how should the product watch incoming work and turn it into grounded analyst workflows without becoming a noisy dashboard or a notification-heavy chatbot.

The goal is not to monitor everything. The goal is to make one incoming work stream useful enough that the product can identify what matters, connect it to existing work context, and help move it forward.

## Phase 5 Outcome

Phase 5 is complete when these questions have clear answers:

- what the first monitored source should be
- what counts as an actionable incoming item
- what the triage view should show besides summaries
- how monitored items become casefiles
- how monitored items connect back to repos, docs, drafts, and prior work
- what should be automated versus only suggested

The current answer is:

- the first monitored source should be a single assigned issue or task queue from one external system
- actionable incoming items should be items that require a concrete decision, investigation, draft, or follow-up
- triage should be a structured work queue, not a notification inbox
- monitored items should either attach to an existing casefile or create a new one
- monitored items should connect back to repo scope, attached sources, and draft artifacts through the same casefile model established earlier
- automation should remain recommendation-first, with only narrow low-risk auto-actions later

## First Monitored Source

The first monitored source should be a single assigned issue or task queue.

Examples:

- issues assigned to me
- tasks assigned to me
- issues in one project queue that map to a known repo or workstream

### Why This Source First

This is the best first monitored source because it is:

- structured
- already work-shaped
- easier to tie to a repo or casefile than email
- less noisy than alerts
- more naturally action-oriented than a generic inbox

It also fits the product direction better than the other candidate sources:

- better than inbox first because it starts from work items rather than messages
- better than alerts first because alerts often need a mature triage system and clear escalation semantics
- better than review queue first because review queues require deeper PR-specific integration than the current repo appears ready for

### Why Not Inbox First

Inbox is a tempting first source, but it is the wrong first move.

Reasons:

- inbox data is noisy and heterogeneous
- email invites a drafting-first product shape before the analyst core is fully durable
- many inbox items are not casefile-worthy
- auth, threading, quoting, and privacy concerns raise the implementation cost quickly

### Why Not Alerts First

Alerts also look tempting because they are clearly "incoming", but they are poor first monitored items for this product.

Reasons:

- alerts are high-volume and easy to turn into noise
- alert usefulness depends on mature routing, thresholds, and deduplication
- the product still needs to prove work-context triage before it proves operations monitoring

### Why Not Review Queue First

Review queues are attractive because the analyst core is review-heavy, but they still assume a connector and object model the repo does not yet have.

Reasons:

- review queue integration tends to be provider-specific
- review queues pull in PR objects, reviewers, diff targets, and comment state all at once
- that is a larger first connector problem than issue or task queues

Decision:

- Phase 5 should begin with one issue or task queue from one system, not multiple streams

## What The Current Repo Already Gives Phase 5

The repo does not already contain a monitoring product model, but it does contain some reusable mechanics.

### `mcpService.ts` And `mcpChannel.ts`: Future Connector Ingress

Useful current behavior:

- configurable external server connections
- browser-to-main-process tool bridge
- state updates when connected servers change

Why it matters:

- this is still the best future path for live monitored sources
- it gives the product a route to issue systems, ticket systems, or similar tools later

Current limitation:

- it is still tool-first rather than monitored-item-first
- it does not yet define queues, polling cursors, deduplication, or incoming-item persistence

Decision:

- use MCP as a future ingestion path, not as the Phase 5 product model

### `refreshModelService.ts`: Reusable Polling Pattern

Useful current behavior:

- periodic refresh loop
- opt-in auto-refresh state
- lightweight state transitions like `init`, `refreshing`, `finished`, and `error`

Why it matters:

- Phase 5 will likely need a bounded polling loop for one monitored source
- the service demonstrates a low-complexity pattern for periodic refresh plus state updates

Current limitation:

- it refreshes provider metadata, not user work items
- it has no notion of queue state, seen items, or triage transitions

Decision:

- reuse the polling mindset, not the exact service shape

### `voidUpdateActions.ts`: Reusable Notification Pattern, But Not The Triage Model

Useful current behavior:

- scheduled checks
- notifications with explicit actions
- separation between auto-check and user-initiated action

Why it matters:

- Phase 5 may still need lightweight notifications for important triage events

Current limitation:

- notifications are not a queue
- they are a poor primary surface for ongoing monitored work

Decision:

- treat notifications as secondary escalation or reminder surfaces
- do not let them become the main triage experience

### `react/src/util/services.tsx`: Reusable State-Wiring Pattern

Useful current behavior:

- React-accessible subscriptions for service state
- MCP state already flows into the UI via listener sets and a dedicated hook

Why it matters:

- a future triage surface will need service-backed state that the React layer can subscribe to

Decision:

- this is a strong UI-state pattern to reuse when a monitoring service exists

### `void.contribution.ts`: Existing Product Surface Registration

Useful current behavior:

- central contribution root already mounts the product surfaces and services

Why it matters:

- Phase 5 should appear as part of the same product shell, not as a separate app-within-an-app

Decision:

- future triage UI should land under the same product contribution boundary rather than as a disconnected assistant surface

## What Counts As An Actionable Incoming Item

Phase 5 needs a narrow definition of what deserves attention.

An incoming item is actionable when it requires at least one of these:

- a decision
- an investigation
- a draft response
- a repo change or review
- a follow-up checklist

An incoming item is not actionable merely because it is new.

### Minimum Actionability Criteria

The first actionability rules should be:

1. the item is assigned, addressed, or otherwise relevant to the user
2. the item implies work to do, not just information to notice
3. the item can be connected to a repo, document, casefile, or draft
4. the item is not an obvious duplicate or already-resolved item

### Suggested Initial Buckets

The triage system should sort incoming items into at least these states:

- needs action
- blocked
- waiting on others
- draftable
- informational or ignore

### First Actionability Heuristics

Good first heuristics:

- assigned to me
- status is open or needs response
- updated recently
- contains a concrete request, question, failure, or review ask
- maps to a known repo or workstream

Bad first heuristics:

- every unread item
- every mention
- every low-level status change
- every connector event

## Triage View Design

Phase 5 should add a triage view, not just a summary prompt.

### Purpose

The triage view should help the user answer:

- what actually needs my attention
- what is blocked
- what touches code
- what needs a draft or response
- what can be deferred

### Minimum Sections

The first triage view should include:

- `needs action`
- `blocked`
- `touches code`
- `should be drafted`
- `recently resolved or ignored`

### Why These Sections

- `needs action` is the real work queue
- `blocked` prevents hidden stagnation
- `touches code` routes into analyst workflows instead of generic assistant behavior
- `should be drafted` routes into writing and response workflows
- `resolved or ignored` keeps the queue from feeling bottomless

### UX Role

The triage view should live in a side panel or dedicated navigation surface because it is:

- queue-oriented
- status-oriented
- an entry point into deeper work

It should open a casefile, draft, or summary in the main editor area rather than trying to host the whole workflow itself.

### What The Triage View Should Not Be

It should not be:

- a raw notification feed
- a generic assistant chat tab
- a connector-status dashboard
- a place where items disappear without a record of triage

## Monitored Item Model

Phase 5 needs one more normalized object beyond Phase 4's source model: the monitored item.

## `Monitored Item`

A monitored item is the normalized record for an incoming work unit discovered from a watched source.

### Minimum Fields

- monitored item ID
- monitored source kind
- external ID or locator
- title
- summary snippet
- status from the source system
- triage status
- assigned or addressed identity
- timestamps for created, updated, and last-seen
- linkage to repo, casefile, or known workstream when available

### First Source Kinds

- `issue_queue_item`
- `task_queue_item`

Later kinds can include:

- `review_queue_item`
- `alert_item`
- `email_item`

### Triage Status

The first triage statuses should be:

- `new`
- `needs_action`
- `blocked`
- `waiting`
- `drafting`
- `attached_to_casefile`
- `ignored`
- `done`

### Relationship To Phase 4

A monitored item is not the same as a source item.

Practical split:

- `monitored item`: incoming work unit from a watched stream
- `source item`: attached evidence or reference material inside a casefile

A monitored item may create or attach source items as part of triage.

## How Monitored Items Become Casefiles

Monitored items should not stay trapped in the queue.

### Promotion Paths

Each monitored item should support three primary outcomes:

1. attach to an existing casefile
2. create a new casefile
3. remain in triage with an explicit reason

### Create-New-Casefile Flow

When a monitored item becomes a new casefile, the product should:

1. create casefile metadata using the monitored item as origin
2. attach the monitored item itself as a source record or origin record
3. attach any immediately relevant repo scope if known
4. attach any relevant docs, prior summaries, or drafts if known
5. create initial open questions or action candidates

### Attach-To-Existing-Casefile Flow

When a monitored item belongs to ongoing work, the product should:

1. link it to the existing casefile
2. append a short activity record
3. add or update action candidates
4. preserve the monitored item as part of the casefile history

### Key Decision

The triage queue is not the system of record. The casefile remains the system of record once the item matters.

## How Monitored Items Connect Back To Repos, Docs, Or Drafts

Monitoring only helps if incoming work reconnects to the rest of the workspace.

### Connection Targets

The first connection targets should be:

- repo scope
- existing casefiles
- attached markdown docs or notes
- summaries and findings
- draft responses or draft comments

### Connection Rules

A monitored item should carry or derive:

- probable repo identity
- probable workstream or casefile match
- supporting source items
- suggested draft type if a response is needed

### First Connection Strategy

The first matching strategy should stay simple:

- explicit repo identifier if present
- explicit casefile link if user provides one
- manual attach if confidence is low

Do not begin with aggressive automatic matching across many signals.

### Draft Outputs

The most useful first draft outputs are:

- issue or task response draft
- internal investigation note
- follow-up checklist
- short status update

## Automation Versus Suggestion

Phase 5 must be careful not to automate away judgment too early.

### What Should Be Suggested First

The product should suggest:

- whether an item is actionable
- whether it likely touches code
- whether it should attach to an existing casefile
- what draft type fits best
- what repo or doc context seems relevant

### What Can Be Safely Automated Early

The product may later automate narrow low-risk actions such as:

- refreshing one monitored queue on an interval
- deduplicating already-seen items
- attaching obvious metadata from the source system
- proposing a default casefile title

### What Should Not Be Automated Early

Do not automate these in the first version:

- sending external replies automatically
- closing or modifying source-system items automatically
- creating many casefiles without user confirmation
- making irreversible triage decisions without review

### Key Decision

Phase 5 should be recommendation-first and confirmation-oriented. The product earns more automation only after the queue, casefile, and draft flows feel trustworthy.

## First Required Monitoring Workflow

The first Phase 5 workflow should be:

### Assigned Issue Or Task Triage

1. ingest one assigned issue or task queue
2. identify which items actually need action
3. classify whether they touch code, need drafting, or are blocked
4. attach the item to an existing casefile or create a new one
5. pull in relevant repo or source context
6. generate a draft response, investigation note, or follow-up list

### Why This Workflow First

- it is structured enough to triage cleanly
- it naturally becomes casefile work
- it connects well to repo analysis, docs, and drafts
- it avoids the notification-soup trap better than inbox or alerts

## What To Defer Until Later

Phase 5 should explicitly defer:

- many monitored streams at once
- inbox-first assistant behavior
- alerting dashboards
- automatic outbound actions
- connector-specific queue UX before the monitored-item model is stable

These belong later unless one narrow use case clearly forces them earlier.

## Suggested Phase 5 Implementation Order

The lowest-risk implementation order is:

1. add a monitored-item model and one queue state service
2. support one issue or task queue from one source
3. add a triage surface with explicit statuses
4. add casefile creation or attachment from triage items
5. connect triage items to repo scope, source items, and draft outputs
6. add reminders or notifications only as secondary aids

This order keeps monitoring subordinate to analyst work rather than becoming a separate product inside the shell.

## Mapping From Current Repo To Phase 5 Decisions

The clearest current bridges into monitoring and triage are:

- `src/vs/workbench/contrib/void/common/mcpService.ts`
  - strongest future ingress path for external monitored sources
- `src/vs/workbench/contrib/void/electron-main/mcpChannel.ts`
  - future transport layer for monitored-source connectors
- `src/vs/workbench/contrib/void/common/refreshModelService.ts`
  - demonstrates reusable polling and state-transition ideas
- `src/vs/workbench/contrib/void/browser/voidUpdateActions.ts`
  - demonstrates secondary notification behavior for scheduled checks
- `src/vs/workbench/contrib/void/browser/react/src/util/services.tsx`
  - demonstrates the React subscription pattern needed for service-backed triage state
- `src/vs/workbench/contrib/void/browser/void.contribution.ts`
  - existing product root where a future triage surface should remain integrated

The clearest current constraints are:

- there is no monitored-item model yet
- there is no queue or triage service yet
- current connector support is still tool-first, not feed-first
- notification patterns exist, but they are not a substitute for a triage queue

## Phase 5 Decisions Summary

1. The first monitored source should be a single assigned issue or task queue from one external system.
2. Actionable incoming items are items that require a decision, investigation, draft, repo work, or follow-up, not merely items that are new.
3. Phase 5 needs a dedicated monitored-item model in addition to the Phase 4 source-item model.
4. The triage view should be a structured work queue with sections like `needs action`, `blocked`, `touches code`, and `should be drafted`.
5. Monitored items should either attach to an existing casefile or create a new one; the queue is not the final system of record.
6. Monitoring must reconnect incoming work to repos, docs, findings, and drafts through the casefile model.
7. Automation should stay recommendation-first, with only narrow low-risk automation early on.
8. Existing MCP, polling, notification, and React-state patterns are useful infrastructure hints, but none of them yet amount to a finished monitoring product model.

## Phase 5 Definition Of Done Check

Phase 5 is complete at the planning layer because:

- the first monitored source is now selected
- actionable-item criteria are now explicit
- the triage view is now defined as a queue rather than a summary prompt
- the path from monitored items to casefiles is now explicit
- the connection back to repos, docs, and drafts is now defined
- the automation boundary is now explicit enough to avoid premature over-automation

The implementation demo for this phase still belongs to later product work. What is complete here is the design decision layer needed to add monitoring and triage without turning the product into a noisy notification dashboard or a generic assistant inbox.
