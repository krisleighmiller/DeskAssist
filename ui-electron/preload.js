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

  // Findings, notes, comparison, export (M3).
  listFindings: (laneId) => ipcRenderer.invoke("casefile:listFindings", { laneId }),
  getFinding: (findingId) => ipcRenderer.invoke("casefile:getFinding", { findingId }),
  createFinding: (finding) => ipcRenderer.invoke("casefile:createFinding", { finding }),
  updateFinding: (findingId, finding) =>
    ipcRenderer.invoke("casefile:updateFinding", { findingId, finding }),
  deleteFinding: (findingId) => ipcRenderer.invoke("casefile:deleteFinding", { findingId }),
  getNote: (laneId) => ipcRenderer.invoke("casefile:getNote", { laneId }),
  saveNote: (laneId, content) => ipcRenderer.invoke("casefile:saveNote", { laneId, content }),
  compareLanes: (leftLaneId, rightLaneId) =>
    ipcRenderer.invoke("casefile:compareLanes", { leftLaneId, rightLaneId }),
  exportFindings: (laneIds) => ipcRenderer.invoke("casefile:exportFindings", { laneIds }),
  readLaneFile: (laneId, path, maxChars) =>
    ipcRenderer.invoke("lane:readFile", { laneId, path, maxChars }),

  // M3.5: hierarchical scope, attachments, context manifest, overlay reads.
  setLaneParent: (laneId, parentId) =>
    ipcRenderer.invoke("casefile:setLaneParent", { laneId, parentId }),
  updateLaneAttachments: (laneId, attachments) =>
    ipcRenderer.invoke("casefile:updateLaneAttachments", { laneId, attachments }),
  getContext: () => ipcRenderer.invoke("casefile:getContext"),
  saveContext: (manifest) => ipcRenderer.invoke("casefile:saveContext", { manifest }),
  resolveScope: (laneId) => ipcRenderer.invoke("casefile:resolveScope", { laneId }),
  listOverlayTrees: (laneId, maxDepth) =>
    ipcRenderer.invoke("casefile:listOverlayTrees", { laneId, maxDepth }),
  readOverlayFile: (laneId, path, maxChars) =>
    ipcRenderer.invoke("casefile:readOverlayFile", { laneId, path, maxChars }),

  // M4.1: prompt drafts (casefile-scoped).
  listPrompts: () => ipcRenderer.invoke("casefile:listPrompts"),
  getPrompt: (promptId) => ipcRenderer.invoke("casefile:getPrompt", { promptId }),
  createPrompt: (prompt) => ipcRenderer.invoke("casefile:createPrompt", { prompt }),
  savePrompt: (promptId, prompt) =>
    ipcRenderer.invoke("casefile:savePrompt", { promptId, prompt }),
  deletePrompt: (promptId) => ipcRenderer.invoke("casefile:deletePrompt", { promptId }),

  // Chat (against the currently active casefile + lane).
  sendChat: (payload) => ipcRenderer.invoke("chat:send", payload),

  // M3.5c: comparison-chat sessions (multi-lane, read-only).
  openComparison: (laneIds) =>
    ipcRenderer.invoke("casefile:openComparison", { laneIds }),
  sendComparisonChat: (payload) =>
    ipcRenderer.invoke("casefile:sendComparisonChat", payload),

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
