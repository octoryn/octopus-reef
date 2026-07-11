const vscode = acquireVsCodeApi();

const els = {
  edition: document.getElementById("edition"),
  identity: document.getElementById("identity"),
  identitySource: document.getElementById("identity-source"),
  entitlement: document.getElementById("entitlement"),
  user: document.getElementById("user"),
  license: document.getElementById("license"),
  usage: document.getElementById("usage"),
  usageSource: document.getElementById("usage-source"),
  quotaPill: document.getElementById("quota-pill"),
  plan: document.getElementById("plan"),
  quotaUsed: document.getElementById("quota-used"),
  quotaRemaining: document.getElementById("quota-remaining"),
  quotaSource: document.getElementById("quota-source"),
  teamSection: document.getElementById("team-section"),
  auditSection: document.getElementById("audit-section"),
  ssoPill: document.getElementById("sso-pill"),
  ssoIssuer: document.getElementById("sso-issuer"),
  team: document.getElementById("team"),
  teamMembers: document.getElementById("team-members"),
  teamSource: document.getElementById("team-source"),
  auditSource: document.getElementById("audit-source"),
  auditList: document.getElementById("audit-list"),
  prioritySection: document.getElementById("priority-section"),
  priorityPill: document.getElementById("priority-pill"),
  priorityTier: document.getElementById("priority-tier"),
  priorityRoute: document.getElementById("priority-route"),
  prioritySla: document.getElementById("priority-sla"),
  prioritySource: document.getElementById("priority-source"),
  status: document.getElementById("status"),
  signin: document.getElementById("signin"),
  signout: document.getElementById("signout"),
  copy: document.getElementById("copy"),
  upgrade: document.getElementById("upgrade"),
};

let current = undefined;
const honestEconomicsNote =
  "BYOK: no markup. Usage is provider/API-sourced, labeled by source, and never a fake credit meter.";

function setStatus(message, tone = "") {
  els.status.className = `status ${tone}`;
  els.status.textContent = message;
}

// Per-button feedback: disable the panel's action buttons and show a working
// label on the clicked one; restore on the next response so clicks feel alive.
function actionButtons() {
  return [
    document.getElementById("refresh"),
    document.getElementById("evidence"),
    els.signin,
    els.signout,
    els.copy,
  ].filter(Boolean);
}
function busy(btn, label) {
  for (const b of actionButtons()) b.disabled = true;
  if (btn) {
    if (btn.dataset.origLabel === undefined) btn.dataset.origLabel = btn.textContent;
    btn.textContent = label;
  }
}
function clearBusy() {
  for (const b of actionButtons()) {
    b.disabled = false;
    if (b.dataset.origLabel !== undefined) {
      b.textContent = b.dataset.origLabel;
      delete b.dataset.origLabel;
    }
  }
}

function text(el, value) {
  el.textContent = value;
}

function formatTokens(value) {
  return Number(value || 0).toLocaleString();
}

function formatCost(value) {
  return typeof value === "number" && Number.isFinite(value)
    ? `$${value.toFixed(6)}`
    : "not available";
}

function shortHash(value) {
  return typeof value === "string" && value.length > 12
    ? `${value.slice(0, 12)}…`
    : value || "not available";
}

function toneFor(status) {
  if (status === "available" || status === "licensed" || status === true) {
    return "ok";
  }
  if (status === "pending-key" || status === "missing-account") return "warn";
  if (status === "error" || status === false || status === "missing") {
    return "bad";
  }
  return "";
}

function setPill(el, label, tone = "") {
  el.className = `pill ${tone}`;
  el.textContent = label;
}

function tile(label, value) {
  return `<div class="tile"><div class="key">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div></div>`;
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

function renderUsage(usage) {
  const totals = usage?.totals || {};
  els.usage.innerHTML =
    tile("Calls", formatTokens(totals.calls)) +
    tile("Input", formatTokens(totals.inputTokens)) +
    tile("Output", formatTokens(totals.outputTokens)) +
    tile("Cost", formatCost(totals.costUsd));
  text(
    els.usageSource,
    `N6 session evidence aggregation · ${honestEconomicsNote} · generated ${usage?.generatedAt || "unknown"}`,
  );
}

function renderQuota(data) {
  const quota = data.plan?.quota || {};
  setPill(
    els.quotaPill,
    quota.status || "not-available",
    toneFor(quota.status),
  );
  text(els.plan, `${data.plan?.name || "unknown"}`);
  text(
    els.quotaUsed,
    typeof quota.usedTokens === "number"
      ? `${formatTokens(quota.usedTokens)} tokens`
      : "not available",
  );
  text(
    els.quotaRemaining,
    typeof quota.remainingTokens === "number"
      ? `${formatTokens(quota.remainingTokens)} of ${formatTokens(
          quota.limitTokens,
        )} tokens`
      : quota.message || "not available; no fake credit meter",
  );
  text(els.quotaSource, quota.source || "not available; provider source missing");
  els.upgrade.hidden =
    data.edition !== "commercial" || !data.plan?.upgradeAvailable;
}

function renderTeam(data) {
  const commercial = data.edition === "commercial";
  els.teamSection.hidden = !commercial;
  els.auditSection.hidden = !commercial;
  if (!commercial) return;
  const sso = data.sso || {};
  const team = data.team || {};
  setPill(
    els.ssoPill,
    sso.state || "gated",
    toneFor(sso.state === "signed-in" ? "licensed" : sso.state),
  );
  text(els.ssoIssuer, sso.issuer || sso.message || "not available");
  text(
    els.team,
    team.gated
      ? team.message || "gated"
      : `${team.name || "Team"} · ${team.role || "member"}`,
  );
  text(
    els.teamMembers,
    Array.isArray(team.members)
      ? team.members
          .map((member) => `${member.displayName} (${member.role})`)
          .join(", ")
      : "not available",
  );
  text(els.teamSource, team.source || "not available");
  renderAudit(data.audit || {});
}

function renderAudit(audit) {
  text(
    els.auditSource,
    `${audit.source || "not available"} · ${audit.message || ""}`,
  );
  const sessions = Array.isArray(audit.sessions) ? audit.sessions : [];
  if (audit.gated) {
    els.auditList.innerHTML = `<div class="value">${escapeHtml(audit.message || "Sign in to inspect team evidence.")}</div>`;
    return;
  }
  if (sessions.length === 0) {
    els.auditList.innerHTML =
      '<div class="value">No sealed team sessions yet.</div>';
    return;
  }
  els.auditList.innerHTML = sessions
    .map(
      (session) =>
        `<article class="audit-row"><div><b>${escapeHtml(session.task)}</b><div class="meta">${escapeHtml(session.id)} · ${escapeHtml(session.message)}</div></div><span class="pill ${session.status === "verified" ? "ok" : "bad"}">${session.status === "verified" ? "✓ verified" : "✗ broken"}</span></article>`,
    )
    .join("");
}

function renderPriority(data) {
  const commercial = data.edition === "commercial";
  els.prioritySection.hidden = !commercial;
  if (!commercial) return;
  const priority = data.priority || {};
  const selectedTier = priority.selectedTier === "priority" ? "priority" : "standard";
  const tiers = Array.isArray(priority.tiers) ? priority.tiers : [];
  const selected = tiers.find((tier) => tier.id === selectedTier);
  els.priorityTier.innerHTML = tiers
    .map(
      (tier) =>
        `<option value="${escapeHtml(tier.id)}">${escapeHtml(tier.label)} · ${escapeHtml(tier.queue)} queue</option>`,
    )
    .join("");
  if (tiers.length === 0) {
    els.priorityTier.innerHTML = `<option value="${selectedTier}">${escapeHtml(selectedTier)} · gated</option>`;
  }
  els.priorityTier.value = selectedTier;
  els.priorityTier.disabled = priority.gated || !priority.available;
  setPill(
    els.priorityPill,
    priority.available ? selectedTier : "gated",
    priority.available ? "ok" : "warn",
  );
  text(
    els.priorityRoute,
    selected
      ? `${selected.model} · ${selected.queue} queue`
      : priority.message || "not available",
  );
  text(els.prioritySla, priority.serviceLevel || "not available");
  text(els.prioritySource, priority.source || "not available");
}

function render(data) {
  current = data;
  setPill(
    els.edition,
    data.edition,
    data.edition === "commercial" ? "warn" : "ok",
  );
  text(els.identity, data.identity?.label || "not configured");
  text(els.identitySource, data.identity?.source || "not available");
  setPill(
    els.entitlement,
    data.entitlement?.state || "missing",
    toneFor(data.entitlement?.state),
  );

  if (data.account?.signedIn) {
    text(
      els.user,
      `${data.account.displayName || "Octopus user"} · ${data.account.userId}`,
    );
    text(els.license, shortHash(data.account.licenseSha256));
  } else if (data.edition === "community") {
    text(els.user, "Local BYOK identity");
    text(els.license, "not used in community");
  } else {
    text(els.user, "Not signed in");
    text(els.license, "not available");
  }

  els.signin.hidden = data.edition !== "commercial" || data.account?.signedIn;
  els.signout.hidden = data.edition !== "commercial" || !data.account?.signedIn;
  els.copy.hidden = data.edition !== "commercial" || !data.account?.signedIn;

  renderUsage(data.usage);
  renderQuota(data);
  renderTeam(data);
  renderPriority(data);
  setStatus(`Account refreshed ${data.generatedAt || ""}`, "ok");
}

document.getElementById("refresh").addEventListener("click", (e) => {
  busy(e.currentTarget, "Refreshing…");
  setStatus("Refreshing account…", "warn");
  vscode.postMessage({ kind: "getAccount" });
});

document.getElementById("evidence").addEventListener("click", (e) => {
  busy(e.currentTarget, "Recording…");
  setStatus("Recording account evidence…", "warn");
  vscode.postMessage({ kind: "recordAccountEvidence" });
});

els.signin.addEventListener("click", (e) => {
  busy(e.currentTarget, "Signing in…");
  setStatus("Signing in…", "warn");
  vscode.postMessage({ kind: "signInAccount" });
});

els.signout.addEventListener("click", (e) => {
  busy(e.currentTarget, "Signing out…");
  setStatus("Signing out…", "warn");
  vscode.postMessage({ kind: "signOutAccount" });
});

els.priorityTier.addEventListener("change", () => {
  const tier = els.priorityTier.value;
  if (tier === "standard" || tier === "priority") {
    setStatus("Saving priority tier...", "warn");
    vscode.postMessage({ kind: "setPriorityTier", tier });
  }
});

els.copy.addEventListener("click", (e) => {
  busy(e.currentTarget, "Copied ✓");
  vscode.postMessage({
    kind: "copyAccountId",
    id: current?.account?.userId || "",
  });
  setTimeout(clearBusy, 700);
});

els.upgrade.addEventListener("click", () => {
  setStatus("Upgrade path is handled by future Octopus billing infra.", "warn");
});

window.addEventListener("message", (message) => {
  const data = message.data;
  clearBusy();
  if (data.kind === "account") {
    render(data.account);
  } else if (data.kind === "status") {
    setStatus(data.message, data.tone || "");
  }
});

vscode.postMessage({ kind: "getAccount" });
