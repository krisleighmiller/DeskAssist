import type { ApiKeyStatus, CasefileSnapshot, Provider } from "../types";

interface ToolbarProps {
  casefile: CasefileSnapshot | null;
  provider: Provider;
  onProviderChange: (provider: Provider) => void;
  keyStatus: ApiKeyStatus;
  onChooseCasefile: () => void;
  onOpenKeys: () => void;
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

function describeCasefile(casefile: CasefileSnapshot | null): string {
  if (!casefile) {
    return "No casefile open";
  }
  const lane = casefile.lanes.find((l) => l.id === casefile.activeLaneId);
  const laneLabel = lane ? `${lane.name} (${lane.kind})` : "no active lane";
  return `${casefile.root} — ${laneLabel}`;
}

export function Toolbar(props: ToolbarProps): JSX.Element {
  const { casefile, provider, onProviderChange, keyStatus, onChooseCasefile, onOpenKeys } = props;
  return (
    <div className="toolbar">
      <button type="button" onClick={onChooseCasefile}>
        Open Casefile
      </button>
      <span className="workspace-label" title={casefile?.root ?? ""}>
        {describeCasefile(casefile)}
      </span>
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
      <button type="button" onClick={onOpenKeys}>
        API Keys
      </button>
      <span className="keys-status">{describeKeys(keyStatus)}</span>
    </div>
  );
}
