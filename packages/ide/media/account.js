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
  status: document.getElementById("status"),
  signin: document.getElementById("signin"),
  signout: document.getElementById("signout"),
  copy: document.getElementById("copy"),
  upgrade: document.getElementById("upgrade"),
};

let current = undefined;

function setStatus(message, tone = "") {
  els.status.className = `status ${tone}`;
  els.status.textContent = message;
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
    `N6 session evidence aggregation · generated ${usage?.generatedAt || "unknown"}`,
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
      : quota.message || "not available",
  );
  text(els.quotaSource, quota.source || "not available");
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
  setStatus(`Account refreshed ${data.generatedAt || ""}`, "ok");
}

document.getElementById("refresh").addEventListener("click", () => {
  setStatus("Refreshing account...", "warn");
  vscode.postMessage({ kind: "getAccount" });
});

document.getElementById("evidence").addEventListener("click", () => {
  setStatus("Recording account evidence...", "warn");
  vscode.postMessage({ kind: "recordAccountEvidence" });
});

els.signin.addEventListener("click", () => {
  setStatus("Signing in to local stub account...", "warn");
  vscode.postMessage({ kind: "signInAccount" });
});

els.signout.addEventListener("click", () => {
  setStatus("Signing out...", "warn");
  vscode.postMessage({ kind: "signOutAccount" });
});

els.copy.addEventListener("click", () => {
  vscode.postMessage({
    kind: "copyAccountId",
    id: current?.account?.userId || "",
  });
});

els.upgrade.addEventListener("click", () => {
  setStatus("Upgrade path is handled by future Octopus billing infra.", "warn");
});

window.addEventListener("message", (message) => {
  const data = message.data;
  if (data.kind === "account") {
    render(data.account);
  } else if (data.kind === "status") {
    setStatus(data.message, data.tone || "");
  }
});

vscode.postMessage({ kind: "getAccount" });
