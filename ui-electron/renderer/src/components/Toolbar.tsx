import type { ApiKeyStatus, CasefileSnapshot, Lane, Provider } from "../types";

interface ToolbarProps {
  casefile: CasefileSnapshot | null;
  provider: Provider;
  onProviderChange: (provider: Provider) => void;
  keyStatus: ApiKeyStatus;
  onChooseCasefile: () => void;
  onOpenKeys: () => void;
  onSwitchLane?: (laneId: string) => void;
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
  const { casefile, provider, onProviderChange, keyStatus, onChooseCasefile, onOpenKeys, onSwitchLane } = props;
  const chain = casefile ? ancestorChain(casefile, casefile.activeLaneId) : [];
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
      <button type="button" onClick={onOpenKeys}>
        API Keys
      </button>
      <span className="keys-status">{describeKeys(keyStatus)}</span>
    </div>
  );
}
