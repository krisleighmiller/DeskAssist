# Phase 1 Identity Inventory

This document completes Phase 1 of the analyst workbench plan.

The goal here is not to rename the repo yet. The goal is to make the current product boundary explicit so future work can preserve the shell while avoiding accidental recommitment to the old Void identity.

## Phase 1 Outcome

Phase 1 is complete when these questions have clear answers:

- what is product identity and branding
- what is a reusable shell seam
- what is product logic that may survive with adaptation
- what should not be renamed until the analyst core is proven

The current answer is:

- keep the VS Code-derived shell and current product contribution seam
- keep `src/vs/workbench/contrib/void/` in place temporarily as the active experimentation root
- delay broad renaming until Phase 6
- treat current Void naming as inventory and constraint data, not as a prompt to start a churn-heavy rewrite

## Identity Surfaces In The Repo

These files currently define the repo's visible product identity, runtime naming, or packaging/distribution identity.

### Product Metadata

`product.json` is the center of current identity. It defines:

- app names: `nameShort`, `nameLong`, `applicationName`, `serverApplicationName`, `tunnelApplicationName`
- storage identity: `dataFolderName`, `serverDataFolderName`
- OS-specific identifiers: `win32MutexName`, `win32AppUserModelId`, bundle IDs, app IDs, tunnel mutexes
- launch and protocol identity: `urlProtocol`, `linuxIconName`
- support and issue endpoints: `licenseUrl`, `serverLicenseUrl`, `reportIssueUrl`
- trusted-domain identity tied to Void web properties

Conclusion:

- `product.json` is pure identity/config surface, not analyst-core logic
- it should be replaced later as one coordinated rename/distribution pass
- it should not be changed yet unless a specific experiment is blocked by it

### Main-Process Runtime Channels

`src/vs/code/electron-main/app.ts` is the main-process seam where Void-specific runtime contracts become real.

Current Void-specific registrations include:

- `IMetricsService`
- `IVoidUpdateService`
- `IVoidSCMService`
- IPC channels:
  - `void-channel-metrics`
  - `void-channel-update`
  - `void-channel-llmMessage`
  - `void-channel-scm`
  - `void-channel-mcp`

This file also depends on `productService.urlProtocol`, which ties runtime behavior back to `product.json`.

Conclusion:

- this is an architectural seam, not just branding
- the shell should stay intact, but the `void-channel-*` namespace and `IVoid*` contracts are eventual Phase 6 cleanup targets
- do not rename these channels yet; changing them early would create churn across browser/common/electron-main layers before the new product boundary is settled

### Workbench Mount Point

`src/vs/workbench/workbench.common.main.ts` is the workbench entry point that mounts the custom product contribution:

- `./contrib/void/browser/void.contribution.js`

Conclusion:

- this is a shell seam worth preserving
- the mount point proves the repo already has a dedicated product boundary
- keeping this seam is more important than renaming it right now

### Product Contribution Root

`src/vs/workbench/contrib/void/browser/void.contribution.ts` is the current composition root for product behavior.

It registers the current custom product surface, including:

- inline diff/edit flows
- sidebar actions and pane
- quick edit
- autocomplete
- settings pane
- update actions
- tool services
- thread history
- metrics
- onboarding
- SCM integration

Conclusion:

- this is the best temporary home for early analyst workbench experiments
- the location is Void-specific, but the existence of a single contribution root is an asset
- keep it in place through the early analyst-core phases, then decide in Phase 6 whether to rename or relocate it

### Feature And Settings Identity

`src/vs/workbench/contrib/void/common/voidSettingsTypes.ts` is one of the clearest files where the current product model is still encoded.

The file currently organizes model selection and settings around:

- `Chat`
- `Ctrl+K`
- `Autocomplete`
- `Apply`
- `SCM`

It also encodes chat-centered global state such as:

- `chatMode`
- `syncApplyToChat`
- `syncSCMToChat`
- `enableAutocomplete`
- `enableFastApply`

Conclusion:

- this is not just branding; it is a product-assumption surface
- the file should be treated as a design constraint to outgrow in Phase 2, not as the permanent feature taxonomy
- this is a strong example of "product assumptions we want to replace"

### Void-Specific Service And Decorator Names

Several service boundaries already encode Void in names or decorator IDs, including:

- `IVoidSettingsService`
- `IVoidModelService`
- `IVoidUpdateService`
- `IVoidSCMService`
- `voidChatThreadService`
- `voidSCMService`
- `VoidSettingsService`
- `VoidUpdateService`
- `VoidMainUpdateService`
- `VoidSCMService`

Conclusion:

- these names are part branding, part architecture
- they should remain stable during early experiments so the app shell stays functional
- they should be renamed only once the analyst-first boundary is clear enough to rename coherently instead of piecemeal

### Packaging And Distribution Surfaces

Current Linux packaging/distribution identity is spread across:

- `scripts/appimage/create_appimage.sh`
- `scripts/appimage/void.desktop`
- `scripts/appimage/void-url-handler.desktop`

These encode:

- executable names like `void`
- desktop icon name `void`
- workspace mime type `application/x-void-workspace`
- URL handler mime type `x-scheme-handler/void`
- UI labels such as `Void` and `Void - URL Handler`

Additional distribution identity also appears in:

- `extensions/open-remote-ssh/package.json`
- `extensions/open-remote-ssh/src/serverSetup.ts`
- `extensions/open-remote-wsl/package.json`
- `extensions/open-remote-wsl/src/serverSetup.ts`

Those files point to `voideditor`-hosted release artifacts.

Conclusion:

- packaging identity is real and operationally sticky
- it should not be changed until the analyst core is worth distributing under a new identity
- Phase 6 should update packaging, URLs, protocol names, and release endpoints together

### Contributor And Product Docs

Current docs still define the repo as Void:

- `README.md`
- `HOW_TO_CONTRIBUTE.md`
- `VOID_CODEBASE_GUIDE.md`

These files still describe the repo as:

- Void
- a Cursor alternative / AI code editor
- a repo built and distributed through Void-specific infrastructure

Conclusion:

- these docs are identity surfaces, not neutral technical references
- they should remain historically accurate for now, but any new analyst-workbench planning should stay isolated under `plans/analyst-workbench/`
- later product-facing docs should be updated together with the actual rename boundary

## Void-Specific Architectural Seams

The repo has several seams that are useful to keep even though their naming is currently Void-specific.

### Shell We Want To Keep

Keep these because they provide structure without forcing the old product thesis:

- the VS Code-derived shell and workbench mount in `src/vs/workbench/workbench.common.main.ts`
- the dedicated product contribution root in `src/vs/workbench/contrib/void/browser/void.contribution.ts`
- the repo-aware context and ongoing-context services under `src/vs/workbench/contrib/void/`
- the browser/common/electron-main split already used for model execution and tool routing
- the reviewable edit/apply infrastructure as a supporting capability

### Product Assumptions We Want To Replace

Replace or redesign these later because they keep the product centered on coding-assistant behavior:

- feature naming organized around `Chat`, `Ctrl+K`, `Autocomplete`, `Apply`, and `SCM`
- global state that assumes chat is the hub other features sync to
- chat-first sidebar framing as the primary visible product surface
- `void-channel-*` IPC and `IVoid*` service names as permanent product vocabulary
- update/download/help text that assumes the repo remains distributed as Void

### Branding Versus Architecture Versus Product Logic

The practical split for future work is:

- branding:
  - `product.json`
  - desktop entries
  - website, issue, and download URLs
  - docs that still present the repo as Void
- architecture:
  - workbench mount point
  - contribution root
  - main-process channels and service contracts
  - settings/state service boundaries
- product logic:
  - context gathering
  - thread/session persistence candidates
  - tool routing
  - reviewable edit/apply flows
  - repo-structure and analysis helpers

This means Phase 1 should preserve architecture, avoid premature branding churn, and identify which product logic is worth adapting later.

## Decisions Made In Phase 1

### 1. Keep `src/vs/workbench/contrib/void/` Temporarily

Decision:

- yes, keep it in place during early experiments

Why:

- it is already the cleanest product seam in the repo
- moving it now would create mechanical rename work without improving the analyst core
- the guardrails explicitly prefer additive experiments over invasive rewrites

### 2. Delay Renaming Until The Analyst Core Is Proven

Decision:

- yes, broad renaming should wait until after the analyst core is credible

Why:

- the current risk is not lack of rename work; it is letting old product assumptions shape the new product
- early rename work would spread across metadata, IPC contracts, services, docs, and packaging at once
- waiting preserves optionality while Phase 2 and Phase 3 clarify the real future boundary

### 3. Packaging And Distribution Replacement Is A Later Coordinated Pass

Decision:

- package/distribution replacement belongs primarily to Phase 6

Surfaces already identified for that later pass:

- `product.json`
- `src/vs/code/electron-main/app.ts`
- `scripts/appimage/create_appimage.sh`
- `scripts/appimage/void.desktop`
- `scripts/appimage/void-url-handler.desktop`
- `extensions/open-remote-ssh/package.json`
- `extensions/open-remote-ssh/src/serverSetup.ts`
- `extensions/open-remote-wsl/package.json`
- `extensions/open-remote-wsl/src/serverSetup.ts`
- `README.md`
- `HOW_TO_CONTRIBUTE.md`
- `VOID_CODEBASE_GUIDE.md`

## Phase 1 Definition Of Done Check

Phase 1 is complete because this repo now has an explicit answer to the checklist question:

- you can point to the exact files that define current identity, runtime channels, settings, and packaging

Those files are now named above, and they are separated into:

- shell worth preserving
- assumptions to redesign
- identity surfaces to rename later

That is enough to move into Phase 2 without pretending the repo has already been re-anchored under the new product boundary.
