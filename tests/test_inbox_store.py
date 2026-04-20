"""Unit tests for `assistant_app.casefile.inbox.InboxStore`.

The store is the one place where casefile-relative inbox config touches
arbitrary user filesystems, so the tests exercise: id normalization
guards, source CRUD round-trips, depth-bounded walking, suffix
filtering, path-escape rejection on read, and the truncation contract on
read_item that the renderer relies on for the "showing first N chars"
banner.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from assistant_app.casefile.inbox import (
    DEFAULT_INBOX_READ_MAX_CHARS,
    INBOX_FILENAME,
    INBOX_TEXT_SUFFIXES,
    InboxFileError,
    InboxStore,
    MAX_INBOX_LIST_DEPTH,
    normalize_source_id,
    slug_from_name,
)


def _make_casefile(tmp_path: Path) -> Path:
    root = tmp_path / "case"
    root.mkdir()
    return root


# ----- id / slug helpers -----


def test_normalize_source_id_rejects_path_like():
    for bad in ("a/b", "a\\b", "..", "x\x00y"):
        with pytest.raises(ValueError):
            normalize_source_id(bad)


def test_normalize_source_id_lowercases_and_collapses():
    assert normalize_source_id("My Notes!") == "my-notes"
    assert normalize_source_id("ABC_123") == "abc_123"


def test_normalize_source_id_rejects_empty_after_normalize():
    with pytest.raises(ValueError):
        normalize_source_id("!!!")


def test_slug_from_name_falls_back_to_inbox():
    assert slug_from_name("!!!") == "inbox"
    assert slug_from_name("Project Alpha") == "project-alpha"


# ----- source CRUD -----


def test_list_sources_empty_when_no_config(tmp_path: Path):
    store = InboxStore(_make_casefile(tmp_path))
    assert store.list_sources() == []


def test_add_source_persists_and_assigns_unique_id(tmp_path: Path):
    case = _make_casefile(tmp_path)
    src_dir = tmp_path / "external"
    src_dir.mkdir()
    store = InboxStore(case)

    a = store.add_source(name="Project Notes", root=str(src_dir))
    b = store.add_source(name="Project Notes", root=str(src_dir))
    assert a.id == "project-notes"
    assert b.id == "project-notes-2"

    payload = json.loads((case / ".casefile" / INBOX_FILENAME).read_text())
    assert payload["version"] == 1
    assert [s["id"] for s in payload["sources"]] == ["project-notes", "project-notes-2"]


def test_add_source_rejects_missing_directory(tmp_path: Path):
    store = InboxStore(_make_casefile(tmp_path))
    with pytest.raises(ValueError):
        store.add_source(name="x", root=str(tmp_path / "nope"))


def test_add_source_rejects_duplicate_explicit_id(tmp_path: Path):
    case = _make_casefile(tmp_path)
    src_dir = tmp_path / "ext"
    src_dir.mkdir()
    store = InboxStore(case)
    store.add_source(name="A", root=str(src_dir), source_id="shared")
    with pytest.raises(ValueError):
        store.add_source(name="B", root=str(src_dir), source_id="shared")


def test_update_source_changes_name_and_root(tmp_path: Path):
    case = _make_casefile(tmp_path)
    a = tmp_path / "a"
    b = tmp_path / "b"
    a.mkdir()
    b.mkdir()
    store = InboxStore(case)
    store.add_source(name="Notes", root=str(a))
    updated = store.update_source("notes", name="New Notes", root=str(b))
    assert updated.name == "New Notes"
    assert Path(updated.root) == b.resolve()


def test_update_source_requires_known_id(tmp_path: Path):
    store = InboxStore(_make_casefile(tmp_path))
    with pytest.raises(KeyError):
        store.update_source("missing", name="x")


def test_remove_source(tmp_path: Path):
    case = _make_casefile(tmp_path)
    src = tmp_path / "ext"
    src.mkdir()
    store = InboxStore(case)
    store.add_source(name="Notes", root=str(src))
    store.remove_source("notes")
    assert store.list_sources() == []


def test_list_sources_skips_malformed_entries(tmp_path: Path):
    case = _make_casefile(tmp_path)
    meta = case / ".casefile"
    meta.mkdir()
    payload = {
        "version": 1,
        "sources": [
            {"id": "ok", "name": "Ok", "root": str(tmp_path)},
            {"name": "missing-id", "root": str(tmp_path)},
            "not-an-object",
        ],
    }
    (meta / INBOX_FILENAME).write_text(json.dumps(payload), encoding="utf-8")
    store = InboxStore(case)
    sources = store.list_sources()
    assert [s.id for s in sources] == ["ok"]


def test_list_sources_raises_on_corrupt_root(tmp_path: Path):
    case = _make_casefile(tmp_path)
    meta = case / ".casefile"
    meta.mkdir()
    (meta / INBOX_FILENAME).write_text("[not an object]", encoding="utf-8")
    with pytest.raises(InboxFileError):
        InboxStore(case).list_sources()


# ----- items -----


def test_list_items_filters_suffixes_and_hidden(tmp_path: Path):
    case = _make_casefile(tmp_path)
    src = tmp_path / "src"
    src.mkdir()
    (src / "note.md").write_text("hello", encoding="utf-8")
    (src / "data.csv").write_text("a,b", encoding="utf-8")
    (src / "binary.bin").write_bytes(b"\x00\x01")
    (src / ".hidden.md").write_text("nope", encoding="utf-8")
    sub = src / "sub"
    sub.mkdir()
    (sub / "deep.txt").write_text("x", encoding="utf-8")

    store = InboxStore(case)
    store.add_source(name="S", root=str(src))
    items = store.list_items("s")
    paths = [it.path for it in items]
    assert "note.md" in paths
    assert "data.csv" in paths
    assert "sub/deep.txt" in paths
    assert all(not p.endswith(".bin") for p in paths)
    assert all(".hidden" not in p for p in paths)


def test_list_items_respects_depth_cap(tmp_path: Path):
    case = _make_casefile(tmp_path)
    src = tmp_path / "src"
    src.mkdir()
    deep = src
    # MAX_INBOX_LIST_DEPTH levels deep + one extra to verify it gets cut.
    for i in range(MAX_INBOX_LIST_DEPTH + 2):
        deep = deep / f"d{i}"
        deep.mkdir()
    (deep / "leaf.md").write_text("x", encoding="utf-8")
    store = InboxStore(case)
    store.add_source(name="S", root=str(src))
    items = store.list_items("s")
    assert items == []


def test_list_items_skips_casefile_metadata(tmp_path: Path):
    case = _make_casefile(tmp_path)
    src = tmp_path / "src"
    src.mkdir()
    meta = src / ".casefile"
    meta.mkdir()
    (meta / "internal.md").write_text("x", encoding="utf-8")
    (src / "real.md").write_text("y", encoding="utf-8")
    store = InboxStore(case)
    store.add_source(name="S", root=str(src))
    paths = [it.path for it in store.list_items("s")]
    assert paths == ["real.md"]


def test_list_items_returns_empty_when_root_vanishes(tmp_path: Path):
    case = _make_casefile(tmp_path)
    src = tmp_path / "src"
    src.mkdir()
    (src / "note.md").write_text("x", encoding="utf-8")
    store = InboxStore(case)
    store.add_source(name="S", root=str(src))
    # Remove after registration: should not raise.
    (src / "note.md").unlink()
    src.rmdir()
    assert store.list_items("s") == []


# ----- read_item -----


def test_read_item_returns_content_and_truncation_flag(tmp_path: Path):
    case = _make_casefile(tmp_path)
    src = tmp_path / "src"
    src.mkdir()
    body = "abc\n" * 10
    (src / "note.md").write_text(body, encoding="utf-8")
    store = InboxStore(case)
    store.add_source(name="S", root=str(src))

    content, truncated, abs_path = store.read_item("s", "note.md")
    assert content == body
    assert truncated is False
    assert Path(abs_path) == (src / "note.md").resolve()

    short, was_trunc, _ = store.read_item("s", "note.md", max_chars=4)
    assert short == body[:4]
    assert was_trunc is True


def test_read_item_rejects_path_escape(tmp_path: Path):
    case = _make_casefile(tmp_path)
    src = tmp_path / "src"
    src.mkdir()
    outside = tmp_path / "outside.md"
    outside.write_text("secret", encoding="utf-8")
    store = InboxStore(case)
    store.add_source(name="S", root=str(src))
    with pytest.raises(ValueError):
        store.read_item("s", "../outside.md")


def test_read_item_rejects_non_text_suffix(tmp_path: Path):
    case = _make_casefile(tmp_path)
    src = tmp_path / "src"
    src.mkdir()
    (src / "data.bin").write_bytes(b"x")
    store = InboxStore(case)
    store.add_source(name="S", root=str(src))
    with pytest.raises(ValueError):
        store.read_item("s", "data.bin")


def test_read_item_missing_raises(tmp_path: Path):
    case = _make_casefile(tmp_path)
    src = tmp_path / "src"
    src.mkdir()
    store = InboxStore(case)
    store.add_source(name="S", root=str(src))
    with pytest.raises(FileNotFoundError):
        store.read_item("s", "nope.md")


def test_read_item_validates_max_chars_bounds(tmp_path: Path):
    case = _make_casefile(tmp_path)
    src = tmp_path / "src"
    src.mkdir()
    (src / "n.md").write_text("x", encoding="utf-8")
    store = InboxStore(case)
    store.add_source(name="S", root=str(src))
    with pytest.raises(ValueError):
        store.read_item("s", "n.md", max_chars=0)
    with pytest.raises(ValueError):
        store.read_item("s", "n.md", max_chars=10_000_000)


def test_inbox_text_suffix_set_includes_common_text():
    for suf in (".md", ".txt", ".csv", ".log", ".json"):
        assert suf in INBOX_TEXT_SUFFIXES


def test_default_read_cap_is_reasonable():
    assert DEFAULT_INBOX_READ_MAX_CHARS >= 1000
