const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("assistantApi", {
  // Casefile + lane management
  chooseCasefile: () => ipcRenderer.invoke("casefile:choose"),
  openCasefile: (root) => ipcRenderer.invoke("casefile:open", { root }),
  closeCasefile: () => ipcRenderer.invoke("casefile:close"),
  chooseLaneRoot: () => ipcRenderer.invoke("casefile:chooseLaneRoot"),
  registerLane: (lane) => ipcRenderer.invoke("casefile:registerLane", { lane }),
  switchLane: (laneId) => ipcRenderer.invoke("casefile:switchLane", { laneId }),
  // M4.6: lane CRUD + casefile reset.
  updateLane: (laneId, update) =>
    ipcRenderer.invoke("casefile:updateLane", { laneId, ...update }),
  removeLane: (laneId) => ipcRenderer.invoke("casefile:removeLane", { laneId }),
  hardResetCasefile: () => ipcRenderer.invoke("casefile:hardReset"),
  softResetCasefile: () => ipcRenderer.invoke("casefile:softReset"),
  listChat: (laneId) => ipcRenderer.invoke("casefile:listChat", { laneId }),

  // Lane-scoped filesystem (rooted at the active lane).
  listWorkspace: (maxDepth = 4) => ipcRenderer.invoke("workspace:list", { maxDepth }),
  readFile: (path, maxChars = 200000) => ipcRenderer.invoke("file:read", { path, maxChars }),
  saveFile: (path, content) => ipcRenderer.invoke("file:save", { path, content }),
  renameFile: (path, newName) => ipcRenderer.invoke("file:rename", { path, newName }),
  // M2: browser-driven workspace mutations. All four are constrained to
  // the active casefile root (validated in main.js via ensureInWorkspace).
  createFile: (parentDir, name) =>
    ipcRenderer.invoke("file:createFile", { parentDir, name }),
  createFolder: (parentDir, name) =>
    ipcRenderer.invoke("file:createFolder", { parentDir, name }),
  moveEntry: (sourcePath, destinationPath) =>
    ipcRenderer.invoke("file:move", { sourcePath, destinationPath }),
  trashEntry: (path) => ipcRenderer.invoke("file:trash", { path }),
  // M2.1: in-app undo for the most recent trash. Returns
  // `{ restored: false }` when the stack is empty (intentional: the
  // renderer treats it as a no-op so the keybinding doesn't surface
  // a scary error when there's nothing to undo).
  undoLastTrash: () => ipcRenderer.invoke("file:undoLastTrash"),
  trashUndoStatus: () => ipcRenderer.invoke("file:undoStatus"),

  // Persist a chat message body to a user-chosen directory (lane attachment
  // or anywhere else). The directory must already exist; the bridge refuses
  // to overwrite an existing file.
  saveChatOutput: (payload) => ipcRenderer.invoke("chat:saveOutput", payload),

  // M3.5: context attachments.
  updateLaneAttachments: (laneId, attachments) =>
    ipcRenderer.invoke("casefile:updateLaneAttachments", { laneId, attachments }),

  // Chat (against the currently active casefile + lane).
  sendChat: (payload) => ipcRenderer.invoke("chat:send", payload),

  // M3.5c: comparison-chat sessions (multi-lane scoped chat).
  openComparison: (laneIds) =>
    ipcRenderer.invoke("casefile:openComparison", { laneIds }),
  updateComparisonAttachments: (laneIds, attachments) =>
    ipcRenderer.invoke("casefile:updateComparisonAttachments", { laneIds, attachments }),
  sendComparisonChat: (payload) =>
    ipcRenderer.invoke("casefile:sendComparisonChat", payload),

  // API keys.
  getApiKeyStatus: () => ipcRenderer.invoke("keys:getStatus"),
  saveApiKeys: (payload) => ipcRenderer.invoke("keys:save", payload),
  clearApiKey: (provider) => ipcRenderer.invoke("keys:clear", { provider }),

  // Per-provider preferred model. Stored separately from keys (plain
  // user-data file, not the keychain). Empty string for a provider means
  // "use the backend default".
  getProviderModels: () => ipcRenderer.invoke("models:get"),
  saveProviderModels: (payload) => ipcRenderer.invoke("models:save", payload),
  onOpenApiKeys: (handler) => {
    const wrapped = () => handler();
    ipcRenderer.on("app:open-api-keys", wrapped);
    return () => ipcRenderer.removeListener("app:open-api-keys", wrapped);
  },
  onToggleTerminal: (handler) => {
    const wrapped = () => handler();
    ipcRenderer.on("app:toggle-terminal", wrapped);
    return () => ipcRenderer.removeListener("app:toggle-terminal", wrapped);
  },

  // Menu-bar → renderer: lane management actions.
  // Each returns an unsubscribe function so callers can clean up in
  // useEffect teardowns. The renderer handles the dialog/prompt flow
  // (main has no access to per-lane state; it just fires the trigger).
  onOpenCasefile: (handler) => {
    const wrapped = () => handler();
    ipcRenderer.on("app:open-casefile", wrapped);
    return () => ipcRenderer.removeListener("app:open-casefile", wrapped);
  },
  onCloseCasefile: (handler) => {
    const wrapped = () => handler();
    ipcRenderer.on("app:close-casefile", wrapped);
    return () => ipcRenderer.removeListener("app:close-casefile", wrapped);
  },
  onLaneCreate: (handler) => {
    const wrapped = () => handler();
    ipcRenderer.on("app:lane:create", wrapped);
    return () => ipcRenderer.removeListener("app:lane:create", wrapped);
  },
  onLaneAttach: (handler) => {
    const wrapped = () => handler();
    ipcRenderer.on("app:lane:attach", wrapped);
    return () => ipcRenderer.removeListener("app:lane:attach", wrapped);
  },
  onLaneRename: (handler) => {
    const wrapped = () => handler();
    ipcRenderer.on("app:lane:rename", wrapped);
    return () => ipcRenderer.removeListener("app:lane:rename", wrapped);
  },
  onLaneToggleAccess: (handler) => {
    const wrapped = () => handler();
    ipcRenderer.on("app:lane:toggle-access", wrapped);
    return () => ipcRenderer.removeListener("app:lane:toggle-access", wrapped);
  },
  onLaneRemove: (handler) => {
    const wrapped = () => handler();
    ipcRenderer.on("app:lane:remove", wrapped);
    return () => ipcRenderer.removeListener("app:lane:remove", wrapped);
  },
  onCasefileSoftReset: (handler) => {
    const wrapped = () => handler();
    ipcRenderer.on("app:casefile:soft-reset", wrapped);
    return () => ipcRenderer.removeListener("app:casefile:soft-reset", wrapped);
  },
  onCasefileHardReset: (handler) => {
    const wrapped = () => handler();
    ipcRenderer.on("app:casefile:hard-reset", wrapped);
    return () => ipcRenderer.removeListener("app:casefile:hard-reset", wrapped);
  },

  // Filesystem-watcher events from main: emitted whenever the active
  // casefile root or any of its overlay roots is mutated (by the user
  // via the editor, by the assistant via tools, or by an external
  // program). Renderer subscribes once and reacts by re-listing the
  // file tree.
  onWorkspaceChanged: (handler) => {
    const wrapped = () => handler();
    ipcRenderer.on("workspace:changed", wrapped);
    return () => ipcRenderer.removeListener("workspace:changed", wrapped);
  },
  // Tell main about overlay roots that live *outside* the casefile so
  // their changes also fire `workspace:changed`. Roots inside the
  // casefile root are already covered and may be passed safely — main
  // dedupes them.
  registerWatchRoots: (roots) =>
    ipcRenderer.invoke("workspace:registerWatchRoots", { roots }),

  // -----------------------------------------------------------------------
  // Integrated terminal (PTY-backed shell)
  // -----------------------------------------------------------------------
  // Each session has an opaque renderer-chosen id used for both the
  // invoke channels and the streaming events. The data/exit listeners
  // return an unsubscribe function so the caller can detach when the
  // React component unmounts.
  terminalAvailable: () => ipcRenderer.invoke("terminal:available"),
  terminalSpawn: (opts) => ipcRenderer.invoke("terminal:spawn", opts),
  terminalWrite: (id, data) => ipcRenderer.invoke("terminal:write", { id, data }),
  terminalResize: (id, cols, rows) =>
    ipcRenderer.invoke("terminal:resize", { id, cols, rows }),
  terminalKill: (id) => ipcRenderer.invoke("terminal:kill", { id }),
  terminalList: () => ipcRenderer.invoke("terminal:list"),
  onTerminalData: (id, handler) => {
    const channel = `terminal:data:${id}`;
    const wrapped = (_event, data) => handler(data);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
  onTerminalExit: (id, handler) => {
    const channel = `terminal:exit:${id}`;
    const wrapped = (_event, payload) => handler(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
});
