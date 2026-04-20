import type { ApiKeyStatus, Provider } from "../types";

interface ToolbarProps {
  workspaceRoot: string | null;
  provider: Provider;
  onProviderChange: (provider: Provider) => void;
  keyStatus: ApiKeyStatus;
  onChooseWorkspace: () => void;
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

export function Toolbar(props: ToolbarProps): JSX.Element {
  const { workspaceRoot, provider, onProviderChange, keyStatus, onChooseWorkspace, onOpenKeys } =
    props;
  return (
    <div className="toolbar">
      <button type="button" onClick={onChooseWorkspace}>
        Choose Workspace
      </button>
      <span className="workspace-label" title={workspaceRoot ?? ""}>
        {workspaceRoot ?? "No workspace selected"}
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
