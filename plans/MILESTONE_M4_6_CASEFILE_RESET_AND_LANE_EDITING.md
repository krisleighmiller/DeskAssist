# M4.6 — Casefile Reset & Lane Editing

A focused milestone slotted after M4.5 (assistant charter). Adds the operational primitives the analyst needs to iterate on a casefile: full reset for repeatable tests, soft reset for new tasks, and the missing pieces of lane CRUD (edit + remove).

## Goal

Give the user three operations they currently lack:

1. **Hard reset (`Revert casefile`).** Restore the casefile to its pre-DeskAssist state — wipe everything under `.casefile/`. Buried in a menu, gated by confirmation. Primary use case: repeatable charter / behavior testing without prior chat history skewing the model's defaults.
2. **Soft reset (`New task`).** Wipe per-task scratch (lanes, chats, findings, notes, runs, exports) but keep durable setup (`context.json` always; prompts conditionally based on a per-call user choice). Primary use case: starting the next task in the same casefile without losing rubrics.
3. **Lane editing + removal.** Edit a lane's `name`, `kind`, and `root` directory; remove a lane without losing its chat / notes / findings (hidden-but-recoverable). Primary use case: fixing a wrong-directory mistake without rebuilding the whole casefile.

## Why now

Surfaced during M4.5 manual verification against `Boxing_test`:

- **No way to test the charter from a clean slate.** Chat history persists across sessions per `(casefile, lane)`, so a model that has already produced an "execution plan" in a lane will see that turn in its history and may anchor on it. Without a hard reset, "did the charter actually change behavior?" is unanswerable.
- **Wrong-directory lane bug.** `Boxing_test`'s `modelb` lane was registered pointing at `TEST_TASK` (the parent) rather than at the elm subdirectory. Today there is no way to fix that short of hand-editing `.casefile/lanes.json`, which defeats the point of having a UI.
- **No "next task" path.** Reusing a casefile across tasks (boxing eval round 1, then round 2) means manually deleting lanes and chats one by one. The rubrics in `_context/` and the prompt drafts in `.casefile/prompts/` are the same; only the per-task scratch needs to clear.

## What lands

### Hard reset

- Backend: `CasefileService.hard_reset()` removes the entire `.casefile/` directory tree and re-initializes it (empty `lanes.json` v2, no chats, no findings, no notes, no prompts, no runs, no exports, no inbox, no context manifest).
- Bridge: `casefile:hardReset` (takes `casefileRoot`).
- UI: a `⋯` overflow menu on the Casefile header in `LanesTab` (or a new `Casefile` toolbar menu, see UI Decisions below) with a `Revert casefile…` item. Click opens a confirmation dialog that names the casefile and warns "this will delete all lanes, chat history, findings, notes, runs, exports, and prompts." Confirm wipes.

### Soft reset (`New task`)

- Backend: `CasefileService.soft_reset(*, keep_prompts: bool)` removes:
  - `chats/` (per-lane and `_compare__*` logs).
  - `findings/` (all entries).
  - `notes/` (all entries).
  - `runs/` (all entries).
  - `exports/` (all entries).
  - `lanes.json` reset to an empty version-2 file (`lanes: []`, `active_lane_id: null`).
  - `prompts/` if and only if `keep_prompts is False`.

  Preserves:
  - `context.json` (the auto-include manifest).
  - `inbox.json` (configured external sources).
  - `prompts/` if `keep_prompts is True`.

- Bridge: `casefile:softReset` (takes `casefileRoot`, `keepPrompts: bool`).
- UI: same menu, `New task…` item. Confirmation dialog includes a checkbox `Keep prompt drafts` (defaulted however we decide — see UI Decisions). Confirm executes the reset.

### Lane editing

- Backend: `CasefileService.update_lane(lane_id, *, name, kind, root)` — new wrapper, all three fields optional (None means "leave alone"). Delegates to a new `CasefileStore.update_lane` that produces a new `Lane` record with the requested fields swapped in and writes it back.
- Conflict detection: if `root` is being changed (or if the call is wrapped from a register flow), the service / bridge surfaces a warning when another lane already points at the same resolved path. **Warning, not block.** The system already supports overlapping roots; we're just making the confusion visible.
- Bridge: `casefile:updateLane` taking `casefileRoot`, `laneId`, optional `name`, `kind`, `root`. Returns the updated snapshot plus an optional `rootConflict: { conflictingLaneId }` field for the renderer to surface as a warning *after* the update has been written. (Two-phase confirm — backend writes, frontend can surface "by the way, this overlaps lane X" as info, not as a blocking dialog. See "Conflict UX" below for the alternative.)
- UI: extend the existing lane edit panel in `LanesTab` (`editLaneId` state) with editable `Name`, `Kind` (dropdown: `repo` / `doc` / `rubric` / `review` / `other`), and `Root` (text + Browse button reusing the existing directory picker). Save button issues `casefile:updateLane`.

### Lane removal

- Backend: `CasefileService.remove_lane(lane_id)` — wraps the existing `CasefileStore.remove_lane` (which already handles re-parenting children and re-picking the active lane). **Does not delete** `chats/<lane_id>.jsonl`, `notes/<lane_id>.md`, or any findings tagged with the lane id. They remain on disk.
- Bridge: `casefile:removeLane` taking `casefileRoot`, `laneId`.
- UI: a `Remove lane` button in the edit panel. Confirmation dialog explains "this removes the lane from the casefile. Its chat history, notes, and findings will be hidden but kept on disk; re-registering a lane with the same id (`<lane_id>`) will surface them again." Confirm wipes the lane entry.

## In scope

- Three new bridge commands: `casefile:hardReset`, `casefile:softReset`, `casefile:updateLane`, `casefile:removeLane`. (Four. Math.)
- Three new `CasefileService` methods: `hard_reset`, `soft_reset`, `update_lane`. (`remove_lane` already exists in the store; service wrapper is trivial.)
- One new `CasefileStore` method: `update_lane`.
- LanesTab UI extensions:
  - Casefile-level overflow menu with `New task…` and `Revert casefile…`.
  - Lane edit panel gains `Name` / `Kind` / `Root` fields and a `Remove lane` button.
  - Three new confirmation dialogs (or one parameterised one).
- Tests:
  - `tests/test_casefile_reset.py` — hard reset wipes everything; soft reset preserves the right files; `keep_prompts` toggle works; both succeed on an already-empty casefile (idempotent).
  - Extend `tests/test_casefile_store.py` (or a new `tests/test_casefile_lane_edit.py`) — `update_lane` round-trips name / kind / root, rejects bad ids, refuses to change a lane that doesn't exist; `remove_lane` exposed via service preserves on-disk data files.
  - Extend `tests/test_electron_bridge_dispatch.py` — bridge dispatch for the four new commands, including the conflict-flag in `casefile:updateLane`.

## Out of scope

- **Data-merge / data-restore on lane re-registration.** "Re-registering lane id `<x>` should auto-restore its chats / notes / findings from disk" is a sensible follow-up, but it's a separate piece of UX and not required to fix the immediate Boxing_test bug. Filed as an open question, not implemented.
- **Cascade delete option for lane removal.** Hidden-but-recoverable is the only mode in M4.6. If the user wants the cascade option later, it's an additive bridge flag.
- **Renaming the lane id.** `update_lane` changes name / kind / root only. Changing the id is a much bigger surgery (it's the filename stem for chats / notes; renaming would have to migrate those files) and is not requested.
- **Multi-lane "remove these N lanes" bulk operation.** One lane at a time.
- **Undo for hard / soft reset.** They are destructive by design. Confirmation is the safety net.
- **Backups.** No automatic snapshot before reset. A user who wants a backup can copy the casefile directory.

## Conflict UX (root overlap on edit / register)

Open question. Two viable shapes:

- **A — Post-write info banner.** Backend writes the change, returns `rootConflict: { conflictingLaneId }` if applicable, renderer shows a passive warning ("Heads up: lane `task` also points at this directory."). Pro: simple; never blocks the user. Con: easy to miss.
- **B — Pre-write confirmation.** Backend includes a `dryRun` mode that detects the conflict and returns it without writing. Renderer shows a modal: "Lane `task` already points here. Continue anyway?" with Cancel / Continue. Pro: harder to miss. Con: extra round-trip and more UI plumbing.

**Recommendation:** start with A. The user explicitly framed this as "gating" with "options," but in practice the only useful options are "use anyway" (which is what the user clicked through to here) and "cancel" (which they can do by not editing). A warning that surfaces the conflict accomplishes the goal without adding modal noise. If A turns out to be too easy to miss in real usage, upgrade to B.

## UI Decisions

Worth pinning before implementation:

1. **Where the menu lives.** Two reasonable choices:
   - In the `LanesTab` header (e.g. a `⋯` next to the casefile name). Keeps casefile-level operations co-located with lane operations. Slight risk: the menu only renders when the Lanes tab is visible.
   - As a top-level `Casefile` menu in the `Toolbar`. Always reachable. Slight risk: yet another toolbar element.
   - **Default for M4.6**: Lanes tab header overflow menu. The user explicitly said "buried" — a tab-local menu is more buried than a toolbar menu.
2. **`Keep prompt drafts` default.** True (preserve them) or False (wipe by default)?
   - **Default for M4.6**: True. "Sometimes I reuse, sometimes I don't" + the destructive default is the safer one.
3. **Confirmation dialog text.** Each dialog must name *what* is being destroyed. Hard reset names "all chats, findings, notes, runs, exports, prompts, lanes, context manifest, and inbox configuration." Soft reset names the per-task scratch and notes whether prompts are being kept. Lane remove names that data is hidden, not deleted.

## Backend touch points

- `src/assistant_app/casefile/store.py` — `update_lane` (new); helper to remove the entire `.casefile/` directory used by `hard_reset`; selective-delete helpers used by `soft_reset`.
- `src/assistant_app/casefile/service.py` — `hard_reset`, `soft_reset`, `update_lane`, `remove_lane` (wrapper).
- `src/assistant_app/electron_bridge.py` — four new dispatch handlers + dispatch-table entries.
- `ui-electron/main.js` + `preload.js` + `renderer/src/types.ts` + `renderer/src/api.ts` (or equivalent) — IPC plumbing.
- `ui-electron/renderer/src/components/LanesTab.tsx` — overflow menu, edit-panel extensions, remove button, confirmation dialogs.

No changes to `chat_service.py`, providers, tools, security, or charter.

## Exit criteria

1. Manual: in `Boxing_test`, `Revert casefile…` returns the casefile to a state indistinguishable from "never opened in DeskAssist" — `.casefile/` contains only the freshly initialized files.
2. Manual: `New task…` with `Keep prompt drafts` checked wipes lanes/chats/findings/notes/runs/exports but leaves `context.json` and `prompts/` intact. With it unchecked, `prompts/` is also wiped.
3. Manual: editing the `modelb` lane to point at `TEST_TASK/elm` (the correct subdirectory) saves successfully and the file tree re-roots accordingly. If another lane already points at `TEST_TASK/elm`, the renderer surfaces a non-blocking warning.
4. Manual: removing the `modelb` lane removes it from the lane list. Re-registering a lane with id `modelb` surfaces the prior chat history (because it was hidden, not deleted).
5. Automated: hard reset, soft reset (both `keep_prompts` modes), `update_lane`, `remove_lane` all pass unit + dispatch tests. Reset operations are idempotent on already-empty casefiles.
6. `pytest -q` green; `tsc --noEmit` and `vite build` clean.

## Status

- Planned. Not yet implemented.

## Follow-ups (filed, not scheduled)

- **Auto-restore on re-registration.** When a lane id with on-disk orphaned data is re-registered, prompt "Restore prior chat history / notes / findings for this lane id?" Out of scope for M4.6; revisit after using lane-removal in practice.
- **Cascade delete option for lane removal.** Add an optional `cascade: bool` to `casefile:removeLane` if hidden-but-recoverable proves to leak too much disk over time.
- **Pre-write conflict modal (Conflict UX option B).** If post-write warnings are missed in practice, add a `dryRun` mode and a blocking dialog.
- **Rename lane id.** Requires migrating chat / notes / findings files. Not requested today.
