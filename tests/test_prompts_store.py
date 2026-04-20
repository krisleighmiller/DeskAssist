from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

import pytest

from assistant_app.casefile.prompts import (
    MAX_PROMPT_BODY_BYTES,
    PromptDraft,
    PromptFileError,
    PromptsStore,
    normalize_prompt_id,
    slug_from_name,
)


def test_normalize_prompt_id_lowercases_and_slugs():
    assert normalize_prompt_id("Code Review") == "code-review"
    assert normalize_prompt_id("My  Prompt!!") == "my-prompt"


def test_normalize_prompt_id_rejects_path_like():
    with pytest.raises(ValueError):
        normalize_prompt_id("../escape")
    with pytest.raises(ValueError):
        normalize_prompt_id("foo/bar")
    with pytest.raises(ValueError):
        normalize_prompt_id("")


def test_normalize_prompt_id_rejects_reserved():
    with pytest.raises(ValueError):
        normalize_prompt_id("casefile")


def test_slug_from_empty_name_falls_back_to_prompt():
    assert slug_from_name("") == "prompt"


# ---------------------------------------------------------------------------
# Basic CRUD
# ---------------------------------------------------------------------------


def test_create_then_get_round_trip(tmp_path: Path):
    store = PromptsStore(tmp_path)
    created = store.create(
        name="Code Review System",
        body="You are a code reviewer.",
        now=datetime(2025, 1, 1, 12, 0, 0, tzinfo=timezone.utc),
    )
    assert created.id == "code-review-system"
    assert created.name == "Code Review System"
    assert created.body == "You are a code reviewer."
    assert created.created_at == "2025-01-01T12:00:00Z"
    assert created.updated_at == created.created_at

    fetched = store.get("code-review-system")
    assert fetched == created

    # On disk: body lives in .md, metadata in .json sidecar.
    body_path = tmp_path / ".casefile" / "prompts" / "code-review-system.md"
    meta_path = tmp_path / ".casefile" / "prompts" / "code-review-system.json"
    assert body_path.read_text(encoding="utf-8") == "You are a code reviewer."
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    assert meta["id"] == "code-review-system"
    assert meta["name"] == "Code Review System"


def test_list_returns_summaries_sorted_by_filename(tmp_path: Path):
    store = PromptsStore(tmp_path)
    store.create(name="Beta", body="b")
    store.create(name="Alpha", body="aaa")
    summaries = store.list()
    assert [s.id for s in summaries] == ["alpha", "beta"]
    assert summaries[0].size_bytes == 3
    assert summaries[1].size_bytes == 1


def test_create_collides_then_suffixes(tmp_path: Path):
    store = PromptsStore(tmp_path)
    a = store.create(name="Notes", body="first")
    b = store.create(name="Notes", body="second")
    assert a.id == "notes"
    assert b.id == "notes-2"


def test_save_updates_body_and_updated_at(tmp_path: Path):
    store = PromptsStore(tmp_path)
    created = store.create(
        name="Draft", body="v1",
        now=datetime(2025, 1, 1, tzinfo=timezone.utc),
    )
    saved = store.save(
        created.id,
        body="v2",
        now=datetime(2025, 1, 2, tzinfo=timezone.utc),
    )
    assert saved.body == "v2"
    assert saved.created_at == "2025-01-01T00:00:00Z"
    assert saved.updated_at == "2025-01-02T00:00:00Z"
    assert saved.name == created.name


def test_save_rename_keeps_id(tmp_path: Path):
    store = PromptsStore(tmp_path)
    created = store.create(name="Old Name", body="x")
    renamed = store.save(created.id, name="New Name")
    assert renamed.id == created.id
    assert renamed.name == "New Name"


def test_save_unknown_id_raises(tmp_path: Path):
    store = PromptsStore(tmp_path)
    with pytest.raises(KeyError):
        store.save("does-not-exist", body="x")


def test_get_unknown_id_raises(tmp_path: Path):
    store = PromptsStore(tmp_path)
    with pytest.raises(KeyError):
        store.get("missing")


def test_delete_removes_both_files(tmp_path: Path):
    store = PromptsStore(tmp_path)
    created = store.create(name="Temp", body="x")
    assert (tmp_path / ".casefile" / "prompts" / f"{created.id}.md").exists()
    assert (tmp_path / ".casefile" / "prompts" / f"{created.id}.json").exists()
    store.delete(created.id)
    assert not (tmp_path / ".casefile" / "prompts" / f"{created.id}.md").exists()
    assert not (tmp_path / ".casefile" / "prompts" / f"{created.id}.json").exists()


def test_delete_unknown_id_raises(tmp_path: Path):
    store = PromptsStore(tmp_path)
    with pytest.raises(KeyError):
        store.delete("missing")


# ---------------------------------------------------------------------------
# Validation + size caps
# ---------------------------------------------------------------------------


def test_create_rejects_empty_name(tmp_path: Path):
    store = PromptsStore(tmp_path)
    with pytest.raises(ValueError):
        store.create(name="   ", body="x")


def test_create_rejects_oversize_body(tmp_path: Path):
    store = PromptsStore(tmp_path)
    body = "a" * (MAX_PROMPT_BODY_BYTES + 1)
    with pytest.raises(ValueError):
        store.create(name="Big", body=body)


def test_create_rejects_path_like_explicit_id(tmp_path: Path):
    store = PromptsStore(tmp_path)
    with pytest.raises(ValueError):
        store.create(name="x", body="", prompt_id="../escape")


# ---------------------------------------------------------------------------
# Sidecar resilience
# ---------------------------------------------------------------------------


def test_orphaned_body_falls_back_to_filename(tmp_path: Path):
    """A body file without a sidecar JSON should still surface in `list()`
    using the filename as a synthesized display name. This guards against
    the user manually dropping a `.md` into the prompts directory."""
    prompts_dir = tmp_path / ".casefile" / "prompts"
    prompts_dir.mkdir(parents=True)
    (prompts_dir / "manual-drop.md").write_text("orphan", encoding="utf-8")
    store = PromptsStore(tmp_path)
    summaries = store.list()
    assert len(summaries) == 1
    assert summaries[0].id == "manual-drop"
    # Title-cased fallback name
    assert summaries[0].name == "Manual Drop"
    fetched = store.get("manual-drop")
    assert fetched.body == "orphan"


def test_sidecar_with_disagreeing_id_trusts_filename(tmp_path: Path):
    """If the sidecar's `id` field disagrees with the filename, the filename
    wins so renaming on disk is not silently undone."""
    prompts_dir = tmp_path / ".casefile" / "prompts"
    prompts_dir.mkdir(parents=True)
    (prompts_dir / "renamed.md").write_text("body", encoding="utf-8")
    (prompts_dir / "renamed.json").write_text(
        json.dumps({
            "version": 1,
            "id": "old-name",
            "name": "Renamed Prompt",
            "created_at": "2025-01-01T00:00:00Z",
            "updated_at": "2025-01-01T00:00:00Z",
        }),
        encoding="utf-8",
    )
    store = PromptsStore(tmp_path)
    fetched = store.get("renamed")
    assert fetched.id == "renamed"
    assert fetched.name == "Renamed Prompt"
