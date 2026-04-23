"""Tests for `casefile.scope.resolve_scope` (M3.5a → M2.5 flat scope model)."""

from __future__ import annotations

from pathlib import Path

from assistant_app.casefile import (
    CONTEXT_PREFIX,
    SCOPE_PREFIX,
    CasefileStore,
    ContextManifest,
    ContextManifestStore,
    LaneAttachment,
    resolve_scope,
)


def _setup(tmp_path: Path):
    """Build a small tree:

        family/         <- 'family' lane (top-level)
          rubric.md
          TASK_9/       <- 'task-9' lane, parent=family
            ash/        <- 'ash' lane, parent=task-9, attachment=ash_notes
            elm/        <- 'elm' lane, parent=task-9
            ash_notes/  <- attached to 'ash'
    """
    family_root = tmp_path / "family"
    family_root.mkdir()
    (family_root / "rubric.md").write_text("be a good boxer", encoding="utf-8")
    task9 = family_root / "TASK_9"
    task9.mkdir()
    (task9 / "AGENTS.md").write_text("task 9 agents", encoding="utf-8")
    (task9 / "ash").mkdir()
    (task9 / "elm").mkdir()
    (task9 / "ash_notes").mkdir()
    (task9 / "ash_notes" / "log.md").write_text("ash log", encoding="utf-8")

    store = CasefileStore(family_root)
    store.ensure_initialized()  # creates 'main' pointing at family_root
    store.register_lane(name="Task 9", kind="other", root=task9, parent_id="main")
    store.register_lane(
        name="Ash",
        kind="repo",
        root=task9 / "ash",
        parent_id="task-9",
        attachments=[LaneAttachment(name="notes", root=task9 / "ash_notes")],
    )
    store.register_lane(name="Elm", kind="repo", root=task9 / "elm", parent_id="task-9")
    return family_root, store


def test_root_lane_has_no_read_overlays(tmp_path: Path):
    """Root lane has only its own writable directory; no _scope entries."""
    family_root, store = _setup(tmp_path)
    snapshot = store.load_snapshot()
    scope = resolve_scope(snapshot, "main")
    # Only the write root; no read-only _scope directories.
    assert all(d.writable for d in scope.directories)
    assert scope.write_root == family_root.resolve()
    overlay_map = scope.overlay_map()
    # No _scope/… keys (write root isn't in the overlay map)
    assert not any(k.startswith(SCOPE_PREFIX) for k in overlay_map)


def test_child_lane_has_flat_scope_labels(tmp_path: Path):
    """Ash lane's scope is flat: own write root + attachment + ancestors under _scope/."""
    family_root, store = _setup(tmp_path)
    snapshot = store.load_snapshot()
    scope = resolve_scope(snapshot, "ash")
    # Should have writable directory for ash, plus read-only for notes, task_9, main.
    labels = [d.label for d in scope.directories]
    assert scope.directories[0].writable, "first directory must be the write root"
    read_labels = [d.label for d in scope.directories if not d.writable]
    # All labels must be unique.
    assert len(read_labels) == len(set(read_labels))
    # Notes attachment must be present.
    assert "notes" in read_labels
    # Ancestor lanes (task_9, main) must be present in some form.
    assert any(lbl.startswith("task") for lbl in read_labels), read_labels
    assert any(lbl.startswith("main") for lbl in read_labels), read_labels
    # Order: attachment first, then task-9, then main.
    idx = {lbl: i for i, lbl in enumerate(labels)}
    notes_i = idx.get("notes")
    task_i = next(i for lbl, i in idx.items() if lbl.startswith("task"))
    main_i = next(i for lbl, i in idx.items() if lbl.startswith("main"))
    assert notes_i is not None
    assert notes_i < task_i < main_i


def test_sibling_lanes_are_not_in_scope(tmp_path: Path):
    """Cross-sibling isolation: 'ash' must not see 'elm'."""
    _, store = _setup(tmp_path)
    snapshot = store.load_snapshot()
    scope = resolve_scope(snapshot, "ash")
    elm_root = snapshot.lane_by_id("elm").root
    scope_paths = {d.path for d in scope.directories}
    assert elm_root not in scope_paths


def test_context_files_resolved_with_size(tmp_path: Path):
    family_root, store = _setup(tmp_path)
    manifest_store = ContextManifestStore(family_root)
    manifest_store.save(ContextManifest(files=("rubric.md",), auto_include_max_bytes=1024))
    snapshot = store.load_snapshot()
    scope = resolve_scope(snapshot, "ash")
    assert len(scope.context_files) == 1
    assert scope.context_files[0].relative_path == "rubric.md"
    assert scope.context_files[0].size_bytes > 0
    assert scope.auto_include_max_bytes == 1024
    candidates = scope.auto_include_candidates()
    assert len(candidates) == 1


def test_auto_include_skips_oversized_files(tmp_path: Path):
    family_root, store = _setup(tmp_path)
    big = family_root / "big.md"
    big.write_text("x" * 5000, encoding="utf-8")
    manifest_store = ContextManifestStore(family_root)
    manifest_store.save(
        ContextManifest(files=("rubric.md", "big.md"), auto_include_max_bytes=1000)
    )
    snapshot = store.load_snapshot()
    scope = resolve_scope(snapshot, "ash")
    assert {entry.relative_path for entry in scope.context_files} == {"rubric.md", "big.md"}
    candidate_paths = {entry.relative_path for entry in scope.auto_include_candidates()}
    assert candidate_paths == {"rubric.md"}


def test_overlay_map_includes_context_when_files_present(tmp_path: Path):
    family_root, store = _setup(tmp_path)
    manifest_store = ContextManifestStore(family_root)
    manifest_store.save(ContextManifest(files=("rubric.md",), auto_include_max_bytes=1024))
    snapshot = store.load_snapshot()
    scope = resolve_scope(snapshot, "ash")
    overlay_map = scope.overlay_map()
    assert CONTEXT_PREFIX in overlay_map
    assert overlay_map[CONTEXT_PREFIX] == family_root.resolve()


def test_overlay_map_uses_scope_prefix_for_read_only_dirs(tmp_path: Path):
    """Read-only directories should appear under `_scope/<label>/` in the overlay map."""
    _, store = _setup(tmp_path)
    snapshot = store.load_snapshot()
    scope = resolve_scope(snapshot, "ash")
    overlay_map = scope.overlay_map()
    # Every key should start with _scope/ or _context/ — no _ancestors, no _attachments.
    for key in overlay_map:
        assert key.startswith(SCOPE_PREFIX + "/") or key == CONTEXT_PREFIX, (
            f"Unexpected overlay key: {key}"
        )


def test_glob_patterns_resolve(tmp_path: Path):
    family_root, store = _setup(tmp_path)
    (family_root / "checklists").mkdir()
    (family_root / "checklists" / "a.md").write_text("a", encoding="utf-8")
    (family_root / "checklists" / "b.md").write_text("b", encoding="utf-8")
    manifest_store = ContextManifestStore(family_root)
    manifest_store.save(ContextManifest(files=("checklists/*.md",), auto_include_max_bytes=4096))
    snapshot = store.load_snapshot()
    scope = resolve_scope(snapshot, "ash")
    paths = {entry.relative_path for entry in scope.context_files}
    assert paths == {"checklists/a.md", "checklists/b.md"}


def test_traversal_pattern_is_dropped(tmp_path: Path):
    family_root, store = _setup(tmp_path)
    manifest_store = ContextManifestStore(family_root)
    manifest_store.save(ContextManifest(files=("../escape.md",), auto_include_max_bytes=4096))
    snapshot = store.load_snapshot()
    scope = resolve_scope(snapshot, "ash")
    assert scope.context_files == ()
