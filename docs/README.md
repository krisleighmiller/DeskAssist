# DeskAssist Documentation

This documentation set starts from the application as it exists now.

The goal is to reduce confusion from older milestone history. Use these docs to answer:

- what does DeskAssist do today?
- what is incomplete from the current baseline?
- what should be built next?
- how does the current architecture work?

## Reading Order

Read in this order:

1. [`current-state.md`](current-state.md) for the current product, implementation, and gap baseline.
2. [`planning/roadmap.md`](planning/roadmap.md) for the forward roadmap from the current baseline.
3. [`architecture/system-overview.md`](architecture/system-overview.md) for runtime boundaries and persistence.
4. [`architecture/domain-model.md`](architecture/domain-model.md) for vocabulary and data model mapping.
5. [`architecture/runtime-flows.md`](architecture/runtime-flows.md) for major flows that exist today.
6. [`planning/open-questions.md`](planning/open-questions.md) for live decisions that still need product or architecture calls.

The top-level [`../README.md`](../README.md) remains the product overview. This `docs/` tree is the contributor-facing operating manual.

## Source Of Truth

For current state, use [`current-state.md`](current-state.md).

For execution order, use [`planning/roadmap.md`](planning/roadmap.md).

If an older architecture or planning document appears to disagree with the current-state baseline, update the older document instead of treating old milestone language as authoritative.

## What Each Doc Is For

[`current-state.md`](current-state.md)

- Baseline of what is implemented now.
- Known gaps from the current app.
- Current priority order.

[`planning/roadmap.md`](planning/roadmap.md)

- Forward plan from the current app baseline.
- Near-term work areas and exit criteria.
- Sequencing for current-state gaps.

[`planning/open-questions.md`](planning/open-questions.md)

- Live decisions that could change product or architecture direction.
- Provisional defaults for moving forward without drift.

[`architecture/system-overview.md`](architecture/system-overview.md)

- Current Electron, React, and Python split.
- Current persistence shape.
- Current scope resolution model.

[`architecture/domain-model.md`](architecture/domain-model.md)

- Product and implementation vocabulary.
- How `workspace`, `casefile`, `context`, `scope`, `comparison`, and `attachment` relate.

[`architecture/runtime-flows.md`](architecture/runtime-flows.md)

- Main runtime paths for opening work, file operations, context chat, comparison chat, and watch refresh.

[`architecture/target-v1-architecture.md`](architecture/target-v1-architecture.md)

- Historical shaping doc for the intended V1 architecture.
- Useful for context, but not the first source for current planning.

[`architecture/product-north-star.md`](architecture/product-north-star.md)

- Historical product framing.
- Useful for direction, but superseded for execution by the current-state baseline and roadmap.

## Documentation Policy

Docs should describe the app as it is now, then map forward from there.

Avoid:

- revisiting closed milestones as if they are still the planning model
- documenting removed surfaces as current
- introducing future platform or integration language before the core workspace/context/scope loops are stronger
- using implementation history as the explanation for current product behavior
