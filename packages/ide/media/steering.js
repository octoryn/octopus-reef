const vscode = acquireVsCodeApi();
const availableEl = document.getElementById("available");
const activeEl = document.getElementById("active");
const statusEl = document.getElementById("status");
const refreshBtn = document.getElementById("refresh");
const applyBtn = document.getElementById("apply");
const runBtn = document.getElementById("run");
const customForm = document.getElementById("custom");

let activeIds = new Set();
let items = [];

function setStatus(message, tone = "") {
  statusEl.className = `status ${tone}`;
  statusEl.textContent = message;
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

function shortHash(value) {
  return String(value || "").slice(0, 12);
}

function render(data) {
  items = data.available || [];
  activeIds = new Set(data.activeIds || []);
  availableEl.innerHTML =
    items.length === 0
      ? '<div class="meta">No steering docs or skills.</div>'
      : items
          .map((item) => {
            const checked = activeIds.has(item.id) ? " checked" : "";
            return (
              `<label class="check item">` +
              `<input type="checkbox" data-id="${escapeHtml(item.id)}"${checked} />` +
              `<span><span class="top"><span><span class="name">${escapeHtml(item.title)}</span><span class="meta"> ${escapeHtml(item.kind)} · ${escapeHtml(item.source)}</span></span><span class="pill">${escapeHtml(item.id)}</span></span>` +
              `<span class="meta">${escapeHtml(item.content)}</span>` +
              `<span class="meta hash">${escapeHtml(shortHash(item.contentSha256))}</span>` +
              `</span></label>`
            );
          })
          .join("");
  activeEl.innerHTML =
    (data.active || []).length === 0
      ? '<div class="meta">No active steering set.</div>'
      : data.active
          .map(
            (item) =>
              `<div class="item"><div class="top"><div><div class="name">${escapeHtml(item.title)}</div><div class="meta">${escapeHtml(item.kind)} · ${escapeHtml(item.source)}</div></div><span class="pill ok">${escapeHtml(shortHash(item.contentSha256))}</span></div><div class="meta">${escapeHtml(item.mockEffect || item.content)}</div></div>`,
          )
          .join("");
  setStatus(`${activeIds.size} active steering item${activeIds.size === 1 ? "" : "s"}.`, "ok");
}

function selectedIds() {
  return [...availableEl.querySelectorAll("input[type='checkbox']")]
    .filter((input) => input.checked)
    .map((input) => input.dataset.id)
    .filter(Boolean);
}

refreshBtn.addEventListener("click", () => {
  setStatus("Refreshing steering...", "warn");
  vscode.postMessage({ kind: "listSteering" });
});

applyBtn.addEventListener("click", () => {
  setStatus("Applying steering set...", "warn");
  vscode.postMessage({ kind: "setActiveSteering", activeIds: selectedIds() });
});

runBtn.addEventListener("click", () => {
  setStatus("Starting steered mock session...", "warn");
  vscode.postMessage({ kind: "runSteeringDemo" });
});

customForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const title = document.getElementById("custom-title").value.trim();
  const kind = document.getElementById("custom-kind").value;
  const content = document.getElementById("custom-content").value.trim();
  const mockEffect = document.getElementById("custom-effect").value.trim();
  setStatus("Adding custom steering...", "warn");
  vscode.postMessage({
    kind: "addCustomSteering",
    input: {
      ...(title ? { title } : {}),
      kind,
      content,
      ...(mockEffect ? { mockEffect } : {}),
    },
  });
});

window.addEventListener("message", (message) => {
  const data = message.data;
  if (data.kind === "steering") {
    render(data.steering);
  } else if (data.kind === "status") {
    setStatus(data.message, data.tone || "");
  }
});

vscode.postMessage({ kind: "listSteering" });
