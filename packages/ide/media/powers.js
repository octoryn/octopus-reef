const vscode = acquireVsCodeApi();
const installedEl = document.getElementById("installed");
const availableEl = document.getElementById("available");
const statusEl = document.getElementById("status");
const refresh = document.getElementById("refresh");
const custom = document.getElementById("custom");

function setStatus(message, tone = "") {
  statusEl.className = `status ${tone}`;
  statusEl.textContent = message;
}

function tools(power) {
  const allowed = new Set(power.allowedTools || []);
  return (power.tools || [])
    .map((tool) => {
      const cls = allowed.has(tool.name) ? "tool allow" : "tool";
      return `<span class="${cls}">${tool.name}</span>`;
    })
    .join("");
}

function item(power, action) {
  const transport =
    power.transport && typeof power.transport === "object"
      ? power.transport.type === "stdio"
        ? `stdio · ${power.transport.command}`
        : `http · ${power.transport.url}`
      : power.transport;
  return (
    `<div class="item">` +
    `<div class="top"><div><div class="name">${escapeHtml(power.name)}</div><div class="meta">${escapeHtml(transport || "")}</div></div>${action || ""}</div>` +
    `<div class="meta">${escapeHtml(power.description || "")}</div>` +
    `<div class="tools">${tools(power)}</div>` +
    `</div>`
  );
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (ch) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[ch],
  );
}

function parseJsonField(id, fallback) {
  const value = document.getElementById(id).value.trim();
  if (!value) return fallback;
  return JSON.parse(value);
}

function render(data) {
  installedEl.innerHTML =
    data.installed.length === 0
      ? '<div class="meta">No powers installed.</div>'
      : data.installed.map((power) => item(power, "")).join("");
  availableEl.innerHTML =
    data.available.length === 0
      ? '<div class="meta">All available powers are installed.</div>'
      : data.available
          .map((power) =>
            item(
              power,
              `<button type="button" data-install="${escapeHtml(power.id)}">Add</button>`,
            ),
          )
          .join("");
  for (const button of availableEl.querySelectorAll("[data-install]")) {
    button.addEventListener("click", () => {
      setStatus(`Adding ${button.dataset.install}...`, "warn");
      vscode.postMessage({ kind: "installPower", id: button.dataset.install });
    });
  }
  setStatus(data.host.reason, "ok");
}

refresh.addEventListener("click", () => {
  setStatus("Refreshing powers...", "warn");
  vscode.postMessage({ kind: "listPowers" });
});

custom.addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    const name = document.getElementById("custom-name").value.trim();
    const command = document.getElementById("custom-command").value.trim();
    const url = document.getElementById("custom-url").value.trim();
    const body = {
      ...(name ? { name } : {}),
      ...(command ? { command, args: parseJsonField("custom-args", []) } : {}),
      ...(url ? { url } : {}),
      tools: parseJsonField("custom-tools", []),
    };
    setStatus("Adding custom power...", "warn");
    vscode.postMessage({ kind: "addCustomPower", input: body });
  } catch (error) {
    setStatus(
      `Invalid custom power JSON: ${error.message || String(error)}`,
      "bad",
    );
  }
});

document.getElementById("run-allowed").addEventListener("click", () => {
  setStatus("Starting governed MCP tool-call session...", "warn");
  vscode.postMessage({ kind: "runMcpDemo", mode: "allowed" });
});

document.getElementById("run-denied").addEventListener("click", () => {
  setStatus("Starting governed MCP denial session...", "warn");
  vscode.postMessage({ kind: "runMcpDemo", mode: "denied" });
});

window.addEventListener("message", (message) => {
  const data = message.data;
  if (data.kind === "powers") {
    render(data.powers);
  } else if (data.kind === "status") {
    setStatus(data.message, data.tone || "");
  }
});

vscode.postMessage({ kind: "listPowers" });
