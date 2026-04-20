# DeskAssist

A workspace-first IDE and personal assistant that brings repositories, documents, prompts, inbox items, tasks, and ongoing work memory into one place so you can review, synthesize, draft, and move work forward.

DeskAssist is **not** another chat-with-your-files tool and **not** a fork of VS Code or Void. It is a small, opinionated workbench whose primary object is the **casefile** — a directory holding one or more parallel **lanes** (repos, prompt iterations, agent attempts, review variants) that the assistant reasons about as first-class, isolated contexts.

## Status

Phase 0 (intent and product spec) is complete. The canonical product description lives in [`plans/analyst-workbench/`](plans/analyst-workbench/README.md). The execution path is in [`plans/MILESTONES.md`](plans/MILESTONES.md).

The current code in this repo is the **inherited backend foundation** from the previous `desktop-assistant-new` codename (vendor-agnostic provider adapters, workspace-bound filesystem, tool registry with security policy, Electron shell). It works. It is the trunk for everything that follows.

## What's Here

- `src/assistant_app/` — Python backend: providers, tools, filesystem, security, chat service.
- `ui-electron/` — Electron shell with a minimal renderer. Will be rebuilt around Monaco + a casefile-aware UI in M1.
- `tests/` — pytest suite covering providers, tools, filesystem, policy.
- `plans/` — canonical product spec and execution plan. **Read these before changing direction.**
- `docs/` — current technical architecture; `docs/legacy/` holds frozen records from the previous product framing.

## Running

```bash
pytest -q
```

```bash
cd ui-electron
npm install
npm start
```

## What This Project Replaces

This repo supersedes and consolidates several earlier attempts now archived under `../_Archive/`:

- `desktop-assistant-new` — the trunk, renamed to DeskAssist.
- `void-linux-port` — VS Code fork; abandoned (too much bloat, too high a merge tax).
- `vscode`, `zed` — reference checkouts; not building on either.
- `skales`, `py-gpt` — donor codebases; relevant pieces already migrated (see `docs/legacy/MIGRATED_FROM_LEGACY.md`).

## Where to Start Reading

1. [`plans/analyst-workbench/README.md`](plans/analyst-workbench/README.md) — product thesis, primary object, workflows, non-goals.
2. [`plans/MILESTONES.md`](plans/MILESTONES.md) — concrete M1–M4 build plan.
3. [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — technical layout as it stands today.
4. [`AGENTS.md`](AGENTS.md) — orientation for AI assistants opening this repo.
