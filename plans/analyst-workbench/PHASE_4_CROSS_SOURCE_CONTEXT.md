# Phase 4 Cross-Source Context

This document completes the planning portion of Phase 4 of the analyst workbench plan.

Phase 3 defined the minimum analyst core around repository analysis, review, and durable artifacts. Phase 4 answers the next question: how should the product reason across code and non-code sources without collapsing into a generic connector shell.

The goal is not to connect every system. The goal is to make at least one cross-source workflow feel grounded, reviewable, and more useful than either a code-only assistant or a chatbot with disconnected integrations.

## Phase 4 Outcome

Phase 4 is complete when these questions have clear answers:

- what the first non-code source should be
- why static or local sources come before live connectors
- what normalized source objects the product needs
- how non-code sources attach to a casefile
- how citations should work across mixed source types
- what the first truly cross-source workflow is

The current answer is:

- the first non-code source should be local markdown docs tied to the same job or workspace
- Phase 4 should start with attached local sources, not live connectors
- the product needs normalized `source item`, `summary`, `citation`, and `action candidate` objects
- non-code sources should attach to the casefile as explicit records, not pasted chat context
- mixed-source answers should cite both code and non-code evidence in one artifact model
- the first cross-source workflow should be implementation-versus-intent analysis using repo code plus task or plan docs

## First Non-Code Source

The first non-code source should be local markdown docs.

Examples:

- task instructions
- project plans
- design notes
- verification rules
- requirement docs
- repo-adjacent analyst notes

### Why Markdown First

Markdown is the right first source because it matches both the current workflow and the current repo.

Current workflow fit:

- the existing planning docs already describe work that depends on task-family docs and local notes outside the chat
- the product thesis explicitly calls out comparing implementation against intent
- a local markdown source is the cleanest replacement for copy-pasting instructions into chat

Current codebase fit:

- local file reading and repo traversal are already strong
- the existing tool and prompt layers already understand files and directories
- no connector auth, sync, or background service model is required

Product-fit advantage:

- this proves cross-source reasoning without turning Phase 4 into connector infrastructure work
- it keeps the work grounded inside the casefile model rather than in a list of external integrations

### Why Not Live Connectors First

Live connectors should not be the first Phase 4 step.

Reasons:

- the repo already has an MCP tool bridge, but not a durable source-object layer
- live connectors create auth, sync, freshness, and failure-handling complexity before the product model is ready
- a connector-first move would make it too easy to build "Void plus connectors" instead of a grounded analyst workbench

### Position Of Other Candidate Sources

The best order after local markdown docs is:

1. local notes
2. saved prompt libraries
3. exported issue or task data
4. selective live connectors later

Why this order works:

- local notes are nearly identical to markdown-doc support
- prompt libraries are still local, durable, and useful in drafting workflows
- exported issue data gives structured non-code input without requiring a live integration surface

## What The Current Repo Already Gives Phase 4

The repo already contains several useful cross-source building blocks, but they stop short of a true source-ingestion model.

### `mcpService.ts`: Future Ingress Layer, Not Yet A Source Model

Useful current behavior:

- creates and watches an `mcp.json` config file
- discovers configured MCP servers
- exposes their tools to the browser layer
- routes MCP tool calls and returns typed tool results

Why it matters:

- it is the strongest long-term bridge toward external or non-local capabilities
- it gives the product a future path for live source access without inventing a new transport mechanism

Current limitation:

- it exposes tools, not durable source items
- it can stringify tool results, but it does not normalize them into casefile records
- the user-facing controls are server-centric, not workflow-centric

Decision:

- keep `mcpService.ts` as a future ingress layer
- do not use it as the first Phase 4 source model

### `mcpChannel.ts`: Tool Execution Works, But Resource Ingestion Does Not

Useful current behavior:

- connects to stdio, HTTP, or SSE MCP servers
- lists tools
- calls tools safely through the main process

Important limitation:

- the active implementation is centered on `listTools()` and `callTool()`
- prompt listing and resource browsing are not implemented as product features
- resource responses are still not truly supported as first-class content in the channel path

Why it matters:

- this confirms that current MCP support is execution-oriented, not ingestion-oriented
- it would be premature to anchor Phase 4 on live MCP resources before a normalized source layer exists

Decision:

- treat `mcpChannel.ts` as infrastructure to build on later
- do not mistake tool access for completed cross-source support

### `toolsService.ts`: Strong For Local Discovery, Not For Durable Attachments

Useful current behavior:

- reads files
- explores directories
- searches files and pathnames
- gives the model concrete ways to inspect local workspace content

Why it matters:

- this already supports the first Phase 4 source choice: local markdown docs
- it gives the product a strong low-risk path for code plus document analysis

Current limitation:

- tool results are still transient
- nothing here turns discovered docs into explicit attached source records inside a casefile

Decision:

- keep this as the operational discovery layer for local sources
- add a source-attachment model above it instead of treating tool output as the source model

### `convertToLLMMessageService.ts`: Good Grounding Layer For Mixed Requests

Useful current behavior:

- already assembles grounded requests using workspace, file, directory, and terminal context

Why it matters:

- the future mixed-source workflow still needs a grounded request assembly layer

Current limitation:

- it is still optimized around chat messages and repo-aware context
- non-code source attachments are not yet first-class inputs

Decision:

- keep this as the future assembly layer for code-plus-doc analysis requests
- broaden it later from repo-context assembly into mixed-source request assembly

## Why Static Or Local Sources Come First

Phase 4 should explicitly start with local or static sources before adding live connectors.

### Product Reason

The product still needs to prove that cross-source reasoning strengthens analyst work rather than just making the assistant aware of more systems.

### Architecture Reason

Local and exported sources avoid several classes of premature complexity:

- authentication
- sync and freshness concerns
- background polling
- connector-specific failure states
- account and permission UX

### Workflow Reason

The current target workflows already contain local docs and notes, so the product can solve a real problem immediately by attaching those sources properly.

### Phase 4 Rule

If a cross-source workflow can be proven with a local artifact, do that before introducing a live connector for the same job.

## Normalized Source Model

Phase 4 needs normalized source objects so mixed-source reasoning can stay grounded and reviewable.

The first normalized objects should be:

- `source item`
- `summary`
- `citation`
- `action candidate`

## `Source Item`

A source item is the normalized record for any non-code input attached to a casefile.

### Minimum Fields

- source item ID
- source kind
- title
- canonical locator
- casefile attachment status
- content type
- imported or last-seen timestamp
- optional author or origin system
- optional summary metadata

### First Source Kinds

The first source kinds should be:

- `local_markdown_doc`
- `local_note`
- `prompt_library_entry`
- `issue_export_item`

Later source kinds can include:

- `ticket`
- `chat_message`
- `email_thread`
- `doc_page`

### Canonical Locator

The locator should be the stable way to point back to the source.

Examples:

- file URI plus optional heading anchor
- file URI plus section range
- exported issue item ID inside a local export
- later: external URL or system-specific record ID

### Key Decision

Source items are references with metadata, not blobs of pasted text. The product may cache excerpts or summaries, but the casefile should preserve the origin and locator.

## `Summary`

A summary is the durable synthesis artifact derived from one or more source items, code scope, or both.

### Minimum Fields

- summary ID
- summary type
- title
- scope definition
- contributing source item IDs
- contributing code citations
- created-at timestamp
- author or generator identity
- summary body

### Summary Types For Phase 4

- source summary
- code-versus-doc comparison summary
- implementation-versus-intent summary
- issue-context summary

### Key Decision

Summaries are artifacts inside the casefile, not just generated text in a thread.

## `Citation`

A citation is the atomic evidence pointer used inside findings, summaries, review notes, and answers.

### Minimum Fields

- citation ID
- source domain
- target reference
- excerpt or locator description
- relation to the claim

### Source Domains

The first source domains should be:

- `code`
- `diff`
- `run_log`
- `local_doc`
- `note`
- `issue_export`

### Citation Behavior Across Mixed Sources

Mixed-source artifacts should allow both kinds of evidence side by side:

- code citations, such as file path plus range or diff scope
- non-code citations, such as document URI plus heading, section, or excerpt

### Key Decision

Do not flatten all evidence into markdown footnotes only. Citations should remain structured records so the product can filter, revisit, or regenerate grounded outputs later.

## `Action Candidate`

An action candidate is a structured next step proposed from mixed-source analysis.

### Minimum Fields

- action candidate ID
- description
- why this action is suggested
- linked citations
- linked source items
- linked code scope
- status such as proposed, accepted, dismissed, or done

### Examples

- inspect an implementation path that contradicts the task plan
- update a doc section that no longer matches code behavior
- draft review comments from a doc-versus-code mismatch
- open a follow-up casefile from an issue export item

### Key Decision

Action candidates are not tasks from an external system yet. They are casefile-native follow-up objects that may later sync outward.

## How Non-Code Sources Attach To A Casefile

Non-code sources should attach to the casefile as explicit records, not as pasted chat turns.

### Attachment Rules

Each attached source should preserve:

- source kind
- locator
- display title
- attachment reason
- relationship to repo scope
- relationship to current workflow or review scope

### Attachment Modes

The first attachment modes should be:

- manual attach from workspace
- attach from file selection
- attach from casefile setup or orientation flow

Later attachment modes can include:

- attach from export import
- attach from connector search
- suggested attach based on casefile similarity

### Relationship To Phase 2

Phase 2 already established that linked docs or notes belong in the casefile. Phase 4 makes that durable and normalized instead of leaving it as an unstructured idea.

### Practical Storage Rule

The casefile should store source references and metadata first, and only cache excerpts or summaries as needed. This reduces churn and keeps source provenance clear.

## How Citations Should Appear Across Mixed Sources

Cross-source reasoning only works if claims stay grounded.

### Mixed Citation Principle

Any important cross-source conclusion should be able to point to both:

- the code evidence
- the non-code evidence

### Minimum Citation UX

Users should be able to see:

- what source a claim came from
- what part of that source matters
- whether the evidence was code, doc, note, diff, or another source type

### Example Citation Pair

An implementation-versus-intent summary might cite:

- `code`: `src/.../feature.ts` plus the relevant range or diff scope
- `local_doc`: `TASK_<X>/plan.md` plus the relevant section heading or excerpt

### Key Decision

Cross-source summaries, findings, and review notes should use one citation system with multiple source domains, not separate citation systems for code and documents.

## First Required Cross-Source Workflow

The first Phase 4 workflow that truly requires another source should be implementation-versus-intent analysis.

### Workflow

1. open a repo or task workspace
2. attach one or more local markdown docs, such as the task plan or requirement notes
3. inspect relevant code and selected files
4. ask whether implementation matches the attached intent sources
5. save findings with citations to both code and docs
6. produce a durable comparison summary or investigation memo

### Why This Workflow First

- it already exists in the user's real workflow
- it uses sources that are already local and easy to attach
- it demonstrates real cross-source value without requiring connector infrastructure
- it naturally produces grounded artifacts instead of generic chat output

### Example Questions This Workflow Should Answer

- does the implementation match the task plan
- what parts of the doc are no longer reflected in code
- what code paths appear to violate the stated requirement
- what follow-up actions should come from the mismatch

## What To Defer Until Later

Phase 4 should explicitly defer the following until the normalized source model is real:

- broad email automation
- many live connectors at once
- connector-specific UI before shared source objects exist
- relying on MCP server tools as if they were already durable source attachments

These are Phase 5 or later concerns unless a very narrow connector proves necessary.

## Suggested Phase 4 Implementation Order

The lowest-risk implementation order is:

1. add casefile attachment support for local markdown docs
2. add normalized source item and citation records
3. allow summaries and findings to cite both code and docs
4. add an implementation-versus-intent summary flow
5. support local notes and prompt-library entries next
6. revisit MCP-backed external sources only after the shared source model is stable

This order preserves the shell, stays additive, and proves the core cross-source value before connector expansion.

## Mapping From Current Repo To Phase 4 Decisions

The clearest current bridges into cross-source work are:

- `src/vs/workbench/contrib/void/common/mcpService.ts`
  - strongest future ingress path for external capabilities
  - currently server and tool oriented, not source-item oriented
- `src/vs/workbench/contrib/void/electron-main/mcpChannel.ts`
  - handles remote or local MCP transport and tool execution
  - confirms current MCP support is still tool-first
- `src/vs/workbench/contrib/void/browser/toolsService.ts`
  - strongest current layer for local discovery and file access
- `src/vs/workbench/contrib/void/browser/convertToLLMMessageService.ts`
  - strongest current grounding layer to broaden into mixed-source request assembly

The clearest current constraints are:

- MCP support is primarily `listTools()` plus `callTool()`, not a general source model
- MCP prompt and resource ideas exist in types, but are not product-level source surfaces yet
- resource results are not yet treated as durable attached artifacts
- current chat and tool flows still treat most external context as transient tool output

## Phase 4 Decisions Summary

1. The first non-code source should be local markdown docs tied to the job or workspace.
2. Phase 4 should start with local or static sources before any live connector expansion.
3. The product needs normalized `source item`, `summary`, `citation`, and `action candidate` objects before broader source integration.
4. Non-code sources should attach to the casefile as explicit records with locators and metadata, not as pasted chat context.
5. Mixed-source artifacts should use one citation model that can point to code, diffs, logs, docs, notes, and exported issue data.
6. The first required cross-source workflow should be implementation-versus-intent analysis using code plus attached local docs.
7. `mcpService.ts` and `mcpChannel.ts` are promising future ingress layers, but they are not yet sufficient as the Phase 4 source model.
8. Connector-specific UX and live ingestion should wait until the shared source model is proven with local artifacts.

## Phase 4 Definition Of Done Check

Phase 4 is complete at the planning layer because:

- the first non-code source is now selected
- the reason to start with static or local sources is now explicit
- the normalized source model is now defined
- casefile attachment and citation behavior are now defined for mixed-source work
- at least one genuinely cross-source workflow is now explicit
- the current repo's MCP and tool boundaries are now understood well enough to avoid connector-first drift

The implementation demo for this phase still belongs to later product work. What is complete here is the design decision layer needed to add cross-source context without turning the product into a generic assistant with a bag of integrations.
