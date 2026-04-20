from __future__ import annotations

from pathlib import Path

import pytest

from assistant_app.casefile.notes import NotesStore


def test_read_returns_empty_when_no_note(tmp_path: Path):
    store = NotesStore(tmp_path)
    assert store.read("main") == ""


def test_write_then_read_round_trip(tmp_path: Path):
    store = NotesStore(tmp_path)
    store.write("main", "# header\n\nbody\n")
    assert store.read("main") == "# header\n\nbody\n"


def test_write_overwrites_existing(tmp_path: Path):
    store = NotesStore(tmp_path)
    store.write("main", "first")
    store.write("main", "second")
    assert store.read("main") == "second"


def test_write_atomic_does_not_leave_tmp(tmp_path: Path):
    store = NotesStore(tmp_path)
    store.write("main", "x")
    tmp_files = list(store.directory.glob("*.tmp"))
    assert tmp_files == []


def test_path_for_rejects_traversal(tmp_path: Path):
    store = NotesStore(tmp_path)
    with pytest.raises(ValueError):
        store.read("../escape")
