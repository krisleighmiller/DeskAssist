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
 ├─ tools/             — registry, schemas, file_tools, system_tools (LLM-facing)
 ├─ system_exec.py     — single safe-exec primitive (allowlist + bounded IO +
 │                       timeout) shared by sys_exec tool and user runs
 ├─ filesystem/        — workspace-root-bound path/read/write helpers
 ├─ security/          — command authorization policy (sys_exec confirmation,
 │                       allowlists, output bounds)
 ├─ casefile/          — casefile/lane services + per-feature stores:
 │                       findings, notes, prompts (M4.1), runs (M4.2),
 │                       inbox (M4.3), context manifest, scope/overlay
 ├─ electron_bridge.py — JSON-over-stdio dispatch for every IPC command
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
- **M1–M3 (shipped).** Workbench shell (React + Monaco + tabbed right panel), casefile + lane model, hierarchical scopes / inherited context (M3.5), comparison chat (M3.5c).
- **M4 — Streamlining (shipped).** Prompt drafts (`.casefile/prompts/`), run launcher (`.casefile/runs/`) sharing the safe-exec primitive with the LLM tool, and external local-directory inbox sources (`.casefile/inbox.json`).

### M4 components

- **Prompts (M4.1).** `PromptsStore` persists prompt bodies as `.md` plus a `.json` sidecar with metadata. The renderer's `PromptsTab` lets the user create/edit/delete prompts and pick one as the active system prompt for a lane; `chat:send` injects the selected body as a marker-tagged system message *after* auto-context, with idempotent retries.
- **Runs (M4.2).** `system_exec` is the single source of truth for spawning child processes: it owns the executable allowlist, command-line validation, bounded stdout/stderr capture, and timeout. The legacy `sys_exec` tool is now a thin wrapper around it. `RunsStore` persists each user-launched command as a `RunRecord` (cwd-scoped to a lane or the casefile root) so the `RunsTab` can list, inspect, and delete prior runs.
- **Inbox (M4.3).** `InboxStore` registers external read-only directories in `.casefile/inbox.json`. Items are walked depth-bounded and filtered to text suffixes; reads are size-capped and reject path-escape. The `InboxTab` exposes a "Create finding" action that links the item via the virtual path `_inbox/<source>/<rel>` on a finding owned by the active lane — no schema change to findings.

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
