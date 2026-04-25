const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("assistantApi", {
  // Casefile + context management
  chooseCasefile: () => ipcRenderer.invoke("casefile:choose"),
  openCasefile: (root) => ipcRenderer.invoke("casefile:open", { root }),
  closeCasefile: () => ipcRenderer.invoke("casefile:close"),
  chooseContextRoot: () => ipcRenderer.invoke("casefile:chooseContextRoot"),
  registerContext: (context) => ipcRenderer.invoke("casefile:registerContext", { context }),
  switchContext: (contextId) => ipcRenderer.invoke("casefile:switchContext", { contextId }),
  // M4.6: context CRUD + casefile reset.
  updateContext: (contextId, update) =>
    ipcRenderer.invoke("casefile:updateContext", { contextId, ...update }),
  removeContext: (contextId) => ipcRenderer.invoke("casefile:removeContext", { contextId }),
  hardResetCasefile: () => ipcRenderer.invoke("casefile:hardReset"),
  softResetCasefile: () => ipcRenderer.invoke("casefile:softReset"),
  listChat: (contextId) => ipcRenderer.invoke("casefile:listChat", { contextId }),

  // Context-scoped filesystem (rooted at the active context).
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

  // Persist a chat message body to a user-chosen directory (context attachment
  // or anywhere else). The directory must already exist; the bridge refuses
  // to overwrite an existing file.
  saveChatOutput: (payload) => ipcRenderer.invoke("chat:saveOutput", payload),

  // M3.5: context attachments.
  updateContextAttachments: (contextId, attachments) =>
    ipcRenderer.invoke("casefile:updateContextAttachments", { contextId, attachments }),

  // Chat (against the currently active casefile + context).
  sendChat: (payload) => ipcRenderer.invoke("chat:send", payload),
  // SECURITY (H1): explicit approval path for write tools. Distinct
  // from `sendChat` so the renderer cannot enable write tools by
  // toggling a flag on the regular send. Main verifies a fresh
  // bridge-issued approval token exists before enabling writes.
  approveAndResumeChat: (payload) =>
    ipcRenderer.invoke("chat:approveAndResume", payload),

  // M3.5c: comparison-chat sessions (multi-context scoped chat).
  openComparison: (contextIds) =>
    ipcRenderer.invoke("casefile:openComparison", { contextIds }),
  updateComparisonAttachments: (contextIds, attachments) =>
    ipcRenderer.invoke("casefile:updateComparisonAttachments", { contextIds, attachments }),
  sendComparisonChat: (payload) =>
    ipcRenderer.invoke("casefile:sendComparisonChat", payload),
  // SECURITY (H1): comparison-chat counterpart of `approveAndResumeChat`.
  approveAndResumeComparisonChat: (payload) =>
    ipcRenderer.invoke("casefile:approveAndResumeComparison", payload),

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
  onOpenPreferences: (handler) => {
    const wrapped = () => handler();
    ipcRenderer.on("app:open-preferences", wrapped);
    return () => ipcRenderer.removeListener("app:open-preferences", wrapped);
  },
  onOpenRecent: (handler) => {
    const wrapped = () => handler();
    ipcRenderer.on("app:recent:open", wrapped);
    return () => ipcRenderer.removeListener("app:recent:open", wrapped);
  },
  onToggleTerminal: (handler) => {
    const wrapped = () => handler();
    ipcRenderer.on("app:toggle-terminal", wrapped);
    return () => ipcRenderer.removeListener("app:toggle-terminal", wrapped);
  },
  onToggleLeftPanel: (handler) => {
    const wrapped = () => handler();
    ipcRenderer.on("app:toggle-left-panel", wrapped);
    return () => ipcRenderer.removeListener("app:toggle-left-panel", wrapped);
  },
  onToggleRightPanel: (handler) => {
    const wrapped = () => handler();
    ipcRenderer.on("app:toggle-right-panel", wrapped);
    return () => ipcRenderer.removeListener("app:toggle-right-panel", wrapped);
  },

  // Menu-bar → renderer: context management actions.
  // Each returns an unsubscribe function so callers can clean up in
  // useEffect teardowns. The renderer handles the dialog/prompt flow
  // (main has no access to per-context state; it just fires the trigger).
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
  onNewFile: (handler) => {
    const wrapped = () => handler();
    ipcRenderer.on("app:file:new", wrapped);
    return () => ipcRenderer.removeListener("app:file:new", wrapped);
  },
  onNewFolder: (handler) => {
    const wrapped = () => handler();
    ipcRenderer.on("app:folder:new", wrapped);
    return () => ipcRenderer.removeListener("app:folder:new", wrapped);
  },
  onContextCreate: (handler) => {
    const wrapped = () => handler();
    ipcRenderer.on("app:context:create", wrapped);
    return () => ipcRenderer.removeListener("app:context:create", wrapped);
  },
  onContextAttach: (handler) => {
    const wrapped = () => handler();
    ipcRenderer.on("app:context:attach", wrapped);
    return () => ipcRenderer.removeListener("app:context:attach", wrapped);
  },
  onContextRename: (handler) => {
    const wrapped = () => handler();
    ipcRenderer.on("app:context:rename", wrapped);
    return () => ipcRenderer.removeListener("app:context:rename", wrapped);
  },
  onContextToggleAccess: (handler) => {
    const wrapped = () => handler();
    ipcRenderer.on("app:context:toggle-access", wrapped);
    return () => ipcRenderer.removeListener("app:context:toggle-access", wrapped);
  },
  onContextRemove: (handler) => {
    const wrapped = () => handler();
    ipcRenderer.on("app:context:remove", wrapped);
    return () => ipcRenderer.removeListener("app:context:remove", wrapped);
  },
  onContextCompare: (handler) => {
    const wrapped = () => handler();
    ipcRenderer.on("app:context:compare", wrapped);
    return () => ipcRenderer.removeListener("app:context:compare", wrapped);
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
