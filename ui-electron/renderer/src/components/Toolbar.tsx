import {
  DEFAULT_PROVIDER_MODELS,
  type ApiKeyStatus,
  type CasefileSnapshot,
  type Lane,
  type Provider,
  type ProviderModels,
} from "../types";

interface ToolbarProps {
  casefile: CasefileSnapshot | null;
  provider: Provider;
  onProviderChange: (provider: Provider) => void;
  keyStatus: ApiKeyStatus;
  /** Per-provider model overrides. Empty string for a provider means
   * "use the backend default" — the toolbar surfaces the resolved model
   * (override OR default) so users can see what they'll get without
   * opening the API Keys & Models dialog. */
  providerModels: ProviderModels;
  onChooseCasefile: () => void;
  onOpenKeys: () => void;
  onSwitchLane?: (laneId: string) => void;
  /** Show/hide the integrated-terminal pane. Mirrors the View →
   * Toggle Integrated Terminal menu item and the CmdOrCtrl+`
   * accelerator. */
  onToggleTerminal: () => void;
  /** Whether the integrated-terminal pane is currently visible.
   * Drives the pressed/aria-pressed state on the toolbar button so
   * the user can see at a glance whether the pane is open. */
  terminalOpen: boolean;
}

function describeKeys(status: ApiKeyStatus): string {
  const tags: string[] = [];
  if (status.openaiConfigured) tags.push("OpenAI");
  if (status.anthropicConfigured) tags.push("Anthropic");
  if (status.deepseekConfigured) tags.push("DeepSeek");
  const backend = status.storageBackend === "keychain" ? "Keychain" : "File";
  return tags.length > 0
    ? `Keys (${backend}): ${tags.join(", ")}`
    : `No keys configured (${backend})`;
}

function ancestorChain(casefile: CasefileSnapshot, laneId: string | null): Lane[] {
  if (!laneId) return [];
  const byId = new Map(casefile.lanes.map((l) => [l.id, l]));
  const chain: Lane[] = [];
  let current = byId.get(laneId);
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    chain.unshift(current);
    seen.add(current.id);
    const parentId = current.parentId ?? null;
    current = parentId ? byId.get(parentId) : undefined;
  }
  return chain;
}

export function Toolbar(props: ToolbarProps): JSX.Element {
  const {
    casefile,
    provider,
    onProviderChange,
    keyStatus,
    providerModels,
    onChooseCasefile,
    onOpenKeys,
    onSwitchLane,
    onToggleTerminal,
    terminalOpen,
  } = props;
  const terminalShortcutHint =
    typeof navigator !== "undefined" && /Mac/i.test(navigator.platform)
      ? "⌘`"
      : "Ctrl+`";
  const chain = casefile ? ancestorChain(casefile, casefile.activeLaneId) : [];
  const activeModel =
    providerModels[provider]?.trim() || DEFAULT_PROVIDER_MODELS[provider];
  const modelIsDefault = !providerModels[provider]?.trim();
  return (
    <div className="toolbar">
      <button type="button" onClick={onChooseCasefile}>
        Open Casefile
      </button>
      {casefile ? (
        <span className="breadcrumb" title={casefile.root}>
          <span className="breadcrumb-root">{casefile.root}</span>
          {chain.length === 0 ? (
            <span className="breadcrumb-empty"> — no active lane</span>
          ) : (
            chain.map((lane, idx) => {
              const isLast = idx === chain.length - 1;
              return (
                <span key={lane.id} className="breadcrumb-segment">
                  <span className="breadcrumb-sep"> / </span>
                  {onSwitchLane && !isLast ? (
                    <button
                      type="button"
                      className="breadcrumb-link"
                      onClick={() => onSwitchLane(lane.id)}
                      title={lane.root}
                    >
                      {lane.name}
                    </button>
                  ) : (
                    <span
                      className={`breadcrumb-segment-label${isLast ? " active" : ""}`}
                      title={lane.root}
                    >
                      {lane.name}
                      <span className="breadcrumb-kind"> ({lane.kind})</span>
                    </span>
                  )}
                </span>
              );
            })
          )}
        </span>
      ) : (
        <span className="breadcrumb breadcrumb-empty">No casefile open</span>
      )}
      <label htmlFor="providerSelect">Provider</label>
      <select
        id="providerSelect"
        value={provider}
        onChange={(event) => onProviderChange(event.target.value as Provider)}
      >
        <option value="openai">OpenAI</option>
        <option value="anthropic">Anthropic</option>
        <option value="deepseek">DeepSeek</option>
      </select>
      <span
        className="toolbar-model"
        title={modelIsDefault ? "Backend default — change in API Keys & Models" : "Custom model"}
      >
        Model: <code>{activeModel}</code>
        {modelIsDefault && <span className="muted"> (default)</span>}
      </span>
      <button type="button" onClick={onOpenKeys}>
        API Keys & Models
      </button>
      <button
        type="button"
        className={`toolbar-terminal-toggle${terminalOpen ? " active" : ""}`}
        onClick={onToggleTerminal}
        aria-pressed={terminalOpen}
        title={`Toggle integrated terminal (${terminalShortcutHint})`}
      >
        Terminal
      </button>
      <span className="keys-status">{describeKeys(keyStatus)}</span>
    </div>
  );
}
