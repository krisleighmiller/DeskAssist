const { app, BrowserWindow, Menu, dialog, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs/promises");
const { spawn } = require("child_process");
const { TextDecoder } = require("util");

let workspaceRoot = null;
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

  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

function ensureInWorkspace(targetPath) {
  if (!workspaceRoot) {
    throw new Error("Workspace is not selected");
  }
  const resolvedWorkspace = path.resolve(workspaceRoot);
  const resolvedTarget = path.resolve(targetPath);
  if (
    resolvedTarget !== resolvedWorkspace &&
    !resolvedTarget.startsWith(`${resolvedWorkspace}${path.sep}`)
  ) {
    throw new Error("Path escapes workspace");
  }
  return resolvedTarget;
}

async function buildTree(directoryPath, depth = 0, maxDepth = 4) {
  const directory = ensureInWorkspace(directoryPath);
  const node = {
    name: path.basename(directory),
    path: directory,
    type: "dir",
    children: [],
  };

  if (depth >= maxDepth) {
    return node;
  }

  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      node.children.push(await buildTree(entryPath, depth + 1, maxDepth));
    } else if (entry.isFile()) {
      node.children.push({
        name: entry.name,
        path: entryPath,
        type: "file",
      });
    }
  }

  return node;
}

async function runPythonBridge(payload) {
  const repoRoot = path.resolve(__dirname, "..");
  const pythonPath = process.env.PYTHONPATH
    ? `${path.join(repoRoot, "src")}:${process.env.PYTHONPATH}`
    : path.join(repoRoot, "src");
  const env = { ...process.env, PYTHONPATH: pythonPath };
  const bridgePayload = {
    ...payload,
    apiKeys: {
      openai: apiKeysCache.openai || null,
      anthropic: apiKeysCache.anthropic || null,
      deepseek: apiKeysCache.deepseek || null,
    },
  };

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
      try {
        const response = extractBridgeResponse(stdout);
        if (response.ok) {
          resolve(response);
          return;
        }
        reject(new Error(response.error || stderr || `Bridge failed with exit code ${code}`));
      } catch (error) {
        reject(
          new Error(
            stderr ||
              `Bridge parse error: ${error.message}; stdout=${stdout.slice(-500)}`
          )
        );
      }
    });

    child.stdin.write(JSON.stringify(bridgePayload));
    child.stdin.end();
  });
}

function extractBridgeResponse(stdout) {
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
      // keep scanning for final JSON line
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

ipcMain.handle("workspace:choose", async () => {
  const result = await dialog.showOpenDialog({
    properties: ["openDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }
  workspaceRoot = result.filePaths[0];
  return workspaceRoot;
});

ipcMain.handle("workspace:list", async (_, args = {}) => {
  const maxDepth = Number.isInteger(args.maxDepth) ? args.maxDepth : 4;
  if (!workspaceRoot) {
    throw new Error("Workspace is not selected");
  }
  return buildTree(workspaceRoot, 0, Math.max(1, Math.min(maxDepth, 8)));
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
  if (!workspaceRoot) {
    throw new Error("Workspace is not selected");
  }
  return runPythonBridge({
    workspaceRoot,
    provider: payload.provider || "openai",
    model: payload.model || null,
    messages: Array.isArray(payload.messages) ? payload.messages : [],
    userMessage: payload.userMessage || "",
    allowWriteTools: Boolean(payload.allowWriteTools),
    resumePendingToolCalls: Boolean(payload.resumePendingToolCalls),
  });
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
