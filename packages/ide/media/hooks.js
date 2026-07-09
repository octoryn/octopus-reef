const vscode = acquireVsCodeApi();
const hooksEl = document.getElementById("hooks");
const statusEl = document.getElementById("status");
const refreshBtn = document.getElementById("refresh");
const createForm = document.getElementById("create");

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

function render(data) {
  const hooks = data.hooks || [];
  hooksEl.innerHTML =
    hooks.length === 0
      ? '<div class="meta">No hooks defined.</div>'
      : hooks
          .map(
            (hook) =>
              `<div class="hook">` +
              `<div class="top"><div><div class="name">${escapeHtml(hook.name)}</div><div class="meta">${escapeHtml(hook.id)}</div></div><span class="pill ok">${escapeHtml(hook.trigger)}</span></div>` +
              `<div class="meta">${escapeHtml(hook.task)}</div>` +
              `<div class="actions"><button type="button" data-fire="${escapeHtml(hook.id)}">Fire Hook</button></div>` +
              `</div>`,
          )
          .join("");
  for (const button of hooksEl.querySelectorAll("[data-fire]")) {
    button.addEventListener("click", () => {
      setStatus("Firing hook...", "warn");
      vscode.postMessage({
        kind: "fireHook",
        id: button.dataset.fire,
        input: {
          event: {
            source: "reef-hooks-panel",
            firedAt: new Date().toISOString(),
          },
        },
      });
    });
  }
  setStatus(`${hooks.length} hook${hooks.length === 1 ? "" : "s"}.`, "ok");
}

refreshBtn.addEventListener("click", () => {
  setStatus("Refreshing hooks...", "warn");
  vscode.postMessage({ kind: "listHooks" });
});

createForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = document.getElementById("hook-name").value.trim();
  const trigger = document.getElementById("hook-trigger").value;
  const task = document.getElementById("hook-task").value.trim();
  setStatus("Creating hook...", "warn");
  vscode.postMessage({
    kind: "createHook",
    input: {
      ...(name ? { name } : {}),
      trigger,
      ...(task ? { task } : {}),
    },
  });
});

window.addEventListener("message", (message) => {
  const data = message.data;
  if (data.kind === "hooks") {
    render(data.hooks);
  } else if (data.kind === "status") {
    setStatus(data.message, data.tone || "");
  }
});

vscode.postMessage({ kind: "listHooks" });
