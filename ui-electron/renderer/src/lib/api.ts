import type { AssistantApi } from "../types";

// Single accessor so components can pretend the IPC surface is always present.
// In practice it is injected by `ui-electron/preload.js` via contextBridge.
export function api(): AssistantApi {
  if (typeof window === "undefined" || !window.assistantApi) {
    throw new Error(
      "assistantApi is not available. The renderer must be hosted by Electron with preload.js loaded."
    );
  }
  return window.assistantApi;
}
