# DeskAssist Milestones (M1–M4)

This is the **concrete execution plan** for DeskAssist. The product spec it implements lives in [`analyst-workbench/`](analyst-workbench/README.md); the long-form phased thinking lives in [`analyst-workbench/PHASED_PLAN.md`](analyst-workbench/PHASED_PLAN.md). This file is what work is actually scheduled against.

These four milestones cover the path from the current inherited backend foundation to a casefile-aware workbench that satisfies the "repo review" and "cross-source analysis" success definitions in the product spec. Monitoring/triage (the "Analyst Assistant" outcome) is explicitly deferred past M4.

## Guiding Constraints

- The casefile is the primary object. A milestone is not done until the relevant code paths know they are operating on a casefile + lane, not on a bare workspace root.
- The Python backend (`src/assistant_app/`) stays headless and reusable. UI work happens in `ui-electron/`. Renames of the `assistant_app` package are out of scope until at least M4 ships.
- Each milestone must keep `pytest -q` green and must not break the existing Electron shell's ability to launch and run a chat against a configured provider.
- A feature is in scope only if it satisfies the test in [`analyst-workbench/REPO_GUARDRAILS.md`](analyst-workbench/REPO_GUARDRAILS.md): does it deepen repo analysis, improve review, add structured context, ground cross-source reasoning, or turn analysis into reusable outputs?

---

## M1 — Workbench Shell

**Goal.** Replace the current minimal renderer (`ui-electron/renderer/index.html` + `renderer.js` + `styles.css`) with a real workbench: file tree, Monaco editor, and a four-tab right panel (Chat / Notes / Findings / Lanes). The backend is unchanged.

**Why first.** Every later milestone needs a surface to render lanes, findings, and diffs. M1 stops us from bolting casefile concepts onto an HTML shell that cannot represent them.

**In scope.**
- React + Monaco renderer, built with Vite, served by Electron.
- Three-pane layout: left file tree (rooted at the current workspace), center Monaco editor with tab strip, right tabbed panel.
- Right panel tabs: Chat (existing chat UX, ported), Notes (free markdown scratch), Findings (placeholder list, structure defined in M3), Lanes (placeholder list, structure defined in M2).
- Preload/IPC surface in `ui-electron/preload.js` extended only as needed for file-tree reads and editor open/save. Reuse existing `electron_bridge.py` endpoints.
- Renderer build pipeline wired into `npm start` (Vite dev server + Electron main, or pre-bundled assets).

**Out of scope.**
- Any change to `chat_service.py`, providers, tools, filesystem, or security layers.
- Casefile or lane services. Notes/Findings/Lanes tabs are placeholders.
- Multi-window, settings UI redesign, theme system.

**Backend touch points.** None expected. If a missing IPC handler is discovered, add it to `electron_bridge.py` with a corresponding test in `tests/test_electron_bridge.py`.

**Exit criteria.**
1. `cd ui-electron && npm install && npm start` opens the new workbench and lets you browse files, open one in Monaco, edit and save, and have a chat in the Chat tab against a configured provider.
2. All four right-panel tabs render and switch without error.
3. `pytest -q` is green.
4. The old `index.html`/`renderer.js`/`styles.css` are removed (not left as dead code).

---

## M2 — Casefile + Lanes

**Goal.** Introduce the casefile and lane abstractions in both the backend and the UI. After M2, the workbench operates on a registered casefile containing one or more named lanes, not on a bare directory.

**In scope.**
- New backend module `src/assistant_app/casefile/` with:
  - `Casefile` (root path + `.casefile/` metadata directory).
  - `Lane` (name, kind, root path, scoped filesystem).
  - `lanes.json` as the source of truth for which lanes exist in a casefile and what `kind` each is (`repo`, `doc`, `rubric`, `review`, etc.).
- Casefile registration: `electron_bridge.py` exposes "open casefile", "list lanes", "register lane", "switch lane".
- Per-lane scoping: `WorkspaceFilesystem` becomes lane-bound; tool calls inside a lane cannot read or write outside it.
- Per-lane chat: `chat_service.py` keys conversation state by `(casefile_id, lane_id)`. Switching lanes switches chat history.
- UI: lane switcher in the Lanes tab, file tree re-rooted to the active lane, chat tab shows the active lane's history.
- Tests: `tests/test_casefile.py`, `tests/test_lanes.py`; extend `tests/test_filesystem_helpers.py` and `tests/test_chat_service.py` for lane scoping.

**Out of scope.**
- Cross-lane operations (M3).
- Findings persistence beyond a flat per-lane notes file.
- Auto-discovery of lanes from heuristics; lanes are registered explicitly.

**Backend touch points.** `filesystem/`, `chat_service.py`, `electron_bridge.py`, plus the new `casefile/` package.

**Exit criteria.**
1. A user can open a casefile directory, see its registered lanes, register a new lane pointing at a sibling directory, switch between lanes, and have chat + file tree update accordingly.
2. A tool call issued in lane A cannot touch lane B's files (covered by tests).
3. `lanes.json` round-trips: editing it on disk and reopening the casefile reflects the change.
4. `pytest -q` is green.

---

## M3 — Cross-Lane Operations

**Goal.** Make the value of having multiple lanes visible: compare them, capture findings against them, export the result.

**In scope.**
- Lane comparison view:
  - File-tree diff between two selected lanes (added / removed / changed).
  - Per-file Monaco diff editor for any file present in both.
- Findings panel becomes structured:
  - A finding has `id`, `lane_id` (or `[lane_a, lane_b]` for comparisons), `title`, `body` (markdown), `severity`, `created_at`, `source_refs` (list of `{lane_id, path, line_range?}`).
  - Persisted under the casefile's `.casefile/findings/` directory as one file per finding.
  - Backend module `src/assistant_app/casefile/findings.py` + `tests/test_findings.py`.
- Markdown export: "export findings + notes for lane(s) X" produces a single review document under `.casefile/exports/`.
- Chat can cite findings (read-only): a tool that lists/reads findings for the active lane or comparison.

**Out of scope.**
- Three-way diffs.
- Branch/commit-aware diffs (lanes are sibling directories, no git assumption).
- Inline editing of findings inside Monaco; Findings panel owns editing.

**Backend touch points.** `casefile/findings.py` (new), new findings tool in `tools/`, export helper.

**Exit criteria.**
1. With at least two lanes registered, the Lanes tab can launch a comparison; the file-tree diff and Monaco per-file diff both render.
2. A finding created against a comparison persists to disk and reloads on restart.
3. `Export` produces a readable markdown review note with citations back into lanes.
4. `pytest -q` is green.

---

## M3.5 — Hierarchical Scopes + Inherited Context

**Goal.** Replace the flat-and-isolated lane model with a tree of user-defined scopes, each rooted at a real directory, where chats inherit read access from their ancestors and from a workspace-level "always-on" context manifest. After M3.5, opening an evaluation family, a book, or a code project all use the same primitive — the user nests scopes to whatever depth their material needs.

**Why before M4.** M2 baked "lanes are flat and isolated" into the schema; M3 built findings/notes/compare/export on top of it. M4 (prompts, runs, inboxes) all want to live *inside* a scope and inherit its context. Doing M4 on the flat model means rewriting M4 once we eventually fix the model. M3.5 also unblocks the actual workflow that motivated DeskAssist: discussing one part of a workspace without losing access to the workspace-level rubrics or to paired notes.

**In scope.**

- *Schema.* `Lane` gains `parent_id: string | null` and `attachments: [{ name, root, mode: "read" }]`. New `.casefile/context.json` (separate from `lanes.json`) holds `{ "files": [<paths/globs at casefile root>], "auto_include_max_bytes": 32768 }`. Both files are versioned. `lanes.json` schema bumps to `version: 2`.
- *Migration.* The store reads version 1 by treating every existing lane as a root with no attachments and writes back as version 2 on first modification. Tests cover the upgrade path; no manual user action required.
- *Cascade resolver.* New `assistant_app/casefile/scope.py` with `resolve_scope(lane_id) -> ScopeContext`. A `ScopeContext` carries the lane's write root, an ordered list of ancestor read roots (nearest first), the lane's attachment roots, the casefile's always-on file list, and the auto-include byte budget. Pure data — no I/O at construction.
- *Filesystem.* `WorkspaceFilesystem` learns to accept a list of read roots while keeping write operations bound to the single primary root. Path resolution tries roots in order and reports which root a hit came from so the model sees stable virtual paths (`_ancestors/<lane_name>/...`, `_attachments/<attachment_name>/...`, `_context/...`). Symlink and traversal protection from M2 stays.
- *Bridge.* `chat:send` resolves the active lane's `ScopeContext`, builds the tool registry with the multi-root reader + single-root writer, and prepends auto-included context files (those under `auto_include_max_bytes`) as a system message. New commands: `casefile:saveContext`, `casefile:getContext`. `casefile:registerLane` accepts optional `parentId` and `attachments`. The casefile snapshot returned by IPC carries the lane tree, not a flat list.
- *Comparison chat.* New `casefile:openComparison` / `casefile:sendComparisonChat` taking two or more lane ids. Tool registry sees the union of those lanes' `ScopeContext`s (read-only across all of them; writes refused). History persisted to `.casefile/chats/_compare__<sorted-lane-ids>.jsonl`. Findings created in a comparison chat default to `lane_ids = <those ids>` (M3 already supports the shape).
- *Renderer.*
  - `LanesTab` becomes a tree view (collapsible). Selecting a node sets it as the active scope. Compare is now "select N+ siblings" via checkbox in the tree.
  - Toolbar shows a breadcrumb (e.g. `BOXING_CLAUDE › TASK_9 › ash`) instead of just the lane name.
  - File tree gets a "Show ancestor files" toggle — off by default, on shows a read-only overlay of ancestor + attachment files prefixed by their virtual root name.
  - Right panel gets a "Comparison" mode active when a comparison session is open; banner indicates which lanes it spans.
  - Register-lane form gains an optional parent picker (defaults to currently active scope) and an "Add attachment…" affordance.
  - Small "Workspace context" editor lets the user pick which casefile-root files are auto-included.

**Out of scope.**

- Cross-casefile context (always-on manifest is per-casefile only).
- Auto-discovery of scopes from heuristics; scopes are still registered explicitly.
- Multi-write lanes. A chat writes to exactly one root, full stop.
- Renaming "lane" to "scope" or "section" in the codebase. Pick one term in M4 if we want, not now.

**Defaults (settled, can be tuned later).**

- `auto_include_max_bytes = 32768`. Files under that auto-inject as system context; larger files are read on demand via tool calls.
- Path display is **virtual** (`_ancestors/...`, `_attachments/...`, `_context/...`), not absolute, both in tool responses and in the file tree's ancestor overlay.

**Backend touch points.** `casefile/models.py`, `casefile/store.py`, `casefile/service.py`, `casefile/scope.py` (new), `filesystem/workspace.py`, `electron_bridge.py`, `tools/__init__.py` (registry now takes a list of read roots).

**Phasing.** Three internal phases, each independently shippable and testable.

- **M3.5a — Schema + cascade + multi-root FS (backend only).** Lanes gain parent/attachments, context.json lands, ScopeContext resolver works, WorkspaceFilesystem reads from multiple roots and writes to one, bridge `chat:send` uses the cascade and auto-injects small context files. Backend tests cover all of this. The renderer is unchanged in this phase, so no visible UI improvement yet — but `chat:send` from a registered child lane will already see ancestors + attachments + context.
- **M3.5b — Renderer tree view + register form + context editor.** Tree-shaped LanesTab with breadcrumb and ancestor-files toggle, parent picker + attachments in the register form, workspace-context editor. This is when the BOXING_CLAUDE-style workflow becomes pleasant in the UI.
- **M3.5c — Comparison chat (backend + UI).** Multi-lane sessions, persisted history, comparison-chat right-panel mode. After this, `Comparison_Prompt.txt` becomes a one-shot interaction.

**Exit criteria (whole milestone).**

1. With a casefile open, `Behavior_Issues.md`-style files listed in the context manifest, and a child lane registered with an attachment, a chat in that child lane sees the manifest files in its system context without manual paste, and `read_file` against an attachment-relative path succeeds.
2. The same chat cannot read or write into a sibling lane (cross-sibling isolation preserved from M2).
3. Selecting two sibling lanes and starting a comparison chat produces a session whose tool calls can read from both lanes plus their ancestors plus the casefile context, and whose history persists across restarts.
4. A finding created from a comparison chat has `lane_ids` matching the session, and the M3 export still works against either lane.
5. An existing M3 casefile (`lanes.json` version 1, no `context.json`) opens without manual migration and is upgraded transparently on first lane modification.
6. `pytest -q` is green; `tsc --noEmit` and `vite build` are clean.

**Test additions.**

- `tests/test_scope_resolution.py` — cascade order, attachment inclusion, casefile-context inclusion, depth correctness, write-root remains single.
- `tests/test_workspace_multi_root.py` — read tries roots in order, writes refuse non-primary roots, traversal protection still rejects `../`.
- `tests/test_lanes_v2_migration.py` — v1 → v2 upgrade is transparent and idempotent; v2 round-trips.
- `tests/test_comparison_chat.py` — multi-lane registry, history persistence, write rejected, findings get `lane_ids` from the session.
- Extend `tests/test_electron_bridge_dispatch.py` with new commands.

---

## M4 — Streamlining

**Goal.** Close the loop from "I have casefiles and lanes" to "I run things and capture results inside the casefile." Add the first non-code source so cross-source analysis becomes real.

**In scope.**
- Prompt drafts as first-class objects:
  - Stored under `.casefile/prompts/` as named markdown files.
  - Editable in Monaco; selectable as the system prompt for a chat in any lane.
- Run launcher:
  - "Run command in lane" invokes `sys_exec` (existing security policy applies, including `confirm`) with the lane root as cwd.
  - Stdout / stderr / exit code captured under `.casefile/runs/<run_id>/`.
  - Runs listed per lane; clicking one opens the captured output.
- First "inbox" source:
  - A local-directory inbox: a configured folder of markdown files appears in the casefile as a non-lane source.
  - Items can be linked into a lane (becomes a finding's `source_ref`) or used as chat context.
- Documentation pass: update `docs/ARCHITECTURE.md` to reflect the casefile/lane/findings/runs model as built (not as planned).

**Out of scope.**
- Live connectors (email, issue trackers, chat). Phase 5 of the long-form plan covers these.
- Background polling or notifications. The inbox is read on demand.
- Auto-summarization of runs.

**Backend touch points.** `casefile/` (prompts, runs, inbox submodules), `tools/` (run launcher tool that wraps `sys_exec` with run capture), possibly a small extension to `security/policy.py` to record run IDs in the audit envelope.

**Exit criteria.**
1. A prompt draft can be created, edited, and selected as the system prompt for a chat in a lane.
2. A run launched from a lane captures full stdout/stderr/exit code into `.casefile/runs/` and is visible in the UI without restarting.
3. A local inbox folder can be configured; its items are listable in the workbench and at least one item can be linked into a lane as a finding source.
4. `docs/ARCHITECTURE.md` matches what the code actually does.
5. `pytest -q` is green.

---

## Cross-Milestone Hygiene

- Every milestone ships with tests. New backend modules require a matching `tests/test_*.py`.
- No milestone may introduce a dependency on the archived `../_Archive/py-gpt/` tree. The migration window is closed; see `docs/legacy/MIGRATION_BACKLOG.md`.
- No milestone renames the `assistant_app` Python package. A dedicated rename milestone is the only acceptable place for that, and it is not scheduled here.
- If a milestone discovers that a planned scope item violates [`analyst-workbench/REPO_GUARDRAILS.md`](analyst-workbench/REPO_GUARDRAILS.md), the scope item is dropped or moved, not the guardrail.

## Status

- M1: done. Vite + React + TypeScript renderer with three-pane layout (file tree / Monaco editor / four-tab right panel: Chat / Notes / Findings / Lanes), chat + tool-approval + API-keys dialog ported. Manually verified end-to-end.
- M2: done. `assistant_app/casefile/` module owns the on-disk shape (`.casefile/lanes.json` + `.casefile/chats/<lane_id>.jsonl`); bridge factored into a dispatch table; `chat:send` resolves the active lane root and uses it as the `WorkspaceFilesystem` root so tool calls in lane A cannot reach lane B; renderer keeps per-lane editor tabs + chat history; Lanes tab is an interactive switcher with a Register Lane flow. Manually verified end-to-end.
- M3.5: in progress (M3.5a + M3.5b shipped; M3.5c — comparison chat — backend + UI landed, awaiting manual verification with a running Electron). M3.5c: new `casefile/scope.py::resolve_comparison_scope` builds a *read-only* `ScopeContext` over any 2+ lanes (each lane mounted under `_lanes/<id>/` plus its ancestors and attachments and the casefile-wide `_context/`); `casefile/store.py` gained `comparison_chat_log_path` + `append_comparison_chat_messages` + `read_comparison_chat_messages` writing to `.casefile/chats/_compare__<sorted-lane-ids>.jsonl` (sorted-id keying makes the path order-independent); `tools/__init__.py::build_default_tool_registry` learned `enable_writes=False` so write tools are *physically absent* from the registry for compare sessions (defence-in-depth alongside the read-only scope); `electron_bridge.py` exposes `casefile:openComparison` (idempotent: returns canonical id + lane summaries + persisted history) and `casefile:sendComparisonChat` (parallel to `chat:send` but write-disabled); preload + main.js + AssistantApi wired up; renderer gained a new `ComparisonChatTab` with a "Compare" right-panel mode and an "Open compare chat" button in `LanesTab` next to the existing diff Compare control. `tests/test_comparison_chat.py` covers id stability, scope union, write-tool omission, the bridge round-trip with persisted-history reload, and finding-store integration with multi-lane `lane_ids`. Full pytest: 180 passing. `tsc --noEmit` and `vite build` clean. M3.5b: tree-shaped LanesTab with parent-aware indentation and per-lane edit panel (parent picker + attachments management); ancestor breadcrumb in the toolbar; FileTree gained a "Show ancestor / attachment / context files" toggle that fetches and renders overlay subtrees and opens overlay files (`_ancestors/<id>/...`, `_attachments/<name>/...`, `_context/...`) as read-only Monaco tabs via a new scope-aware `casefile:readOverlayFile` bridge command; new `ContextEditor` renders/edits the casefile-wide context manifest (patterns + auto-include cap, with resolved-file preview); register-lane form gained parent picker + attachment editor. Bridge surface extended with `casefile:listOverlayTrees` / `casefile:readOverlayFile`; preload + main.js + types + AssistantApi all wired up. `tsc --noEmit` and `vite build` clean; full pytest still 167 passing. Pulled in ahead of M4 because the eval/book/project workflows discussed during M3 verification all depend on hierarchical scopes + inherited context, which the M3 flat-lane model can't express. The previous M3 status entry above remains accurate; M3 exit criteria 1–3 still need manual verification with a running Electron, but no further M3 code is planned. New `assistant_app/casefile/` modules: `findings.py` (one JSON per finding under `.casefile/findings/`, atomic writes, version-checked schema), `notes.py` (per-lane markdown under `.casefile/notes/<lane_id>.md`, atomic writes), `compare.py` (sha256-based file-tree diff, skips `.casefile`/VCS dirs and symlinks, file-count and per-file-byte caps), `export.py` (renders findings + notes for selected lanes into `.casefile/exports/<ts>-<slug>.md`). New read-only chat tools `findings_list` / `findings_read` registered when a casefile is in play, so the model can cite findings without being able to mutate them. Bridge dispatch extended with `casefile:listFindings`, `casefile:getFinding`, `casefile:createFinding`, `casefile:updateFinding`, `casefile:deleteFinding`, `casefile:getNote`, `casefile:saveNote`, `casefile:compareLanes`, `casefile:exportFindings`, and a lane-scoped `lane:readFile` (used by the diff editor to fetch the non-active side without leaving the casefile sandbox). Renderer Notes moved off `localStorage` onto disk with debounced autosave; `FindingsTab` is a real CRUD list with severity badges, lane filter, and an export button; `LanesTab` gained a Compare flow that lists added/removed/changed files; clicking a changed file opens a Monaco DiffEditor in a new editor tab kind. Backend tests cover findings store CRUD + schema validation, notes round-trip, comparison semantics (added/removed/changed/identical/skipped), export markdown shape, and bridge dispatch for every new command (135 passing). `tsc --noEmit` and `vite build` both clean. Exit criteria 1–3 (compare two lanes, persist a comparison-scoped finding, export readable markdown) require manual verification with a running Electron.
- M4: shipped (M4.1 prompts + M4.2 runs + M4.3 inbox + docs landed; awaiting end-to-end manual verification with a running Electron).
  - **M4.1 (Prompts).** New `assistant_app/casefile/prompts.py` — prompt drafts persisted as `.casefile/prompts/<id>.md` (body) + `<id>.json` (metadata sidecar); `PromptsStore` enforces id normalization, body byte cap, atomic writes, and is resilient to a missing/malformed sidecar. `electron_bridge.py` exposes `casefile:listPrompts` / `getPrompt` / `createPrompt` / `savePrompt` / `deletePrompt`; `chat:send` accepts an optional `systemPromptId` and injects the resolved body as a marker-tagged system message *after* auto-context, with idempotency on retries via `_history_has_prompt_marker`. Renderer adds a `PromptsTab` (two-pane editor + use-in-chat selection, per-lane selection in `App.tsx`) and a `chat-prompt-badge` in `ChatTab` showing/clearing the active prompt. `tests/test_prompts_store.py` covers normalization, CRUD, size caps, and resilience; dispatch tests extended.
  - **M4.2 (Runs).** New `assistant_app/system_exec.py` extracts the safe-exec primitive (executable allowlist, path-form rejection, bounded stdout/stderr decoding, timeout) so it is the *single* code path for spawning child processes — `tools/system_tools.py::sys_exec` is now a thin LLM-facing wrapper that still enforces `confirm=true`. New `casefile/runs.py` with `RunRecord` / `RunSummary` / `RunsStore` persists user-launched commands as `.casefile/runs/<run_id>.json`; validation/permission/timeout failures are recorded *into* the record (`exit_code: null` + populated `error`) rather than raised, so the UI renders failed runs alongside successful ones. Bridge surfaces `casefile:listRuns` / `getRun` / `runCommand` / `deleteRun`; the `runCommand` payload uses `commandLine` (not `command`) to avoid colliding with the IPC envelope's command name. Renderer adds a `RunsTab` with a cwd picker (active lane / casefile root / any registered lane), an allowed-executables hint mirrored from the backend, and a detail pane showing stdout/stderr/exit/error. `tests/test_runs_store.py` covers allowlisted execution, error recording for disallowed commands, and listing/filtering; dispatch tests extended.
  - **M4.3 (Inbox).** New `assistant_app/casefile/inbox.py` with `InboxSource` / `InboxItem` / `InboxStore` persisting external read-only sources in `.casefile/inbox.json` (single small file, atomic rewrites). Item walking is depth-bounded (`MAX_INBOX_LIST_DEPTH=4`), filtered to `INBOX_TEXT_SUFFIXES`, and skips hidden + `.casefile` directories; `read_item` enforces a char cap and rejects path-escape via `..`. Bridge exposes `casefile:listInboxSources` / `addInboxSource` / `updateInboxSource` / `removeInboxSource` / `listInboxItems` / `readInboxItem`, plus a `casefile:chooseInboxRoot` directory-picker dialog reusing the lane-root pattern. Renderer adds an `InboxTab` (sources / items / content three-pane, with Add/Browse and Remove flows) and a "Create finding" action that links the selected item via the virtual path `_inbox/<source_id>/<rel>` on a finding owned by the active lane — no schema change to findings. `tests/test_inbox_store.py` covers id normalization, source CRUD, depth-bounded walking, suffix filtering, path-escape rejection, and the truncation contract; dispatch tests cover the full source lifecycle.
  - Verification status: full `pytest -q` is green (250 passing); `tsc --noEmit` clean; `vite build` clean. Manual end-to-end exercise of prompts/runs/inbox in a running Electron is still TODO.

Update this section as milestones complete. Each milestone's exit criteria are the gate; partial completion is tracked in the milestone's own working notes, not here.
