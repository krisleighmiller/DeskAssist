# Repo Guardrails

> **Scope note (updated).** This file was originally written for the Void fork, where the analyst-workbench plans were a deletable side experiment. In the DeskAssist trunk repo, the product thesis is settled and the casefile model is being built directly into the app. The "removal safety" rules at the bottom of this file are historical. The feature-evaluation rules in the middle remain useful and apply unchanged.

This file exists to keep experimentation focused while the repo is still serving as your working agent-testing environment.

## Intent

Use the repo as:

- a stable shell for product exploration
- a sandbox for agent-testing work
- a place to evolve the future analyst workbench incrementally

Avoid turning the repo into:

- a pile of half-connected assistant experiments
- a connector dump with no product model
- a large rewrite driven by naming frustration alone

## Rules For Early Work

1. Keep planning artifacts isolated.
   - Put product planning in `plans/analyst-workbench/` until it hardens.
   - Do not wire planning files into the app or build.

2. Prefer additive experiments over invasive rewrites.
   - Add isolated proof-of-concept surfaces first.
   - Delay major renames until the product thesis is stable.

3. Protect the shell.
   - The VS Code-style layout is part of the reason this repo is useful.
   - Do not destabilize core shell behavior unless it blocks the target product directly.

4. Keep agentic code creation as a supported mode, not the organizing principle.
   - It can remain available.
   - It should not define the whole information architecture.

5. Design around work context, not chat turns.
   - Every major feature should answer:
     - what context does it use?
     - what artifact does it create?
     - how does it connect to ongoing work?

## Rules For Product Decisions

Before adding a new feature, ask:

1. Does this help repository understanding, cross-source analysis, operational triage, or drafting?
2. Does this strengthen the workspace/casefile model?
3. Would this still make sense if chat were only one UI among several?
4. Is this solving your real work, or copying a familiar assistant pattern?

If the answer is "no" to most of those, the feature probably belongs later or not at all.

## Suggested Boundaries For Experiments

Good early experiments:

- repo summary workflows
- persistent findings
- review note capture
- diff discussion and synthesis
- document plus repo comparison
- draft generation from saved analysis

Risky early experiments:

- broad email automation before casefiles exist
- many live connectors at once
- large-scale renaming without a settled product boundary
- replacing stable core editor behavior to chase novelty

## Definition Of Staying Within The Plan

Work is aligned if it does at least one of these:

- deepens repo analysis
- improves review and synthesis
- adds structured context beyond chat history
- makes cross-source reasoning more grounded
- turns analysis into reusable outputs

Work is drifting if it mostly does this:

- adds another generic chat entry point
- adds connectors without clear workflows
- imitates coding-agent UX without matching your job
- changes names without clarifying the product

## Removal Safety

This directory should remain safe to remove as long as these rules are followed:

- no code imports from this directory
- no build references to this directory
- no tests depend on this directory
- no generated assets are written here as part of runtime behavior

If that remains true, deleting `plans/analyst-workbench/` should not affect the repo beyond removing planning documents.
