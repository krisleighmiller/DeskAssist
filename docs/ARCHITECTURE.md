# Architecture

The product spec lives in [`../plans/analyst-workbench/`](../plans/analyst-workbench/README.md). This file describes the **current technical state** of the repo — what exists today and what the immediate build adds.

For the prior product framing ("vendor-agnostic desktop AI assistant for chat...") see [`legacy/ARCHITECTURE_OLD.md`](legacy/ARCHITECTURE_OLD.md). It is retained for historical context only and does not describe the current direction.

## Stack

```
Electron shell (ui-electron/)
 ├─ Main process: main.js — IPC bridge, workspace selection, key storage
 ├─ Preload:      preload.js — exposes safe IPC surface
 └─ Renderer:     renderer/ — current minimal UI; M1 replaces this with
                              Monaco + casefile-aware panels

Python backend (src/assistant_app/)
 ├─ chat_service.py    — conversation state + provider routing + tool dispatch
 ├─ providers/         — HttpChatProvider contract + OpenAI/Anthropic/DeepSeek
 ├─ tools/             — registry, schemas, file_tools, system_tools
 ├─ filesystem/        — workspace-root-bound path/read/write helpers
 ├─ security/          — command authorization policy (sys_exec confirmation,
 │                       allowlists, output bounds)
 ├─ config.py          — AppConfig and workspace root setup
 └─ models.py          — chat request/response primitives
```

The Electron main process spawns the Python backend and routes messages through IPC. Tests cover the backend in isolation (`pytest -q`).

## What Is Implemented

- Provider-agnostic chat with OpenAI, Anthropic, DeepSeek under a shared `HttpChatProvider` contract.
- Workspace-root-bound filesystem helpers (`WorkspaceFilesystem`).
- Tool registry with schema validation, policy enforcement, audit envelope.
- File tools: `list_dir`, `read_file`, `save_file`, `append_file`, `delete_file`.
- System tool: `sys_exec` with explicit `confirm`, low-risk executable allowlist, bounded output, timeout.
- Electron shell with workspace picker, file browse, chat panel, API key storage (keytar with file fallback).

## What Is Planned (M1–M4)

See [`../plans/MILESTONES.md`](../plans/MILESTONES.md) for the full plan. Short version:

- **M1 — Workbench shell.** Replace the current renderer with React + Monaco + a four-tab right panel (Chat / Notes / Findings / Lanes). Backend unchanged.
- **M2 — Casefile + lanes.** New `Casefile` and `Lane` services. `lanes.json` source of truth. Per-lane chat, file tree, notes. Lane switcher in the UI.
- **M3 — Cross-lane operations.** Compare lanes (file-tree diff + per-file Monaco diff), structured Findings panel, markdown export.
- **M4 — Streamlining.** Prompt drafts as first-class objects, run launcher that captures stdout into the casefile, first local "inbox" source.

## Key Architectural Decisions

1. **Casefile is the primary object.** Not a chat thread. Not a workspace root. A casefile is a directory with a `.casefile/` metadata folder and one or more registered lanes.
2. **A lane is a named, scoped container.** Most often a directory. Always paired with a `kind` (`repo`, `doc`, `rubric`, `review`, etc.) that hints at default panels. Every chat message, edit, finding, and run is bound to exactly one lane.
3. **No git dependency for lane separation.** Lanes are sibling directories; the IDE registers them explicitly. This is what enables AMETHYST/BOXING_CLAUDE-style workflows where multiple repo copies coexist without versioning.
4. **Monaco, not a VS Code fork.** The IDE-quality editor surface comes from the Monaco npm package directly. The shell is built around the casefile model, not around a generic workbench framework.
5. **Backend stays headless and Pythonic.** The renderer talks to it via IPC. Future surfaces (CLI, web) can reuse the same backend.

## Access Model

- User explicitly registers casefile roots.
- Workspace-root-bound filesystem rejects access outside registered roots.
- `sys_exec` requires per-call confirmation and an allowlisted executable.
- Future: lane-scoped permissions (a tool call inside `Run1` cannot touch `Run2`'s files).
