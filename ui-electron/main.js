const { app, BrowserWindow, Menu, dialog, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs/promises");
const fsSync = require("fs");
const os = require("os");
const { spawn } = require("child_process");
const { TextDecoder } = require("util");

// node-pty is a native module compiled against Electron's ABI by the
// `electron-rebuild` postinstall step. We require it lazily so that a
// missing/broken native binding doesn't prevent the rest of the app from
// starting — the terminal feature simply degrades to "unavailable" if
// the load fails.
let ptyLib = null;
let ptyLoadError = null;
try {
  ptyLib = require("node-pty");
} catch (err) {
  ptyLoadError = err && err.message ? err.message : String(err);
  console.error("[pty] failed to load node-pty:", ptyLoadError);
}

// `activeLaneRoot` is the directory that the file-tree IPC and editor IO are
// currently scoped to. Before M2 it was set by "Choose Workspace" and pointed
// at a bare directory. After M2 it is set by `casefile:open`/`casefile:switchLane`
// and points at the active lane's root (which may be the casefile root itself
// if no extra lane has been registered, or any sibling directory the user
// has registered as a lane). The file-tree IPC handlers below treat this as
// the "workspace" for path-escape checks.
let activeCasefileRoot = null;
let activeLaneId = null;
let activeLaneRoot = null;

// Filesystem watcher for the active casefile + extra overlay roots.
// We notify the renderer any time something inside one of the watched
// directories changes so the file tree, the inherited-context overlay
// section, and any other workspace-derived UI can re-list.
//
// Why the casefile root, not just the active lane root? Lanes are
// typically siblings under the casefile root, and ancestor lanes are
// surfaced to the renderer as `_ancestors/<id>/...` overlays. If we
// only watched the active lane, an external rename in a sibling
// (== ancestor) lane wouldn't refresh the inherited-context pane —
// which was the bug from the user's screenshot where Ratings.md still
// showed under its original chat-output filename inside an overlay.
//
// `extraWatchRoots` covers attachment / context roots that live
// *outside* the casefile root (uncommon but supported). The renderer
// reports those via the `workspace:registerWatchRoots` IPC after each
// `listOverlayTrees` call.
//
// fs.watch on Linux uses inotify which (unlike kqueue / ReadDirectoryChangesW)
// is not recursive. We pass `{ recursive: true }` anyway: Node falls back
// to a per-directory walk on Linux internally, which is fine for typical
// casefile sizes (lanes hold notes + small attachments, not a node_modules
// tree). If a future user opens a giant casefile and the watcher becomes
// expensive, we can swap this for chokidar with a `depth: 4` cap.
const activeWatchers = new Map(); // path -> fs.FSWatcher
let extraWatchRoots = []; // overlay roots outside the casefile, set by renderer
let workspaceChangeNotifyTimer = null;
const WORKSPACE_CHANGE_DEBOUNCE_MS = 150;

function notifyWorkspaceChanged() {
  // Coalesce bursts of inotify events (e.g. a `cp -r` of a directory
  // fires per-file) into one renderer message per debounce window.
  if (workspaceChangeNotifyTimer) return;
  workspaceChangeNotifyTimer = setTimeout(() => {
    workspaceChangeNotifyTimer = null;
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("workspace:changed");
    }
  }, WORKSPACE_CHANGE_DEBOUNCE_MS);
}

function stopAllWatchers() {
  for (const watcher of activeWatchers.values()) {
    try {
      watcher.close();
    } catch {
      // Closing an already-closed watcher throws on some platforms; ignore.
    }
  }
  activeWatchers.clear();
  if (workspaceChangeNotifyTimer) {
    clearTimeout(workspaceChangeNotifyTimer);
    workspaceChangeNotifyTimer = null;
  }
}

function watchOne(root) {
  if (!root || activeWatchers.has(root)) return;
  try {
    const watcher = fsSync.watch(
      root,
      { recursive: true, persistent: false },
      // We don't care about which file changed — the renderer always
      // re-fetches the whole subtree. So just fire the debounced
      // notifier on every event.
      () => notifyWorkspaceChanged()
    );
    watcher.on("error", (err) => {
      // Don't crash the main process if the watch breaks (e.g. user
      // deleted the directory from the shell). Log, drop the entry, and
      // let the next reconcileWatchers() call re-attach if appropriate.
      console.warn("[main] watcher error on", root, ":", err && err.message);
      try {
        watcher.close();
      } catch {
        // Ignore — already in the process of dying.
      }
      activeWatchers.delete(root);
    });
    activeWatchers.set(root, watcher);
  } catch (err) {
    // ENOENT / EACCES on the root — surface as a single warning,
    // don't keep retrying. The user can refresh manually if needed.
    console.warn("[main] failed to watch", root, ":", err && err.message);
  }
}

function reconcileWatchers() {
  // Compute the desired set of roots from the current state and bring
  // the live watcher map in line — start any missing watchers, stop
  // any that are no longer needed. Called whenever the casefile root
  // or the extra overlay roots change.
  const desired = new Set();
  if (activeCasefileRoot) desired.add(activeCasefileRoot);
  for (const root of extraWatchRoots) {
    if (!root) continue;
    // Skip roots already covered by the casefile-root recursive watch
    // — Node would happily start a redundant watcher otherwise.
    if (
      activeCasefileRoot &&
      (root === activeCasefileRoot ||
        root.startsWith(`${activeCasefileRoot}${path.sep}`))
    ) {
      continue;
    }
    desired.add(root);
  }
  for (const existing of Array.from(activeWatchers.keys())) {
    if (!desired.has(existing)) {
      try {
        activeWatchers.get(existing).close();
      } catch {
        // Ignore close-time errors, same rationale as stopAllWatchers.
      }
      activeWatchers.delete(existing);
    }
  }
  for (const root of desired) watchOne(root);
}
let apiKeysCache = {
  openai: "",
  anthropic: "",
  deepseek: "",
};
// Per-provider model overrides. The backend has its own defaults (see
// `ChatService._default_models`); an empty string here means "use the
// backend default". These are stored in plain config (not the keychain)
// since they're not secret — keytar only carries credentials.
let providerModelsCache = {
  openai: "",
  anthropic: "",
  deepseek: "",
};
const KEY_SERVICE = "deskassist";
const PROVIDERS = ["openai", "anthropic", "deepseek"];
let keytar = null;
let keyStorageBackend = "file";
let mainWindow = null;
const MAX_FILE_READ_CHARS = 2_000_000;

function apiKeysPath() {
  return path.join(app.getPath("userData"), "api-keys.json");
}

function providerModelsPath() {
  return path.join(app.getPath("userData"), "provider-models.json");
}

async function readProviderModels() {
  try {
    const raw = await fs.readFile(providerModelsPath(), "utf-8");
    const parsed = JSON.parse(raw);
    return {
      openai: typeof parsed.openai === "string" ? parsed.openai : "",
      anthropic: typeof parsed.anthropic === "string" ? parsed.anthropic : "",
      deepseek: typeof parsed.deepseek === "string" ? parsed.deepseek : "",
    };
  } catch (error) {
    return { openai: "", anthropic: "", deepseek: "" };
  }
}

async function persistProviderModels() {
  await fs.mkdir(path.dirname(providerModelsPath()), { recursive: true });
  await fs.writeFile(
    providerModelsPath(),
    JSON.stringify(providerModelsCache, null, 2),
    { encoding: "utf-8", mode: 0o600 }
  );
}

function tryInitKeytar() {
  try {
    keytar = require("keytar");
    keyStorageBackend = "keychain";
  } catch (error) {
    keytar = null;
    keyStorageBackend = "file";
  }
}

async function readFileKeys() {
  try {
    const raw = await fs.readFile(apiKeysPath(), "utf-8");
    const parsed = JSON.parse(raw);
    return {
      openai: typeof parsed.openai === "string" ? parsed.openai : "",
      anthropic: typeof parsed.anthropic === "string" ? parsed.anthropic : "",
      deepseek: typeof parsed.deepseek === "string" ? parsed.deepseek : "",
    };
  } catch (error) {
    return { openai: "", anthropic: "", deepseek: "" };
  }
}

async function loadApiKeys() {
  if (!keytar) {
    apiKeysCache = await readFileKeys();
    return;
  }

  const fileKeys = await readFileKeys();
  const loaded = { openai: "", anthropic: "", deepseek: "" };
  for (const provider of PROVIDERS) {
    const keyFromKeychain = await keytar.getPassword(KEY_SERVICE, provider);
    if (keyFromKeychain) {
      loaded[provider] = keyFromKeychain;
      continue;
    }
    if (fileKeys[provider]) {
      await keytar.setPassword(KEY_SERVICE, provider, fileKeys[provider]);
      loaded[provider] = fileKeys[provider];
    }
  }
  apiKeysCache = loaded;
  // Remove the plain-text fallback file once keys are available from the
  // system keychain.  We delete it whenever the file contained at least one
  // non-empty key; if any keytar.setPassword call above threw, we never reach
  // this point, so the file is only removed after a fully successful cycle.
  const fileHasKeys = PROVIDERS.some((p) => Boolean(fileKeys[p]));
  if (fileHasKeys) {
    try {
      await fs.unlink(apiKeysPath());
    } catch {
      // Non-fatal: file may already be absent or on a read-only filesystem.
    }
  }
}

async function persistApiKeys() {
  if (keytar) {
    for (const provider of PROVIDERS) {
      const value = apiKeysCache[provider];
      if (value) {
        await keytar.setPassword(KEY_SERVICE, provider, value);
      } else {
        await keytar.deletePassword(KEY_SERVICE, provider);
      }
    }
    return;
  }

  await fs.mkdir(path.dirname(apiKeysPath()), { recursive: true });
  await fs.writeFile(apiKeysPath(), JSON.stringify(apiKeysCache, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  // Tighten permissions on an already-existing file; writeFile's `mode`
  // option only applies on creation, not when the file is truncated.
  try {
    await fs.chmod(apiKeysPath(), 0o600);
  } catch {
    // Non-fatal on filesystems that do not support chmod (e.g. FAT32).
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const settingsSubmenu = [
    {
      label: "API Keys",
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send("app:open-api-keys");
        }
      },
    },
  ];
  const template = [
    ...(process.platform === "darwin"
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { label: "Settings", submenu: settingsSubmenu },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        ...(process.platform === "darwin" ? [{ role: "close" }] : [{ role: "quit" }]),
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        ...(process.platform === "darwin"
          ? [
              { role: "pasteAndMatchStyle" },
              { role: "delete" },
              { role: "selectAll" },
              { type: "separator" },
              {
                label: "Speech",
                submenu: [{ role: "startSpeaking" }, { role: "stopSpeaking" }],
              },
            ]
          : [{ role: "delete" }, { type: "separator" }, { role: "selectAll" }]),
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(process.platform === "darwin"
          ? [{ type: "separator" }, { role: "front" }]
          : [{ role: "close" }]),
      ],
    },
    {
      label: "Settings",
      submenu: settingsSubmenu,
    },
    {
      role: "help",
      submenu: [
        {
          label: "Learn More",
          click: async () => {
            const { shell } = require("electron");
            await shell.openExternal("https://www.electronjs.org");
          },
        },
      ],
    },
  ];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);

  // In dev (`npm run start:dev`) the Vite server is loaded directly so HMR
  // works. In normal `npm start` the renderer is built first and served from
  // the static dist/ directory via file://.
  const devUrl = process.env.DESKASSIST_RENDERER_URL;
  if (devUrl) {
    mainWindow.loadURL(devUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, "renderer", "dist", "index.html"));
  }
}

function ensureInWorkspace(targetPath) {
  if (!activeLaneRoot) {
    throw new Error("No active lane (open a casefile first)");
  }
  const resolvedWorkspace = path.resolve(activeLaneRoot);
  const resolvedTarget = path.resolve(targetPath);
  if (
    resolvedTarget !== resolvedWorkspace &&
    !resolvedTarget.startsWith(`${resolvedWorkspace}${path.sep}`)
  ) {
    throw new Error("Path escapes lane root");
  }
  return resolvedTarget;
}

async function buildTree(directoryPath, depth = 0, maxDepth = 4) {
  const directory = ensureInWorkspace(directoryPath);
  return buildTreeAt(directory, depth, maxDepth);
}

async function buildTreeAt(directory, depth = 0, maxDepth = 4, virtualPath = null) {
  // Like buildTree, but does NOT enforce activeLaneRoot containment. Used by
  // overlay-tree listings (ancestor + attachment + casefile-context roots,
  // which legitimately live outside the active lane). Each node's `path` is
  // either its real absolute path (default) or a caller-supplied virtual
  // path (e.g. `_ancestors/<lane>/foo.md`) so the renderer can route opens
  // back through the scoped overlay reader.
  const nodePath = virtualPath ?? directory;
  const node = {
    name: path.basename(virtualPath ?? directory),
    path: nodePath,
    type: "dir",
    children: [],
  };
  if (depth >= maxDepth) return node;
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return node;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.name === ".casefile") continue;
    const entryPath = path.join(directory, entry.name);
    const childVirtual = virtualPath ? `${virtualPath}/${entry.name}` : null;
    if (entry.isDirectory()) {
      node.children.push(
        await buildTreeAt(entryPath, depth + 1, maxDepth, childVirtual)
      );
    } else if (entry.isFile()) {
      node.children.push({
        name: entry.name,
        path: childVirtual ?? entryPath,
        type: "file",
      });
    }
  }
  return node;
}

// Default budget for general bridge calls. Chat turns get the most generous
// budget because an agentic turn with several tool calls + provider latency
// on a slower model (e.g. DeepSeek doing a code review) routinely runs past
// two minutes; capping that at 120s surfaces as a confusing "Python bridge
// timed out" error to the user. Metadata calls (list/get/save/etc) use a
// tighter cap so a hung Python process surfaces within seconds rather than
// the two-minute budget.
const BRIDGE_DEFAULT_TIMEOUT_MS = 120_000;
const BRIDGE_METADATA_TIMEOUT_MS = 10_000;
const BRIDGE_CHAT_TIMEOUT_MS = 600_000;

async function runPythonBridge(payload, { attachApiKeys = false, timeoutMs } = {}) {
  const repoRoot = path.resolve(__dirname, "..");
  const pythonPath = process.env.PYTHONPATH
    ? `${path.join(repoRoot, "src")}:${process.env.PYTHONPATH}`
    : path.join(repoRoot, "src");
  const env = { ...process.env, PYTHONPATH: pythonPath };
  const bridgePayload = { ...payload };
  if (attachApiKeys) {
    bridgePayload.apiKeys = {
      openai: apiKeysCache.openai || null,
      anthropic: apiKeysCache.anthropic || null,
      deepseek: apiKeysCache.deepseek || null,
    };
  }
  const effectiveTimeoutMs =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : BRIDGE_DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    const child = spawn(
      "python3",
      ["-m", "assistant_app.electron_bridge"],
      {
        cwd: repoRoot,
        env,
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error("Python bridge timed out"));
      }
    }, effectiveTimeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      reject(new Error(`Python bridge process error: ${error.message}`));
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      // Always log raw stderr in the main process only — it may contain
      // request payload fragments (including API keys) from Python tracebacks
      // and must never be forwarded verbatim to the renderer.
      if (stderr) {
        console.error("[bridge stderr]", stderr);
      }
      try {
        const response = extractBridgeResponse(stdout);
        if (response.ok) {
          resolve(response);
          return;
        }
        // response.error is produced by the bridge's own error handling and
        // is safe to surface; raw stderr is kept in the main process only.
        reject(new Error(response.error || `Bridge failed with exit code ${code}`));
      } catch (error) {
        reject(new Error(`Bridge response parse error (exit ${code}): ${error.message}`));
      }
    });

    child.stdin.write(JSON.stringify(bridgePayload));
    child.stdin.end();
  });
}

function runPythonBridgeMeta(payload) {
  // Read-only / metadata bridge calls use a tighter timeout so a hung
  // Python process surfaces as a renderer error within seconds rather
  // than the two-minute budget reserved for chat / run commands.
  return runPythonBridge(payload, { timeoutMs: BRIDGE_METADATA_TIMEOUT_MS });
}

// Sentinel constants must match electron_bridge.py RESPONSE_START / RESPONSE_END.
const BRIDGE_RESPONSE_START = "<<<BRIDGE_RESPONSE>>>";
const BRIDGE_RESPONSE_END = "<<<END_RESPONSE>>>";

function extractBridgeResponse(stdout) {
  // Primary path: sentinel-framed response written by electron_bridge.py main().
  // Use lastIndexOf for END so that earlier occurrences of the marker in tool
  // output or user content don't truncate the real payload prematurely.
  const startIdx = stdout.lastIndexOf(BRIDGE_RESPONSE_START);
  const endIdx = stdout.lastIndexOf(BRIDGE_RESPONSE_END);
  if (startIdx !== -1 && endIdx > startIdx) {
    const jsonStr = stdout.slice(startIdx + BRIDGE_RESPONSE_START.length, endIdx);
    try {
      const parsed = JSON.parse(jsonStr);
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch {
      // Framed payload was corrupt; fall through to the line-scan fallback.
    }
  }
  // Fallback: scan lines from the end for the last parseable JSON object.
  // Kept for backward compatibility with tests that invoke the bridge directly.
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch (error) {
      // keep scanning
    }
  }
  throw new Error("No JSON response found on bridge stdout");
}

async function readUtf8Bounded(filePath, maxChars) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const handle = await fs.open(filePath, "r");
  try {
    const chunkSize = Math.min(64 * 1024, maxChars + 1);
    const buffer = Buffer.allocUnsafe(chunkSize);
    const chunks = [];
    let totalBytes = 0;
    // Approximate-byte budget: ASCII is 1 byte/char so reading
    // `maxChars` bytes is a safe lower bound on the eventual decoded
    // length. We over-read by `chunkSize` to absorb multi-byte codepoints
    // straddling the cap, then verify the truncation cleanly after a
    // single decode.
    const byteBudget = maxChars + chunkSize;
    let truncated = false;
    while (totalBytes < byteBudget) {
      const { bytesRead } = await handle.read(buffer, 0, chunkSize, null);
      if (bytesRead === 0) {
        break;
      }
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      totalBytes += bytesRead;
    }
    // Single decode after the loop: previously this ran on every
    // iteration, making the overall read O(n²) in file size. For a 2 MB
    // file at the declared MAX_FILE_READ_CHARS limit that was a real
    // regression, however unlikely in practice.
    const decoded = decoder.decode(Buffer.concat(chunks, totalBytes));
    if (decoded.length > maxChars) {
      truncated = true;
    }
    return { content: decoded.slice(0, maxChars), truncated };
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error("File is not valid UTF-8 text");
    }
    throw error;
  } finally {
    await handle.close();
  }
}

function adoptCasefileSnapshot(snapshot) {
  // Apply a snapshot returned by the Python bridge to the main-process state
  // so the next file-tree IPC call is rooted at the active lane.
  if (!snapshot || typeof snapshot.root !== "string") {
    throw new Error("Bridge returned an invalid casefile snapshot");
  }
  activeCasefileRoot = snapshot.root;
  activeLaneId = snapshot.activeLaneId || null;
  const lanes = Array.isArray(snapshot.lanes) ? snapshot.lanes : [];
  const activeLane = lanes.find((lane) => lane && lane.id === activeLaneId);
  activeLaneRoot = activeLane && typeof activeLane.root === "string" ? activeLane.root : null;
  // Re-bind the filesystem watchers to the (possibly new) casefile +
  // overlay roots so the renderer's file tree picks up external
  // changes (`git checkout`, `cp` from another terminal, the
  // assistant writing via tools, etc.).
  reconcileWatchers();
  return snapshot;
}

ipcMain.handle("casefile:choose", async () => {
  // Default to the parent of the currently-open casefile (so "open another
  // casefile" lands in the right neighbourhood) or to the user's documents
  // folder on first launch — never the home directory, which is noisy.
  const defaultPath = activeCasefileRoot
    ? path.dirname(activeCasefileRoot)
    : app.getPath("documents");
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"],
    title: "Open Casefile",
    defaultPath,
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  const chosen = result.filePaths[0];
  const response = await runPythonBridgeMeta({ command: "casefile:open", root: chosen });
  return adoptCasefileSnapshot(response.casefile);
});

ipcMain.handle("casefile:open", async (_, args = {}) => {
  const root = typeof args.root === "string" ? args.root : "";
  if (!root) {
    throw new Error("root is required");
  }
  const response = await runPythonBridgeMeta({ command: "casefile:open", root });
  return adoptCasefileSnapshot(response.casefile);
});

ipcMain.handle("casefile:chooseLaneRoot", async () => {
  // Lane / attachment / context pickers all default to the casefile root
  // when one is open. This is the right behaviour for the common case
  // (lanes live next to or under the casefile) and falls back to documents
  // only when no casefile is open yet (in which case there's no lane to
  // register anyway, but we still want a sane default).
  const defaultPath = activeCasefileRoot || app.getPath("documents");
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory", "createDirectory"],
    title: "Choose Directory",
    defaultPath,
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  return result.filePaths[0];
});

ipcMain.handle("casefile:registerLane", async (_, args = {}) => {
  if (!activeCasefileRoot) {
    throw new Error("No casefile is open");
  }
  const lane = args.lane && typeof args.lane === "object" ? args.lane : null;
  if (!lane) {
    throw new Error("lane is required");
  }
  const response = await runPythonBridgeMeta({
    command: "casefile:registerLane",
    casefileRoot: activeCasefileRoot,
    lane,
  });
  return adoptCasefileSnapshot(response.casefile);
});

ipcMain.handle("casefile:switchLane", async (_, args = {}) => {
  if (!activeCasefileRoot) {
    throw new Error("No casefile is open");
  }
  const laneId = typeof args.laneId === "string" ? args.laneId : "";
  if (!laneId) {
    throw new Error("laneId is required");
  }
  const response = await runPythonBridgeMeta({
    command: "casefile:switchLane",
    casefileRoot: activeCasefileRoot,
    laneId,
  });
  return adoptCasefileSnapshot(response.casefile);
});

ipcMain.handle("casefile:listChat", async (_, args = {}) => {
  if (!activeCasefileRoot) {
    throw new Error("No casefile is open");
  }
  const laneId = typeof args.laneId === "string" ? args.laneId : activeLaneId;
  if (!laneId) {
    throw new Error("laneId is required");
  }
  const response = await runPythonBridge(
    {
      command: "casefile:listChat",
      casefileRoot: activeCasefileRoot,
      laneId,
    },
    { timeoutMs: BRIDGE_METADATA_TIMEOUT_MS }
  );
  return Array.isArray(response.messages) ? response.messages : [];
});

// ----- M3: notes, compare, lane-scoped read, save chat output -----

function requireCasefile() {
  if (!activeCasefileRoot) {
    throw new Error("No casefile is open");
  }
  return activeCasefileRoot;
}

ipcMain.handle("casefile:getNote", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const laneId = typeof args.laneId === "string" ? args.laneId : "";
  if (!laneId) throw new Error("laneId is required");
  const response = await runPythonBridgeMeta({
    command: "casefile:getNote",
    casefileRoot,
    laneId,
  });
  return typeof response.content === "string" ? response.content : "";
});

ipcMain.handle("casefile:saveNote", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const laneId = typeof args.laneId === "string" ? args.laneId : "";
  const content = typeof args.content === "string" ? args.content : "";
  if (!laneId) throw new Error("laneId is required");
  await runPythonBridgeMeta({ command: "casefile:saveNote", casefileRoot, laneId, content });
  return true;
});

ipcMain.handle("casefile:compareLanes", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const leftLaneId = typeof args.leftLaneId === "string" ? args.leftLaneId : "";
  const rightLaneId = typeof args.rightLaneId === "string" ? args.rightLaneId : "";
  if (!leftLaneId || !rightLaneId) {
    throw new Error("leftLaneId and rightLaneId are required");
  }
  const response = await runPythonBridge({
    command: "casefile:compareLanes",
    casefileRoot,
    leftLaneId,
    rightLaneId,
  });
  return response.comparison;
});

ipcMain.handle("chat:saveOutput", async (_, args = {}) => {
  // The destination directory is an *absolute* path picked by the user
  // via the lane attachment list or the system folder dialog. It is not
  // necessarily inside the active lane root, so we pass it straight to
  // the Python bridge instead of resolving against `activeCasefileRoot`.
  const destinationDir = typeof args.destinationDir === "string" ? args.destinationDir : "";
  const filename = typeof args.filename === "string" ? args.filename : "";
  const body = typeof args.body === "string" ? args.body : "";
  if (!destinationDir) throw new Error("destinationDir is required");
  if (!filename) throw new Error("filename is required");
  const response = await runPythonBridgeMeta({
    command: "chat:saveOutput",
    destinationDir,
    filename,
    body,
  });
  return { path: response.path };
});

ipcMain.handle("lane:readFile", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const laneId = typeof args.laneId === "string" ? args.laneId : "";
  const filePath = typeof args.path === "string" ? args.path : "";
  if (!laneId) throw new Error("laneId is required");
  if (!filePath) throw new Error("path is required");
  const payload = { command: "lane:readFile", casefileRoot, laneId, path: filePath };
  if (Number.isInteger(args.maxChars)) payload.maxChars = args.maxChars;
  const response = await runPythonBridgeMeta(payload);
  return {
    path: response.path,
    content: response.content,
    truncated: Boolean(response.truncated),
  };
});

// ----- M3.5: hierarchical scope, attachments, context, overlays -----

ipcMain.handle("casefile:setLaneParent", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const laneId = typeof args.laneId === "string" ? args.laneId : "";
  if (!laneId) throw new Error("laneId is required");
  const parentId =
    args.parentId === null || args.parentId === undefined
      ? null
      : String(args.parentId);
  const response = await runPythonBridgeMeta({
    command: "casefile:setLaneParent",
    casefileRoot,
    laneId,
    parentId,
  });
  return adoptCasefileSnapshot(response.casefile);
});

ipcMain.handle("casefile:updateLaneAttachments", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const laneId = typeof args.laneId === "string" ? args.laneId : "";
  if (!laneId) throw new Error("laneId is required");
  const attachments = Array.isArray(args.attachments) ? args.attachments : [];
  const response = await runPythonBridgeMeta({
    command: "casefile:updateLaneAttachments",
    casefileRoot,
    laneId,
    attachments,
  });
  return adoptCasefileSnapshot(response.casefile);
});

// ----- M4.6: lane CRUD + casefile reset -----

ipcMain.handle("casefile:updateLane", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const laneId = typeof args.laneId === "string" ? args.laneId : "";
  if (!laneId) throw new Error("laneId is required");
  // Pass through only the fields that were actually supplied; the bridge
  // distinguishes "omitted" (leave alone) from "null"/"empty" via key
  // presence + type checks, so spreading the args object would hand it
  // bogus keys.
  const payload = {
    command: "casefile:updateLane",
    casefileRoot,
    laneId,
  };
  if (Object.prototype.hasOwnProperty.call(args, "name")) payload.name = args.name;
  if (Object.prototype.hasOwnProperty.call(args, "kind")) payload.kind = args.kind;
  if (Object.prototype.hasOwnProperty.call(args, "root")) payload.root = args.root;
  const response = await runPythonBridgeMeta(payload);
  // Adopt the snapshot for state-tracking, but return the *full* response so
  // the renderer can surface `rootConflict` alongside the new snapshot.
  adoptCasefileSnapshot(response.casefile);
  return {
    casefile: response.casefile,
    rootConflict: response.rootConflict || null,
  };
});

ipcMain.handle("casefile:removeLane", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const laneId = typeof args.laneId === "string" ? args.laneId : "";
  if (!laneId) throw new Error("laneId is required");
  const response = await runPythonBridgeMeta({
    command: "casefile:removeLane",
    casefileRoot,
    laneId,
  });
  return adoptCasefileSnapshot(response.casefile);
});

ipcMain.handle("casefile:hardReset", async () => {
  const casefileRoot = requireCasefile();
  const response = await runPythonBridgeMeta({
    command: "casefile:hardReset",
    casefileRoot,
  });
  return adoptCasefileSnapshot(response.casefile);
});

ipcMain.handle("casefile:softReset", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const keepPrompts = args.keepPrompts !== false; // default true
  const response = await runPythonBridgeMeta({
    command: "casefile:softReset",
    casefileRoot,
    keepPrompts,
  });
  return adoptCasefileSnapshot(response.casefile);
});

ipcMain.handle("casefile:getContext", async () => {
  const casefileRoot = requireCasefile();
  const response = await runPythonBridgeMeta({
    command: "casefile:getContext",
    casefileRoot,
  });
  return response.context;
});

ipcMain.handle("casefile:saveContext", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const manifest = args.manifest && typeof args.manifest === "object" ? args.manifest : null;
  if (!manifest) throw new Error("manifest is required");
  const response = await runPythonBridgeMeta({
    command: "casefile:saveContext",
    casefileRoot,
    context: manifest,
  });
  return response.context;
});

ipcMain.handle("casefile:resolveScope", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const laneId = typeof args.laneId === "string" ? args.laneId : "";
  if (!laneId) throw new Error("laneId is required");
  const response = await runPythonBridgeMeta({
    command: "casefile:resolveScope",
    casefileRoot,
    laneId,
  });
  return response.scope;
});

// Renderer-side hint: after `listOverlayTrees` resolves, the renderer
// pushes the set of overlay roots back to main so we can extend the
// filesystem watch to any directory that lives *outside* the casefile
// (uncommon but supported — e.g. an attachment pointing at a folder
// elsewhere on disk). Roots inside the casefile are ignored because
// the casefile-level recursive watch already covers them.
ipcMain.handle("workspace:registerWatchRoots", async (_, args = {}) => {
  const incoming = Array.isArray(args.roots) ? args.roots : [];
  // Defensive: drop non-strings, normalise, dedupe.
  const cleaned = Array.from(
    new Set(
      incoming
        .filter((r) => typeof r === "string" && r.length > 0)
        .map((r) => path.resolve(r))
    )
  );
  extraWatchRoots = cleaned;
  reconcileWatchers();
  return { watching: Array.from(activeWatchers.keys()) };
});

ipcMain.handle("casefile:listOverlayTrees", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const laneId = typeof args.laneId === "string" ? args.laneId : "";
  if (!laneId) throw new Error("laneId is required");
  const maxDepthRaw = Number.isInteger(args.maxDepth) ? args.maxDepth : 3;
  const maxDepth = Math.max(1, Math.min(maxDepthRaw, 8));
  const response = await runPythonBridgeMeta({
    command: "casefile:resolveScope",
    casefileRoot,
    laneId,
  });
  const scope = response.scope || {};
  const overlays = Array.isArray(scope.readOverlays) ? scope.readOverlays : [];
  const out = [];
  for (const overlay of overlays) {
    if (!overlay || typeof overlay.root !== "string") continue;
    try {
      const tree = await buildTreeAt(overlay.root, 0, maxDepth, overlay.prefix);
      out.push({
        prefix: overlay.prefix,
        label: overlay.label,
        root: overlay.root,
        tree,
      });
    } catch (error) {
      out.push({
        prefix: overlay.prefix,
        label: overlay.label,
        root: overlay.root,
        tree: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  // Casefile-wide context bucket is also surfaced as an overlay (if any
  // resolved files exist) so the renderer can show "_context/...".
  const ctxFiles = Array.isArray(scope.contextFiles) ? scope.contextFiles : [];
  if (ctxFiles.length > 0) {
    const children = ctxFiles
      .filter((f) => f && typeof f.path === "string")
      .map((f) => ({
        name: f.path.split("/").pop() || f.path,
        path: `_context/${f.path}`,
        type: "file",
      }));
    out.push({
      prefix: "_context",
      label: "casefile context",
      root: scope.casefileRoot || "",
      tree: {
        name: "_context",
        path: "_context",
        type: "dir",
        children,
      },
    });
  }
  return out;
});

ipcMain.handle("casefile:readOverlayFile", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const laneId = typeof args.laneId === "string" ? args.laneId : "";
  const filePath = typeof args.path === "string" ? args.path : "";
  if (!laneId) throw new Error("laneId is required");
  if (!filePath) throw new Error("path is required");
  const payload = {
    command: "casefile:readOverlayFile",
    casefileRoot,
    laneId,
    path: filePath,
  };
  if (Number.isInteger(args.maxChars)) payload.maxChars = args.maxChars;
  const response = await runPythonBridgeMeta(payload);
  return {
    path: response.path,
    content: response.content,
    truncated: Boolean(response.truncated),
  };
});

ipcMain.handle("workspace:list", async (_, args = {}) => {
  const maxDepth = Number.isInteger(args.maxDepth) ? args.maxDepth : 4;
  if (!activeLaneRoot) {
    throw new Error("No active lane (open a casefile first)");
  }
  return buildTree(activeLaneRoot, 0, Math.max(1, Math.min(maxDepth, 8)));
});

ipcMain.handle("file:read", async (_, args = {}) => {
  const filePath = ensureInWorkspace(args.path || "");
  if ((await fs.stat(filePath)).isFile() === false) {
    throw new Error("Path is not a file");
  }
  const requestedMaxChars = Number.isInteger(args.maxChars) ? args.maxChars : 200000;
  if (requestedMaxChars <= 0 || requestedMaxChars > MAX_FILE_READ_CHARS) {
    throw new Error(`maxChars must be between 1 and ${MAX_FILE_READ_CHARS}`);
  }
  const { content, truncated } = await readUtf8Bounded(filePath, requestedMaxChars);
  return {
    path: filePath,
    content,
    truncated,
  };
});

ipcMain.handle("file:save", async (_, args = {}) => {
  const filePath = ensureInWorkspace(args.path || "");
  if (typeof args.content !== "string") {
    throw new Error("content must be a string");
  }
  const content = args.content;
  // Create intermediate directories so a future "new file" workflow can
  // save into a path whose parent doesn't exist yet without hitting an
  // ENOENT from writeFile. The path-escape check above already runs
  // through `ensureInWorkspace`, so mkdir is bounded to the lane.
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
  return { path: filePath, saved: true };
});

// Rename a file or directory inside the active lane. The renderer
// supplies the source absolute path (already inside the lane root,
// validated via ensureInWorkspace) and a *new basename* — we
// intentionally don't accept an arbitrary destination path so this
// can't be used to move files into a different overlay or escape the
// lane. Refuses to clobber an existing entry; the caller should
// prompt the user if they really want that.
ipcMain.handle("file:rename", async (_, args = {}) => {
  const sourcePath = ensureInWorkspace(args.path || "");
  const newName = typeof args.newName === "string" ? args.newName.trim() : "";
  if (!newName) {
    throw new Error("newName must be a non-empty string");
  }
  // Disallow path separators in the new name — rename is a same-dir
  // operation, not a move. Also block leading dots that hide the file
  // and the conventional reserved names ".", "..".
  if (
    newName.includes("/") ||
    newName.includes("\\") ||
    newName === "." ||
    newName === ".."
  ) {
    throw new Error("newName must be a single filename without path separators");
  }
  const parentDir = path.dirname(sourcePath);
  const destinationPath = ensureInWorkspace(path.join(parentDir, newName));
  if (destinationPath === sourcePath) {
    return { oldPath: sourcePath, newPath: destinationPath, renamed: false };
  }
  // Race-y but good enough: check then rename. An attacker who can
  // write to the lane already has full control, so TOCTOU here is
  // not a security issue, only a UX guard against accidental
  // overwrite.
  try {
    await fs.access(destinationPath);
    throw new Error(`A file named "${newName}" already exists in this folder`);
  } catch (err) {
    if (err && err.code !== "ENOENT") throw err;
  }
  await fs.rename(sourcePath, destinationPath);
  return { oldPath: sourcePath, newPath: destinationPath, renamed: true };
});

ipcMain.handle("chat:send", async (_, payload = {}) => {
  if (!activeCasefileRoot || !activeLaneId) {
    throw new Error("Open a casefile before sending a chat");
  }
  const provider = payload.provider || "openai";
  // Fall back to the user's saved per-provider model if the renderer
  // didn't explicitly override it. Empty string in the cache means "use
  // the backend default", which we send as null so the Python side picks
  // its own default.
  const savedModel = providerModelsCache[provider] || null;
  const bridgePayload = {
    command: "chat:send",
    casefileRoot: activeCasefileRoot,
    laneId: activeLaneId,
    provider,
    model: payload.model || savedModel,
    messages: Array.isArray(payload.messages) ? payload.messages : [],
    userMessage: payload.userMessage || "",
    allowWriteTools: Boolean(payload.allowWriteTools),
    resumePendingToolCalls: Boolean(payload.resumePendingToolCalls),
  };
  // M4.1: only forward systemPromptId when set; the bridge treats absence
  // as "no system prompt", whereas a literal empty string would be a
  // validation error.
  if (typeof payload.systemPromptId === "string" && payload.systemPromptId) {
    bridgePayload.systemPromptId = payload.systemPromptId;
  }
  return runPythonBridge(bridgePayload, {
    attachApiKeys: true,
    timeoutMs: BRIDGE_CHAT_TIMEOUT_MS,
  });
});

// ----- M4.1: prompt drafts -----

ipcMain.handle("casefile:listPrompts", async () => {
  const casefileRoot = requireCasefile();
  const response = await runPythonBridgeMeta({
    command: "casefile:listPrompts",
    casefileRoot,
  });
  return Array.isArray(response.prompts) ? response.prompts : [];
});

ipcMain.handle("casefile:getPrompt", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const promptId = typeof args.promptId === "string" ? args.promptId : "";
  if (!promptId) throw new Error("promptId is required");
  const response = await runPythonBridgeMeta({
    command: "casefile:getPrompt",
    casefileRoot,
    promptId,
  });
  return response.prompt;
});

ipcMain.handle("casefile:createPrompt", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const prompt = args.prompt && typeof args.prompt === "object" ? args.prompt : null;
  if (!prompt) throw new Error("prompt is required");
  const response = await runPythonBridgeMeta({
    command: "casefile:createPrompt",
    casefileRoot,
    prompt,
  });
  return response.prompt;
});

ipcMain.handle("casefile:savePrompt", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const promptId = typeof args.promptId === "string" ? args.promptId : "";
  const prompt = args.prompt && typeof args.prompt === "object" ? args.prompt : null;
  if (!promptId) throw new Error("promptId is required");
  if (!prompt) throw new Error("prompt is required");
  const response = await runPythonBridgeMeta({
    command: "casefile:savePrompt",
    casefileRoot,
    promptId,
    prompt,
  });
  return response.prompt;
});

ipcMain.handle("casefile:deletePrompt", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const promptId = typeof args.promptId === "string" ? args.promptId : "";
  if (!promptId) throw new Error("promptId is required");
  await runPythonBridgeMeta({
    command: "casefile:deletePrompt",
    casefileRoot,
    promptId,
  });
  return true;
});

// ----- M4.3: external local-directory inboxes -----

ipcMain.handle("casefile:listInboxSources", async () => {
  const casefileRoot = requireCasefile();
  const response = await runPythonBridgeMeta({
    command: "casefile:listInboxSources",
    casefileRoot,
  });
  return Array.isArray(response.sources) ? response.sources : [];
});

ipcMain.handle("casefile:addInboxSource", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const name = typeof args.name === "string" ? args.name : "";
  const root = typeof args.root === "string" ? args.root : "";
  if (!name.trim()) throw new Error("name is required");
  if (!root.trim()) throw new Error("root is required");
  const payload = {
    command: "casefile:addInboxSource",
    casefileRoot,
    name,
    root,
  };
  if (typeof args.sourceId === "string" && args.sourceId.trim()) {
    payload.sourceId = args.sourceId;
  }
  const response = await runPythonBridgeMeta(payload);
  return response.source;
});

ipcMain.handle("casefile:updateInboxSource", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const sourceId = typeof args.sourceId === "string" ? args.sourceId : "";
  if (!sourceId.trim()) throw new Error("sourceId is required");
  const payload = {
    command: "casefile:updateInboxSource",
    casefileRoot,
    sourceId,
  };
  if (typeof args.name === "string") payload.name = args.name;
  if (typeof args.root === "string") payload.root = args.root;
  const response = await runPythonBridgeMeta(payload);
  return response.source;
});

ipcMain.handle("casefile:removeInboxSource", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const sourceId = typeof args.sourceId === "string" ? args.sourceId : "";
  if (!sourceId.trim()) throw new Error("sourceId is required");
  await runPythonBridgeMeta({
    command: "casefile:removeInboxSource",
    casefileRoot,
    sourceId,
  });
  return true;
});

ipcMain.handle("casefile:listInboxItems", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const sourceId = typeof args.sourceId === "string" ? args.sourceId : "";
  if (!sourceId.trim()) throw new Error("sourceId is required");
  const payload = { command: "casefile:listInboxItems", casefileRoot, sourceId };
  if (Number.isInteger(args.maxDepth) && args.maxDepth > 0) {
    payload.maxDepth = args.maxDepth;
  }
  const response = await runPythonBridgeMeta(payload);
  return Array.isArray(response.items) ? response.items : [];
});

ipcMain.handle("casefile:readInboxItem", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const sourceId = typeof args.sourceId === "string" ? args.sourceId : "";
  const itemPath = typeof args.path === "string" ? args.path : "";
  if (!sourceId.trim()) throw new Error("sourceId is required");
  if (!itemPath.trim()) throw new Error("path is required");
  const payload = {
    command: "casefile:readInboxItem",
    casefileRoot,
    sourceId,
    path: itemPath,
  };
  if (Number.isInteger(args.maxChars) && args.maxChars > 0) {
    payload.maxChars = args.maxChars;
  }
  const response = await runPythonBridgeMeta(payload);
  return {
    content: response.content || "",
    truncated: Boolean(response.truncated),
    absolutePath: response.absolutePath || "",
  };
});

ipcMain.handle("casefile:chooseInboxRoot", async () => {
  // Reuse the same dialog as the lane-root picker so users get a
  // consistent "pick a directory" experience for any external mount.
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"],
    title: "Choose inbox folder",
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

// ----- M3.5c: comparison-chat sessions -----

function normalizeLaneIds(raw) {
  if (!Array.isArray(raw)) {
    throw new Error("laneIds must be an array of at least two lane ids");
  }
  const ids = raw
    .filter((x) => typeof x === "string" && x.trim().length > 0)
    .map((x) => x.trim());
  if (ids.length < 2 || new Set(ids).size < 2) {
    throw new Error("laneIds must contain at least two distinct ids");
  }
  return ids;
}

ipcMain.handle("casefile:openComparison", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const laneIds = normalizeLaneIds(args.laneIds);
  const response = await runPythonBridgeMeta({
    command: "casefile:openComparison",
    casefileRoot,
    laneIds,
  });
  return response.comparison;
});

ipcMain.handle("casefile:sendComparisonChat", async (_, payload = {}) => {
  const casefileRoot = requireCasefile();
  const laneIds = normalizeLaneIds(payload.laneIds);
  const provider = payload.provider || "openai";
  const savedModel = providerModelsCache[provider] || null;
  return runPythonBridge(
    {
      command: "casefile:sendComparisonChat",
      casefileRoot,
      laneIds,
      provider,
      model: payload.model || savedModel,
      messages: Array.isArray(payload.messages) ? payload.messages : [],
      userMessage: payload.userMessage || "",
      resumePendingToolCalls: Boolean(payload.resumePendingToolCalls),
    },
    { attachApiKeys: true, timeoutMs: BRIDGE_CHAT_TIMEOUT_MS }
  );
});

ipcMain.handle("keys:getStatus", async () => {
  return {
    openaiConfigured: Boolean(apiKeysCache.openai),
    anthropicConfigured: Boolean(apiKeysCache.anthropic),
    deepseekConfigured: Boolean(apiKeysCache.deepseek),
    storageBackend: keyStorageBackend,
  };
});

ipcMain.handle("keys:save", async (_, payload = {}) => {
  const updates = {
    openai: typeof payload.openai === "string" ? payload.openai.trim() : "",
    anthropic: typeof payload.anthropic === "string" ? payload.anthropic.trim() : "",
    deepseek: typeof payload.deepseek === "string" ? payload.deepseek.trim() : "",
  };
  // Empty value means "leave existing key unchanged".
  if (updates.openai) {
    apiKeysCache.openai = updates.openai;
  }
  if (updates.anthropic) {
    apiKeysCache.anthropic = updates.anthropic;
  }
  if (updates.deepseek) {
    apiKeysCache.deepseek = updates.deepseek;
  }
  await persistApiKeys();
  return {
    openaiConfigured: Boolean(apiKeysCache.openai),
    anthropicConfigured: Boolean(apiKeysCache.anthropic),
    deepseekConfigured: Boolean(apiKeysCache.deepseek),
    storageBackend: keyStorageBackend,
  };
});

// Per-provider preferred model. Stored in plain config (not the keychain)
// because model ids are not secret. The renderer treats absence as "use the
// backend default", so an empty string here is meaningful and is what we
// persist when the user clears the field.
ipcMain.handle("models:get", async () => {
  return { ...providerModelsCache };
});

ipcMain.handle("models:save", async (_, payload = {}) => {
  const updates = {};
  for (const provider of PROVIDERS) {
    const value = payload[provider];
    if (typeof value === "string") {
      updates[provider] = value.trim();
    }
  }
  for (const provider of PROVIDERS) {
    if (provider in updates) {
      providerModelsCache[provider] = updates[provider];
    }
  }
  await persistProviderModels();
  return { ...providerModelsCache };
});

ipcMain.handle("keys:clear", async (_, payload = {}) => {
  const provider = typeof payload.provider === "string" ? payload.provider : "";
  if (!PROVIDERS.includes(provider)) {
    throw new Error("Unknown provider for key clear");
  }
  apiKeysCache[provider] = "";
  await persistApiKeys();
  return {
    openaiConfigured: Boolean(apiKeysCache.openai),
    anthropicConfigured: Boolean(apiKeysCache.anthropic),
    deepseekConfigured: Boolean(apiKeysCache.deepseek),
    storageBackend: keyStorageBackend,
  };
});

// ---------------------------------------------------------------------------
// Terminal (PTY) sessions
// ---------------------------------------------------------------------------
//
// One renderer can host multiple terminals (one per lane, plus optional
// extras). Each terminal corresponds to a long-lived shell process owned
// by the main process. The renderer addresses sessions by an opaque
// string id it chose when it called `terminal:spawn`. The main process
// pipes shell stdout/stderr back via `terminal:data:<id>` events and
// forwards keyboard input + resize events via the corresponding
// invoke channels.
//
// Sessions outlive lane / tab switches: closing a tab in the UI does
// NOT kill the shell. The shell is killed when the renderer explicitly
// calls `terminal:kill` or when it disappears (window close).

const ptySessions = new Map(); // id -> { pty, cwd, shell, laneId }

function pickShell() {
  if (process.platform === "win32") {
    // PowerShell is a saner default than cmd.exe when available; node-pty
    // accepts either. We don't probe for pwsh.exe here — the launcher
    // can always be overridden later.
    return process.env.COMSPEC || "powershell.exe";
  }
  return process.env.SHELL || "/bin/bash";
}

function killPtySession(id) {
  const session = ptySessions.get(id);
  if (!session) return false;
  ptySessions.delete(id);
  try {
    session.pty.kill();
  } catch {
    // pty.kill() throws if the child already exited; ignore.
  }
  return true;
}

function killAllPtySessions() {
  for (const id of Array.from(ptySessions.keys())) {
    killPtySession(id);
  }
}

ipcMain.handle("terminal:spawn", async (_event, args = {}) => {
  if (!ptyLib) {
    throw new Error(
      `Terminal unavailable: node-pty failed to load (${ptyLoadError || "unknown error"}). ` +
        `Run \`npm run rebuild:native\` in ui-electron/.`
    );
  }
  const id = typeof args.id === "string" && args.id ? args.id : null;
  if (!id) throw new Error("terminal:spawn requires an id");
  if (ptySessions.has(id)) {
    throw new Error(`terminal session already exists: ${id}`);
  }
  const requestedCwd = typeof args.cwd === "string" && args.cwd ? args.cwd : null;
  let cwd = requestedCwd || activeLaneRoot || activeCasefileRoot || os.homedir();
  // Don't trust the renderer; fall back to homedir if the requested cwd
  // doesn't exist or isn't a directory.
  try {
    const stat = fsSync.statSync(cwd);
    if (!stat.isDirectory()) cwd = os.homedir();
  } catch {
    cwd = os.homedir();
  }
  const cols = Number.isInteger(args.cols) && args.cols > 0 ? args.cols : 80;
  const rows = Number.isInteger(args.rows) && args.rows > 0 ? args.rows : 24;
  const shell = pickShell();
  // node-pty's spawn signature is (file, args, opts). We pass an empty
  // arg list so we get a normal interactive shell — login behavior is
  // controlled by SHELL and the user's rc files.
  const env = { ...process.env, TERM: "xterm-256color" };
  // Strip ELECTRON_*/NODE_* leakage that confuses subprocess shells
  // (e.g. ELECTRON_RUN_AS_NODE forces children into Node mode).
  delete env.ELECTRON_RUN_AS_NODE;
  let ptyProc;
  try {
    ptyProc = ptyLib.spawn(shell, [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env,
    });
  } catch (err) {
    throw new Error(
      `Failed to spawn shell '${shell}': ${err && err.message ? err.message : String(err)}`
    );
  }

  const session = { pty: ptyProc, cwd, shell, laneId: args.laneId || null };
  ptySessions.set(id, session);

  ptyProc.onData((data) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send(`terminal:data:${id}`, data);
  });
  ptyProc.onExit(({ exitCode, signal }) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(`terminal:exit:${id}`, { exitCode, signal });
    }
    ptySessions.delete(id);
  });

  return { id, cwd, shell, pid: ptyProc.pid };
});

ipcMain.handle("terminal:write", async (_event, args = {}) => {
  const id = typeof args.id === "string" ? args.id : "";
  const data = typeof args.data === "string" ? args.data : "";
  // 1 MB per write is already very generous for interactive terminal input;
  // anything larger is almost certainly accidental and could saturate the PTY.
  if (data.length > 1_000_000) {
    throw new Error("terminal:write data exceeds 1 MB limit");
  }
  const session = ptySessions.get(id);
  if (!session) return false;
  session.pty.write(data);
  return true;
});

ipcMain.handle("terminal:resize", async (_event, args = {}) => {
  const id = typeof args.id === "string" ? args.id : "";
  const session = ptySessions.get(id);
  if (!session) return false;
  const cols = Number.isInteger(args.cols) && args.cols > 0 ? args.cols : 80;
  const rows = Number.isInteger(args.rows) && args.rows > 0 ? args.rows : 24;
  try {
    session.pty.resize(cols, rows);
  } catch {
    // pty already exited — surface as a no-op rather than throwing,
    // because the renderer's resize observer can race the exit event.
    return false;
  }
  return true;
});

ipcMain.handle("terminal:kill", async (_event, args = {}) => {
  const id = typeof args.id === "string" ? args.id : "";
  return killPtySession(id);
});

ipcMain.handle("terminal:list", async () => {
  return Array.from(ptySessions.entries()).map(([id, s]) => ({
    id,
    cwd: s.cwd,
    shell: s.shell,
    laneId: s.laneId,
    pid: s.pty.pid,
  }));
});

ipcMain.handle("terminal:available", async () => {
  return { available: Boolean(ptyLib), error: ptyLoadError };
});

app.whenReady().then(async () => {
  tryInitKeytar();
  await loadApiKeys();
  providerModelsCache = await readProviderModels();
  createWindow();
});

app.on("window-all-closed", () => {
  stopAllWatchers();
  killAllPtySessions();
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", () => {
  stopAllWatchers();
  killAllPtySessions();
});
