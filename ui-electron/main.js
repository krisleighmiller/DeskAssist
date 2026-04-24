const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require("electron");
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
// directories changes so the file tree (and any other workspace-derived
// UI) can re-list.
//
// Implementation note. We deliberately do NOT use Node's recursive
// `fs.watch(root, { recursive: true })`. On Linux that mode walks the
// entire tree and creates a per-subdirectory inotify watch with no
// way to exclude paths. A casefile that contains a normal repo
// (`node_modules/`, `.git/`, `.venv/`, build outputs, etc.) easily
// produces tens of thousands of watches, which:
//   * exhausts `fs.inotify.max_user_watches` for the whole user
//     session — every other app's file watcher (file managers,
//     editors, sync clients) starts failing too, which the user
//     experiences as "the desktop froze";
//   * leaks inotify watches across rename/move events.
//
// Instead we walk each registered root manually, skip a fixed set of
// noisy directories (`IGNORED_DIRS`), skip symlinks (so a stray
// `lib -> ..` cannot blow the walk up), and cap the total number of
// per-directory watchers we will install. If a directory is created
// inside a watched tree the per-parent watcher fires, and we walk
// that new subtree on demand.
const activeWatchers = new Map(); // path -> fs.FSWatcher
let extraWatchRoots = []; // overlay roots outside the casefile, set by renderer
let workspaceChangeNotifyTimer = null;
const WORKSPACE_CHANGE_DEBOUNCE_MS = 150;

// Directories that are essentially never interesting to surface in the
// file tree, never edited by hand, and routinely contain hundreds of
// thousands of files. Skipping them protects both the recursive walk
// (`buildTreeAt`) and the watcher (`attachSubtree`).
const IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".casefile",
  "node_modules",
  ".venv",
  "venv",
  "env",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  ".cache",
  ".gradle",
  ".idea",
  ".vscode",
  ".terraform",
  ".direnv",
]);

// Hard cap on the number of per-directory watchers we will install
// across all registered roots. Cheap insurance against a user opening
// a casefile that points at, say, `~/` — without this cap a recursive
// walk would still try to install hundreds of thousands of watches
// even with IGNORED_DIRS in place.
const MAX_WATCHED_DIRS = 4096;
let watchCapReachedNotified = false;

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

function detachDirWatcher(dir) {
  const watcher = activeWatchers.get(dir);
  if (!watcher) return;
  try {
    watcher.close();
  } catch {
    // Closing an already-closed watcher throws on some platforms; ignore.
  }
  activeWatchers.delete(dir);
}

function stopAllWatchers() {
  for (const dir of Array.from(activeWatchers.keys())) {
    detachDirWatcher(dir);
  }
  if (workspaceChangeNotifyTimer) {
    clearTimeout(workspaceChangeNotifyTimer);
    workspaceChangeNotifyTimer = null;
  }
  watchCapReachedNotified = false;
}

function detachSubtreeWatchers(root) {
  // Drop the watcher for `root` and every descendant directory we have
  // a watcher for. Used when a directory disappears (rename / delete)
  // so we don't keep stale FDs around.
  const prefix = root + path.sep;
  for (const dir of Array.from(activeWatchers.keys())) {
    if (dir === root || dir.startsWith(prefix)) {
      detachDirWatcher(dir);
    }
  }
}

function attachDirWatcher(dir) {
  // Install a single non-recursive watcher on `dir`. New entries
  // created inside `dir` fire this watcher and are reconciled by
  // `reconcileChild` below. Idempotent.
  if (!dir || activeWatchers.has(dir)) return;
  if (activeWatchers.size >= MAX_WATCHED_DIRS) {
    if (!watchCapReachedNotified) {
      watchCapReachedNotified = true;
      console.warn(
        `[main] watcher cap reached (${MAX_WATCHED_DIRS} dirs); ` +
          "additional subdirectories will not auto-refresh. " +
          "Consider opening a smaller casefile root."
      );
    }
    return;
  }
  let watcher;
  try {
    watcher = fsSync.watch(dir, { persistent: false }, (eventType, filename) => {
      notifyWorkspaceChanged();
      if (filename) {
        // A `rename` event fires both for created and deleted entries
        // (inotify IN_CREATE / IN_DELETE / IN_MOVED_*). Reconcile the
        // affected child in the background so we attach watchers to
        // brand-new subdirectories and drop watchers for vanished
        // ones. We never block the inotify callback on filesystem IO.
        const child = path.join(dir, filename);
        setImmediate(() => {
          reconcileChild(child).catch(() => {
            // Reconciliation errors are best-effort; the next watcher
            // event (or a manual refresh) will retry.
          });
        });
      }
    });
  } catch (err) {
    // ENOENT / EACCES on the directory — surface as a single warning
    // and move on. The next reconcile pass will retry if appropriate.
    console.warn("[main] failed to watch", dir, ":", err && err.message);
    return;
  }
  watcher.on("error", (err) => {
    console.warn("[main] watcher error on", dir, ":", err && err.message);
    detachDirWatcher(dir);
  });
  activeWatchers.set(dir, watcher);
}

async function attachSubtree(root) {
  // Iteratively walk `root`, attaching a non-recursive watcher per
  // real subdirectory we visit. Skips IGNORED_DIRS by basename and
  // skips directory symlinks so a self-referential link cannot loop
  // the walk. Bounded by MAX_WATCHED_DIRS via attachDirWatcher.
  if (!root) return;
  if (IGNORED_DIRS.has(path.basename(root))) return;
  let rootStat;
  try {
    rootStat = await fs.lstat(root);
  } catch {
    return;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return;
  const stack = [root];
  while (stack.length > 0) {
    if (activeWatchers.size >= MAX_WATCHED_DIRS) break;
    const dir = stack.pop();
    attachDirWatcher(dir);
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // `Dirent` from `readdir({withFileTypes: true})` reports the
      // entry's own type without following symlinks, so a symlink to
      // a directory has `isDirectory() === false` and is naturally
      // skipped here. `entry.isSymbolicLink()` is checked anyway in
      // case Node's behaviour ever shifts.
      if (typeof entry.isSymbolicLink === "function" && entry.isSymbolicLink()) {
        continue;
      }
      if (IGNORED_DIRS.has(entry.name)) continue;
      stack.push(path.join(dir, entry.name));
    }
  }
}

async function reconcileChild(p) {
  // Called from a watcher callback when an entry inside a watched
  // directory was created, renamed, or deleted. If `p` is a new
  // directory we now want to watch, walk it. If it has disappeared,
  // drop watchers for it and any descendants.
  if (!p) return;
  if (IGNORED_DIRS.has(path.basename(p))) return;
  let stat;
  try {
    stat = await fs.lstat(p);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      detachSubtreeWatchers(p);
    }
    return;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  if (!activeWatchers.has(p)) {
    await attachSubtree(p);
  }
}

let watchedRoots = new Set();

function reconcileWatchers() {
  // Bring the per-directory watcher set in line with the desired set
  // of roots. Called whenever the casefile root or the extra overlay
  // roots change. Synchronous from the caller's point of view; the
  // per-subtree walk runs in the background.
  const desired = new Set();
  if (activeCasefileRoot) desired.add(activeCasefileRoot);
  for (const root of extraWatchRoots) {
    if (!root) continue;
    if (
      activeCasefileRoot &&
      (root === activeCasefileRoot ||
        root.startsWith(`${activeCasefileRoot}${path.sep}`))
    ) {
      // Already covered by the casefile-root walk.
      continue;
    }
    desired.add(root);
  }
  // If the desired root set is unchanged, leave the existing
  // per-directory watchers in place. The watcher callbacks keep them
  // honest on subsequent create/delete events.
  let same = desired.size === watchedRoots.size;
  if (same) {
    for (const r of desired) {
      if (!watchedRoots.has(r)) {
        same = false;
        break;
      }
    }
  }
  if (same && watchedRoots.size > 0) return;
  // Desired set changed — drop everything and rewalk. Coverage gap is
  // a few ms; renderer refresh is debounced anyway.
  stopAllWatchers();
  watchedRoots = new Set(desired);
  for (const root of desired) {
    void attachSubtree(root).catch((err) => {
      console.warn("[main] attachSubtree failed for", root, ":", err && err.message);
    });
  }
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

  const sendToRenderer = (channel) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel);
    }
  };

  const laneSubmenu = [
    {
      label: "Create Lane…",
      accelerator: "CmdOrCtrl+Shift+L",
      click: () => sendToRenderer("app:lane:create"),
    },
    {
      label: "Attach to Lane…",
      accelerator: "CmdOrCtrl+Shift+A",
      click: () => sendToRenderer("app:lane:attach"),
    },
    { type: "separator" },
    {
      label: "Rename Active Lane…",
      accelerator: "CmdOrCtrl+Shift+N",
      click: () => sendToRenderer("app:lane:rename"),
    },
    {
      label: "Toggle AI Write Access",
      accelerator: "CmdOrCtrl+Shift+W",
      click: () => sendToRenderer("app:lane:toggle-access"),
    },
    {
      label: "Remove Active Lane",
      click: () => sendToRenderer("app:lane:remove"),
    },
    { type: "separator" },
    {
      label: "Reset Casefile (soft)…",
      click: () => sendToRenderer("app:casefile:soft-reset"),
    },
    {
      label: "Hard Reset Casefile…",
      click: () => sendToRenderer("app:casefile:hard-reset"),
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
        {
          label: "Open Casefile…",
          accelerator: "CmdOrCtrl+Shift+O",
          click: () => sendToRenderer("app:open-casefile"),
        },
        {
          label: "Close Casefile",
          accelerator: "CmdOrCtrl+Shift+K",
          click: () => sendToRenderer("app:close-casefile"),
        },
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
      label: "Lane",
      submenu: laneSubmenu,
    },
    {
      label: "View",
      submenu: [
        {
          label: "Toggle Integrated Terminal",
          // Mirrors the well-known VS Code shortcut. Electron normalises
          // `CmdOrCtrl` to ⌘ on macOS and Ctrl elsewhere, so this is a
          // single binding that does the right thing on every platform.
          accelerator: "CmdOrCtrl+`",
          click: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send("app:toggle-terminal");
            }
          },
        },
        { type: "separator" },
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
  // Containment is enforced against the *casefile* root, not the active
  // lane root. The file tree shows the entire casefile (M2.1 — see the
  // "show full tree, color the active lane" change), so user-driven
  // file ops naturally need to act on anything inside the casefile.
  // Lane-scoped restrictions for AI-initiated ops are still enforced
  // separately by the Python backend's `WorkspaceFilesystem` (lane-
  // bound), which is what actually limits what tools can touch.
  if (!activeCasefileRoot) {
    throw new Error("No casefile open");
  }
  const resolvedWorkspace = path.resolve(activeCasefileRoot);
  const resolvedTarget = path.resolve(targetPath);
  if (
    resolvedTarget !== resolvedWorkspace &&
    !resolvedTarget.startsWith(`${resolvedWorkspace}${path.sep}`)
  ) {
    // Include both the offending path and the casefile root in the
    // error so the user (and the renderer error banner) can actually
    // diagnose what went wrong, instead of seeing the bare "Path
    // escapes casefile root" with no clue which path or which root.
    throw new Error(
      `Path escapes casefile root: ${resolvedTarget} is not inside ${resolvedWorkspace}`
    );
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
    // Skip noisy directories (`.git`, `node_modules`, build outputs,
    // virtualenvs, etc.) for the same reason `attachSubtree` skips
    // them: they routinely hold hundreds of thousands of files, are
    // never user-edited from the tree, and recursively walking them
    // on every workspace:list call freezes the main process.
    if (IGNORED_DIRS.has(entry.name)) continue;
    // Directory symlinks are skipped to avoid walk loops. With
    // `withFileTypes: true`, `entry.isDirectory()` already returns
    // false for symlinks; the explicit check is defensive.
    if (typeof entry.isSymbolicLink === "function" && entry.isSymbolicLink()) {
      continue;
    }
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
  // Drop any pending trash-undo entries when the casefile changes — the
  // backups are tied to the previous casefile root and would either fail
  // the casefile match or, worse, surprise the user by resurrecting a
  // file in a workspace they're no longer in.
  if (activeCasefileRoot && activeCasefileRoot !== snapshot.root) {
    clearTrashUndoStack();
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

function closeActiveCasefile() {
  activeCasefileRoot = null;
  activeLaneId = null;
  activeLaneRoot = null;
  extraWatchRoots = [];
  clearTrashUndoStack();
  reconcileWatchers();
}

ipcMain.handle("casefile:choose", async () => {
  // Default to the parent of the currently-open casefile (so "open another
  // casefile" lands in the right neighbourhood) or to the user's documents
  // folder on first launch — never the home directory, which is noisy.
  const defaultPath = activeCasefileRoot
    ? path.dirname(activeCasefileRoot)
    : app.getPath("documents");
  // Attach the dialog to the main window so it's tracked as a true
  // child window. Without this the Linux portal-backed file picker can
  // stay visible after the user picks a directory — the promise
  // resolves but the OS never tears the window down because it has no
  // parent to dismiss it against. Passing `mainWindow` here also
  // disables interaction with the workbench while the picker is open
  // (matches the user's intuition for a modal "open" dialog).
  const result = await dialog.showOpenDialog(mainWindow, {
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

ipcMain.handle("casefile:close", async () => {
  closeActiveCasefile();
  return true;
});

ipcMain.handle("casefile:chooseLaneRoot", async () => {
  // Lane / attachment / context pickers all default to the casefile root
  // when one is open. This is the right behaviour for the common case
  // (lanes live next to or under the casefile) and falls back to documents
  // only when no casefile is open yet (in which case there's no lane to
  // register anyway, but we still want a sane default).
  const defaultPath = activeCasefileRoot || app.getPath("documents");
  // Parent-window so the dialog is properly modal and dismisses on
  // pick (see `casefile:choose` for the longer rationale).
  const result = await dialog.showOpenDialog(mainWindow, {
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
  if (Object.prototype.hasOwnProperty.call(args, "writable")) payload.writable = args.writable;
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
  const maxDepth = Number.isInteger(args.maxDepth) ? args.maxDepth : 6;
  // M2.1: list from the casefile root so the user always sees the full
  // tree. The renderer marks subtree(s) belonging to the active lane
  // with a "in-active-lane" CSS class for the colour cue. Going through
  // `buildTreeAt` (no containment check) is fine here: we're explicitly
  // rooting at the casefile, not honouring a caller-supplied path.
  if (!activeCasefileRoot) {
    throw new Error("No casefile open");
  }
  return buildTreeAt(activeCasefileRoot, 0, Math.max(1, Math.min(maxDepth, 8)));
});

ipcMain.handle("file:read", async (_, args = {}) => {
  const filePath = ensureInWorkspace(args.path || "");
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      throw new Error(`File does not exist: ${filePath}`);
    }
    throw new Error(`Cannot stat ${filePath}: ${err && err.message ? err.message : err}`);
  }
  if (!stat.isFile()) {
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
  // Atomic write: stage to a sibling temp file, then rename onto the
  // target. This mirrors the temp-file-then-rename pattern every
  // Python-side save uses, and means a crash mid-write never leaves
  // the destination truncated.
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmpPath, content, "utf-8");
    await fs.rename(tmpPath, filePath);
  } catch (err) {
    try {
      await fs.unlink(tmpPath);
    } catch {
      // Best-effort cleanup; the temp file may not exist if writeFile failed early.
    }
    throw err;
  }
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

// Validate that a basename is acceptable as a directory entry name. The
// rules match `file:rename` for consistency: no path separators, no
// reserved navigation segments, no empty / whitespace-only strings.
function validateBasename(name) {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed) {
    throw new Error("name must be a non-empty string");
  }
  if (
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed === "." ||
    trimmed === ".."
  ) {
    throw new Error("name must not contain path separators or be '.'/'..'");
  }
  return trimmed;
}

// Create a new (empty) file inside the active lane.  The caller supplies
// a parent directory (absolute, must already be inside the lane root)
// and a basename (single segment, no separators).  We refuse to clobber
// an existing entry; if you need to overwrite, save through the editor.
ipcMain.handle("file:createFile", async (_, args = {}) => {
  const parentPath = ensureInWorkspace(args.parentDir || "");
  const name = validateBasename(args.name);
  const destinationPath = ensureInWorkspace(path.join(parentPath, name));
  // The parent must exist and be a directory; otherwise the user picked
  // a stale tree entry. We do not implicitly create parents here — that
  // is what `file:createFolder` is for.
  let parentStat;
  try {
    parentStat = await fs.stat(parentPath);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      throw new Error(`Parent directory does not exist: ${parentPath}`);
    }
    throw err;
  }
  if (!parentStat.isDirectory()) {
    throw new Error("Parent path is not a directory");
  }
  // O_EXCL semantics: fail if the target already exists. This avoids
  // race-y "check-then-write" patterns and matches what the user would
  // expect from a "new file" action.
  try {
    const handle = await fs.open(destinationPath, "wx");
    await handle.close();
  } catch (err) {
    if (err && err.code === "EEXIST") {
      throw new Error(`A file or folder named "${name}" already exists`);
    }
    throw err;
  }
  return { path: destinationPath, created: true };
});

// Create a new directory inside the active lane.  Like `file:createFile`
// we require the parent to exist and refuse to clobber an existing
// entry of any kind.
ipcMain.handle("file:createFolder", async (_, args = {}) => {
  const parentPath = ensureInWorkspace(args.parentDir || "");
  const name = validateBasename(args.name);
  const destinationPath = ensureInWorkspace(path.join(parentPath, name));
  let parentStat;
  try {
    parentStat = await fs.stat(parentPath);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      throw new Error(`Parent directory does not exist: ${parentPath}`);
    }
    throw err;
  }
  if (!parentStat.isDirectory()) {
    throw new Error("Parent path is not a directory");
  }
  try {
    await fs.mkdir(destinationPath); // not recursive — fail on existing
  } catch (err) {
    if (err && err.code === "EEXIST") {
      throw new Error(`A file or folder named "${name}" already exists`);
    }
    throw err;
  }
  return { path: destinationPath, created: true };
});

// Move (or rename) a file/directory inside the active lane.  Both the
// source and destination must resolve inside the current lane root —
// this handler is intentionally NOT a generic mv across lanes/overlays.
// We refuse to overwrite an existing destination so a stray drag in the
// tree can't silently destroy data; the caller can issue a follow-up
// trash + retry if they want overwrite semantics.
ipcMain.handle("file:move", async (_, args = {}) => {
  const sourcePath = ensureInWorkspace(args.sourcePath || "");
  const destinationPath = ensureInWorkspace(args.destinationPath || "");
  if (sourcePath === destinationPath) {
    return { sourcePath, destinationPath, moved: false };
  }
  // Source must exist; we don't pre-stat for a perf reason but we want
  // a clean error if it's already gone (e.g. the user trashed it from
  // a terminal between the right-click and the menu pick).
  try {
    await fs.access(sourcePath);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      throw new Error(`Source no longer exists: ${sourcePath}`);
    }
    throw err;
  }
  // Forbid moving a directory into itself / its own descendants —
  // fs.rename silently turns this into ENOTEMPTY or worse on some
  // platforms. Compare with a trailing separator so a/b doesn't match
  // a/bc.
  const srcWithSep = sourcePath + path.sep;
  if (
    destinationPath === sourcePath ||
    destinationPath.startsWith(srcWithSep)
  ) {
    throw new Error("Cannot move a directory into itself");
  }
  // Same overwrite guard as `file:rename`. Race-y but acceptable: an
  // attacker who can write to the lane already has full control; this
  // is a UX guard against the common "drop on the wrong row" mistake.
  try {
    await fs.access(destinationPath);
    throw new Error(
      `A file or folder already exists at the destination: ${destinationPath}`
    );
  } catch (err) {
    if (err && err.code !== "ENOENT") throw err;
  }
  // Ensure the destination's parent exists. We allow moves into a
  // nested sub-path the user typed by hand (e.g. drop "foo.md" into
  // "subdir" the tree had not yet expanded), but we do NOT create
  // arbitrary missing parent chains — that would mask typos.
  const destParent = path.dirname(destinationPath);
  let parentStat;
  try {
    parentStat = await fs.stat(destParent);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      throw new Error(`Destination parent directory does not exist: ${destParent}`);
    }
    throw err;
  }
  if (!parentStat.isDirectory()) {
    throw new Error("Destination parent is not a directory");
  }
  await fs.rename(sourcePath, destinationPath);
  return { sourcePath, destinationPath, moved: true };
});

// In-app undo stack for `file:trash`.  We snapshot each trashed entry
// to a session-private staging directory before invoking the OS trash
// so the renderer can restore-on-Ctrl+Z without depending on the
// (platform-specific, frequently inaccessible) OS Trash on-disk layout.
// The stack is process-local — restarting the app forfeits any pending
// undo entries (deliberate: long-lived staging would silently double
// disk usage and require its own GC story).
//
// We cap the stack at MAX_TRASH_UNDO entries; once full, the oldest
// snapshot is purged from disk and from the stack. Per-entry size is
// not capped here because casefiles can legitimately contain large
// trees and refusing to back up a directory would yield a
// silently-undone "trash" the user can't recover. Operators who care
// about disk usage can lower MAX_TRASH_UNDO.
const MAX_TRASH_UNDO = 20;
const trashUndoStack = [];
let trashUndoSeq = 0;
let trashUndoStagingDir = null;

async function ensureTrashUndoStagingDir() {
  if (trashUndoStagingDir) return trashUndoStagingDir;
  const base = path.join(
    os.tmpdir(),
    `deskassist-trash-undo-${process.pid}-${Date.now()}`
  );
  await fs.mkdir(base, { recursive: true });
  trashUndoStagingDir = base;
  return base;
}

async function purgeTrashUndoEntry(entry) {
  if (!entry || !entry.backupPath) return;
  try {
    await fs.rm(entry.backupPath, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup: leftover staging files are harmless and the
    // staging dir is under the OS temp dir anyway.
  }
}

function clearTrashUndoStack() {
  // Spawn cleanup so we don't keep ipc handlers waiting on disk IO when
  // a casefile is closed / a hard reset fires.
  const drained = trashUndoStack.splice(0, trashUndoStack.length);
  for (const entry of drained) {
    void purgeTrashUndoEntry(entry);
  }
}

// Move a file or directory to the OS trash via Electron's shell API.
// We deliberately do not offer permanent delete from the renderer; if
// the user wants that, they can empty the OS trash.  shell.trashItem
// uses the platform's recycle bin / Trash semantics so the operation
// is recoverable.
ipcMain.handle("file:trash", async (_, args = {}) => {
  const targetPath = ensureInWorkspace(args.path || "");
  // Refuse to trash the lane root itself — that would leave the
  // active lane pointing at a hole. Lane removal is a separate flow
  // (`casefile:removeLane`) which preserves on-disk content.
  if (activeLaneRoot && path.resolve(targetPath) === path.resolve(activeLaneRoot)) {
    throw new Error("Cannot trash the active lane's root directory");
  }
  let stat;
  try {
    stat = await fs.stat(targetPath);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      throw new Error(`File or folder no longer exists: ${targetPath}`);
    }
    throw err;
  }
  // Snapshot to the undo staging dir BEFORE trashing. We use a fresh
  // per-entry sub-directory keyed by `trashUndoSeq` so two entries with
  // the same basename can coexist in the staging dir without collision.
  const stagingRoot = await ensureTrashUndoStagingDir();
  const undoId = `undo-${++trashUndoSeq}-${Date.now().toString(36)}`;
  const backupPath = path.join(stagingRoot, undoId, path.basename(targetPath));
  await fs.mkdir(path.dirname(backupPath), { recursive: true });
  if (stat.isDirectory()) {
    await fs.cp(targetPath, backupPath, { recursive: true, preserveTimestamps: true });
  } else {
    await fs.copyFile(targetPath, backupPath);
  }
  // Record the casefile root that owned this entry so we can refuse to
  // restore it across casefile switches (`originalCasefileRoot` mismatch).
  const entry = {
    id: undoId,
    originalPath: targetPath,
    backupPath,
    type: stat.isDirectory() ? "dir" : "file",
    originalCasefileRoot: activeCasefileRoot,
    timestamp: Date.now(),
  };
  // Now do the actual trash. If trashItem fails after the snapshot we
  // purge the snapshot to avoid leaving an undo entry that resurrects
  // a file that was never deleted.
  try {
    await shell.trashItem(targetPath);
  } catch (err) {
    void purgeTrashUndoEntry(entry);
    throw err;
  }
  trashUndoStack.push(entry);
  while (trashUndoStack.length > MAX_TRASH_UNDO) {
    void purgeTrashUndoEntry(trashUndoStack.shift());
  }
  return { path: targetPath, trashed: true, undoId };
});

// Restore the most recently trashed entry from the undo stack. Returns
// `{ restored: false }` when nothing is on the stack so the renderer can
// flash a hint (or stay silent) without the IPC throwing. The restore is
// blocked when the original path now belongs to a different casefile
// (the user opened a different workspace mid-undo) — silently restoring
// outside the current ensureInWorkspace would be a path-escape.
ipcMain.handle("file:undoLastTrash", async () => {
  // Pop entries from the top until we find one that's still restorable
  // for the current casefile. Stale entries (different casefile) get
  // purged so the next undo skips straight to a usable one.
  while (trashUndoStack.length > 0) {
    const entry = trashUndoStack.pop();
    if (!entry) continue;
    if (
      !activeCasefileRoot ||
      entry.originalCasefileRoot !== activeCasefileRoot
    ) {
      void purgeTrashUndoEntry(entry);
      continue;
    }
    // Refuse to clobber an entry that came back at the same path while
    // the user wasn't looking (created via the "+ File" toolbar, e.g.).
    try {
      await fs.access(entry.originalPath);
      void purgeTrashUndoEntry(entry);
      throw new Error(
        `Cannot restore: a file or folder already exists at ${entry.originalPath}`
      );
    } catch (err) {
      if (err && err.code !== "ENOENT") throw err;
    }
    // Make sure the parent dir still exists. If the user trashed both
    // the entry and its parent in succession, restoring just the leaf
    // would silently leave the parent missing — better to surface it.
    const parent = path.dirname(entry.originalPath);
    try {
      const parentStat = await fs.stat(parent);
      if (!parentStat.isDirectory()) {
        throw new Error(`Cannot restore: ${parent} is not a directory`);
      }
    } catch (err) {
      void purgeTrashUndoEntry(entry);
      if (err && err.code === "ENOENT") {
        throw new Error(
          `Cannot restore: parent directory no longer exists: ${parent}`
        );
      }
      throw err;
    }
    if (entry.type === "dir") {
      await fs.cp(entry.backupPath, entry.originalPath, {
        recursive: true,
        preserveTimestamps: true,
      });
    } else {
      await fs.copyFile(entry.backupPath, entry.originalPath);
    }
    void purgeTrashUndoEntry(entry);
    return { restored: true, path: entry.originalPath, type: entry.type };
  }
  return { restored: false };
});

// How many entries are currently restorable for the active casefile.
// Used by the renderer to decide whether to surface an "undo available"
// hint and to keep keyboard shortcuts a no-op when there's nothing to
// undo (so the binding falls through to the OS / browser default).
ipcMain.handle("file:undoStatus", async () => {
  const restorable = trashUndoStack.filter(
    (entry) => entry.originalCasefileRoot === activeCasefileRoot
  ).length;
  return { restorable };
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
  const result = await dialog.showOpenDialog(mainWindow, {
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

ipcMain.handle("casefile:updateComparisonAttachments", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const laneIds = normalizeLaneIds(args.laneIds);
  const attachments = Array.isArray(args.attachments) ? args.attachments : [];
  const response = await runPythonBridgeMeta({
    command: "casefile:updateComparisonAttachments",
    casefileRoot,
    laneIds,
    attachments,
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
      allowWriteTools: Boolean(payload.allowWriteTools),
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
  if (process.platform === "darwin") {
    // On macOS the app stays alive in the dock when its last window
    // closes, so the pty sessions and file watchers are about to be
    // orphaned (no UI to read their output). Tear them down here;
    // `will-quit` will not fire until the user explicitly quits.
    stopAllWatchers();
    killAllPtySessions();
    return;
  }
  // Everywhere else we ask Electron to quit, which fires `will-quit`
  // (the single source of cleanup for every quit path, including
  // `app.quit()` called from elsewhere).
  app.quit();
});

app.on("will-quit", () => {
  stopAllWatchers();
  killAllPtySessions();
  // Drop any pending trash-undo backups; the staging dir lives under
  // the OS temp dir but cleaning up explicitly avoids leaking gigabytes
  // across many short-lived sessions.
  clearTrashUndoStack();
  if (trashUndoStagingDir) {
    try {
      fsSync.rmSync(trashUndoStagingDir, { recursive: true, force: true });
    } catch {
      // The OS will GC its temp dir eventually; ignore.
    }
  }
});
