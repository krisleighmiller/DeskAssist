# Codebase Map For The Analyst Workbench Plan

This map links the current repo structure to the product plan in `PHASED_PLAN.md`.

It is not a full code inventory. It is a planning-oriented map of:

- what the current repo already gives you
- what looks reusable
- what looks too tied to the current Void product shape
- what areas matter for each phase of the plan

## Reading Guide

Use these labels mentally while reading the repo:

- `keep`: likely useful for the future analyst workbench
- `adapt`: useful, but too shaped around Void's current product model
- `replace later`: likely to pull the product back toward "coding agent" if left unchanged
- `shell`: infrastructure you probably want to preserve while experimenting

## 1. App Entry And Product Mount

### `src/vs/workbench/workbench.common.main.ts`

Role:

- main workbench entry point
- mounts the dedicated Void product contribution into the VS Code shell

Why it matters:

- this is one of the strongest signs that the repo already has a product seam
- the seam is currently named and mounted as Void, but it is still a seam you can evolve

Planning label:

- `shell`
- `keep`
- revisit in Phase 6 when the new product boundary is renamed

### `src/vs/workbench/contrib/void/browser/void.contribution.ts`

Role:

- the product composition root for most of the custom app behavior
- imports and registers editing, sidebar, settings, tools, thread history, onboarding, metrics, SCM, and related services

Why it matters:

- this is the most important "current product surface" in the repo
- early work can probably keep this location stable while the product direction evolves
- later work should decide whether it remains a temporary home or becomes a renamed neutral contribution root

Planning label:

- `keep`
- `adapt`

Best phase fit:

- Phase 1 for inventory and boundary thinking
- Phase 6 for final renaming or relocation

## 2. Shell And Layout Surfaces

### `src/vs/workbench/contrib/void/browser/sidebarPane.ts`

Role:

- registers the current main sidebar/view container
- mounts the React sidebar into the workbench

Why it matters:

- this is where the current product becomes a visible first-class workbench surface
- the shell integration is valuable
- the current title, icon, and chat-first framing will probably need to change

Planning label:

- `keep`
- `adapt`

Best phase fit:

- Phase 2 when deciding whether the primary object is a casefile rather than a chat thread
- Phase 3 when designing findings, notes, and review-centric surfaces

### `src/vs/workbench/contrib/void/browser/react/`

Role:

- React UI for sidebar, settings, onboarding, tooltips, quick edit, markdown rendering, and widgets

Why it matters:

- this is the main frontend surface for product-level UX changes
- it is likely where most analyst workbench UI experiments will eventually land

Planning label:

- `keep`
- `adapt`

Best phase fit:

- Phase 2 for information architecture
- Phase 3 onward for UI implementation

## 3. Current Feature Model And Settings

### `src/vs/workbench/contrib/void/common/voidSettingsTypes.ts`

Role:

- defines provider settings, feature model selection, and global product settings

Important current assumption:

- the feature model is explicitly centered on `Chat`, `Ctrl+K`, `Autocomplete`, `Apply`, and `SCM`

Why it matters:

- this is one of the clearest places where the repo still encodes a coding-assistant product model
- for the analyst workbench vision, this file is less a destination than a source of constraints to outgrow

Planning label:

- `adapt`
- `replace later`

Best phase fit:

- Phase 1 to understand current assumptions
- Phase 2 to redesign around workflow or capability models
- Phase 6 to rename and harden the new model

### `src/vs/workbench/contrib/void/common/voidSettingsService.ts`

Role:

- stores and updates the current product state
- persists provider selections, model choices, and global settings

Why it matters:

- any future casefile/session model will likely interact with or eventually supersede parts of this service
- do not rush to rewrite it until the new state model is clear on paper

Planning label:

- `adapt`

Best phase fit:

- Phase 2 for future state design
- Phase 6 for structural replacement once the new model is real

## 4. Repo Discussion, Threads, And Context

### `src/vs/workbench/contrib/void/browser/chatThreadService.ts`

Role:

- manages thread state, message history, staging selections, tools, snapshots, retries, and persistence

Why it matters:

- despite the name, this is one of the richer "ongoing context" surfaces in the repo
- parts of it may evolve into the future casefile/session layer
- the danger is leaving it as a pure chat-thread abstraction when your product needs structured work context

Planning label:

- `keep`
- `adapt`

Best phase fit:

- Phase 2 for casefile/session design
- Phase 3 for saved findings and review workflows

### `src/vs/workbench/contrib/void/common/directoryStrService.ts`

Role:

- turns directory and file context into structured representations for tools and prompts

Why it matters:

- repo understanding depends on good structural context
- this looks closer to your target product than generic chat UI surfaces do

Planning label:

- `keep`

Best phase fit:

- Phase 3, the analyst core

### `src/vs/workbench/contrib/void/browser/convertToLLMMessageService.ts`

Role:

- converts internal context into model-facing message structures

Why it matters:

- likely useful as a translation layer even if the future product stops being chat-centered
- may need to broaden from "chat prompt assembly" into "analysis request assembly"

Planning label:

- `adapt`

Best phase fit:

- Phase 3 and Phase 4

## 5. Editing And Reviewable Change Surfaces

### `src/vs/workbench/contrib/void/browser/editCodeService.ts`

Role:

- the core apply/edit pipeline
- manages diff areas, Ctrl+K zones, streaming changes, and reviewable edits

Why it matters:

- this is a strong reusable capability, even if your product is not generation-first
- the underlying "reviewable action" mindset fits analyst and review work better than blind automation
- however, it should become a supporting capability, not the product center

Planning label:

- `keep`
- `adapt`

Best phase fit:

- Phase 3, but explicitly as secondary support for review and editing

### `src/vs/workbench/contrib/void/browser/quickEditActions.ts`

Role:

- wires in the current quick-edit behavior

Why it matters:

- useful to understand, but easy to over-prioritize because it is concrete and already exists
- likely not the best starting point for the analyst workbench identity

Planning label:

- `replace later` as a primary organizing concept
- `keep` only as a secondary editing mode

## 6. Model, Tool, And Connector Infrastructure

### `src/vs/workbench/contrib/void/common/sendLLMMessageService.ts`

Role:

- browser-side service for sending model requests through main-process channels
- integrates settings and MCP tools into requests

Why it matters:

- this is part of the core "reasoning engine" path
- the existence of a dedicated bridge to model backends is useful
- the current shape is still tied to the Void product and channel naming

Planning label:

- `keep`
- `adapt`

Best phase fit:

- Phase 3 for analyst workflows
- Phase 4 for mixed-source reasoning
- Phase 6 for renaming channels and contracts

### `src/vs/workbench/contrib/void/common/mcpService.ts`

Role:

- manages MCP config, exposed tools, state, and calls through the main process

Why it matters:

- this is one of the most promising bridges toward your long-term vision
- it gives you a route toward non-code tools and connectors without immediately turning the app into a generic connector shell
- it should be used deliberately and workflow-first

Planning label:

- `keep`
- `adapt`

Best phase fit:

- Phase 4 for cross-source context
- Phase 5 for monitored and assistant-style workflows

### `src/vs/workbench/contrib/void/browser/toolsService.ts`

Role:

- tool calling surface for in-product actions and tool results

Why it matters:

- tools are part of your long-term product, but the tools need to serve work context rather than generic chat feature expansion

Planning label:

- `adapt`

Best phase fit:

- Phase 3 to Phase 5

## 7. Product Identity And Runtime Channels

### `product.json`

Role:

- current app identity, protocol names, data folder names, icon names, issue URLs, and related metadata

Why it matters:

- this is the center of current product identity
- it is a major Phase 1 inventory target and a Phase 6 replacement target

Planning label:

- `replace later`

### `src/vs/code/electron-main/app.ts`

Role:

- main process wiring
- registers product-specific channels including metrics, updates, LLM messaging, SCM, and MCP

Why it matters:

- this is where product-specific runtime contracts become real
- it is also where the current `void-channel-*` names are rooted

Planning label:

- `adapt`
- `replace later`

Best phase fit:

- Phase 1 for architecture inventory
- Phase 6 for final runtime boundary cleanup

## 8. Packaging, Distribution, And Build Identity

### `HOW_TO_CONTRIBUTE.md`

Role:

- current contributor guidance
- describes the repo as Void and points to Void-specific build/release assumptions

Why it matters:

- this is a documentation-level reminder that the repo is still operationally tied to the current product identity
- useful for understanding the true scope of a future break

Planning label:

- `replace later`

### `build/`, `resources/`, `scripts/`

Role:

- packaging, Linux assets, desktop launchers, and distribution plumbing

Why it matters:

- this is where product identity becomes operationally sticky
- a real break from Void requires revisiting these areas eventually, but not before the analyst core is proven

Planning label:

- `shell`
- `replace later`

Best phase fit:

- primarily Phase 6

## 9. What Seems Closest To Your Target Product

If the goal is an analyst-first workbench, the most promising existing surfaces are:

1. `src/vs/workbench/contrib/void/browser/chatThreadService.ts`
   - not because chat should remain central
   - because it already handles persistent, evolving context

2. `src/vs/workbench/contrib/void/common/directoryStrService.ts`
   - because repo structure is central to analyst workflows

3. `src/vs/workbench/contrib/void/browser/editCodeService.ts`
   - because reviewable edits and explicit diff handling fit analysis-heavy work

4. `src/vs/workbench/contrib/void/common/sendLLMMessageService.ts`
   - because you will still need a strong model execution path

5. `src/vs/workbench/contrib/void/common/mcpService.ts`
   - because cross-source reasoning and monitored workflows will eventually need well-bounded external capabilities

## 10. What Looks Most Likely To Pull You Backward

These areas are important to understand, but risky to build your future identity around:

1. feature naming and model selection organized around `Chat`, `Ctrl+K`, `Autocomplete`, `Apply`, and `SCM`
2. chat-first sidebar framing
3. product naming embedded in metadata and channel names
4. packaging and docs that still define the repo as Void
5. any impulse to start with connectors before a strong casefile/session model exists

## 11. Suggested Implementation Order By Area

### Start Here

- `plans/analyst-workbench/`
- `src/vs/workbench/contrib/void/browser/sidebarPane.ts`
- `src/vs/workbench/contrib/void/browser/chatThreadService.ts`
- `src/vs/workbench/contrib/void/common/voidSettingsTypes.ts`
- `src/vs/workbench/contrib/void/common/directoryStrService.ts`

Reason:

- these files and docs help define what the product is before you commit to major code changes

### Move To Next

- `src/vs/workbench/contrib/void/browser/react/`
- `src/vs/workbench/contrib/void/browser/editCodeService.ts`
- `src/vs/workbench/contrib/void/common/sendLLMMessageService.ts`
- `src/vs/workbench/contrib/void/common/mcpService.ts`

Reason:

- these are likely to become part of the analyst core and cross-source reasoning path

### Leave For Later

- `product.json`
- `src/vs/code/electron-main/app.ts`
- packaging, desktop assets, and distribution docs

Reason:

- changing them too early increases churn without proving the product direction

## 12. Phase-To-Codebase Crosswalk

### Phase 1: Preserve The Shell, Decouple The Identity

Focus on:

- `product.json`
- `src/vs/code/electron-main/app.ts`
- `src/vs/workbench/workbench.common.main.ts`
- `src/vs/workbench/contrib/void/browser/void.contribution.ts`
- `HOW_TO_CONTRIBUTE.md`

### Phase 2: Reframe The Product Around Analysis

Focus on:

- `src/vs/workbench/contrib/void/common/voidSettingsTypes.ts`
- `src/vs/workbench/contrib/void/common/voidSettingsService.ts`
- `src/vs/workbench/contrib/void/browser/sidebarPane.ts`
- `src/vs/workbench/contrib/void/browser/chatThreadService.ts`
- `src/vs/workbench/contrib/void/browser/react/`

### Phase 3: Build The Analyst Core

Focus on:

- `src/vs/workbench/contrib/void/browser/chatThreadService.ts`
- `src/vs/workbench/contrib/void/common/directoryStrService.ts`
- `src/vs/workbench/contrib/void/browser/editCodeService.ts`
- `src/vs/workbench/contrib/void/browser/react/`
- `src/vs/workbench/contrib/void/common/sendLLMMessageService.ts`

### Phase 4: Add Cross-Source Context

Focus on:

- `src/vs/workbench/contrib/void/common/mcpService.ts`
- `src/vs/workbench/contrib/void/browser/toolsService.ts`
- `src/vs/workbench/contrib/void/common/sendLLMMessageService.ts`
- future source-normalization and attachment surfaces

### Phase 5: Add Monitoring And Triage

Focus on:

- MCP-backed or connector-backed source integration
- triage-oriented UI under the product React surface
- casefile creation from incoming monitored items

### Phase 6: Rename And Re-Anchor The Product Boundary

Focus on:

- `product.json`
- `src/vs/code/electron-main/app.ts`
- `src/vs/workbench/contrib/void/browser/void.contribution.ts`
- `src/vs/workbench/contrib/void/common/voidSettingsTypes.ts`
- build and packaging identity surfaces

## Final Advice

The codebase already gives you a usable shell and a meaningful product seam. The biggest risk is not that the repo is too tied to Void to evolve. The biggest risk is that the current product vocabulary will quietly keep shaping decisions until the new product becomes "Void plus connectors."

Use this map to keep asking:

- is this part of the shell we want?
- is this part of the current product we can adapt?
- or is this a constraint we should outgrow once the analyst core is proven?
