import { useCallback, useEffect, useRef, useState } from "react";

import { api } from "../lib/api";
import type { ApiKeyStatus, Provider, ProviderModels } from "../types";

const PROVIDER_STORAGE_KEY = "deskassist.selectedProvider";

const VALID_PROVIDERS: readonly Provider[] = ["openai", "anthropic", "deepseek"];

const DEFAULT_KEY_STATUS: ApiKeyStatus = {
  openaiConfigured: false,
  anthropicConfigured: false,
  deepseekConfigured: false,
  storageBackend: "file",
};

const EMPTY_PROVIDER_MODELS: ProviderModels = {
  openai: "",
  anthropic: "",
  deepseek: "",
};

function isValidProvider(value: unknown): value is Provider {
  return typeof value === "string" && (VALID_PROVIDERS as readonly string[]).includes(value);
}

function readPersistedProvider(): Provider {
  // localStorage can throw in Safari private mode and some sandboxed
  // contexts; treat any failure as "no preference". (Review item #10.)
  try {
    const saved = window.localStorage.getItem(PROVIDER_STORAGE_KEY);
    if (isValidProvider(saved)) return saved;
  } catch {
    // ignore
  }
  return "openai";
}

export function useProviderSettings() {
  const [provider, setProvider] = useState<Provider>(readPersistedProvider);
  const [keyStatus, setKeyStatus] = useState<ApiKeyStatus>(DEFAULT_KEY_STATUS);
  const [providerModels, setProviderModels] =
    useState<ProviderModels>(EMPTY_PROVIDER_MODELS);

  useEffect(() => {
    try {
      window.localStorage.setItem(PROVIDER_STORAGE_KEY, provider);
    } catch {
      // ignore (e.g., quota exceeded, private browsing)
    }
  }, [provider]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const next = await api().getProviderModels();
        if (!cancelled) setProviderModels(next);
      } catch (error) {
        console.warn("getProviderModels failed", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The auto-switch heuristic ("if exactly one provider is configured,
  // jump to it") only runs once at mount. We track that explicitly so
  // it's clear that subsequent key configurations don't silently swap
  // the user's selection out from under them.
  const initialAutoSwitchDoneRef = useRef(false);

  const refreshKeyStatus = useCallback(async () => {
    try {
      const status = await api().getApiKeyStatus();
      setKeyStatus(status);
      if (initialAutoSwitchDoneRef.current) return;
      initialAutoSwitchDoneRef.current = true;
      const configured: Provider[] = [];
      if (status.openaiConfigured) configured.push("openai");
      if (status.anthropicConfigured) configured.push("anthropic");
      if (status.deepseekConfigured) configured.push("deepseek");
      // Use the functional form so we're not racing against any other
      // setProvider that may have happened between mount and this
      // resolution. The check still uses the value React knows about.
      setProvider((current) =>
        configured.length === 1 && !configured.includes(current) ? configured[0] : current
      );
    } catch (error) {
      console.warn("getApiKeyStatus failed", error);
    }
  }, []);

  useEffect(() => {
    void refreshKeyStatus();
  }, [refreshKeyStatus]);

  return {
    provider,
    setProvider,
    keyStatus,
    setKeyStatus,
    providerModels,
    setProviderModels,
  };
}
