# M4.5 — Assistant Charter (Product-Owned System Prompt)

A focused mid-cycle milestone slotted between M4 (shipped) and any future M5. Same role in the plan as M3.5: a small, additive change that closes a behavioral gap the larger milestones did not address.

## Goal

Establish a product-owned system-prompt layer — the **assistant charter** — that frames the model as a casefile analyst rather than a coding agent. The charter is prepended to every chat turn (single-lane and comparison) above the existing auto-context and user-selected prompt-draft layers, and is owned by the product (not editable per casefile or per lane).

After M4.5 the layered system surface is:

1. **Charter** (this milestone) — product-owned, single file, applies everywhere.
2. **Casefile auto-context** (existing, M3.5a) — situational; what files are visible.
3. **User-selected prompt draft** (existing, M4.1) — the analyst's rubric / question.
4. Conversation.

Each layer narrows the previous one; nothing below can override anything above.

## Why now

The behavior gap surfaced during MVP testing against `/media/kris/Files/Development/Testing/Boxing_test`. With a casefile open, lanes registered (`main` → `task` → `model-a` / `modelb`), and a user prompt draft selected, asking "please review the code and tell me how well it meets the prompt requirements" produced an *execution plan* rather than a *review*.

This is the predictable result of the current design: the only system messages on the wire are situational (`_build_context_system_prompt` in `electron_bridge.py`) and user-authored (`_build_prompt_system_message`). Neither tells the model what kind of assistant DeskAssist is. The base models (`gpt-4o-mini`, `claude-haiku-4-5`, `deepseek-chat`) are all tuned with strong "be a coding agent, plan and execute" defaults, and on coding-flavored input they win.

The product thesis in `plans/analyst-workbench/README.md` and `REPO_GUARDRAILS.md` ("analysis over execution; ground claims in scope; turn analysis into reusable outputs") is currently encoded only in markdown that the runtime model never sees. The charter is the layer that puts that thesis in front of the model on every turn.

This must land before any further milestone that adds new chat surfaces or prompt-shaped objects (any future M5+), so we don't ship more code that compensates for the missing layer with workarounds.

## What the charter must encode

Driven by the `Boxing_test` MVP scenario (per-lane analysis + cross-lane comparison) and the analyst-workbench thesis. Charter content stays short — a few hundred tokens — and only encodes things true across *all* casefiles.

- **Role.** "You are a DeskAssist analyst working inside a casefile. Your default deliverable is written analysis, not an execution plan or code edits."
- **Default behavior on common asks.** When the user says *review*, *evaluate*, *score against this rubric*, *compare*, or *summarize*, produce that artifact directly. Do not substitute a planning step or a clarifying-questions list unless the request is genuinely ambiguous.
- **Grounding.** Cite file paths and line ranges from the active scope (lane root + ancestors + `_attachments/` + `_context/`, plus `_lanes/<id>/` in comparison sessions). If a claim is not supported by something visible in scope, say so explicitly rather than guessing.
- **Comparison posture.** When the active scope contains multiple `_lanes/<id>/` roots (i.e. a comparison session), produce comparison output that references both/all sides. Do not critique only one side.
- **Where outputs go.** Substantive analysis belongs in `.casefile/findings/` (structured) or `.casefile/notes/<lane>.md` (free-form), not buried in chat scrollback. Suggest the right home when the user hasn't said.
- **Tool posture.** Prefer read tools. Only use write tools when the user has clearly asked for a change. Pairs with the existing `allowWriteTools` gate in `chat_service.py` and the `enable_writes=False` registry the comparison path already uses (`tools/__init__.py`).
- **Ambiguity.** When two reasonable interpretations of an ask exist, ask exactly one clarifying question rather than guessing or producing both.

What the charter explicitly does **not** encode:

- Tone, formatting templates, headings, bullet styles. Those fight the model and lose.
- Refusal policy add-ons. Provider defaults are sufficient at this stage.
- Per-domain rubric content (boxing evaluation, code review checklist, etc.). That is the user-prompt-draft layer's job.

## In scope

- New file `src/assistant_app/prompts/charter.md` — the actual charter text. Hand-authored markdown, version-controlled, no YAML frontmatter.
- New module `src/assistant_app/prompts/__init__.py` exposing `load_charter() -> str` (cached read of `charter.md`, returns the body verbatim) and a `CHARTER_MARKER` constant for idempotent injection.
- Extension to `electron_bridge.py`:
  - New helper `_build_charter_system_message() -> str` returning `f"{CHARTER_MARKER} {body}"`.
  - New predicate `_history_has_charter_marker(history) -> bool` mirroring `_history_has_context_marker` / `_history_has_prompt_marker`.
  - In `handle_chat_send`: prepend the charter at index 0 (above context and prompt-draft) when the marker is not already present.
  - In the comparison-chat send path (currently in the second half of `electron_bridge.py`, around line 1213+): same prepend, same marker check.
- Tests: new `tests/test_assistant_charter.py` covering:
  - `load_charter()` returns non-empty content.
  - Single-lane chat: with no prior charter in history, the injected system messages are ordered `[charter, context, prompt_draft, ...]` (charter at index 0).
  - Single-lane chat: re-running with the same history (resumed turn) does not duplicate the charter.
  - Comparison chat: charter is injected exactly once at the head of the comparison history.
  - Charter is injected even when no casefile context and no user prompt draft are present (i.e. plain workspace chat).

## Out of scope

- **Per-casefile or per-lane charter overrides.** The user-prompt-draft layer (M4.1) is already the place for casefile-specific behavioral nudges. Adding a third tier of behavioral overrides multiplies the surface area without solving a problem we have.
- **Provider-specific charter variants.** One file, all providers. The existing `AnthropicProvider` already extracts `role: "system"` messages and merges them into Anthropic's top-level `system` field (`providers/anthropic.py:33`), so a single `role: "system"` prepend works across OpenAI, Anthropic, and DeepSeek without provider changes.
- **Charter editing UI.** The charter is a product asset. If we ever want to expose it in the workbench it'll be read-only at first.
- **Output-format enforcement** (markdown structure, finding shape, headings). The charter *guides* output format implicitly; structured-output enforcement is a separate problem and is not what's failing today.
- **Charter A/B testing or per-model variants.** Premature; we have one test bed (`Boxing_test`).

## Backend touch points

- `src/assistant_app/prompts/__init__.py` (new).
- `src/assistant_app/prompts/charter.md` (new).
- `src/assistant_app/electron_bridge.py` (charter helpers + injection in two send paths).
- `tests/test_assistant_charter.py` (new).

No changes to:

- `chat_service.py` (the charter is purely a system-message prepend; the service already handles arbitrary `role: "system"` entries).
- Provider adapters.
- Renderer.
- Tool registry, filesystem, security, casefile store.

## Layering and idempotency

Three system-message types may now appear at the head of `parsed_history`, in fixed order:

| Index | Source | Marker | Inserted by |
|---|---|---|---|
| 0 | Charter | `CHARTER_MARKER` | M4.5 |
| 1 | Casefile auto-context | `_CONTEXT_MARKER` | M3.5a |
| 2 | User prompt draft | `_PROMPT_MARKER` | M4.1 |

Insertion logic in `handle_chat_send` becomes (conceptually):

1. Prepend charter at the index of the first non-charter system message (or 0 if absent), guarded by `_history_has_charter_marker`.
2. Prepend context at the index after the charter (or 0 if no charter), guarded by `_history_has_context_marker`. *(existing)*
3. Insert prompt draft at the index after charter+context, guarded by `_history_has_prompt_marker`. *(existing)*

All three guards scan the full history, so a resumed turn that already has the charter (or context, or prompt) will not stack duplicates. Switching prompt drafts mid-conversation still appends a new prompt-draft message (existing M4.1 behavior), and the charter remains a singleton at index 0.

The comparison-chat send path gets the same charter prepend, with the comparison-context and comparison-history already handled.

## Defaults

- **Charter location.** `src/assistant_app/prompts/charter.md`, alongside the Python package so `importlib.resources` (or a plain `Path(__file__).parent`) can locate it without packaging gymnastics.
- **Charter caching.** Loaded once on first use and cached for the process lifetime. Acceptable because the file ships with the build and only changes between releases.
- **Charter size budget.** Soft target ~400 tokens, hard cap 2000 tokens (enforced in `load_charter()` with a clear error message). The charter is on every turn for every provider; runaway growth is a real cost.

## Exit criteria

1. Manual: in `/media/kris/Files/Development/Testing/Boxing_test`, opening the `model-a` lane and sending "Please review the code and tell me how well it meets the prompt requirements" produces a written review grounded in the lane's files, not an execution plan.
2. Manual: opening a comparison chat across `model-a` + `modelb` and sending the contents of `Comparison_Prompt.txt` produces a comparison artifact citing both lanes.
3. Automated: with both auto-context and a user prompt draft active, the injected system-message order is `[charter, context, prompt_draft]` at indices 0/1/2.
4. Automated: a resumed turn (history already containing the charter) does not duplicate it.
5. Automated: the comparison-chat send path injects the charter exactly once at the head.
6. `pytest -q` green; `tsc --noEmit` and `vite build` clean (no UI changes expected, but verify).

## Iteration loop

The charter text itself will need tuning against real usage. The expected loop after the wiring is in:

1. Run a representative prompt against `Boxing_test` (per-lane and comparison).
2. Observe drift (planning instead of reviewing, ungrounded claims, output landing in chat instead of `.casefile/findings/`, etc.).
3. Edit `src/assistant_app/prompts/charter.md` only — no code changes.
4. Repeat until the failure modes from MVP testing no longer reproduce.

This is why the charter is a single hand-edited file, not generated from the planning docs: the iteration loop needs to be tight and human-driven.

## Status

- Planned. Not yet implemented.
