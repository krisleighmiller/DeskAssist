# Migration Backlog (py-gpt -> desktop-assistant-new)

Use this file to triage legacy modules before import.

Rules:

- No direct copy without a filled row
- If triage is inconclusive, default to rewrite
- Imported modules must also be logged in `docs/MIGRATED_FROM_LEGACY.md`

Status legend:

- `triage` - not yet decided
- `import` - approved for selective import
- `rewrite` - rebuild in this repo
- `defer` - not in near-term scope
- `done` - completed and validated

## Triage Table


| ID    | Legacy Module/Feature                                | Legacy Path(s)                                                                                                                     | User Value | Coupling Risk | Dependency Impact | Recommendation | Target Phase | Status | Notes                                                                                        |
| ----- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------- | ----------------- | -------------- | ------------ | ------ | -------------------------------------------------------------------------------------------- |
| M-001 | Command security policy primitives                   | `src/pygpt_net/core/security/policy.py`                                                                                            | High       | Low           | Low               | import         | Phase 1      | done   | Imported/adapted into `assistant_app/security/policy.py` and wired through `ToolRegistry`.    |
| M-002 | Provider adapter pattern (OpenAI/Anthropic/DeepSeek) | `src/pygpt_net/provider/llms/openai.py`; `src/pygpt_net/provider/llms/anthropic.py`; `src/pygpt_net/provider/llms/deepseek_api.py` | High       | Medium        | High              | rewrite        | Phase 1      | done   | Rewritten with shared `HttpChatProvider` contract and provider-specific payload/parse adapters. |
| M-003 | File tools command surface                           | `src/pygpt_net/plugin/cmd_files/plugin.py`; `src/pygpt_net/plugin/cmd_files/worker.py`                                             | High       | High          | Medium            | rewrite        | Phase 1      | done   | Rewritten with schema validation + deterministic envelopes and workspace-bound file commands. |
| M-004 | Filesystem helpers                                   | `src/pygpt_net/core/filesystem/filesystem.py`                                                                                      | High       | High          | Medium            | rewrite        | Phase 1      | done   | Rewritten as `WorkspaceFilesystem` helpers and wired into file tools without UI coupling.     |
| M-005 | File explorer controller actions                     | `src/pygpt_net/controller/files/files.py`                                                                                          | Medium     | Very High     | Medium            | defer          | Phase 2      | defer  | Explicitly deferred: legacy controller is UI/dialog heavy and out of scope for current headless core. |
| M-006 | System command plugin                                | `src/pygpt_net/plugin/cmd_system/plugin.py`; `src/pygpt_net/plugin/cmd_system/worker.py`                                           | High       | High          | Medium            | rewrite        | Phase 1      | done   | Rewritten `sys_exec` with explicit confirmation, strict low-risk executable allowlist, streamed bounded output capture, timeout limits, and permission enforcement. |
| M-007 | Mailer command plugin                                | `src/pygpt_net/plugin/mailer/plugin.py`; `src/pygpt_net/plugin/mailer/worker.py`; `src/pygpt_net/plugin/mailer/runner.py`          | High       | High          | Medium            | rewrite        | Phase 2      | triage | Command taxonomy is useful; transport and auth should be reimplemented cleanly.              |
| M-008 | Gmail indexing loader                                | `src/pygpt_net/provider/loaders/web_google_gmail.py`                                                                               | Medium     | Medium        | High              | rewrite        | Phase 2      | triage | Loader API is LlamaIndex-specific; keep only argument semantics.                             |
| M-009 | Google Calendar indexing loader                      | `src/pygpt_net/provider/loaders/web_google_calendar.py`                                                                            | Medium     | Medium        | High              | rewrite        | Phase 2      | triage | Rebuild as integration adapter, not retrieval/index loader.                                  |
| M-010 | Google Drive indexing loader                         | `src/pygpt_net/provider/loaders/web_google_drive.py`                                                                               | Medium     | Medium        | High              | rewrite        | Phase 2      | triage | Reuse endpoint/argument ideas only; avoid inheriting indexer abstractions.                   |
| M-011 | OneDrive indexing loader                             | `src/pygpt_net/provider/loaders/web_microsoft_onedrive.py`                                                                         | Medium     | Medium        | High              | rewrite        | Phase 2      | triage | Same rationale as Drive loader.                                                              |
| M-012 | Google mega-plugin command set                       | `src/pygpt_net/plugin/google/plugin.py`; `src/pygpt_net/plugin/google/worker.py`                                                   | Medium     | Very High     | High              | defer          | Phase 3      | triage | Too broad for MVP; split into focused connectors (gmail/calendar/drive/docs).                |
| M-013 | GitHub plugin                                        | `src/pygpt_net/plugin/github/plugin.py`; `src/pygpt_net/plugin/github/worker.py`                                                   | Low        | Medium        | Medium            | defer          | Phase 3      | triage | Useful later, but outside immediate assistant identity baseline.                             |
| M-014 | Voice accessibility controller                       | `src/pygpt_net/controller/access/voice.py`                                                                                         | High       | High          | Medium            | rewrite        | Phase 3      | triage | Keep flow ideas (event feedback, confirmations), rebuild around new app events.              |
| M-015 | Audio input plugin                                   | `src/pygpt_net/plugin/audio_input/plugin.py`; `src/pygpt_net/plugin/audio_input/worker.py`                                         | Medium     | High          | High              | rewrite        | Phase 3      | triage | Keep provider abstraction idea; avoid carrying complex mode-specific behavior.               |
| M-016 | Audio output plugin                                  | `src/pygpt_net/plugin/audio_output/plugin.py`; `src/pygpt_net/plugin/audio_output/worker.py`                                       | Medium     | High          | High              | rewrite        | Phase 3      | triage | Keep cache and provider concepts; re-implement pipeline with simpler contracts.              |
| M-017 | Image generation plugin                              | `src/pygpt_net/plugin/openai_dalle/plugin.py`                                                                                      | Medium     | Medium        | Medium            | rewrite        | Phase 3      | triage | Keep "inline image command in chat" concept, replace mode-specific glue.                     |
| M-018 | Calendar UI tab + controller                         | `src/pygpt_net/ui/layout/chat/calendar.py`; `src/pygpt_net/controller/calendar/calendar.py`                                        | Low        | High          | Medium            | defer          | N/A          | triage | Current semantics are chat-history centric, not scheduling centric.                          |
| M-019 | Painter UI tab                                       | `src/pygpt_net/ui/layout/chat/painter.py`; `src/pygpt_net/ui/widget/draw/painter.py`                                               | Low        | High          | Medium            | defer          | N/A          | triage | Not aligned with core MVP; revisit only after core productivity surface is stable.           |
| M-020 | Mode system                                          | `src/pygpt_net/core/modes/modes.py`; `src/pygpt_net/controller/mode/mode.py`; `src/pygpt_net/ui/layout/toolbox/mode.py`            | High       | Very High     | Medium            | rewrite        | Phase 1      | triage | Collapse to one assistant surface; legacy contains deprecated and overlapping modes.         |
| M-021 | Plugin registry/runtime management                   | `src/pygpt_net/core/plugins/plugins.py`                                                                                            | Medium     | High          | Medium            | rewrite        | Phase 2      | triage | Useful reference for option lifecycle; design new registry with typed contracts.             |
| M-022 | Chat controller decomposition pattern                | `src/pygpt_net/controller/chat/chat.py`                                                                                            | Medium     | Medium        | Low               | import         | Phase 1      | triage | Keep compositional structure idea (`input/output/stream/tools`) without legacy dependencies. |


## Repo Signal Snapshot (for prioritization)

- `py-gpt/requirements.txt` currently has **4951 lines**; dependency minimization should be tracked as a migration blocker.
- Provider and integration logic is frequently routed through plugin + event + UI layers, increasing coupling cost for direct imports.
- Multiple legacy surfaces are good conceptual references but poor copy targets (mode system, UI tabs, broad plugins).

## Backlog Entry Template

Copy this block for each new candidate:

```
ID: M-###
Legacy path: <path in py-gpt>
Candidate target path: <path in desktop-assistant-new>
User value: <high/medium/low>
Coupling risk: <low/medium/high>
Dependency impact: <low/medium/high>
Recommendation: <import/rewrite/defer>
Target phase: <phase>
Decision owner: <name>
Status: <triage/import/rewrite/defer/done>
Tests required:
  - <test name or file>
Notes:
  - <key concern or rationale>
```

## Ready-for-Import Gate

A backlog item may move from `triage` to `import` only when all are true:

- Legacy code has a bounded interface
- New tests are defined before copy/adaptation
- Dependencies are approved
- Naming and API surface match this repo conventions
- Security/policy constraints are preserved

