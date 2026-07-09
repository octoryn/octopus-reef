const vscode = acquireVsCodeApi();
const specsEl = document.getElementById("specs");
const detailEl = document.getElementById("detail");
const statusEl = document.getElementById("status");
const refreshBtn = document.getElementById("refresh");
const verifyBtn = document.getElementById("verify");
const createForm = document.getElementById("create");

const LEGAL = {
  proposed: ["ready", "cancelled"],
  ready: ["claimed", "blocked", "cancelled"],
  claimed: ["in_progress", "ready", "cancelled"],
  in_progress: ["done", "failed", "blocked", "cancelled"],
  blocked: ["ready", "cancelled"],
  failed: ["ready", "cancelled"],
  done: [],
  cancelled: [],
};
const STATES = Object.keys(LEGAL);
let selectedId = "";
let selectedSpec = null;

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

function short(id) {
  return String(id || "").slice(0, 12);
}

function renderSpecs(specs) {
  specsEl.innerHTML =
    specs.length === 0
      ? '<div class="meta">No specs yet.</div>'
      : specs
          .map((spec) => {
            const counts = Object.entries(spec.states || {})
              .filter(([, count]) => count > 0)
              .map(([state, count]) => `${escapeHtml(state)}:${count}`)
              .join(" ");
            const active = spec.id === selectedId ? " active" : "";
            const ok = spec.verify && spec.verify.ok;
            return (
              `<button class="spec${active}" type="button" data-select="${escapeHtml(spec.id)}">` +
              `<div class="name">${escapeHtml(spec.title)}</div>` +
              `<div class="meta">${escapeHtml(counts || "empty")}</div>` +
              `<div class="summary"><span class="pill ${ok ? "ok" : "bad"}">${ok ? "verified" : "unverified"}</span><span class="pill">${spec.anchor.length} links</span></div>` +
              `</button>`
            );
          })
          .join("");
}

function legalButtons(task) {
  const moves = LEGAL[task.state] || [];
  if (moves.length === 0) return '<span class="meta">terminal</span>';
  return moves
    .map(
      (to) =>
        `<button class="secondary" type="button" data-advance="${escapeHtml(task.id)}" data-to="${escapeHtml(to)}">${escapeHtml(to)}</button>`,
    )
    .join("");
}

function illegalTarget(state) {
  return STATES.find(
    (candidate) => candidate !== state && !(LEGAL[state] || []).includes(candidate),
  );
}

function renderSpec(spec) {
  selectedSpec = spec;
  selectedId = spec ? spec.id : "";
  if (!spec) {
    detailEl.innerHTML = '<div class="meta">Create or select a spec.</div>';
    return;
  }
  const verifyClass = spec.verify && spec.verify.ok ? "ok" : "bad";
  const tasks = spec.tasks
    .map((task) => {
      const history = task.history
        .map(
          (transition) =>
            `<div class="transition"><span>#${transition.sequence}</span><b>${escapeHtml(transition.from === null ? "null" : transition.from)} -&gt; ${escapeHtml(transition.to)}</b><span class="evidence">${escapeHtml(short(transition.evidenceId))}</span></div>`,
        )
        .join("");
      const illegal = illegalTarget(task.state);
      return (
        `<div class="task">` +
        `<div class="task-head"><div><div class="name">${escapeHtml(task.title)}</div><div class="meta">${escapeHtml(task.id)}</div></div><div class="state">${escapeHtml(task.state)}</div></div>` +
        `<div class="actions">${legalButtons(task)}${illegal ? `<button class="danger" type="button" data-illegal="${escapeHtml(task.id)}" data-to="${escapeHtml(illegal)}">Try Illegal</button>` : ""}</div>` +
        `<div class="history">${history}</div>` +
        `</div>`
      );
    })
    .join("");
  detailEl.innerHTML =
    `<div class="summary"><span class="pill ${verifyClass}">${spec.verify.ok ? "verified" : "unverified"}</span><span class="pill">${spec.anchor.length} workstate links</span><span class="pill">${escapeHtml(short(spec.anchor.head))}</span></div>` +
    `<h2>${escapeHtml(spec.title)}</h2>` +
    `<div class="list">${tasks}</div>`;
}

specsEl.addEventListener("click", (event) => {
  const button = event.target.closest("[data-select]");
  if (!button) return;
  selectedId = button.dataset.select;
  setStatus("Loading spec...", "warn");
  vscode.postMessage({ kind: "selectSpec", id: selectedId });
});

detailEl.addEventListener("click", (event) => {
  const advance = event.target.closest("[data-advance]");
  if (advance && selectedId) {
    setStatus("Starting governed spec transition...", "warn");
    vscode.postMessage({
      kind: "advanceSpec",
      specId: selectedId,
      itemId: advance.dataset.advance,
      to: advance.dataset.to,
    });
    return;
  }
  const illegal = event.target.closest("[data-illegal]");
  if (illegal && selectedId) {
    setStatus("Trying illegal transition...", "warn");
    vscode.postMessage({
      kind: "illegalSpecTransition",
      specId: selectedId,
      itemId: illegal.dataset.illegal,
      to: illegal.dataset.to,
    });
  }
});

refreshBtn.addEventListener("click", () => {
  setStatus("Refreshing specs...", "warn");
  vscode.postMessage({ kind: "listSpecs" });
});

verifyBtn.addEventListener("click", () => {
  if (!selectedId) return;
  setStatus("Verifying spec provenance...", "warn");
  vscode.postMessage({ kind: "verifySpec", specId: selectedId });
});

createForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const title = document.getElementById("title").value.trim();
  const tasks = document
    .getElementById("tasks")
    .value.split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  setStatus("Creating spec...", "warn");
  vscode.postMessage({ kind: "createSpec", title, tasks });
});

window.addEventListener("message", (message) => {
  const data = message.data;
  if (data.kind === "specs") {
    renderSpecs(data.specs.specs || []);
  } else if (data.kind === "spec") {
    renderSpec(data.spec);
  } else if (data.kind === "verified") {
    if (selectedSpec) {
      selectedSpec = { ...selectedSpec, verify: data.verify };
      renderSpec(selectedSpec);
    }
    setStatus(data.verify.ok ? "Spec provenance verified." : data.verify.work, data.verify.ok ? "ok" : "bad");
  } else if (data.kind === "status") {
    setStatus(data.message, data.tone || "");
  }
});

vscode.postMessage({ kind: "listSpecs" });
