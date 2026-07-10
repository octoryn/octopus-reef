const vscode = acquireVsCodeApi();

const els = {
  form: document.getElementById("create"),
  tasks: document.getElementById("tasks"),
  sessions: document.getElementById("sessions"),
  ledger: document.getElementById("ledger"),
  status: document.getElementById("status"),
  refresh: document.getElementById("refresh"),
  verify: document.getElementById("verify"),
};

let activeFleetId = undefined;
let poll = undefined;

function setStatus(message, tone = "") {
  els.status.className = `status ${tone}`;
  els.status.textContent = message;
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
  return typeof value === "string" && value.length > 12
    ? `${value.slice(0, 12)}...`
    : value || "pending";
}

function badge(label, tone) {
  return `<span class="pill ${tone || ""}">${escapeHtml(label)}</span>`;
}

function renderLedger(ledger) {
  if (!ledger) {
    els.ledger.className = "ledger";
    els.ledger.innerHTML = '<div class="meta">Fleet ledger pending.</div>';
    return;
  }
  els.ledger.className = `ledger ${ledger.verified ? "ok" : "bad"}`;
  els.ledger.innerHTML =
    `<div class="top"><div class="name">Worker Ledger</div>${badge(
      ledger.verified ? "verified" : "red",
      ledger.verified ? "ok" : "bad",
    )}</div>` +
    `<div class="meta">${Number(ledger.links || 0).toLocaleString()} links · ${escapeHtml(
      ledger.source || "memory",
    )}</div>` +
    `<div class="hash">${escapeHtml(shortHash(ledger.head))}</div>`;
}

function renderFleet(fleet) {
  activeFleetId = fleet.id;
  renderLedger(fleet.ledger);
  const sessions = Array.isArray(fleet.sessions) ? fleet.sessions : [];
  els.sessions.innerHTML =
    sessions.length === 0
      ? '<div class="meta">No sessions.</div>'
      : sessions
          .map((session) => {
            const tone =
              session.verifyOk === true
                ? "ok"
                : session.verifyOk === false
                  ? "bad"
                  : "warn";
            const label =
              session.verifyOk === true
                ? "verified"
                : session.verifyOk === false
                  ? "red"
                  : session.status || "running";
            return (
              `<article class="card">` +
              `<div class="top"><div><div class="name">${escapeHtml(session.task)}</div><div class="meta">${escapeHtml(session.id)} · ${escapeHtml(session.status)}</div></div>${badge(label, tone)}</div>` +
              `<div class="meta">${Number(session.events || 0).toLocaleString()} evidence events · ${Number(session.workChainLength || 0).toLocaleString()} work links · ${Number(session.logChainLength || 0).toLocaleString()} log links</div>` +
              `<div class="hash">${escapeHtml(shortHash(session.logHead))}</div>` +
              `</article>`
            );
          })
          .join("");
  if (fleet.status === "sealed") {
    stopPolling();
    const ok = fleet.ledger?.verified && sessions.every((s) => s.verifyOk);
    setStatus(
      ok ? `Fleet ${fleet.id} verified.` : `Fleet ${fleet.id} needs attention.`,
      ok ? "ok" : "bad",
    );
  } else {
    setStatus(`Fleet ${fleet.id} running.`, "warn");
    startPolling();
  }
}

function startPolling() {
  if (poll !== undefined || activeFleetId === undefined) return;
  poll = setInterval(() => {
    vscode.postMessage({ kind: "getManagerFleet", id: activeFleetId });
  }, 750);
}

function stopPolling() {
  if (poll !== undefined) {
    clearInterval(poll);
    poll = undefined;
  }
}

function taskLines() {
  return els.tasks.value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const tasks = taskLines();
  if (tasks.length < 2) {
    setStatus("Add at least two tasks.", "bad");
    return;
  }
  stopPolling();
  setStatus("Spawning governed fleet...", "warn");
  vscode.postMessage({ kind: "createManagerFleet", tasks });
});

els.refresh.addEventListener("click", () => {
  if (activeFleetId === undefined) {
    setStatus("No fleet to refresh.", "warn");
    return;
  }
  vscode.postMessage({ kind: "getManagerFleet", id: activeFleetId });
});

els.verify.addEventListener("click", () => {
  if (activeFleetId === undefined) {
    setStatus("No fleet to verify.", "warn");
    return;
  }
  vscode.postMessage({ kind: "verifyManagerFleet", id: activeFleetId });
});

window.addEventListener("message", (message) => {
  const data = message.data;
  if (data.kind === "managerFleet") {
    renderFleet(data.fleet);
  } else if (data.kind === "managerVerify") {
    renderLedger(data.verify.ledger);
    const ok = data.verify.ok === true;
    setStatus(data.verify.reason, ok ? "ok" : "bad");
  } else if (data.kind === "status") {
    setStatus(data.message, data.tone || "");
  }
});

setStatus("Manager ready.", "ok");
