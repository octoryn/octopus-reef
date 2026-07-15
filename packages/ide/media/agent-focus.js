const vscode = acquireVsCodeApi();

const taskListEl = document.getElementById("task-list");
const promptEl = document.getElementById("task-prompt");
const runBtn = document.getElementById("run-task");
const newBtn = document.getElementById("new-task");
const focusBtn = document.getElementById("focus-window");
const ideBtn = document.getElementById("ide-window");
const verifyBtn = document.getElementById("verify-run");
const statusEl = document.getElementById("status");
const planEl = document.getElementById("plan");
const actionsEl = document.getElementById("actions");
const diffEl = document.getElementById("diff");
const timelineEl = document.getElementById("timeline");
const badgeEl = document.getElementById("verify-badge");
const usageEl = document.getElementById("usage");
const windowModeEl = document.getElementById("window-mode");

let currentTask = "";
let currentSessionId = "";
let sessions = [];
let busy = false;

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

function setStatus(message, tone = "") {
  statusEl.className = `status ${tone}`;
  statusEl.textContent = message;
}

function setBusy(value) {
  busy = value;
  promptEl.disabled = value;
  runBtn.disabled = value;
  verifyBtn.disabled = value && currentSessionId === "";
}

function short(value) {
  return String(value || "").slice(0, 12);
}

function renderSessions() {
  taskListEl.innerHTML =
    sessions.length === 0
      ? '<div class="empty">No focus tasks yet.</div>'
      : sessions
          .map((session) => {
            const active = session.id === currentSessionId ? " active" : "";
            const tone =
              session.verifyOk === true
                ? " ok"
                : session.verifyOk === false
                  ? " bad"
                  : "";
            return (
              `<button class="task${active}" type="button" data-id="${escapeHtml(session.id)}">` +
              `<span class="task-title">${escapeHtml(session.task)}</span>` +
              `<span class="task-meta">${escapeHtml(short(session.id))}</span>` +
              `<span class="task-pill${tone}">${escapeHtml(session.status || "running")}</span>` +
              `</button>`
            );
          })
          .join("");
}

function renderBadge(tone, label) {
  badgeEl.className = `badge ${tone || "pending"}`;
  badgeEl.innerHTML =
    tone === "ok"
      ? `&#10003; ${escapeHtml(label)}`
      : tone === "bad"
        ? `&#10007; ${escapeHtml(label)}`
        : escapeHtml(label || "PENDING");
}

function resetRun(task) {
  currentTask = task;
  planEl.innerHTML = '<li>Waiting for governed plan.</li>';
  actionsEl.innerHTML = '<li>Waiting for actions.</li>';
  diffEl.textContent = "";
  timelineEl.innerHTML = "";
  renderBadge("pending", "PENDING");
  setBusy(true);
  setStatus("Running governed session...", "warn");
}

function addEvidence(event) {
  const row = document.createElement("div");
  row.className = `evidence ${event.tone || ""}`;
  row.innerHTML =
    `<span>${String(event.seq).padStart(2, "0")}</span>` +
    `<span>${escapeHtml(event.label)}</span>` +
    `<span>${escapeHtml(event.summary)}</span>` +
    `<span>${escapeHtml(short(event.evidenceId))}</span>`;
  timelineEl.appendChild(row);
}

function renderRunView(view) {
  currentTask = view.task || currentTask;
  planEl.innerHTML = (view.plan || [])
    .map((line) => `<li>${escapeHtml(line)}</li>`)
    .join("");
  actionsEl.innerHTML =
    (view.actions || []).length === 0
      ? '<li>Waiting for actions.</li>'
      : view.actions
          .map((action) => {
            const detail = action.command || action.target || "";
            return `<li class="${escapeHtml(action.tone)}"><b>${escapeHtml(action.type)}</b> ${escapeHtml(action.summary)}${detail ? ` <span>${escapeHtml(detail)}</span>` : ""}</li>`;
          })
          .join("");
  diffEl.textContent = view.diff || "";
  renderBadge(view.verifyTone, view.verifyLabel);
  if (view.usage) renderUsage(view.usage);
}

function renderUsage(usage) {
  usageEl.innerHTML =
    `<div><b>${Number(usage.totalTokens || 0).toLocaleString()}</b><span>tokens</span></div>` +
    `<div><b>${escapeHtml(usage.cost || "not available")}</b><span>cost</span></div>` +
    `<div class="wide"><b>${Number(usage.calls || 0).toLocaleString()}</b><span>${escapeHtml(usage.summary || "")}</span></div>` +
    `<div class="wide"><b>remaining</b><span>${escapeHtml(usage.remaining || "not available")}</span></div>`;
}

function renderWindowMode(mode) {
  windowModeEl.textContent =
    mode === "focus" ? "Focus window" : "IDE window";
}

function runTask() {
  if (busy) return;
  const task = promptEl.value.trim();
  if (!task) return;
  vscode.postMessage({ kind: "runFocusTask", task });
}

runBtn.addEventListener("click", runTask);
promptEl.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    runTask();
  }
});
newBtn.addEventListener("click", () => {
  promptEl.value = "";
  promptEl.focus();
  setStatus("Ready for a new focus task.");
});
focusBtn.addEventListener("click", () => {
  vscode.postMessage({ kind: "focusToWindow" });
});
ideBtn.addEventListener("click", () => {
  vscode.postMessage({ kind: "focusToIde" });
});
verifyBtn.addEventListener("click", () => {
  vscode.postMessage({ kind: "verifyFocus" });
});

window.addEventListener("message", (message) => {
  const data = message.data;
  if (data.kind === "focusState") {
    sessions = data.sessions || [];
    currentSessionId = data.currentSessionId || currentSessionId;
    renderSessions();
    renderWindowMode(data.windowMode || "ide");
    if (data.view) renderRunView(data.view);
  } else if (data.kind === "focusReset") {
    currentSessionId = "";
    resetRun(data.task || "");
  } else if (data.kind === "focusStarted") {
    currentSessionId = data.sessionId || "";
    sessions = data.sessions || sessions;
    renderSessions();
    setStatus(`Session ${short(currentSessionId)} started.`, "warn");
  } else if (data.kind === "focusEvent") {
    addEvidence(data.event);
    if (data.view) renderRunView(data.view);
  } else if (data.kind === "focusSealed") {
    setBusy(false);
    sessions = data.sessions || sessions;
    renderSessions();
    if (data.view) renderRunView(data.view);
    setStatus("Governed session sealed.", data.view?.verifyTone === "ok" ? "ok" : "bad");
    vscode.postMessage({ kind: "refreshFocusUsage" });
  } else if (data.kind === "focusVerified") {
    setBusy(false);
    sessions = data.sessions || sessions;
    renderSessions();
    if (data.view) renderRunView(data.view);
    setStatus(
      data.view?.verifyTone === "ok"
        ? "Store-untrusting verification is green."
        : "Store-untrusting verification is red.",
      data.view?.verifyTone === "ok" ? "ok" : "bad",
    );
  } else if (data.kind === "focusUsage") {
    renderUsage(data.usage);
  } else if (data.kind === "focusWindow") {
    renderWindowMode(data.mode || "ide");
    setStatus(data.message || "Window updated.", data.tone || "ok");
  } else if (data.kind === "focusError") {
    setBusy(false);
    setStatus(data.message || "Agent Focus failed.", "bad");
    renderBadge("bad", data.message || "FAILED");
  }
});

vscode.postMessage({ kind: "agentFocusReady" });
