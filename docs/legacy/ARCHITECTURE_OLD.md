# Architecture

## Product Definition

Desktop assistant focused on:

- Vendor-agnostic AI chat
- Workspace-centric local automation
- Personal integrations (email, calendar, cloud storage)
- Accessibility-first interaction (voice and assistive UX)

Working product sentence:

> A vendor-agnostic desktop AI assistant for chat, local workspace automation, and personal productivity integrations, designed with accessibility as a first-class requirement.

Everything in this repository should support that sentence. Features that do not support it are deferred or removed.

## Design Principles

- **One user mental model**: one assistant surface, not disconnected modes.
- **Stable seams first**: define interfaces and contracts before adding feature breadth.
- **Least privilege by default**: workspace-scoped file access first, explicit opt-in for wider access.
- **Import selectively**: legacy code is a donor source, not an architecture to preserve.
- **Test before trust**: all migrated behavior requires tests in this repository.

## System Boundaries

## 1) Core Runtime

- `assistant_app/chat_service.py`: conversation state, provider routing, and tool discovery/execution entry points
- `assistant_app/providers/`: normalized provider adapter interface and implementations
- `assistant_app/tools/`: local capability interface (files, shell, integrations)
- `assistant_app/security/`: command authorization and sanitization policy
- `assistant_app/config.py`: settings and workspace roots
- `assistant_app/filesystem/`: reusable workspace-bound filesystem helpers

## Current Package Layout (Implemented)

Current package layout in `src/assistant_app`:

- `models.py`: chat request/response primitives
- `chat_service.py`: top-level app service for chat and tools
- `providers/`: shared HTTP chat contract + provider adapters
- `tools/`: registry, schemas, and command handlers
- `filesystem/`: workspace-root-safe file/path helpers
- `security/`: authorization and command sanitization policy
- `config.py`: app config and workspace root setup
- `main.py`: bootstrap entry point

## 2) Integrations

- `integrations/email`: provider connectors and action adapters
- `integrations/calendar`: event retrieval and scheduling actions
- `integrations/cloud`: cloud file listing, metadata, and transfer actions

Integration modules should depend on `core` contracts and avoid direct UI coupling.

## 3) UI Shell

- Single chat-first desktop surface
- Unified account/integration settings
- Transparent permission prompts and activity log
- Accessibility controls available globally (not hidden in niche modes)

## 4) Persistence and Security

- Local session history (explicit retention policy)
- Secret storage abstraction (API keys and OAuth tokens)
- Action audit log for user trust and debugging

## Access Model

Default access:

- User explicitly opens one or more workspace roots
- Assistant can operate only within approved roots

Optional elevated mode:

- Full user-space access requires explicit confirmation
- UI must indicate elevated mode clearly and persistently
- User can revoke elevation without restart

## Provider Contract

Provider implementations must:

- Accept normalized chat request messages
- Resolve API key from explicit config or environment
- Return normalized assistant message output
- Surface actionable errors with provider-specific context

Current providers:

- OpenAI
- Anthropic
- DeepSeek

Future providers should follow existing adapter shape; feature code must never depend on provider-specific payload formats.

## Tool Contract

Tools must expose:

- `name`
- input schema
- execution method
- permission requirements
- deterministic result payload format

Tool execution pipeline:

1. Validate input against schema
2. Evaluate policy/permissions
3. Execute action
4. Return structured result + user-visible summary
5. Record audit event

Current `sys_exec` safety profile:

- disabled for external callers by default
- requires explicit `confirm=true`
- allows only a strict low-risk executable set (no shell/interpreter/path launch)
- streams stdout/stderr capture with configured output bounds

## Legacy Migration Policy

Legacy (`py-gpt`) code may be imported only if all are true:

1. Module is self-contained (minimal transitive coupling)
2. Behavior is testable in isolation
3. Behavior aligns with product definition
4. Dependency impact is acceptable
5. Naming and interfaces can be normalized to this architecture

If any condition fails, rewrite instead of import.

## Import vs Rewrite Checklist

For each candidate module:

- What user problem does it solve in this product?
- What are its hard dependencies?
- Does it leak old mode/UI assumptions?
- Can it run behind current contracts with small adaptation?
- Do we have tests that define expected behavior?

Decision:

- **Import** when adaptation is small and code quality is acceptable
- **Rewrite** when coupling is high, semantics are unclear, or dependencies are heavy

## Phased Delivery Plan

## Phase 0: Foundation

- Lock architecture boundaries and contracts
- Establish config + secrets + logging primitives
- Keep single chat surface only

Exit criteria:

- Provider adapter interface stable
- Tool interface stable
- Workspace access policy implemented

## Phase 1: MVP

- Chat with OpenAI/Anthropic/DeepSeek
- Workspace-scoped file and shell tooling
- Session persistence and basic settings

Exit criteria:

- End-to-end chat with tool invocation works
- Permission prompts protect destructive actions
- Basic reliability tests passing

## Phase 2: Personal Integrations

- Email read/summarize and draft
- Calendar view and create/update actions
- Cloud file browsing and handoff into assistant context

Exit criteria:

- Users can connect/disconnect accounts safely
- Integration actions are auditable and reversible where possible

## Phase 3: Multimodal and Accessibility

- Image generation capability integrated into chat
- Voice input/output pipeline
- Accessibility controls for interaction and display

Exit criteria:

- Voice and image workflows follow same permission and logging standards

## Phase 4: Hardening and Distribution

- Performance, retries, and quota controls
- Packaging and update strategy
- Operational telemetry and error diagnostics

## MVP Acceptance Criteria

- One coherent assistant surface
- No duplicated/overlapping mode taxonomy
- Provider-agnostic chat abstraction in active use
- Workspace access model enforced
- At least one integration path scaffolded behind stable contracts
- Migration backlog tracked for all legacy imports