const { app, BrowserWindow, Menu, dialog, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs/promises");
const { spawn } = require("child_process");
const { TextDecoder } = require("util");

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
let apiKeysCache = {
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

async function runPythonBridge(payload, { attachApiKeys = false } = {}) {
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
    }, 120000);

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
    let decoded = "";
    let truncated = false;
    while (decoded.length <= maxChars) {
      const { bytesRead } = await handle.read(buffer, 0, chunkSize, null);
      if (bytesRead === 0) {
        break;
      }
      const chunk = Buffer.from(buffer.subarray(0, bytesRead));
      chunks.push(chunk);
      totalBytes += bytesRead;
      decoded = decoder.decode(Buffer.concat(chunks, totalBytes));
      if (decoded.length > maxChars) {
        truncated = true;
        break;
      }
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
  const response = await runPythonBridge({ command: "casefile:open", root: chosen });
  return adoptCasefileSnapshot(response.casefile);
});

ipcMain.handle("casefile:open", async (_, args = {}) => {
  const root = typeof args.root === "string" ? args.root : "";
  if (!root) {
    throw new Error("root is required");
  }
  const response = await runPythonBridge({ command: "casefile:open", root });
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
  const response = await runPythonBridge({
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
  const response = await runPythonBridge({
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
  const response = await runPythonBridge({
    command: "casefile:listChat",
    casefileRoot: activeCasefileRoot,
    laneId,
  });
  return Array.isArray(response.messages) ? response.messages : [];
});

// ----- M3: findings, notes, compare, export, lane-scoped read -----

function requireCasefile() {
  if (!activeCasefileRoot) {
    throw new Error("No casefile is open");
  }
  return activeCasefileRoot;
}

ipcMain.handle("casefile:listFindings", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const laneId = typeof args.laneId === "string" && args.laneId ? args.laneId : null;
  const payload = { command: "casefile:listFindings", casefileRoot };
  if (laneId) payload.laneId = laneId;
  const response = await runPythonBridge(payload);
  return Array.isArray(response.findings) ? response.findings : [];
});

ipcMain.handle("casefile:getFinding", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const findingId = typeof args.findingId === "string" ? args.findingId : "";
  if (!findingId) throw new Error("findingId is required");
  const response = await runPythonBridge({
    command: "casefile:getFinding",
    casefileRoot,
    findingId,
  });
  return response.finding;
});

ipcMain.handle("casefile:createFinding", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const finding = args.finding && typeof args.finding === "object" ? args.finding : null;
  if (!finding) throw new Error("finding is required");
  const response = await runPythonBridge({
    command: "casefile:createFinding",
    casefileRoot,
    finding,
  });
  return response.finding;
});

ipcMain.handle("casefile:updateFinding", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const findingId = typeof args.findingId === "string" ? args.findingId : "";
  const finding = args.finding && typeof args.finding === "object" ? args.finding : null;
  if (!findingId) throw new Error("findingId is required");
  if (!finding) throw new Error("finding is required");
  const response = await runPythonBridge({
    command: "casefile:updateFinding",
    casefileRoot,
    findingId,
    finding,
  });
  return response.finding;
});

ipcMain.handle("casefile:deleteFinding", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const findingId = typeof args.findingId === "string" ? args.findingId : "";
  if (!findingId) throw new Error("findingId is required");
  await runPythonBridge({ command: "casefile:deleteFinding", casefileRoot, findingId });
  return true;
});

ipcMain.handle("casefile:getNote", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const laneId = typeof args.laneId === "string" ? args.laneId : "";
  if (!laneId) throw new Error("laneId is required");
  const response = await runPythonBridge({ command: "casefile:getNote", casefileRoot, laneId });
  return typeof response.content === "string" ? response.content : "";
});

ipcMain.handle("casefile:saveNote", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const laneId = typeof args.laneId === "string" ? args.laneId : "";
  const content = typeof args.content === "string" ? args.content : "";
  if (!laneId) throw new Error("laneId is required");
  await runPythonBridge({ command: "casefile:saveNote", casefileRoot, laneId, content });
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

ipcMain.handle("casefile:exportFindings", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const laneIds = Array.isArray(args.laneIds) ? args.laneIds.filter((x) => typeof x === "string") : [];
  if (laneIds.length === 0) throw new Error("laneIds is required");
  const response = await runPythonBridge({
    command: "casefile:exportFindings",
    casefileRoot,
    laneIds,
  });
  return { path: response.path, markdown: response.markdown };
});

ipcMain.handle("lane:readFile", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const laneId = typeof args.laneId === "string" ? args.laneId : "";
  const filePath = typeof args.path === "string" ? args.path : "";
  if (!laneId) throw new Error("laneId is required");
  if (!filePath) throw new Error("path is required");
  const payload = { command: "lane:readFile", casefileRoot, laneId, path: filePath };
  if (Number.isInteger(args.maxChars)) payload.maxChars = args.maxChars;
  const response = await runPythonBridge(payload);
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
  const response = await runPythonBridge({
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
  const response = await runPythonBridge({
    command: "casefile:updateLaneAttachments",
    casefileRoot,
    laneId,
    attachments,
  });
  return adoptCasefileSnapshot(response.casefile);
});

ipcMain.handle("casefile:getContext", async () => {
  const casefileRoot = requireCasefile();
  const response = await runPythonBridge({
    command: "casefile:getContext",
    casefileRoot,
  });
  return response.context;
});

ipcMain.handle("casefile:saveContext", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const manifest = args.manifest && typeof args.manifest === "object" ? args.manifest : null;
  if (!manifest) throw new Error("manifest is required");
  const response = await runPythonBridge({
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
  const response = await runPythonBridge({
    command: "casefile:resolveScope",
    casefileRoot,
    laneId,
  });
  return response.scope;
});

ipcMain.handle("casefile:listOverlayTrees", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const laneId = typeof args.laneId === "string" ? args.laneId : "";
  if (!laneId) throw new Error("laneId is required");
  const maxDepthRaw = Number.isInteger(args.maxDepth) ? args.maxDepth : 3;
  const maxDepth = Math.max(1, Math.min(maxDepthRaw, 8));
  const response = await runPythonBridge({
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
  const response = await runPythonBridge(payload);
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
  await fs.writeFile(filePath, content, "utf-8");
  return { path: filePath, saved: true };
});

ipcMain.handle("chat:send", async (_, payload = {}) => {
  if (!activeCasefileRoot || !activeLaneId) {
    throw new Error("Open a casefile before sending a chat");
  }
  const bridgePayload = {
    command: "chat:send",
    casefileRoot: activeCasefileRoot,
    laneId: activeLaneId,
    provider: payload.provider || "openai",
    model: payload.model || null,
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
  return runPythonBridge(bridgePayload, { attachApiKeys: true });
});

// ----- M4.1: prompt drafts -----

ipcMain.handle("casefile:listPrompts", async () => {
  const casefileRoot = requireCasefile();
  const response = await runPythonBridge({
    command: "casefile:listPrompts",
    casefileRoot,
  });
  return Array.isArray(response.prompts) ? response.prompts : [];
});

ipcMain.handle("casefile:getPrompt", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const promptId = typeof args.promptId === "string" ? args.promptId : "";
  if (!promptId) throw new Error("promptId is required");
  const response = await runPythonBridge({
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
  const response = await runPythonBridge({
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
  const response = await runPythonBridge({
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
  await runPythonBridge({
    command: "casefile:deletePrompt",
    casefileRoot,
    promptId,
  });
  return true;
});

// ----- M4.2: command runs -----

ipcMain.handle("casefile:listRuns", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const payload = { command: "casefile:listRuns", casefileRoot };
  if (typeof args.laneId === "string" && args.laneId) payload.laneId = args.laneId;
  const response = await runPythonBridge(payload);
  return Array.isArray(response.runs) ? response.runs : [];
});

ipcMain.handle("casefile:getRun", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const runId = typeof args.runId === "string" ? args.runId : "";
  if (!runId) throw new Error("runId is required");
  const response = await runPythonBridge({
    command: "casefile:getRun",
    casefileRoot,
    runId,
  });
  return response.run;
});

ipcMain.handle("casefile:runCommand", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const commandLine = typeof args.commandLine === "string" ? args.commandLine : "";
  if (!commandLine.trim()) throw new Error("commandLine is required");
  const payload = {
    command: "casefile:runCommand",
    casefileRoot,
    commandLine,
  };
  if (typeof args.laneId === "string" && args.laneId) payload.laneId = args.laneId;
  if (Number.isInteger(args.timeoutSeconds) && args.timeoutSeconds > 0) {
    payload.timeoutSeconds = args.timeoutSeconds;
  }
  if (Number.isInteger(args.maxOutputChars) && args.maxOutputChars > 0) {
    payload.maxOutputChars = args.maxOutputChars;
  }
  const response = await runPythonBridge(payload);
  return response.run;
});

ipcMain.handle("casefile:deleteRun", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const runId = typeof args.runId === "string" ? args.runId : "";
  if (!runId) throw new Error("runId is required");
  await runPythonBridge({
    command: "casefile:deleteRun",
    casefileRoot,
    runId,
  });
  return true;
});

// ----- M4.3: external local-directory inboxes -----

ipcMain.handle("casefile:listInboxSources", async () => {
  const casefileRoot = requireCasefile();
  const response = await runPythonBridge({
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
  const response = await runPythonBridge(payload);
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
  const response = await runPythonBridge(payload);
  return response.source;
});

ipcMain.handle("casefile:removeInboxSource", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const sourceId = typeof args.sourceId === "string" ? args.sourceId : "";
  if (!sourceId.trim()) throw new Error("sourceId is required");
  await runPythonBridge({
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
  const response = await runPythonBridge(payload);
  return Array.isArray(response.items) ? response.items : [];
});

ipcMain.handle("casefile:readInboxItem", async (_, args = {}) => {
  const casefileRoot = requireCasefile();
  const sourceId = typeof args.sourceId === "string" ? args.sourceId : "";
  const path = typeof args.path === "string" ? args.path : "";
  if (!sourceId.trim()) throw new Error("sourceId is required");
  if (!path.trim()) throw new Error("path is required");
  const payload = {
    command: "casefile:readInboxItem",
    casefileRoot,
    sourceId,
    path,
  };
  if (Number.isInteger(args.maxChars) && args.maxChars > 0) {
    payload.maxChars = args.maxChars;
  }
  const response = await runPythonBridge(payload);
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
  const response = await runPythonBridge({
    command: "casefile:openComparison",
    casefileRoot,
    laneIds,
  });
  return response.comparison;
});

ipcMain.handle("casefile:sendComparisonChat", async (_, payload = {}) => {
  const casefileRoot = requireCasefile();
  const laneIds = normalizeLaneIds(payload.laneIds);
  return runPythonBridge(
    {
      command: "casefile:sendComparisonChat",
      casefileRoot,
      laneIds,
      provider: payload.provider || "openai",
      model: payload.model || null,
      messages: Array.isArray(payload.messages) ? payload.messages : [],
      userMessage: payload.userMessage || "",
      resumePendingToolCalls: Boolean(payload.resumePendingToolCalls),
    },
    { attachApiKeys: true }
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

app.whenReady().then(async () => {
  tryInitKeytar();
  await loadApiKeys();
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
