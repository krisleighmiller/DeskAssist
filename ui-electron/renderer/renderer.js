const workspaceLabel = document.getElementById("workspaceLabel");
const chooseWorkspaceBtn = document.getElementById("chooseWorkspaceBtn");
const fileTreeEl = document.getElementById("fileTree");
const fileViewerEl = document.getElementById("fileViewer");
const viewerPathEl = document.getElementById("viewerPath");
const viewerStatusEl = document.getElementById("viewerStatus");
const saveFileBtn = document.getElementById("saveFileBtn");
const messagesEl = document.getElementById("messages");
const approvalPanel = document.getElementById("approvalPanel");
const approvalSummary = document.getElementById("approvalSummary");
const approveToolsBtn = document.getElementById("approveToolsBtn");
const denyToolsBtn = document.getElementById("denyToolsBtn");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const providerSelect = document.getElementById("providerSelect");
const apiKeysDialog = document.getElementById("apiKeysDialog");
const openaiKeyInput = document.getElementById("openaiKeyInput");
const anthropicKeyInput = document.getElementById("anthropicKeyInput");
const deepseekKeyInput = document.getElementById("deepseekKeyInput");
const clearOpenaiKeyBtn = document.getElementById("clearOpenaiKeyBtn");
const clearAnthropicKeyBtn = document.getElementById("clearAnthropicKeyBtn");
const clearDeepseekKeyBtn = document.getElementById("clearDeepseekKeyBtn");
const saveKeysBtn = document.getElementById("saveKeysBtn");
const closeKeysBtn = document.getElementById("closeKeysBtn");
const keysStatusLabel = document.getElementById("keysStatusLabel");

const STORAGE_PROVIDER_KEY = "assistant.selectedProvider";
let messages = [];
let activeFilePath = null;
let activeFileTruncated = false;
let pendingApprovals = [];
let latestTree = null;
const expandedDirectoryPaths = new Set();
let removeApiKeysListener = null;

function renderKeyStatus(status) {
  const tags = [];
  if (status.openaiConfigured) tags.push("OpenAI");
  if (status.anthropicConfigured) tags.push("Anthropic");
  if (status.deepseekConfigured) tags.push("DeepSeek");
  const backend = status.storageBackend === "keychain" ? "Keychain" : "File";
  keysStatusLabel.textContent =
    tags.length > 0
      ? `Configured (${backend}): ${tags.join(", ")}`
      : `No keys configured (${backend})`;
}

function compactToolResult(toolContent) {
  if (typeof toolContent !== "string") {
    return "[tool result]";
  }
  try {
    const parsed = JSON.parse(toolContent);
    if (parsed && typeof parsed === "object") {
      const cmd = typeof parsed.cmd === "string" ? parsed.cmd : "tool";
      const status = parsed.ok ? "ok" : "error";
      const summary = typeof parsed.summary === "string" ? parsed.summary : "";
      return `${cmd} (${status})${summary ? ` - ${summary}` : ""}`;
    }
  } catch (error) {
    // fall through
  }
  return toolContent.length > 180 ? `${toolContent.slice(0, 180)}...` : toolContent;
}

function renderMessages() {
  messagesEl.innerHTML = "";
  for (const msg of messages) {
    const row = document.createElement("div");
    const isToolCallAnnouncement =
      msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
    const roleClass =
      msg.role === "user"
        ? "user"
        : msg.role === "tool" || isToolCallAnnouncement
          ? "tool"
          : "assistant";
    row.className = `msg ${roleClass}`;
    let text = msg.content;
    if (msg.role === "tool") {
      text = compactToolResult(msg.content);
    } else if (!text && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
      text = `[requested tools: ${msg.tool_calls.map((call) => call.name).join(", ")}]`;
    } else if (!text) {
      text = "[empty]";
    }
    row.textContent = `${msg.role}: ${text}`;
    messagesEl.appendChild(row);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function setViewerStatus(text) {
  viewerStatusEl.textContent = text;
}

function setActiveFile(result) {
  activeFilePath = result.path;
  activeFileTruncated = Boolean(result.truncated);
  viewerPathEl.textContent = result.path;
  fileViewerEl.value = result.content;
  saveFileBtn.disabled = false;
  if (result.truncated) {
    setViewerStatus("Loaded with truncation; saving will overwrite with visible content only.");
  } else {
    setViewerStatus("Loaded.");
  }
}

function compareNodes(a, b) {
  if (a.type !== b.type) {
    return a.type === "dir" ? -1 : 1;
  }
  return a.name.localeCompare(b.name);
}

function renderTreeFromState() {
  if (!latestTree) {
    fileTreeEl.innerHTML = "";
    return;
  }
  fileTreeEl.innerHTML = "";
  fileTreeEl.appendChild(createTreeNode(latestTree));
}

function createTreeNode(node) {
  if (node.type === "file") {
    const btn = document.createElement("button");
    btn.textContent = node.name;
    btn.addEventListener("click", async () => {
      try {
        const result = await window.assistantApi.readFile(node.path);
        setActiveFile(result);
      } catch (error) {
        setViewerStatus(`Open file error: ${error.message}`);
      }
    });
    return btn;
  }

  const wrapper = document.createElement("div");
  wrapper.className = "tree-dir";
  const dirPath = typeof node.path === "string" ? node.path : node.name;
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "tree-toggle";
  const expanded = expandedDirectoryPaths.has(dirPath);
  toggle.textContent = `${expanded ? "▾" : "▸"} ${node.name}`;
  toggle.addEventListener("click", () => {
    if (expandedDirectoryPaths.has(dirPath)) {
      expandedDirectoryPaths.delete(dirPath);
    } else {
      expandedDirectoryPaths.add(dirPath);
    }
    renderTreeFromState();
  });
  wrapper.appendChild(toggle);

  if (Array.isArray(node.children) && node.children.length > 0) {
    const sortedChildren = [...node.children].sort(compareNodes);
    const list = document.createElement("ul");
    list.style.display = expanded ? "block" : "none";
    for (const child of sortedChildren) {
      const item = document.createElement("li");
      item.appendChild(createTreeNode(child));
      list.appendChild(item);
    }
    wrapper.appendChild(list);
  }
  return wrapper;
}

async function refreshTree() {
  try {
    const tree = await window.assistantApi.listWorkspace(4);
    latestTree = tree;
    if (tree && typeof tree.path === "string") {
      expandedDirectoryPaths.add(tree.path);
    }
    renderTreeFromState();
    return true;
  } catch (error) {
    setViewerStatus(`Tree refresh error: ${error.message}`);
    return false;
  }
}

async function refreshApiKeyStatus() {
  const status = await window.assistantApi.getApiKeyStatus();
  renderKeyStatus(status);
  const savedProvider = localStorage.getItem(STORAGE_PROVIDER_KEY);
  const configuredProviders = [];
  if (status.openaiConfigured) configuredProviders.push("openai");
  if (status.anthropicConfigured) configuredProviders.push("anthropic");
  if (status.deepseekConfigured) configuredProviders.push("deepseek");
  if (savedProvider && configuredProviders.includes(savedProvider)) {
    providerSelect.value = savedProvider;
    return;
  }
  if (configuredProviders.length === 1) {
    providerSelect.value = configuredProviders[0];
    localStorage.setItem(STORAGE_PROVIDER_KEY, providerSelect.value);
  }
}

chooseWorkspaceBtn.addEventListener("click", async () => {
  try {
    const chosen = await window.assistantApi.chooseWorkspace();
    if (!chosen) {
      return;
    }
    workspaceLabel.textContent = chosen;
    await refreshTree();
  } catch (error) {
    setViewerStatus(`Workspace selection failed: ${error.message}`);
  }
});

saveKeysBtn.addEventListener("click", async () => {
  try {
    const status = await window.assistantApi.saveApiKeys({
      openai: openaiKeyInput.value,
      anthropic: anthropicKeyInput.value,
      deepseek: deepseekKeyInput.value,
    });
    openaiKeyInput.value = "";
    anthropicKeyInput.value = "";
    deepseekKeyInput.value = "";
    renderKeyStatus(status);
  } catch (error) {
    keysStatusLabel.textContent = `Error: ${error.message}`;
  }
});

async function clearProviderKey(provider) {
  try {
    const status = await window.assistantApi.clearApiKey(provider);
    renderKeyStatus(status);
  } catch (error) {
    keysStatusLabel.textContent = `Error: ${error.message}`;
  }
}

clearOpenaiKeyBtn.addEventListener("click", () => clearProviderKey("openai"));
clearAnthropicKeyBtn.addEventListener("click", () => clearProviderKey("anthropic"));
clearDeepseekKeyBtn.addEventListener("click", () => clearProviderKey("deepseek"));
closeKeysBtn.addEventListener("click", () => apiKeysDialog.close());

removeApiKeysListener = window.assistantApi.onOpenApiKeys(() => {
  if (!apiKeysDialog.open) {
    apiKeysDialog.showModal();
  }
});
window.addEventListener("beforeunload", () => {
  if (typeof removeApiKeysListener === "function") {
    removeApiKeysListener();
  }
});

providerSelect.addEventListener("change", () => {
  localStorage.setItem(STORAGE_PROVIDER_KEY, providerSelect.value);
});

chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    chatForm.requestSubmit();
  }
});

function clearApprovalPanel() {
  pendingApprovals = [];
  approvalPanel.hidden = true;
  approvalSummary.textContent = "";
}

function showApprovalPanel(toolCalls) {
  pendingApprovals = Array.isArray(toolCalls) ? toolCalls : [];
  const lines = pendingApprovals.map((call) => {
    const name = typeof call.name === "string" ? call.name : "unknown_tool";
    const input =
      call && typeof call.input === "object"
        ? JSON.stringify(call.input)
        : "{}";
    const compactInput = input.length > 240 ? `${input.slice(0, 240)}...` : input;
    return `- ${name}: ${compactInput}`;
  });
  approvalSummary.textContent =
    lines.length > 0
      ? `Approval required for write tools:\n${lines.join("\n")}`
      : "";
  approvalPanel.hidden = pendingApprovals.length === 0;
}

chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearApprovalPanel();
  const value = chatInput.value.trim();
  if (!value) {
    return;
  }
  const historyBeforeTurn = [...messages];
  messages.push({ role: "user", content: value });
  renderMessages();
  chatInput.value = "";

  try {
    const response = await window.assistantApi.sendChat({
      provider: providerSelect.value,
      messages: historyBeforeTurn,
      userMessage: value,
      allowWriteTools: false,
      resumePendingToolCalls: false,
    });
    if (Array.isArray(response.messages) && response.messages.length > 0) {
      messages = historyBeforeTurn.concat(response.messages);
    } else if (response.message) {
      messages = historyBeforeTurn.concat([{ role: "user", content: value }, response.message]);
    } else {
      messages.push({ role: "assistant", content: "Error: Empty bridge response" });
    }
    if (Array.isArray(response.pendingApprovals) && response.pendingApprovals.length > 0) {
      showApprovalPanel(response.pendingApprovals);
    }
    await refreshTree();
    if (activeFilePath && !activeFileTruncated) {
      try {
        const refreshed = await window.assistantApi.readFile(activeFilePath);
        setActiveFile(refreshed);
      } catch (error) {
        setViewerStatus(`Refresh error: ${error.message}`);
      }
    }
  } catch (error) {
    messages = historyBeforeTurn.concat(
      { role: "user", content: value },
      { role: "assistant", content: `Error: ${error.message}` }
    );
  }
  renderMessages();
});

approveToolsBtn.addEventListener("click", async () => {
  if (!pendingApprovals.length) {
    return;
  }
  try {
    const response = await window.assistantApi.sendChat({
      provider: providerSelect.value,
      messages,
      userMessage: "",
      allowWriteTools: true,
      resumePendingToolCalls: true,
    });
    if (Array.isArray(response.messages) && response.messages.length > 0) {
      messages = messages.concat(response.messages);
      renderMessages();
    }
    clearApprovalPanel();
    await refreshTree();
    if (activeFilePath && !activeFileTruncated) {
      try {
        const refreshed = await window.assistantApi.readFile(activeFilePath);
        setActiveFile(refreshed);
      } catch (error) {
        setViewerStatus(`Refresh error: ${error.message}`);
      }
    }
  } catch (error) {
    messages.push({ role: "assistant", content: `Error: ${error.message}` });
    renderMessages();
    clearApprovalPanel();
  }
});

denyToolsBtn.addEventListener("click", () => {
  if (pendingApprovals.length > 0) {
    messages.push({
      role: "assistant",
      content: "Write operation request denied.",
    });
    renderMessages();
  }
  clearApprovalPanel();
});

saveFileBtn.addEventListener("click", async () => {
  if (!activeFilePath) {
    setViewerStatus("No file selected.");
    return;
  }
  try {
    await window.assistantApi.saveFile(activeFilePath, fileViewerEl.value);
    activeFileTruncated = false;
    setViewerStatus("Saved.");
    await refreshTree();
  } catch (error) {
    setViewerStatus(`Save error: ${error.message}`);
  }
});

refreshApiKeyStatus().catch((error) => {
  keysStatusLabel.textContent = `Error: ${error.message}`;
});

const persistedProvider = localStorage.getItem(STORAGE_PROVIDER_KEY);
if (persistedProvider) {
  providerSelect.value = persistedProvider;
}
