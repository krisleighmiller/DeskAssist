# DeskAssist Documentation

This `docs/` tree turns the product direction in [`README.md`](../README.md) into a contributor-facing set of architecture and planning documents.

Use these docs for internal alignment. The top-level README remains the product and roadmap statement. This docs set explains how the current app works, how its implementation terms map to the product vision, and what should happen next.

## Reading Order

If you are new to the project, read in this order:

1. [`../README.md`](../README.md) for product direction and roadmap.
2. [`architecture/system-overview.md`](architecture/system-overview.md) for runtime boundaries and persistence.
3. [`architecture/domain-model.md`](architecture/domain-model.md) for the current and target vocabulary.
4. [`architecture/runtime-flows.md`](architecture/runtime-flows.md) for the key flows that already exist in the app.
5. [`architecture/target-v1-architecture.md`](architecture/target-v1-architecture.md) for the intended technical shape of V1.
6. [`planning/roadmap.md`](planning/roadmap.md) for workstreams and dependencies.
7. [`planning/near-term-execution-plan.md`](planning/near-term-execution-plan.md) for the next implementation phases.
8. [`planning/open-questions.md`](planning/open-questions.md) for the unresolved decisions that should guide future work.

## What Each Doc Is For

[`architecture/system-overview.md`](architecture/system-overview.md)

- Explains the current Electron, React, and Python split.
- Describes where state lives and how data moves.
- Summarizes the current storage layout under `.casefile/`.

[`architecture/domain-model.md`](architecture/domain-model.md)

- Defines the current implementation terms such as `casefile`, `lane`, and `scope`.
- Maps those terms to the broader product language in the README.
- Recommends which terms should remain internal and which should become user-facing.

[`architecture/runtime-flows.md`](architecture/runtime-flows.md)

- Walks through the important runtime paths.
- Anchors the docs in concrete code paths such as `ui-electron/main.js`, `ui-electron/preload.js`, `ui-electron/renderer/src/App.tsx`, and `src/assistant_app/electron_bridge.py`.

[`architecture/target-v1-architecture.md`](architecture/target-v1-architecture.md)

- Describes the target architecture implied by the README's five-layer model.
- Identifies where the current code already aligns and where it still leaks implementation detail into the product.

[`planning/roadmap.md`](planning/roadmap.md)

- Converts the README phases into engineering workstreams.
- Highlights dependencies, code hotspots, and exit criteria.

[`planning/near-term-execution-plan.md`](planning/near-term-execution-plan.md)

- Focuses on the next 2-3 phases of implementation.
- Gives a concrete execution baseline for the most immediate work.

[`planning/open-questions.md`](planning/open-questions.md)

- Captures the decisions that will materially change architecture and UX direction.
- Provides provisional defaults so work can continue without drifting.

## How To Use These Docs

When adding or changing features:

- Check whether the work fits the product direction in [`../README.md`](../README.md).
- Check whether the implementation matches the terminology guidance in [`architecture/domain-model.md`](architecture/domain-model.md).
- If the change affects runtime boundaries or persistence, update [`architecture/system-overview.md`](architecture/system-overview.md) and [`architecture/runtime-flows.md`](architecture/runtime-flows.md).
- If the change changes priorities or sequencing, update the planning docs in `docs/planning/`.

## Current Documentation Stance

These docs deliberately describe the system in two ways at once:

- the current implementation, so contributors can work safely in the codebase as it exists today
- the intended product framing, so future work moves the app toward a unified context-switching workspace instead of reinforcing narrow internal concepts

That distinction is important in DeskAssist right now. The codebase already has strong scoped-work foundations, but those foundations need better framing and cleaner boundaries to support the larger product vision.
