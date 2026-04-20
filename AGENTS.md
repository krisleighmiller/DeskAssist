# Agent Orientation

If you are an AI assistant (Cursor, Claude, etc.) opening this repository, read this first.

## What This Project Is

DeskAssist is a workspace-first IDE and personal assistant. Its primary object is the **casefile** — a directory containing one or more parallel **lanes** (repos, prompt iterations, agent attempts, review variants), each with its own scoped chat, notes, findings, and artifacts.

It is deliberately **not** a fork of VS Code, Void, or Zed. It builds an Electron shell + Monaco editor + Python backend.

## Required Reading Before Suggesting Changes

In order:

1. `plans/analyst-workbench/README.md` — product thesis and definition of success.
2. `plans/analyst-workbench/PHASED_PLAN.md` — long-form phase 0–6 plan.
3. `plans/MILESTONES.md` — concrete M1–M4 execution plan; this is what is actually being built next.
4. `plans/analyst-workbench/REPO_GUARDRAILS.md` — what counts as "in scope" for a feature.
5. `docs/ARCHITECTURE.md` — current technical layout.

## What Not To Do

- Do not propose forking VS Code, Void, or Zed. That decision was made and reversed; see the project history if curious.
- Do not propose making chat the primary surface. Chat is one panel inside the casefile; it is not the product.
- Do not pull more code from `../_Archive/py-gpt/` without an explicit decision. The migration window is closed; relevant pieces are already in `src/assistant_app/`. See `docs/legacy/MIGRATION_BACKLOG.md` for the frozen triage table.
- Do not rename Python modules (`assistant_app`, etc.) for cosmetic alignment with the new project name. Tests depend on them. Renames happen in a dedicated milestone if at all.
- Do not add features that fail the test in `plans/analyst-workbench/REPO_GUARDRAILS.md` (does it deepen repo analysis, improve review, add structured context, ground cross-source reasoning, or turn analysis into reusable outputs?).

## What Lives Where

| Concern | Location |
|---|---|
| Product spec (canonical) | `plans/analyst-workbench/` |
| Execution plan | `plans/MILESTONES.md` |
| Current architecture | `docs/ARCHITECTURE.md` |
| Frozen historical docs | `docs/legacy/` |
| Python backend | `src/assistant_app/` |
| Electron shell | `ui-electron/` |
| Tests | `tests/` |

## Conventions

- Python package import root is `assistant_app`. Tests run via `pytest -q` from the repo root.
- Electron main process: `ui-electron/main.js`. Renderer: `ui-electron/renderer/`.
- Provider adapters share the `HttpChatProvider` contract in `src/assistant_app/providers/http_chat.py`.
- Tools must register through `src/assistant_app/tools/registry.py` with an explicit schema and policy.
