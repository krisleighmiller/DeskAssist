import { useEffect, useState } from "react";
import {
  DEFAULT_PROVIDER_MODELS,
  type ApiKeyStatus,
  type Provider,
  type ProviderModels,
} from "../types";
import { api } from "../lib/api";

interface ApiKeysDialogProps {
  status: ApiKeyStatus;
  onClose: () => void;
  onStatusChange: (status: ApiKeyStatus) => void;
  /** Currently saved per-provider model overrides. Empty strings mean
   * "use backend default"; the dialog shows the default as a placeholder. */
  models: ProviderModels;
  onModelsChange: (models: ProviderModels) => void;
}

const PROVIDER_LABELS: Record<Provider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  deepseek: "DeepSeek",
};

export function ApiKeysDialog({
  status,
  onClose,
  onStatusChange,
  models,
  onModelsChange,
}: ApiKeysDialogProps): JSX.Element {
  const [openai, setOpenai] = useState("");
  const [anthropic, setAnthropic] = useState("");
  const [deepseek, setDeepseek] = useState("");
  // Model fields are seeded from the saved values so the user can edit
  // (rather than having to retype the current model from scratch). They
  // are persisted independently of the keys — clearing a model field and
  // saving sets it back to "" (use backend default).
  const [modelDraft, setModelDraft] = useState<ProviderModels>(models);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setModelDraft(models);
  }, [models]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const nextStatus = await api().saveApiKeys({ openai, anthropic, deepseek });
      onStatusChange(nextStatus);
      const nextModels = await api().saveProviderModels(modelDraft);
      onModelsChange(nextModels);
      setModelDraft(nextModels);
      setOpenai("");
      setAnthropic("");
      setDeepseek("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const clear = async (provider: Provider) => {
    setBusy(true);
    setError(null);
    try {
      const next = await api().clearApiKey(provider);
      onStatusChange(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const setModel = (provider: Provider, value: string) => {
    setModelDraft((prev) => ({ ...prev, [provider]: value }));
  };

  const renderRow = (
    provider: Provider,
    keyValue: string,
    setKey: (value: string) => void,
    keyConfigured: boolean,
    keyPlaceholder: string
  ) => {
    const inputId = `${provider}Key`;
    const modelId = `${provider}Model`;
    return (
      <>
        <label htmlFor={inputId}>{PROVIDER_LABELS[provider]}</label>
        <input
          id={inputId}
          type="password"
          placeholder={keyConfigured ? "configured (leave blank to keep)" : keyPlaceholder}
          value={keyValue}
          onChange={(event) => setKey(event.target.value)}
        />
        <button type="button" disabled={busy} onClick={() => clear(provider)}>
          Clear
        </button>
        <span className="muted keys-grid-model-label">Model</span>
        <input
          id={modelId}
          type="text"
          placeholder={DEFAULT_PROVIDER_MODELS[provider]}
          value={modelDraft[provider]}
          onChange={(event) => setModel(provider, event.target.value)}
        />
        <button
          type="button"
          disabled={busy || !modelDraft[provider]}
          onClick={() => setModel(provider, "")}
          title="Reset to backend default"
        >
          Reset
        </button>
      </>
    );
  };

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(event) => event.stopPropagation()}>
        <h3>API Keys & Models</h3>
        <p className="muted">
          Keys stored via {status.storageBackend === "keychain" ? "system keychain" : "user-data file"}.
          Empty key fields leave the existing key unchanged. Model fields override the
          built-in defaults shown as placeholders; leave blank to keep using the default.
        </p>
        <div className="keys-grid">
          {renderRow("openai", openai, setOpenai, status.openaiConfigured, "sk-...")}
          {renderRow(
            "anthropic",
            anthropic,
            setAnthropic,
            status.anthropicConfigured,
            "sk-ant-..."
          )}
          {renderRow("deepseek", deepseek, setDeepseek, status.deepseekConfigured, "sk-...")}
        </div>
        <div className="actions">
          {error && <span className="status error">Error: {error}</span>}
          <button type="button" onClick={save} disabled={busy}>
            {busy ? "Saving..." : "Save"}
          </button>
          <button type="button" onClick={onClose} disabled={busy}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
