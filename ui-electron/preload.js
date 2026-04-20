const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("assistantApi", {
  // Casefile + lane management
  chooseCasefile: () => ipcRenderer.invoke("casefile:choose"),
  openCasefile: (root) => ipcRenderer.invoke("casefile:open", { root }),
  chooseLaneRoot: () => ipcRenderer.invoke("casefile:chooseLaneRoot"),
  registerLane: (lane) => ipcRenderer.invoke("casefile:registerLane", { lane }),
  switchLane: (laneId) => ipcRenderer.invoke("casefile:switchLane", { laneId }),
  listChat: (laneId) => ipcRenderer.invoke("casefile:listChat", { laneId }),

  // Lane-scoped filesystem (rooted at the active lane).
  listWorkspace: (maxDepth = 4) => ipcRenderer.invoke("workspace:list", { maxDepth }),
  readFile: (path, maxChars = 200000) => ipcRenderer.invoke("file:read", { path, maxChars }),
  saveFile: (path, content) => ipcRenderer.invoke("file:save", { path, content }),

  // Chat (against the currently active casefile + lane).
  sendChat: (payload) => ipcRenderer.invoke("chat:send", payload),

  // API keys.
  getApiKeyStatus: () => ipcRenderer.invoke("keys:getStatus"),
  saveApiKeys: (payload) => ipcRenderer.invoke("keys:save", payload),
  clearApiKey: (provider) => ipcRenderer.invoke("keys:clear", { provider }),
  onOpenApiKeys: (handler) => {
    const wrapped = () => handler();
    ipcRenderer.on("app:open-api-keys", wrapped);
    return () => ipcRenderer.removeListener("app:open-api-keys", wrapped);
  },
});
