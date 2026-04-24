import { useRef, useState } from "react";
import {
  DEFAULT_PROVIDER_MODELS,
  type ApiKeyStatus,
  type CasefileSnapshot,
  type Lane,
  type Provider,
  type ProviderModels,
} from "../types";
import { ContextMenu } from "./ContextMenu";

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
  onCloseCasefile?: () => void;
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
  /** M2.5: Lane management actions surfaced in the toolbar dropdown so
   * they are reachable without right-clicking the file tree. */
  onUpdateLaneName?: (laneId: string, newName: string) => Promise<void>;
  onRemoveLane?: (laneId: string) => Promise<void>;
  onSetLaneWritable?: (laneId: string, writable: boolean) => Promise<void>;
  onHardResetCasefile?: () => Promise<void>;
  onSoftResetCasefile?: () => Promise<void>;
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
    onCloseCasefile,
    onOpenKeys,
    onSwitchLane,
    onToggleTerminal,
    terminalOpen,
    onUpdateLaneName,
    onRemoveLane,
    onSetLaneWritable,
    onHardResetCasefile,
    onSoftResetCasefile,
  } = props;

  const terminalShortcutHint =
    typeof navigator !== "undefined" && /Mac/i.test(navigator.platform)
      ? "⌘`"
      : "Ctrl+`";
  const chain = casefile ? ancestorChain(casefile, casefile.activeLaneId) : [];
  const activeModel =
    providerModels[provider]?.trim() || DEFAULT_PROVIDER_MODELS[provider];
  const modelIsDefault = !providerModels[provider]?.trim();

  const [laneMenuOpen, setLaneMenuOpen] = useState(false);
  const laneButtonRef = useRef<HTMLButtonElement>(null);

  const activeLane = casefile
    ? casefile.lanes.find((l) => l.id === casefile.activeLaneId) ?? null
    : null;

  const openLaneMenu = () => {
    setLaneMenuOpen(true);
  };

  /** Build the items list for the Lane ▾ dropdown. */
  const buildLaneMenuItems = () => {
    if (!casefile) return [];
    const items: import("./ContextMenu").ContextMenuItem[] = [];

    // Switch to another lane.
    const others = casefile.lanes.filter((l) => l.id !== casefile.activeLaneId);
    if (others.length > 0) {
      for (const lane of others) {
        items.push({
          label: `Switch to "${lane.name}"`,
          onSelect: () => {
            void Promise.resolve(onSwitchLane?.(lane.id));
          },
        });
      }
      items[items.length - 1] = { ...items[items.length - 1], separator: true };
    }

    // Active-lane management (rename, access toggle, remove).
    if (activeLane) {
      if (onUpdateLaneName) {
        items.push({
          label: "Rename lane…",
          onSelect: () => {
            const newName = window.prompt("New name for this lane:", activeLane.name);
            if (!newName?.trim() || newName.trim() === activeLane.name) return;
            void onUpdateLaneName(activeLane.id, newName.trim());
          },
        });
      }
      if (onSetLaneWritable) {
        const isWritable = activeLane.writable !== false;
        items.push({
          label: isWritable
            ? "Set AI access: read-only"
            : "Set AI access: writable",
          onSelect: () => {
            void onSetLaneWritable(activeLane.id, !isWritable);
          },
        });
      }
      if (onRemoveLane) {
        items.push({
          label: "Remove lane",
          onSelect: () => {
            const ok = window.confirm(
              `Remove lane "${activeLane.name}"?\n\nThis removes it from the casefile but does not delete any files.`
            );
            if (!ok) return;
            void onRemoveLane(activeLane.id);
          },
          separator: !!(onSoftResetCasefile || onHardResetCasefile),
        });
      }
    }

    // Casefile-level reset actions.
    if (onSoftResetCasefile) {
      items.push({
        label: "Reset casefile (soft)…",
        onSelect: () => {
          const ok = window.confirm(
            "Soft reset clears lane registrations and chat history metadata. Files on disk are preserved."
          );
          if (!ok) return;
          void onSoftResetCasefile();
        },
      });
    }
    if (onHardResetCasefile) {
      items.push({
        label: "Hard reset casefile…",
        onSelect: () => {
          const ok = window.confirm(
            "Hard reset deletes the entire .casefile metadata folder.\n\nConversation history, lane registrations, and settings will be permanently removed. Files on disk are preserved.\n\nThis cannot be undone. Continue?"
          );
          if (!ok) return;
          void onHardResetCasefile();
        },
      });
    }

    return items;
  };

  // Position the dropdown flush below the "Lane ▾" button.
  const laneMenuPos = (() => {
    if (!laneButtonRef.current) return { x: 0, y: 32 };
    const rect = laneButtonRef.current.getBoundingClientRect();
    return { x: rect.left, y: rect.bottom + 2 };
  })();

  return (
    <div className="toolbar">
      <button type="button" onClick={onChooseCasefile}>
        Open Casefile
      </button>
      {casefile && onCloseCasefile && (
        <button type="button" onClick={onCloseCasefile}>
          Close Casefile
        </button>
      )}
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
      {casefile && (
        <div className="toolbar-lane-menu-wrapper">
          <button
            ref={laneButtonRef}
            type="button"
            className="toolbar-lane-btn"
            aria-haspopup="menu"
            aria-expanded={laneMenuOpen}
            onClick={openLaneMenu}
            title="Lane management actions"
          >
            Lane ▾
          </button>
          {laneMenuOpen && (
            <ContextMenu
              x={laneMenuPos.x}
              y={laneMenuPos.y}
              items={buildLaneMenuItems()}
              onClose={() => setLaneMenuOpen(false)}
            />
          )}
        </div>
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
        API Keys &amp; Models
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
