const { app, BrowserWindow, Menu, dialog, ipcMain, safeStorage, shell } = require("electron");
const path = require("path");
const fs = require("fs/promises");
const fsSync = require("fs");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { TextDecoder } = require("util");
const { resolveAllowedTerminalCwd: resolveTerminalCwdPolicy } = require("./terminalPolicy");

// SECURITY (H8): every IPC handler MUST be invoked from the top-level
// frame of our own renderer window. Without this gate, any future
// `<webview>` / nested `<iframe>` / popup spawned (or coerced) into
// the app would be able to call `ipcRenderer.invoke(...)` and reach
// privileged main-process code.
//
// We enforce that:
//   1. The sending webContents is the main window's webContents.
//   2. The sending frame is the *top* frame (no nested iframes).
//   3. The frame URL is one we expect (file:// for packaged builds,
//      http(s)://localhost for dev). The dev allow-list is
//      intentionally narrow — `loadURL` already rejects anything else
//      via `isAllowedDevRendererUrl`, but checking again at IPC time
//      defends against `will-navigate` races.
//
// The check runs inside a wrapper installed on `ipcMain.handle` so
// every existing call site gets the gate without needing to be edited.
// The wrapper preserves the exact return / throw semantics callers
// already rely on (Electron auto-serialises return values; thrown
// errors surface as renderer-side rejections).
function isFrameUrlAllowed(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) return false;
  if (rawUrl.startsWith("file://")) return true;
  try {
    const parsed = new URL(rawUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function assertTrustedSender(event, channel) {
  // `mainWindow` is captured by closure in `createWindow`; reference
  // it via the module-level binding here. Until the window is up,
  // there is no legitimate sender, so reject everything.
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error(`IPC ${channel}: no main window`);
  }
  if (event.sender !== mainWindow.webContents) {
    throw new Error(`IPC ${channel}: sender is not the main window`);
  }
  const frame = event.senderFrame;
  if (!frame) {
    throw new Error(`IPC ${channel}: no sender frame`);
  }
  if (frame.parent) {
    // Nested frame — could be a malicious sub-frame loaded via an
    // ad-hoc `<iframe>` or `<webview>`. Refuse.
    throw new Error(`IPC ${channel}: refusing call from nested frame`);
  }
  if (!isFrameUrlAllowed(frame.url)) {
    throw new Error(
      `IPC ${channel}: refusing call from disallowed frame url`
    );
  }
}

const _ipcMainHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = function safeHandle(channel, listener) {
  return _ipcMainHandle(channel, async (event, ...args) => {
    assertTrustedSender(event, channel);
    return listener(event, ...args);
  });
};

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

// `activeCasefileRoot` is the containment boundary for file-tree IPC and
// editor IO. `activeContextRoot` remains important for AI scope, terminal cwd,
// and "active context" guardrails such as refusing to trash the active context
// root, but ordinary user file operations are casefile-wide.
let activeCasefileRoot = null;
let activeContextId = null;
let activeContextRoot = null;
let registeredContextRoots = [];
// SECURITY (H3): writable directories within the active context scope (context
// root + any writable attachment root, all realpath-normalised). Used by
// `chat:saveOutput` to refuse destinations the user did not authorise.
// Recomputed via `refreshWritableScopeRoots` whenever a casefile is
// opened, a context switched, attachments edited, or a context removed.
let writableScopeRoots = new Set();
const approvalSecret = crypto.randomBytes(32).toString("hex");
const pendingApprovalTokens = new Map();

// SECURITY (H2): roots the user has explicitly vetted via the OS file
// picker (`casefile:choose`). Re-opening one of these via
// `casefile:open(root)` is a no-prompt op (matches the renderer's
// "Recent" list UX), but opening a path NOT in this set requires the
// renderer to drive the dialog flow first. This blocks a renderer
// compromise (XSS, stored-state corruption, malicious markdown render)
// from coercing main into reading or initialising arbitrary directories
// — including any directory the bridge's `_validate_path_depth` would
// otherwise accept (e.g. `/home/<user>/Documents/anything`).
//
// Persisted to `<userData>/vetted-casefiles.json` so the user does not
// have to re-pick across launches. Realpath-normalised on insertion so
// symlink-vs-target spoofing cannot bypass the set membership check.
const vettedCasefileRoots = new Set();

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
          "Consider opening a smaller workspace root."
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
// SECURITY (C2): possible values, in order of preference:
//   - "keychain"        : node-keytar / OS keychain available
//   - "encrypted-file"  : keytar absent, but Electron safeStorage works,
//                        so we encrypt before persisting. This is bound to
//                        the OS user via DPAPI / Keychain / libsecret-derived
//                        key, depending on platform.
//   - "unavailable"     : neither backend is usable. We refuse to write keys
//                        to disk (no plaintext fallback). The renderer will
//                        see this status and surface a hard error rather
//                        than silently downgrading to plaintext storage.
let keyStorageBackend = "unavailable";
let mainWindow = null;
const MAX_FILE_READ_BYTES = 2_000_000;

// SECURITY (C2): magic prefix marking the on-disk file as a safeStorage
// blob rather than legacy plaintext JSON. Plaintext files start with `{`,
// which is mutually exclusive with this byte sequence, so the migration
// path in `readFileKeys` can detect format unambiguously.
const ENCRYPTED_FILE_MAGIC = Buffer.from("DSKEC1\n", "utf-8");

function apiKeysPath() {
  return path.join(app.getPath("userData"), "api-keys.json");
}

// SECURITY (H2): file backing `vettedCasefileRoots`. Stored as a JSON
// array of strings (realpaths). 0o600 perms because the contents reveal
// directory layout that may be sensitive (e.g. project codenames in
// path components).
function vettedCasefilesPath() {
  return path.join(app.getPath("userData"), "vetted-casefiles.json");
}

async function loadVettedCasefileRoots() {
  try {
    const raw = await fs.readFile(vettedCasefilesPath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    vettedCasefileRoots.clear();
    for (const entry of parsed) {
      if (typeof entry === "string" && entry.length > 0) {
        // realpathIfDirectory is hoisted (function declaration); safe
        // to call here even though the source-order definition is
        // below.
        const real = realpathIfDirectory(entry);
        if (real) vettedCasefileRoots.add(real);
      }
    }
  } catch {
    // First launch / corrupt file / no such file: start with an empty set.
  }
}

async function persistVettedCasefileRoots() {
  await fs.mkdir(path.dirname(vettedCasefilesPath()), { recursive: true });
  await fs.writeFile(
    vettedCasefilesPath(),
    JSON.stringify(Array.from(vettedCasefileRoots), null, 2),
    { encoding: "utf-8", mode: 0o600 }
  );
  try {
    await fs.chmod(vettedCasefilesPath(), 0o600);
  } catch {
    // Non-fatal on filesystems without POSIX perms.
  }
}

async function vetCasefileRoot(rawPath) {
  const real = realpathIfDirectory(rawPath);
  if (!real) {
    throw new Error(`Cannot vet path: not a directory or unreadable: ${rawPath}`);
  }
  if (!vettedCasefileRoots.has(real)) {
    vettedCasefileRoots.add(real);
    try {
      await persistVettedCasefileRoots();
    } catch (err) {
      console.warn(
        "[main] failed to persist vetted casefile roots:",
        err && err.message
      );
    }
  }
  return real;
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
    return;
  } catch (error) {
    keytar = null;
  }
  // SECURITY (C2): keytar is missing, fall back to Electron safeStorage.
  // `isEncryptionAvailable()` is only meaningful after `app.whenReady()`,
  // which is the case at every site where we call `tryInitKeytar`.
  try {
    if (safeStorage && safeStorage.isEncryptionAvailable()) {
      keyStorageBackend = "encrypted-file";
      return;
    }
  } catch (error) {
    // Some Linux setups (no libsecret + no Gnome keyring) throw rather
    // than returning false. Treat that the same as "unavailable".
  }
  keyStorageBackend = "unavailable";
  console.warn(
    "[main] No secure storage backend is available (no keytar and " +
      "Electron safeStorage reports unavailable). API keys cannot be " +
      "persisted. Install libsecret-1 / a system keyring or rebuild " +
      "with keytar to enable storage."
  );
}

async function readFileKeys() {
  // SECURITY (C2): supports three on-disk encodings:
  //   - encrypted (safeStorage blob, magic prefix)
  //   - legacy plaintext JSON (read for one-time migration only)
  //   - missing/corrupt (return empty)
  let buffer;
  try {
    buffer = await fs.readFile(apiKeysPath());
  } catch {
    return { openai: "", anthropic: "", deepseek: "" };
  }
  const empty = { openai: "", anthropic: "", deepseek: "" };
  if (buffer.length >= ENCRYPTED_FILE_MAGIC.length &&
      buffer.subarray(0, ENCRYPTED_FILE_MAGIC.length).equals(ENCRYPTED_FILE_MAGIC)) {
    if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
      console.warn(
        "[main] api-keys.json is encrypted but safeStorage is not " +
          "available; refusing to load (would otherwise expose ciphertext " +
          "as opaque key data)."
      );
      return empty;
    }
    try {
      const ciphertext = buffer.subarray(ENCRYPTED_FILE_MAGIC.length);
      const decrypted = safeStorage.decryptString(ciphertext);
      const parsed = JSON.parse(decrypted);
      return {
        openai: typeof parsed.openai === "string" ? parsed.openai : "",
        anthropic: typeof parsed.anthropic === "string" ? parsed.anthropic : "",
        deepseek: typeof parsed.deepseek === "string" ? parsed.deepseek : "",
      };
    } catch (error) {
      console.warn("[main] failed to decrypt api-keys.json:", error && error.message);
      return empty;
    }
  }
  // Legacy plaintext path. We only return the parsed keys so the caller
  // can migrate them into a secure backend; we do NOT keep writing
  // plaintext on subsequent saves.
  try {
    const parsed = JSON.parse(buffer.toString("utf-8"));
    return {
      openai: typeof parsed.openai === "string" ? parsed.openai : "",
      anthropic: typeof parsed.anthropic === "string" ? parsed.anthropic : "",
      deepseek: typeof parsed.deepseek === "string" ? parsed.deepseek : "",
    };
  } catch (error) {
    return empty;
  }
}

function fileKeysAreLegacyPlaintext(buffer) {
  return buffer.length === 0 ||
    !buffer.subarray(0, ENCRYPTED_FILE_MAGIC.length).equals(ENCRYPTED_FILE_MAGIC);
}

async function fileIsLegacyPlaintext() {
  try {
    const buffer = await fs.readFile(apiKeysPath());
    return fileKeysAreLegacyPlaintext(buffer);
  } catch {
    return false;
  }
}

async function loadApiKeys() {
  // SECURITY (C2): unified loader for keychain + encrypted-file backends.
  // The encrypted-file branch transparently migrates legacy plaintext
  // `api-keys.json` files to encrypted form on first load. The keychain
  // branch additionally consumes any leftover encrypted/plaintext file.
  const wasLegacyPlaintext = await fileIsLegacyPlaintext();
  const fileKeys = await readFileKeys();

  if (keytar) {
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
    // Drop the on-disk file once we've migrated everything into the
    // keychain. Done only after a fully successful migration so a partial
    // failure does not leave the user with no recoverable copy.
    const fileHadKeys = PROVIDERS.some((p) => Boolean(fileKeys[p]));
    if (fileHadKeys) {
      try {
        await fs.unlink(apiKeysPath());
      } catch {
        // Non-fatal: file may already be absent or on a read-only filesystem.
      }
    }
    return;
  }

  apiKeysCache = fileKeys;
  // Migrate legacy plaintext into the encrypted format on first load.
  if (wasLegacyPlaintext && PROVIDERS.some((p) => Boolean(fileKeys[p])) &&
      keyStorageBackend === "encrypted-file") {
    try {
      await persistApiKeys();
      console.warn(
        "[main] migrated legacy plaintext api-keys.json to encrypted form."
      );
    } catch (error) {
      console.warn(
        "[main] failed to migrate api-keys.json to encrypted form:",
        error && error.message
      );
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

  // SECURITY (C2): refuse to write plaintext API keys to disk. If
  // safeStorage is unavailable we surface a hard error instead of
  // silently downgrading. Callers are expected to bubble this up to
  // the renderer so the user knows storage is broken.
  if (keyStorageBackend !== "encrypted-file") {
    throw new Error(
      "Refusing to persist API keys: no secure storage backend is " +
        "available. Install a system keyring (libsecret-1 / Keychain) or " +
        "rebuild with keytar so DeskAssist can store keys safely."
    );
  }
  if (!safeStorage || !safeStorage.isEncryptionAvailable()) {
    throw new Error(
      "Refusing to persist API keys: Electron safeStorage is not available."
    );
  }
  await fs.mkdir(path.dirname(apiKeysPath()), { recursive: true });
  const ciphertext = safeStorage.encryptString(JSON.stringify(apiKeysCache));
  const blob = Buffer.concat([ENCRYPTED_FILE_MAGIC, ciphertext]);
  await fs.writeFile(apiKeysPath(), blob, { mode: 0o600 });
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

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    console.warn("[main] blocked renderer window.open:", url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const currentUrl = mainWindow && !mainWindow.isDestroyed()
      ? mainWindow.webContents.getURL()
      : "";
    if (currentUrl && url !== currentUrl) {
      event.preventDefault();
      console.warn("[main] blocked renderer navigation:", url);
    }
  });

  const sendToRenderer = (channel) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel);
    }
  };

  const settingsSubmenu = [
    {
      label: "API Keys and Models",
      click: () => sendToRenderer("app:open-api-keys"),
    },
    {
      label: "Preferences",
      click: () => sendToRenderer("app:open-preferences"),
    },
  ];

  const contextSubmenu = [
    {
      label: "Create New Context",
      accelerator: "CmdOrCtrl+Shift+L",
      click: () => sendToRenderer("app:context:create"),
    },
    {
      label: "Attach to Context",
      accelerator: "CmdOrCtrl+Shift+A",
      click: () => sendToRenderer("app:context:attach"),
    },
    {
      label: "Toggle AI Access",
      accelerator: "CmdOrCtrl+Shift+W",
      click: () => sendToRenderer("app:context:toggle-access"),
    },
    {
      label: "Rename",
      click: () => sendToRenderer("app:context:rename"),
    },
    {
      label: "Compare",
      click: () => sendToRenderer("app:context:compare"),
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
          label: "Open Casefile",
          accelerator: "CmdOrCtrl+Shift+O",
          click: () => sendToRenderer("app:open-casefile"),
        },
        {
          label: "Close Casefile",
          accelerator: "CmdOrCtrl+Shift+K",
          click: () => sendToRenderer("app:close-casefile"),
        },
        {
          label: "Recent",
          click: () => sendToRenderer("app:recent:open"),
        },
        { type: "separator" },
        {
          label: "New File",
          accelerator: "CmdOrCtrl+N",
          click: () => sendToRenderer("app:file:new"),
        },
        {
          label: "New Folder",
          accelerator: "CmdOrCtrl+Shift+N",
          click: () => sendToRenderer("app:folder:new"),
        },
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
        {
          label: "Terminal",
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
        {
          label: "show/hide left panel",
          click: () => sendToRenderer("app:toggle-left-panel"),
        },
        {
          label: "show/hide right panel",
          click: () => sendToRenderer("app:toggle-right-panel"),
        },
        // SECURITY (H9): Reload / Force Reload / Toggle DevTools are
        // dev-only conveniences. In a packaged build they let a user
        // (or, more importantly, a stored-state corruption that
        // triggered an XSS) recover the renderer after a panic
        // banner — which is exactly what the panic banner is meant
        // to *prevent*. We strip them in `app.isPackaged` builds.
        // DevTools also exposes `process.binding(...)` to anyone who
        // can open the console, which would defeat the renderer
        // sandbox entirely.
        ...(app.isPackaged
          ? []
          : [
              { type: "separator" },
              { role: "reload" },
              { role: "forceReload" },
              { role: "toggleDevTools" },
            ]),
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Context",
      submenu: contextSubmenu,
    },
    {
      label: "Settings",
      submenu: settingsSubmenu,
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
  if (devUrl && isAllowedDevRendererUrl(devUrl)) {
    mainWindow.loadURL(devUrl);
  } else {
    if (devUrl) {
      console.warn(
        "[main] ignoring DESKASSIST_RENDERER_URL; only localhost http(s) URLs are allowed"
      );
    }
    mainWindow.loadFile(path.join(__dirname, "renderer", "dist", "index.html"));
  }
}

function isAllowedDevRendererUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) return false;
    return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function realpathForContainment(targetPath) {
  const resolvedTarget = path.resolve(targetPath);
  const parts = [];
  let cursor = resolvedTarget;
  while (true) {
    try {
      const realCursor = fsSync.realpathSync.native(cursor);
      return parts.length > 0
        ? path.join(realCursor, ...parts.reverse())
        : realCursor;
    } catch (err) {
      if (!err || err.code !== "ENOENT") {
        throw err;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        throw err;
      }
      parts.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

function ensureInWorkspace(targetPath) {
  // Containment is enforced against the *casefile* root, not the active
  // context root. The file tree shows the entire casefile (M2.1 — see the
  // "show full tree, color the active context" change), so user-driven
  // file ops naturally need to act on anything inside the casefile.
  // Context-scoped restrictions for AI-initiated ops are still enforced
  // separately by the Python backend's `WorkspaceFilesystem` (context-
  // bound), which is what actually limits what tools can touch.
  if (!activeCasefileRoot) {
    throw new Error("No workspace open");
  }
  const resolvedWorkspace = fsSync.realpathSync.native(activeCasefileRoot);
  const resolvedTarget = realpathForContainment(targetPath);
  if (
    resolvedTarget !== resolvedWorkspace &&
    !resolvedTarget.startsWith(`${resolvedWorkspace}${path.sep}`)
  ) {
    // Include both the offending path and the casefile root in the
    // error so the user (and the renderer error banner) can actually
    // diagnose what went wrong, instead of seeing the bare "Path
    // escapes casefile root" with no clue which path or which root.
    throw new Error(
      `Path escapes workspace root: ${resolvedTarget} is not inside ${resolvedWorkspace}`
    );
  }
  return resolvedTarget;
}

async function buildTree(directoryPath, depth = 0, maxDepth = 4) {
  const directory = ensureInWorkspace(directoryPath);
  return buildTreeAt(directory, depth, maxDepth);
}

async function buildTreeAt(directory, depth = 0, maxDepth = 4, virtualPath = null) {
  // Like buildTree, but rooted by the caller. Current workspace listings call
  // this with `activeCasefileRoot`; historical overlay-tree callers could pass
  // a virtual path, but the renderer no longer shows separate overlay trees.
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

// SECURITY (H5): regex of provider key shapes — used by
// `redactSensitive` to mask anything that *looks* like a key, in the
// (unlikely) case that one ends up in a logged stderr or an error
// message we forward to the renderer. This is best-effort; the real
// fix is not putting keys on those paths in the first place (H4 +
// H10), but a belt-and-braces masking layer is cheap insurance.
const _KEY_SHAPE_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/g, // OpenAI / DeepSeek
  /sk-ant-[A-Za-z0-9_-]{16,}/g, // Anthropic
];

function _homeDirOrNull() {
  try {
    return os.homedir();
  } catch {
    return null;
  }
}

function _escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const _HOME_DIR_REGEX = (() => {
  const home = _homeDirOrNull();
  if (!home || home === "/") return null;
  return new RegExp(_escapeRegExp(home), "g");
})();

// SECURITY (H5): replace outbound absolute paths under the user's
// home directory with `~` and mask anything that looks like a
// provider key. Used both for renderer-facing error messages
// (`runPythonBridge` reject path, `chat:saveOutput` errors, etc.) and
// for main-process `console.error` so the user's username does not
// leak into uploaded crash dumps.
function redactSensitive(text) {
  if (typeof text !== "string" || text.length === 0) return text;
  let out = text;
  if (_HOME_DIR_REGEX) {
    out = out.replace(_HOME_DIR_REGEX, "~");
  }
  for (const re of _KEY_SHAPE_PATTERNS) {
    out = out.replace(re, "[redacted-api-key]");
  }
  return out;
}

// SECURITY (H4): list of bridge command names that are allowed to
// receive provider API keys. Every other command path MUST be invoked
// without keys — `runPythonBridge` enforces this defensively even if a
// caller sets `attachApiKeys: true` by mistake. Keeping the allow-list
// alongside the helper makes the contract obvious at the call site.
const CHAT_COMMANDS_NEEDING_KEYS = new Set([
  "chat:send",
  "casefile:sendComparisonChat",
]);

async function runPythonBridge(payload, { attachApiKeys = false, timeoutMs } = {}) {
  const repoRoot = path.resolve(__dirname, "..");
  const pythonPath = process.env.PYTHONPATH
    ? `${path.join(repoRoot, "src")}:${process.env.PYTHONPATH}`
    : path.join(repoRoot, "src");
  // SECURITY (H4): build the child env without inheriting any provider
  // API keys that may have leaked into our own `process.env`. We
  // deliver keys exclusively through the stdin payload (`apiKeys`)
  // for chat commands, so the env transport is never legitimately
  // used and scrubbing it costs us nothing while removing a leak path
  // (e.g. a Python traceback that prints `os.environ`, or a child
  // shell spawned from inside a tool).
  const env = { ...process.env, PYTHONPATH: pythonPath };
  for (const k of Object.keys(env)) {
    if (/_API_KEY$/i.test(k)) delete env[k];
  }
  const bridgePayload = { ...payload };
  // SECURITY (H4): defensively gate attachApiKeys to the allow-list
  // even when the caller asks for them on a non-chat command. A bug
  // in a future call site cannot accidentally ship the keys to e.g.
  // `workspace:list` or `file:read`.
  const cmd = typeof bridgePayload.command === "string" ? bridgePayload.command : "";
  const wantKeys = attachApiKeys && CHAT_COMMANDS_NEEDING_KEYS.has(cmd);
  if (attachApiKeys && !wantKeys) {
    console.warn(
      "[main] refusing to attach API keys to non-chat bridge command:",
      cmd
    );
  }
  if (wantKeys) {
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
      // SECURITY (H5): error.message often contains the spawned binary
      // path, which on macOS / Linux includes the username. Redact
      // before the message reaches the renderer.
      reject(
        new Error(
          `Python bridge process error: ${redactSensitive(String(error.message))}`
        )
      );
    });

    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      // SECURITY (H4 + H5): main-process logs stay readable to the
      // user and to remote crash reporters. Scrub provider keys (in
      // case the bridge re-echoed a payload) and the user's home
      // directory (replaced with `~`) before printing. We only ever
      // emit `stderr` here, never to the renderer.
      if (stderr) {
        console.error("[bridge stderr]", redactSensitive(stderr));
      }
      try {
        const response = extractBridgeResponse(stdout);
        if (response.ok) {
          resolve(response);
          return;
        }
        // response.error is produced by the bridge's own error handling and
        // is safe to surface; raw stderr is kept in the main process only.
        // SECURITY (H5): bridge errors frequently embed absolute
        // paths from `_validate_path_depth`, `FileNotFoundError`,
        // etc. Redact home before the renderer sees them.
        reject(
          new Error(
            redactSensitive(
              response.error || `Bridge failed with exit code ${code}`
            )
          )
        );
      } catch (error) {
        reject(
          new Error(
            redactSensitive(
              `Bridge response parse error (exit ${code}): ${error.message}`
            )
          )
        );
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

// SECURITY (M1): read at most `maxBytes` worth of UTF-8 content from
// `filePath`. The budget is enforced in *bytes*, not characters, so
// a UTF-16-heavy file cannot blow past the allocation by having
// multi-byte codepoints that consume a single `String.length` slot
// but 3–4 bytes on disk.
//
// Before decoding, the first `SNIFF_BYTES` bytes are checked for NUL
// bytes (the strongest heuristic for binary content). If found, the
// function throws instead of returning garbage-replacement text.
const SNIFF_BYTES = 8192;

async function readFileBounded(filePath, maxBytes) {
  const handle = await fs.open(filePath, "r");
  try {
    const chunkSize = 64 * 1024;
    const buffer = Buffer.allocUnsafe(chunkSize);
    const chunks = [];
    let totalBytes = 0;
    let truncated = false;

    // Read up to maxBytes, collecting chunks.
    while (totalBytes < maxBytes) {
      const remaining = maxBytes - totalBytes;
      const toRead = Math.min(chunkSize, remaining);
      const { bytesRead } = await handle.read(buffer, 0, toRead, null);
      if (bytesRead === 0) break;
      const chunk = Buffer.from(buffer.subarray(0, bytesRead));

      // Binary sniff: check early bytes for NUL.
      if (totalBytes < SNIFF_BYTES) {
        const sniffEnd = Math.min(bytesRead, SNIFF_BYTES - totalBytes);
        for (let i = 0; i < sniffEnd; i++) {
          if (chunk[i] === 0) {
            throw new Error(
              "File appears to be binary (contains NUL bytes)"
            );
          }
        }
      }

      chunks.push(chunk);
      totalBytes += bytesRead;
    }

    // Check if there's more data after our budget.
    if (!truncated) {
      const { bytesRead } = await handle.read(buffer, 0, 1, null);
      if (bytesRead > 0) truncated = true;
    }

    const raw = Buffer.concat(chunks, totalBytes);
    // Decode the complete buffer in one pass. `fatal: true` rejects
    // invalid UTF-8 sequences immediately.
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const content = decoder.decode(raw);
    return { content, truncated, readBytes: totalBytes };
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
  // so the next file-tree IPC call is rooted at the active context.
  if (!snapshot || typeof snapshot.root !== "string") {
    throw new Error("Bridge returned an invalid workspace snapshot");
  }
  // Drop any pending trash-undo entries when the casefile changes — the
  // backups are tied to the previous casefile root and would either fail
  // the casefile match or, worse, surprise the user by resurrecting a
  // file in a workspace they're no longer in.
  if (activeCasefileRoot && activeCasefileRoot !== snapshot.root) {
    clearTrashUndoStack();
    pendingApprovalTokens.clear();
  }
  activeCasefileRoot = snapshot.root;
  activeContextId = snapshot.activeContextId || null;
  const contexts = Array.isArray(snapshot.contexts) ? snapshot.contexts : [];
  const activeContext = contexts.find((context) => context && context.id === activeContextId);
  activeContextRoot = activeContext && typeof activeContext.root === "string" ? activeContext.root : null;
  registeredContextRoots = contexts
    .map((context) => (context && typeof context.root === "string" ? context.root : null))
    .filter(Boolean);
  // Re-bind the filesystem watchers to the (possibly new) casefile +
  // overlay roots so the renderer's file tree picks up external
  // changes (`git checkout`, `cp` from another terminal, the
  // assistant writing via tools, etc.).
  reconcileWatchers();
  // SECURITY (H3): refresh the writable-scope set used by
  // `chat:saveOutput`. Fire-and-forget — if the bridge call fails the
  // set is cleared and saves fall back to the strict deny path.
  refreshWritableScopeRoots().catch(() => {
    /* refresh handler already logs */
  });
  return snapshot;
}

function closeActiveCasefile() {
  activeCasefileRoot = null;
  activeContextId = null;
  activeContextRoot = null;
  registeredContextRoots = [];
  extraWatchRoots = [];
  pendingApprovalTokens.clear();
  // SECURITY (H3): no active context => no writable scope at all.
  // `chat:saveOutput` will refuse every destination until a context is
  // re-opened.
  writableScopeRoots = new Set();
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
    title: "Open Workspace",
    defaultPath,
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  const chosen = result.filePaths[0];
  // SECURITY (H2): record this OS-picker-confirmed path as vetted
  // before opening it. Subsequent renderer-driven `casefile:open`
  // calls against the same realpath can then proceed without a
  // dialog (the "Recent" list in the renderer relies on this).
  const vettedRoot = await vetCasefileRoot(chosen);
  const response = await runPythonBridgeMeta({
    command: "casefile:open",
    root: vettedRoot,
  });
  return adoptCasefileSnapshot(response.casefile);
});

ipcMain.handle("casefile:open", async (_, args = {}) => {
  const root = typeof args.root === "string" ? args.root : "";
  if (!root) {
    throw new Error("root is required");
  }
  // SECURITY (H2): the renderer is not trusted to nominate arbitrary
  // disk paths. Either the path is in the vetted set (the user picked
  // it via the OS dialog at some point in the past, possibly across
  // launches) or this is the path we are already operating against
  // (re-open is idempotent). Anything else is refused with a hint
  // to use the dialog flow — including paths the bridge would
  // otherwise accept under `_validate_path_depth`.
  const real = realpathIfDirectory(root);
  if (!real) {
    throw new Error(
      `Cannot open workspace: path is not an accessible directory: ${root}`
    );
  }
  const isVetted = vettedCasefileRoots.has(real);
  const isCurrent =
    activeCasefileRoot && realpathIfDirectory(activeCasefileRoot) === real;
  if (!isVetted && !isCurrent) {
    throw new Error(
      "Refusing to open a workspace path that has not been confirmed via " +
        "the Open Workspace dialog. Use File → Open Casefile."
    );
  }
  const response = await runPythonBridgeMeta({
    command: "casefile:open",
    root: real,
  });
  return adoptCasefileSnapshot(response.casefile);
});

ipcMain.handle("casefile:close", async () => {
  closeActiveCasefile();
  return true;
});

ipcMain.handle("casefile:chooseContextRoot", async () => {
  // Context / attachment / context pickers all default to the casefile root
  // when one is open. This is the right behaviour for the common case
  // (contexts live next to or under the casefile) and falls back to documents
  // only when no casefile is open yet (in which case there's no context to
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

ipcMain.handle("casefile:registerContext", async (_, args = {}) => {
  if (!activeCasefileRoot) {
    throw new Error("No workspace is open");
  }
  const context = args.context && typeof args.context === "object" ? args.context : null;
  if (!context) {
    throw new Error("context is required");
  }
  const response = await runPythonBridgeMeta({
    command: "casefile:registerContext",
    casefileRoot: activeCasefileRoot,
    context,
  });
  return adoptCasefileSnapshot(response.casefile);
});

ipcMain.handle("casefile:switchContext", async (_, args = {}) => {
  if (!activeCasefileRoot) {
    throw new Error("No workspace is open");
  }
  const contextId = typeof args.contextId === "string" ? args.contextId : "";
  if (!contextId) {
    throw new Error("contextId is required");
  }
  const response = await runPythonBridgeMeta({
    command: "casefile:switchContext",
    casefileRoot: activeCasefileRoot,
    contextId,
  });
  return adoptCasefileSnapshot(response.casefile);
});

ipcMain.handle("casefile:listChat", async (_, args = {}) => {
  if (!activeCasefileRoot) {
    throw new Error("No workspace is open");
  }
  const contextId = typeof args.contextId === "string" ? args.contextId : activeContextId;
  if (!contextId) {
    throw new Error("contextId is required");
  }
  const response = await runPythonBridge(
    {
      command: "casefile:listChat",
      casefileRoot: activeCasefileRoot,
      contextId,
    },
    { timeoutMs: BRIDGE_METADATA_TIMEOUT_MS }
  );
  return {
    messages: Array.isArray(response.messages) ? response.messages : [],
    skippedCorruptLines: Number.isInteger(response.skippedCorruptLines)
      ? response.skippedCorruptLines
      : 0,
  };
});

// ----- Chat output save -----

function requireCasefile() {
  if (!activeCasefileRoot) {
    throw new Error("No workspace is open");
  }
  return activeCasefileRoot;
}

function contextApprovalKey(casefileRoot, contextId) {
  return `context:${casefileRoot}:${contextId}`;
}

function comparisonApprovalKey(casefileRoot, contextIds) {
  return `comparison:${casefileRoot}:${contextIds.slice().sort().join("\0")}`;
}

// SECURITY (H1): how long a freshly minted write-approval token stays
// valid for. Five minutes is generous enough for a user to read the
// approval banner and click while still bounding replay opportunities
// for a renderer compromise that captured a token earlier in the
// session. Tokens are tied to the *exact* tool_calls list that minted
// them via the bridge-side HMAC; expiry is a defence-in-depth limit on
// blast radius if both the renderer and the model collude across
// multiple turns.
const APPROVAL_TOKEN_TTL_MS = 5 * 60 * 1000;

function updatePendingApprovalToken(key, response) {
  if (response && typeof response.pendingApprovalToken === "string") {
    pendingApprovalTokens.set(key, {
      token: response.pendingApprovalToken,
      issuedAt: Date.now(),
    });
  } else {
    pendingApprovalTokens.delete(key);
  }
  return response;
}

// SECURITY (H1): consume a pending approval record after verifying it
// is fresh and present. Returns the token string, or null when no
// approval is pending. Caller MUST treat null as "no write tools may
// be authorised" — this is the gate that distinguishes a real
// user-driven approval from a renderer XSS forging an approval flow.
function consumePendingApproval(key) {
  const record = pendingApprovalTokens.get(key);
  if (!record) return null;
  pendingApprovalTokens.delete(key);
  const isFresh = Date.now() - record.issuedAt <= APPROVAL_TOKEN_TTL_MS;
  if (!isFresh) {
    console.warn(
      "[main] refusing stale approval token for",
      key,
      "(age:", Date.now() - record.issuedAt, "ms)"
    );
    return null;
  }
  return record.token;
}

ipcMain.handle("chat:saveOutput", async (_, args = {}) => {
  // SECURITY (H3): the destination directory used to be passed
  // straight to the Python bridge with no authorisation check, on the
  // theory that the renderer-side picker had already constrained it.
  // That is not a security boundary — a renderer compromise can call
  // this IPC directly with `destinationDir = "/etc"` and the bridge's
  // `_validate_path_depth` allows any path under e.g. `/home/<user>`.
  //
  // Now we require the destination to land inside one of the active
  // context's WRITABLE scope directories (context write_root + writable
  // attachments). The set is recomputed on every casefile / context /
  // attachment change via `refreshWritableScopeRoots`. We do not let
  // the renderer write to read-only related directories because "Save chat
  // here" is a mutating action — exposing it for read-only mounts
  // would surface a false affordance.
  if (!activeCasefileRoot || !activeContextId) {
    throw new Error("No active context — cannot save chat output");
  }
  const destinationDir = typeof args.destinationDir === "string" ? args.destinationDir : "";
  const filename = typeof args.filename === "string" ? args.filename : "";
  const body = typeof args.body === "string" ? args.body : "";
  if (!destinationDir) throw new Error("destinationDir is required");
  if (!filename) throw new Error("filename is required");
  if (!isInsideWritableScope(destinationDir)) {
    // Refresh once in case the renderer raced ahead of the snapshot
    // adoption (e.g. user clicked "Save" while we were still
    // resolving the new context's scope). One retry only: a steady-state
    // miss is a real authorisation failure that must surface.
    await refreshWritableScopeRoots();
    if (!isInsideWritableScope(destinationDir)) {
      throw new Error(
        "destinationDir is outside the active context's writable scope"
      );
    }
  }
  const response = await runPythonBridgeMeta({
    command: "chat:saveOutput",
    destinationDir,
    filename,
    body,
  });
  return { path: response.path };
});

// ----- Context attachments -----

ipcMain.handle("casefile:updateContextAttachments", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const contextId = typeof args.contextId === "string" ? args.contextId : "";
  if (!contextId) throw new Error("contextId is required");
  const attachments = Array.isArray(args.attachments) ? args.attachments : [];
  const response = await runPythonBridgeMeta({
    command: "casefile:updateContextAttachments",
    casefileRoot,
    contextId,
    attachments,
  });
  return adoptCasefileSnapshot(response.casefile);
});

// ----- M4.6: context CRUD + casefile reset -----

ipcMain.handle("casefile:updateContext", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const contextId = typeof args.contextId === "string" ? args.contextId : "";
  if (!contextId) throw new Error("contextId is required");
  // Pass through only the fields that were actually supplied; the bridge
  // distinguishes "omitted" (leave alone) from "null"/"empty" via key
  // presence + type checks, so spreading the args object would hand it
  // bogus keys.
  const payload = {
    command: "casefile:updateContext",
    casefileRoot,
    contextId,
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

ipcMain.handle("casefile:removeContext", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const contextId = typeof args.contextId === "string" ? args.contextId : "";
  if (!contextId) throw new Error("contextId is required");
  const response = await runPythonBridgeMeta({
    command: "casefile:removeContext",
    casefileRoot,
    contextId,
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

ipcMain.handle("casefile:softReset", async () => {
  const casefileRoot = requireCasefile();
  const response = await runPythonBridgeMeta({
    command: "casefile:softReset",
    casefileRoot,
  });
  return adoptCasefileSnapshot(response.casefile);
});

// The renderer registers extra filesystem roots opportunistically; main
// validates them against the active chat scope before watching.
function realpathIfDirectory(root) {
  try {
    const stat = fsSync.statSync(root);
    if (!stat.isDirectory()) return null;
    return fsSync.realpathSync.native(root);
  } catch {
    return null;
  }
}

async function allowedWatchRootsForActiveScope() {
  const allowed = new Set();
  if (!activeCasefileRoot) return allowed;
  const casefileReal = realpathIfDirectory(activeCasefileRoot);
  if (casefileReal) allowed.add(casefileReal);
  if (!activeContextId) return allowed;
  const response = await runPythonBridgeMeta({
    command: "casefile:resolveScope",
    casefileRoot: activeCasefileRoot,
    contextId: activeContextId,
  });
  const scope = response.scope || {};
  const directories = Array.isArray(scope.directories) ? scope.directories : [];
  for (const entry of directories) {
    if (!entry || typeof entry.path !== "string") continue;
    const real = realpathIfDirectory(entry.path);
    if (real) allowed.add(real);
  }
  return allowed;
}

// SECURITY (H3): recompute the set of directories the renderer is
// allowed to nominate as a `chat:saveOutput` destination. The set
// covers every WRITABLE directory in the active context's resolved scope
// — i.e. the context's own write_root plus any attachment whose mode is
// "rw". Read-only attachments are intentionally excluded: a "Save chat
// here" UI action implies the user wants to mutate the target.
//
// Failures are swallowed and the set cleared, which is the strict /
// fail-closed posture: a stale set could let a saved file land
// outside the current context after a switch.
async function refreshWritableScopeRoots() {
  const next = new Set();
  if (!activeCasefileRoot || !activeContextId) {
    writableScopeRoots = next;
    return;
  }
  try {
    const response = await runPythonBridgeMeta({
      command: "casefile:resolveScope",
      casefileRoot: activeCasefileRoot,
      contextId: activeContextId,
    });
    const scope = response.scope || {};
    const directories = Array.isArray(scope.directories) ? scope.directories : [];
    for (const entry of directories) {
      if (!entry || typeof entry.path !== "string") continue;
      if (!entry.writable) continue;
      const real = realpathIfDirectory(entry.path);
      if (real) next.add(real);
    }
  } catch (err) {
    console.warn(
      "[main] refreshWritableScopeRoots failed; saves will be denied:",
      err && err.message
    );
  }
  writableScopeRoots = next;
}

// SECURITY (H3): test whether `targetDir` is inside one of the
// currently writable scope roots. Resolves both sides via realpath so
// symlink-vs-target spoofing cannot defeat the prefix match.
function isInsideWritableScope(targetDir) {
  const realTarget = realpathIfDirectory(targetDir);
  if (!realTarget) return false;
  for (const root of writableScopeRoots) {
    if (realTarget === root) return true;
    if (realTarget.startsWith(`${root}${path.sep}`)) return true;
  }
  return false;
}

ipcMain.handle("workspace:registerWatchRoots", async (_, args = {}) => {
  const incoming = Array.isArray(args.roots) ? args.roots : [];
  const allowed = await allowedWatchRootsForActiveScope();
  // Defensive: drop non-strings, non-directories, unscoped roots, and dedupe.
  const cleaned = Array.from(
    new Set(
      incoming
        .filter((r) => typeof r === "string" && r.length > 0)
        .map((r) => realpathIfDirectory(path.resolve(r)))
        .filter((r) => r && allowed.has(r))
    )
  );
  extraWatchRoots = cleaned;
  reconcileWatchers();
  return { watching: Array.from(activeWatchers.keys()) };
});

ipcMain.handle("workspace:list", async (_, args = {}) => {
  const maxDepth = Number.isInteger(args.maxDepth) ? args.maxDepth : 6;
  // M2.1: list from the casefile root so the user always sees the full
  // tree. The renderer marks subtree(s) belonging to the active context
  // with a "in-active-context" CSS class for the colour cue. Going through
  // `buildTreeAt` (no containment check) is fine here: we're explicitly
  // rooting at the casefile, not honouring a caller-supplied path.
  if (!activeCasefileRoot) {
    throw new Error("No workspace open");
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
  // SECURITY (M1): budget is now in BYTES, not characters, so a
  // UTF-16-heavy file cannot blow past the memory allocation. The
  // `maxBytes` parameter replaces the old `maxChars`; for backward
  // compat we also accept the legacy `maxChars` name, interpreting it
  // as a byte limit (safe: 1 char >= 1 byte in UTF-8).
  const rawLimit = args.maxBytes ?? args.maxChars;
  const requestedMaxBytes =
    Number.isInteger(rawLimit) ? rawLimit : 200_000;
  if (requestedMaxBytes <= 0 || requestedMaxBytes > MAX_FILE_READ_BYTES) {
    throw new Error(`maxBytes must be between 1 and ${MAX_FILE_READ_BYTES}`);
  }
  const { content, truncated } = await readFileBounded(
    filePath,
    requestedMaxBytes
  );
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
  // through `ensureInWorkspace`, so mkdir is bounded to the casefile.
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

// Rename a file or directory inside the active casefile. The renderer
// supplies the source absolute path (already inside the casefile root,
// validated via ensureInWorkspace) and a *new basename* — we
// intentionally don't accept an arbitrary destination path so this
// can't be used to move files elsewhere or escape the casefile.
// Refuses to clobber an existing entry; the caller should
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
  // write to the casefile already has full control, so TOCTOU here is
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

// Create a new (empty) file inside the active casefile.  The caller supplies
// a parent directory (absolute, must already be inside the casefile root)
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

// Create a new directory inside the active casefile.  Like `file:createFile`
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

// Move (or rename) a file/directory inside the active casefile.  Both the
// source and destination must resolve inside the current casefile root.
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
  // attacker who can write to the context already has full control; this
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
// snapshot is purged from disk and from the stack. Each snapshot is also
// bounded so a large accidental trash cannot fill the OS temp directory
// before the actual shell.trashItem call runs.
const MAX_TRASH_UNDO = 20;
const MAX_TRASH_UNDO_BYTES = 256 * 1024 * 1024;
const trashUndoStack = [];
let trashUndoSeq = 0;
let trashUndoStagingDir = null;

async function ensureTrashUndoStagingDir() {
  if (trashUndoStagingDir) return trashUndoStagingDir;
  // SECURITY (C3): trash backups can carry sensitive content (e.g. a
  // user trashing a `.env`). The previous implementation used a
  // predictable name with `recursive: true`, which on POSIX inherits
  // the umask (typically 0o755), making the staging directory
  // world-traversable for the file lifetime. Other unprivileged users
  // on the same host could enumerate filenames and, depending on
  // per-file modes inherited from the source, read contents.
  // We now:
  //   1. Use `mkdtemp` so the unique suffix is generated atomically.
  //   2. Tighten the directory to 0o700 immediately after creation.
  //   3. Belt-and-braces verify the resulting mode and abort if the
  //      filesystem could not honour the perms (e.g. FAT32 mount).
  const base = await fs.mkdtemp(
    path.join(os.tmpdir(), `deskassist-trash-undo-${process.pid}-`)
  );
  try {
    await fs.chmod(base, 0o700);
  } catch {
    // chmod can fail on filesystems without POSIX perms (FAT32, exFAT
    // on USB sticks). On those systems we cannot guarantee isolation,
    // so refuse to use the staging dir at all rather than pretending
    // it is private.
    await fs.rm(base, { recursive: true, force: true });
    throw new Error(
      "Cannot create a private trash-undo staging directory on this " +
        "filesystem (perms unsupported). Trash-with-undo is disabled."
    );
  }
  trashUndoStagingDir = base;
  return base;
}

// SECURITY (C3): walk a freshly-staged backup tree and tighten perms.
// Source files copied via `fs.copyFile` / `fs.cp` inherit the source's
// mode minus the umask, which can leave intermediate dirs at 0o755 or
// individual files at 0o644. With the parent staging dir locked to
// 0o700 the leaks are blocked one level up, but we tighten leaves too
// so a bug in the staging dir creation does not silently expose
// content to other UIDs.
async function lockdownTrashUndoBackup(targetPath) {
  const stack = [targetPath];
  while (stack.length > 0) {
    const current = stack.pop();
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) continue;
    try {
      await fs.chmod(current, stat.isDirectory() ? 0o700 : 0o600);
    } catch {
      // Best-effort on filesystems without POSIX perms.
    }
    if (stat.isDirectory()) {
      let entries;
      try {
        entries = await fs.readdir(current);
      } catch {
        continue;
      }
      for (const entry of entries) {
        stack.push(path.join(current, entry));
      }
    }
  }
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

async function measureTrashUndoBytes(targetPath, initialStat) {
  let total = 0;
  const stack = [{ path: targetPath, stat: initialStat }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || !current.stat) continue;
    const stat = current.stat;
    if (stat.isSymbolicLink && stat.isSymbolicLink()) {
      continue;
    }
    if (stat.isDirectory()) {
      const entries = await fs.readdir(current.path, { withFileTypes: true });
      for (const entry of entries) {
        const childPath = path.join(current.path, entry.name);
        const childStat = await fs.lstat(childPath);
        stack.push({ path: childPath, stat: childStat });
      }
      continue;
    }
    if (stat.isFile()) {
      total += stat.size;
      if (total > MAX_TRASH_UNDO_BYTES) {
        throw new Error(
          `Cannot trash with undo: item is larger than ${Math.round(
            MAX_TRASH_UNDO_BYTES / (1024 * 1024)
          )} MB`
        );
      }
    }
  }
  return total;
}

// Move a file or directory to the OS trash via Electron's shell API.
// We deliberately do not offer permanent delete from the renderer; if
// the user wants that, they can empty the OS trash.  shell.trashItem
// uses the platform's recycle bin / Trash semantics so the operation
// is recoverable.
ipcMain.handle("file:trash", async (_, args = {}) => {
  const targetPath = ensureInWorkspace(args.path || "");
  // Refuse to trash the context root itself — that would leave the
  // active context pointing at a hole. Context removal is a separate flow
  // (`casefile:removeContext`) which preserves on-disk content.
  if (activeContextRoot && path.resolve(targetPath) === path.resolve(activeContextRoot)) {
    throw new Error("Cannot trash the active context's root directory");
  }
  let stat;
  try {
    stat = await fs.lstat(targetPath);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      // SECURITY (H5): redact the home dir before returning to the
      // renderer (which forwards to logs the user may share).
      throw new Error(
        `File or folder no longer exists: ${redactSensitive(targetPath)}`
      );
    }
    throw err;
  }
  await measureTrashUndoBytes(targetPath, stat);
  // Snapshot to the undo staging dir BEFORE trashing. We use a fresh
  // per-entry sub-directory keyed by `trashUndoSeq` so two entries with
  // the same basename can coexist in the staging dir without collision.
  const stagingRoot = await ensureTrashUndoStagingDir();
  const undoId = `undo-${++trashUndoSeq}-${Date.now().toString(36)}`;
  const backupParent = path.join(stagingRoot, undoId);
  const backupPath = path.join(backupParent, path.basename(targetPath));
  await fs.mkdir(backupParent, { recursive: true });
  // SECURITY (C3): match the stagingRoot perms on every per-entry
  // sub-directory.  fs.mkdir respects the umask by default.
  try {
    await fs.chmod(backupParent, 0o700);
  } catch {
    // Non-fatal on filesystems without POSIX perms; the parent dir is
    // already 0o700.
  }
  if (stat.isDirectory()) {
    await fs.cp(targetPath, backupPath, { recursive: true, preserveTimestamps: true });
  } else {
    await fs.copyFile(targetPath, backupPath);
  }
  await lockdownTrashUndoBackup(backupPath);
  // Record the casefile root that owned this entry so we can refuse to
  // restore it across casefile switches (`originalCasefileRoot` mismatch).
  // SECURITY (M8): capture the original stat mode so the restore path
  // can reinstate it. Without this, a `chmod 700` private file comes
  // back at the umask default (e.g. 644), exposing content to other
  // local users.
  const entry = {
    id: undoId,
    originalPath: targetPath,
    backupPath,
    type: stat.isDirectory() ? "dir" : "file",
    originalCasefileRoot: activeCasefileRoot,
    originalMode: stat.mode,
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
    // SECURITY (M8): restore the original file/dir mode. `fs.cp` and
    // `fs.copyFile` inherit the umask, so without this a private
    // `chmod 700` directory comes back world-readable.
    if (typeof entry.originalMode === "number") {
      try {
        await fs.chmod(entry.originalPath, entry.originalMode & 0o7777);
      } catch {
        // Non-fatal: some filesystems don't support chmod.
      }
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
  if (!activeCasefileRoot || !activeContextId) {
    throw new Error("Open a workspace before sending a chat");
  }
  const provider = payload.provider || "openai";
  // Fall back to the user's saved per-provider model if the renderer
  // didn't explicitly override it. Empty string in the cache means "use
  // the backend default", which we send as null so the Python side picks
  // its own default.
  const savedModel = providerModelsCache[provider] || null;
  const approvalKey = contextApprovalKey(activeCasefileRoot, activeContextId);
  // SECURITY (H1): a fresh chat turn always invalidates any prior
  // approval. Approving means "let *this* batch of pending writes
  // through"; once the user types a new message, prior approvals must
  // not be reusable.
  pendingApprovalTokens.delete(approvalKey);
  // SECURITY (H1): the renderer is NOT allowed to opt into write tools
  // here. Any `allowWriteTools` / `resumePendingToolCalls` value the
  // renderer sends is ignored; resuming with writes goes through the
  // dedicated `chat:approveAndResume` handler which gates on a
  // server-side stored approval record. This means a renderer
  // compromise (XSS, malicious markdown render, future bug) cannot
  // execute write tools without first triggering a model turn that
  // mints an approval token AND going through the explicit approval
  // path.
  const bridgePayload = {
    command: "chat:send",
    casefileRoot: activeCasefileRoot,
    contextId: activeContextId,
    provider,
    model: payload.model || savedModel,
    messages: Array.isArray(payload.messages) ? payload.messages : [],
    userMessage: payload.userMessage || "",
    allowWriteTools: false,
    resumePendingToolCalls: false,
    approvalSecret,
    pendingApprovalToken: null,
  };
  const response = await runPythonBridge(bridgePayload, {
    attachApiKeys: true,
    timeoutMs: BRIDGE_CHAT_TIMEOUT_MS,
  });
  return updatePendingApprovalToken(approvalKey, response);
});

// SECURITY (H1): explicit, server-gated approval path for write tools.
// Distinct from `chat:send` so the renderer can never set
// `allowWriteTools=true` directly; the only way write tools execute is:
//   1. A regular `chat:send` turn returns `pendingApprovals` and a
//      bridge-issued HMAC token, which main stores keyed by context.
//   2. The user clicks Approve in the UI, which calls THIS handler.
//   3. Main verifies a fresh stored token exists, then forwards the
//      resume to the bridge with `allowWriteTools=true` server-side.
// Without a stored token the call is refused before reaching the
// bridge, so a renderer attacker who calls this handler at random
// times sees PermissionError, not silent execution.
ipcMain.handle("chat:approveAndResume", async (_, payload = {}) => {
  if (!activeCasefileRoot || !activeContextId) {
    throw new Error("Open a workspace before approving tools");
  }
  const provider = payload.provider || "openai";
  const savedModel = providerModelsCache[provider] || null;
  const approvalKey = contextApprovalKey(activeCasefileRoot, activeContextId);
  const token = consumePendingApproval(approvalKey);
  if (!token) {
    throw new Error(
      "No pending write approval is recorded for this context. Send a " +
        "new message first; write tools can only be approved in response " +
        "to a model turn that requested them."
    );
  }
  const bridgePayload = {
    command: "chat:send",
    casefileRoot: activeCasefileRoot,
    contextId: activeContextId,
    provider,
    model: payload.model || savedModel,
    messages: Array.isArray(payload.messages) ? payload.messages : [],
    userMessage: "",
    allowWriteTools: true,
    resumePendingToolCalls: true,
    approvalSecret,
    pendingApprovalToken: token,
  };
  const response = await runPythonBridge(bridgePayload, {
    attachApiKeys: true,
    timeoutMs: BRIDGE_CHAT_TIMEOUT_MS,
  });
  return updatePendingApprovalToken(approvalKey, response);
});

// ----- M3.5c: comparison-chat sessions -----

function normalizeContextIds(raw) {
  if (!Array.isArray(raw)) {
    throw new Error("At least two context ids are required");
  }
  const ids = raw
    .filter((x) => typeof x === "string" && x.trim().length > 0)
    .map((x) => x.trim());
  if (ids.length < 2 || new Set(ids).size < 2) {
    throw new Error("At least two distinct contexts are required");
  }
  return ids;
}

ipcMain.handle("casefile:openComparison", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const contextIds = normalizeContextIds(args.contextIds);
  const response = await runPythonBridgeMeta({
    command: "casefile:openComparison",
    casefileRoot,
    contextIds,
  });
  return response.comparison;
});

ipcMain.handle("casefile:updateComparisonAttachments", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const contextIds = normalizeContextIds(args.contextIds);
  const attachments = Array.isArray(args.attachments) ? args.attachments : [];
  const response = await runPythonBridgeMeta({
    command: "casefile:updateComparisonAttachments",
    casefileRoot,
    contextIds,
    attachments,
  });
  return response.comparison;
});

ipcMain.handle("casefile:sendComparisonChat", async (_, payload = {}) => {
  const casefileRoot = requireCasefile();
  const contextIds = normalizeContextIds(payload.contextIds);
  const provider = payload.provider || "openai";
  const savedModel = providerModelsCache[provider] || null;
  const approvalKey = comparisonApprovalKey(casefileRoot, contextIds);
  // SECURITY (H1): identical contract to `chat:send` — the renderer is
  // never trusted to enable write tools. See the comment in `chat:send`
  // for the full rationale; resuming with writes goes through
  // `casefile:approveAndResumeComparison` instead.
  pendingApprovalTokens.delete(approvalKey);
  const response = await runPythonBridge(
    {
      command: "casefile:sendComparisonChat",
      casefileRoot,
      contextIds,
      provider,
      model: payload.model || savedModel,
      messages: Array.isArray(payload.messages) ? payload.messages : [],
      userMessage: payload.userMessage || "",
      allowWriteTools: false,
      resumePendingToolCalls: false,
      approvalSecret,
      pendingApprovalToken: null,
    },
    { attachApiKeys: true, timeoutMs: BRIDGE_CHAT_TIMEOUT_MS }
  );
  return updatePendingApprovalToken(approvalKey, response);
});

// SECURITY (H1): comparison-chat counterpart of `chat:approveAndResume`.
ipcMain.handle("casefile:approveAndResumeComparison", async (_, payload = {}) => {
  const casefileRoot = requireCasefile();
  const contextIds = normalizeContextIds(payload.contextIds);
  const provider = payload.provider || "openai";
  const savedModel = providerModelsCache[provider] || null;
  const approvalKey = comparisonApprovalKey(casefileRoot, contextIds);
  const token = consumePendingApproval(approvalKey);
  if (!token) {
    throw new Error(
      "No pending write approval is recorded for this comparison " +
        "session. Send a new message first; write tools can only be " +
        "approved in response to a model turn that requested them."
    );
  }
  const response = await runPythonBridge(
    {
      command: "casefile:sendComparisonChat",
      casefileRoot,
      contextIds,
      provider,
      model: payload.model || savedModel,
      messages: Array.isArray(payload.messages) ? payload.messages : [],
      userMessage: "",
      allowWriteTools: true,
      resumePendingToolCalls: true,
      approvalSecret,
      pendingApprovalToken: token,
    },
    { attachApiKeys: true, timeoutMs: BRIDGE_CHAT_TIMEOUT_MS }
  );
  return updatePendingApprovalToken(approvalKey, response);
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
  // SECURITY (M5): clear the in-memory cache FIRST so a racing
  // `chat:send` that fires between the cache wipe and the backend
  // write cannot pick up the stale key. If `persistApiKeys` fails
  // below, the cache stays empty (strict posture), and we also try
  // a direct `keytar.deletePassword` as a fallback so the backend
  // doesn't resurrect the key on the next `loadApiKeys`.
  apiKeysCache[provider] = "";
  try {
    await persistApiKeys();
  } catch (err) {
    // Direct-delete fallback: if the backend persist failed (e.g.
    // safeStorage temporarily unavailable), try removing just this
    // provider from keytar so it doesn't survive a restart.
    if (keytar) {
      try {
        await keytar.deletePassword(KEY_SERVICE, provider);
      } catch {
        // Best-effort.
      }
    }
    console.warn(
      "[main] keys:clear: persistApiKeys failed, cache already cleared:",
      err && err.message
    );
  }
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
// One renderer can host multiple terminals (one per context, plus optional
// extras). Each terminal corresponds to a long-lived shell process owned
// by the main process. The renderer addresses sessions by an opaque
// string id it chose when it called `terminal:spawn`. The main process
// pipes shell stdout/stderr back via `terminal:data:<id>` events and
// forwards keyboard input + resize events via the corresponding
// invoke channels.
//
// Sessions outlive context / tab switches: closing a tab in the UI does
// NOT kill the shell. The shell is killed when the renderer explicitly
// calls `terminal:kill` or when it disappears (window close).

const ptySessions = new Map(); // id -> { pty, cwd, shell, contextId }

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

// SECURITY (H7): allow-list of env vars forwarded to spawned shells.
// Anything here is copied verbatim from the Electron process env;
// everything else is silently dropped. We accept a small UX hit (a
// custom var the user set in their login env will NOT make it to the
// spawned shell unless their shell rc re-exports it) for a large
// security win (provider keys can never leak via the terminal).
const TERMINAL_ENV_ALLOWLIST = [
  // Filesystem + identity
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "TMPDIR",
  // Locale
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_NUMERIC",
  "LC_TIME",
  // Time zone
  "TZ",
  // Terminal capabilities
  "TERM",
  "COLORTERM",
  // Linux desktop / display
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_TYPE",
  "XDG_CURRENT_DESKTOP",
  "DBUS_SESSION_BUS_ADDRESS",
  // SSH agent forwarding (the user's existing agent connection — a
  // separate concern from API keys)
  "SSH_AUTH_SOCK",
  "SSH_AGENT_PID",
  // Windows compatibility (ignored on POSIX)
  "COMSPEC",
  "SYSTEMROOT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
];

function buildTerminalEnv() {
  const env = {};
  for (const k of TERMINAL_ENV_ALLOWLIST) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  // Always force TERM so xterm-256color rendering matches what
  // node-pty negotiated for us.
  env.TERM = "xterm-256color";
  return env;
}

function resolveAllowedTerminalCwd(requestedCwd) {
  return resolveTerminalCwdPolicy({
    requestedCwd,
    activeCasefileRoot,
    activeContextRoot,
    registeredContextRoots,
    realpathIfDirectory,
    homeDir: os.homedir(),
  });
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
  // Don't trust the renderer: when a casefile is open, terminals may start
  // only inside the casefile or registered context roots. User file operations
  // remain casefile-wide elsewhere; this only constrains shell authority.
  const cwd = resolveAllowedTerminalCwd(requestedCwd);
  const cols = Number.isInteger(args.cols) && args.cols > 0 ? args.cols : 80;
  const rows = Number.isInteger(args.rows) && args.rows > 0 ? args.rows : 24;
  const shell = pickShell();
  // node-pty's spawn signature is (file, args, opts). We pass an empty
  // arg list so we get a normal interactive shell — login behavior is
  // controlled by SHELL and the user's rc files.
  // SECURITY (H7): build the terminal env from a curated allow-list
  // rather than blanket-inheriting `process.env`. Two motivations:
  //   1. Provider API keys (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
  //      `DEEPSEEK_API_KEY`) MUST NOT leak into the user's shell —
  //      otherwise any command they run, any subshell, and anything
  //      that subshell calls (including arbitrary network tools)
  //      inherits the keys. The Python bridge takes great care
  //      (H10) to scope keys to a single chat turn; that work is
  //      worthless if a separate `terminal:spawn` channel were to
  //      hand the keys out for the lifetime of the user's shell.
  //   2. Other Electron-internal vars (`ELECTRON_*`, `NODE_*`)
  //      confuse subprocess shells. Bulk-dropping them is simpler
  //      than the previous "delete one at a time" approach.
  // We start from a small set of vars the user's shell really does
  // need (PATH, HOME, locale, TZ, display server hooks, SHELL) and
  // re-add them explicitly. Anything else is dropped.
  const env = buildTerminalEnv();
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
    // SECURITY (M4): the full error message often contains
    // `__dirname` or the user's home path. Surface only the error
    // code (e.g. ENOENT, EIO) so the renderer never receives a
    // username via the shell path.
    const code = err && err.code ? err.code : "UNKNOWN";
    throw new Error(
      `Failed to spawn terminal shell (${code}). ` +
        `Verify that '${path.basename(shell)}' is installed and executable.`
    );
  }

  const session = { pty: ptyProc, cwd, shell, contextId: args.contextId || null };
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
    contextId: s.contextId,
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
  // SECURITY (H2): hydrate the vetted-roots set BEFORE creating the
  // window so the very first IPC the renderer fires (typically
  // `casefile:open` against a remembered root) is gated correctly.
  await loadVettedCasefileRoots();
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
