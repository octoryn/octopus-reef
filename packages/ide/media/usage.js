const vscode = acquireVsCodeApi();
const totalsEl = document.getElementById("totals");
const sessionsEl = document.getElementById("sessions");
const providersEl = document.getElementById("providers");
const remainingEl = document.getElementById("remaining");
const statusEl = document.getElementById("status");
const refreshBtn = document.getElementById("refresh");

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

function formatTokens(value) {
  return Number(value || 0).toLocaleString();
}

function formatCost(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? `$${value.toFixed(6)}`
    : "not available";
}

function short(id) {
  return String(id || "").slice(0, 12);
}

function tile(label, value) {
  return `<div class="tile"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div></div>`;
}

function renderTotals(totals) {
  totalsEl.innerHTML =
    tile("Calls", formatTokens(totals.calls)) +
    tile("Input", formatTokens(totals.inputTokens)) +
    tile("Output", formatTokens(totals.outputTokens)) +
    tile("Cost", formatCost(totals.costUsd));
}

function renderSessions(sessions) {
  sessionsEl.innerHTML =
    sessions.length === 0
      ? '<div class="meta">No persisted provider usage yet.</div>'
      : sessions
          .map((session) => {
            const latest = session.calls[session.calls.length - 1];
            const source = latest && latest.costSource ? latest.costSource : "";
            return (
              `<div class="row">` +
              `<div class="top"><div><div class="name">${escapeHtml(session.task)}</div><div class="meta">${escapeHtml(session.id)}</div></div><span class="pill">${formatTokens(session.totals.totalTokens)} tokens</span></div>` +
              `<div class="meta">${formatTokens(session.totals.calls)} calls · ${formatCost(session.totals.costUsd)}${source ? ` · ${escapeHtml(source)}` : ""}</div>` +
              `</div>`
            );
          })
          .join("");
}

function renderProviders(data) {
  const rows = [];
  for (const provider of data.byProvider || []) {
    rows.push(
      `<div class="row"><div class="top"><div class="name">${escapeHtml(provider.provider)}</div><span class="pill">${formatTokens(provider.totalTokens)} tokens</span></div><div class="meta">${formatTokens(provider.calls)} calls · ${formatCost(provider.costUsd)}</div></div>`,
    );
  }
  for (const model of data.byModel || []) {
    const cls =
      model.priceStatus === "priced"
        ? "ok"
        : model.priceStatus === "partial"
          ? "warn"
          : "bad";
    rows.push(
      `<div class="row"><div class="top"><div><div class="name">${escapeHtml(model.model)}</div><div class="meta">${escapeHtml(model.provider)}</div></div><span class="pill ${cls}">${escapeHtml(model.priceStatus)}</span></div><div class="meta">${formatTokens(model.totalTokens)} tokens · ${formatCost(model.costUsd)}${model.costSource ? ` · ${escapeHtml(model.costSource)}` : ""}</div></div>`,
    );
  }
  providersEl.innerHTML =
    rows.length === 0 ? '<div class="meta">No provider usage.</div>' : rows.join("");
}

function renderRemaining(remaining) {
  remainingEl.innerHTML =
    remaining.length === 0
      ? '<div class="meta">No provider remaining sources.</div>'
      : remaining
          .map((entry) => {
            const cls =
              entry.status === "available"
                ? "ok"
                : entry.status === "pending-key"
                  ? "warn"
                  : entry.status === "error"
                    ? "bad"
                    : "";
            const amount =
              typeof entry.amountUsd === "number"
                ? ` · remaining ${formatCost(entry.amountUsd)}`
                : "";
            const limit =
              typeof entry.limitUsd === "number"
                ? ` · limit ${formatCost(entry.limitUsd)}`
                : "";
            return (
              `<div class="row">` +
              `<div class="top"><div><div class="name">${escapeHtml(entry.provider)}</div><div class="meta">${escapeHtml(entry.source)}</div></div><span class="pill ${cls}">${escapeHtml(entry.status)}</span></div>` +
              `<div class="meta">${escapeHtml(entry.message)}${amount}${limit}</div>` +
              `</div>`
            );
          })
          .join("");
}

function render(data) {
  renderTotals(data.totals || {});
  renderSessions(data.sessions || []);
  renderProviders(data);
  renderRemaining(data.remaining || []);
  setStatus(`Usage refreshed ${data.generatedAt || ""}`, "ok");
}

refreshBtn.addEventListener("click", () => {
  setStatus("Refreshing usage...", "warn");
  vscode.postMessage({ kind: "getUsage" });
});

window.addEventListener("message", (message) => {
  const data = message.data;
  if (data.kind === "usage") {
    render(data.usage);
  } else if (data.kind === "status") {
    setStatus(data.message, data.tone || "");
  }
});

vscode.postMessage({ kind: "getUsage" });
