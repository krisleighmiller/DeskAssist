import { useState } from "react";
import type { ApiKeyStatus, Provider } from "../types";
import { api } from "../lib/api";

interface ApiKeysDialogProps {
  status: ApiKeyStatus;
  onClose: () => void;
  onStatusChange: (status: ApiKeyStatus) => void;
}

export function ApiKeysDialog({ status, onClose, onStatusChange }: ApiKeysDialogProps): JSX.Element {
  const [openai, setOpenai] = useState("");
  const [anthropic, setAnthropic] = useState("");
  const [deepseek, setDeepseek] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api().saveApiKeys({ openai, anthropic, deepseek });
      onStatusChange(next);
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

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog" onClick={(event) => event.stopPropagation()}>
        <h3>API Keys</h3>
        <p className="muted">
          Stored via {status.storageBackend === "keychain" ? "system keychain" : "user-data file"}.
          Empty fields leave the existing key unchanged.
        </p>
        <div className="keys-grid">
          <label htmlFor="openaiKey">OpenAI</label>
          <input
            id="openaiKey"
            type="password"
            placeholder={status.openaiConfigured ? "configured (leave blank to keep)" : "sk-..."}
            value={openai}
            onChange={(event) => setOpenai(event.target.value)}
          />
          <button type="button" disabled={busy} onClick={() => clear("openai")}>
            Clear
          </button>

          <label htmlFor="anthropicKey">Anthropic</label>
          <input
            id="anthropicKey"
            type="password"
            placeholder={
              status.anthropicConfigured ? "configured (leave blank to keep)" : "sk-ant-..."
            }
            value={anthropic}
            onChange={(event) => setAnthropic(event.target.value)}
          />
          <button type="button" disabled={busy} onClick={() => clear("anthropic")}>
            Clear
          </button>

          <label htmlFor="deepseekKey">DeepSeek</label>
          <input
            id="deepseekKey"
            type="password"
            placeholder={status.deepseekConfigured ? "configured (leave blank to keep)" : "sk-..."}
            value={deepseek}
            onChange={(event) => setDeepseek(event.target.value)}
          />
          <button type="button" disabled={busy} onClick={() => clear("deepseek")}>
            Clear
          </button>
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
