# Migrated From Legacy

Track every legacy import here.

For each migrated module:

- legacy path
- new path
- reason for migration
- what changed
- test file(s) covering the migrated behavior

No entry means no approved migration.

## Entries

- legacy path: `src/pygpt_net/core/security/policy.py`
- new path: `src/assistant_app/security/policy.py`
- reason for migration: establish a strict authorization gate for tool commands before enabling more filesystem and shell capabilities
- what changed: adapted the policy to the new command IDs (`list_dir`, `read_file`, `sys_exec`) and integrated it with the new `ToolRegistry`
- test file(s) covering the migrated behavior: `tests/test_policy.py`, `tests/test_tools.py`

- legacy path: `src/pygpt_net/provider/llms/openai.py`, `src/pygpt_net/provider/llms/anthropic.py`, `src/pygpt_net/provider/llms/deepseek_api.py`
- new path: `src/assistant_app/providers/http_chat.py`, `src/assistant_app/providers/openai.py`, `src/assistant_app/providers/anthropic.py`, `src/assistant_app/providers/deepseek.py`
- reason for migration: replace provider-specific ad hoc logic with a shared adapter contract before scaling integrations
- what changed: introduced `HttpChatProvider` contract (`build_headers`, `build_payload`, `parse_response_text`) and moved all three providers to this shared flow with normalized parse failure handling
- test file(s) covering the migrated behavior: `tests/test_provider_contract.py`, `tests/test_providers.py`

- legacy path: `src/pygpt_net/plugin/cmd_files/plugin.py`, `src/pygpt_net/plugin/cmd_files/worker.py`
- new path: `src/assistant_app/tools/registry.py`, `src/assistant_app/tools/file_tools.py`, `src/assistant_app/tools/__init__.py`
- reason for migration: rewrite file command surface behind explicit schemas and deterministic contract envelopes before broader module imports
- what changed: added schema-based parameter validation, tool specs/permissions, and implemented `list_dir`, `read_file`, `save_file`, `append_file`, `delete_file` with workspace-bound safety checks
- test file(s) covering the migrated behavior: `tests/test_tools.py`, `tests/test_chat_service.py`

- legacy path: `src/pygpt_net/core/filesystem/filesystem.py`
- new path: `src/assistant_app/filesystem/helpers.py`, `src/assistant_app/filesystem/__init__.py`
- reason for migration: extract reusable, UI-independent filesystem primitives before importing broader legacy modules
- what changed: introduced `WorkspaceFilesystem` with workspace-root path resolution, bounded reads, and shared write/delete helpers used by file tools
- test file(s) covering the migrated behavior: `tests/test_filesystem_helpers.py`, `tests/test_tools.py`

- legacy path: `src/pygpt_net/plugin/cmd_system/plugin.py`, `src/pygpt_net/plugin/cmd_system/worker.py`
- new path: `src/assistant_app/tools/system_tools.py`, `src/assistant_app/tools/__init__.py`
- reason for migration: provide a safer system execution path with explicit confirmation and bounded runtime/output behavior
- what changed: `sys_exec` now requires `confirm=true`, permits only a strict low-risk executable allowlist (no shell/interpreter/path launchers), enforces timeout/output bounds with streamed capture, and remains guarded by registry permissions/internal capability
- test file(s) covering the migrated behavior: `tests/test_tools.py`