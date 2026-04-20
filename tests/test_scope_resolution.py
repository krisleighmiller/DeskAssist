"""Tests for `casefile.scope.resolve_scope` (M3.5a)."""

from __future__ import annotations

from pathlib import Path

from assistant_app.casefile import (
    ANCESTOR_PREFIX,
    ATTACHMENT_PREFIX,
    CONTEXT_PREFIX,
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


def test_root_lane_has_no_overlays(tmp_path: Path):
    family_root, store = _setup(tmp_path)
    snapshot = store.load_snapshot()
    scope = resolve_scope(snapshot, "main")
    assert scope.read_overlays == ()
    assert scope.write_root == family_root.resolve()


def test_child_lane_inherits_ancestor_roots(tmp_path: Path):
    family_root, store = _setup(tmp_path)
    snapshot = store.load_snapshot()
    scope = resolve_scope(snapshot, "ash")
    prefixes = [overlay.prefix for overlay in scope.read_overlays]
    # Order: own attachment first, then nearest ancestor (task-9), then 'main'.
    assert prefixes[0] == f"{ATTACHMENT_PREFIX}/notes"
    assert f"{ANCESTOR_PREFIX}/task-9" in prefixes
    assert f"{ANCESTOR_PREFIX}/main" in prefixes
    assert prefixes.index(f"{ANCESTOR_PREFIX}/task-9") < prefixes.index(
        f"{ANCESTOR_PREFIX}/main"
    )


def test_sibling_lanes_are_not_in_overlays(tmp_path: Path):
    """Cross-sibling isolation from M2 must survive: 'ash' should not see 'elm'."""
    _, store = _setup(tmp_path)
    snapshot = store.load_snapshot()
    scope = resolve_scope(snapshot, "ash")
    overlay_roots = {overlay.root for overlay in scope.read_overlays}
    elm_root = snapshot.lane_by_id("elm").root
    assert elm_root not in overlay_roots


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
