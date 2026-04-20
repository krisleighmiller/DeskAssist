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

- M1: not started.
- M2: not started.
- M3: not started.
- M4: not started.

Update this section as milestones complete. Each milestone's exit criteria are the gate; partial completion is tracked in the milestone's own working notes, not here.
