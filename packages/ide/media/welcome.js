const vscode = acquireVsCodeApi();
const statusEl = document.getElementById("status");

function setStatus(message, tone = "") {
  statusEl.className = `status ${tone}`;
  statusEl.textContent = message;
}

for (const button of document.querySelectorAll("[data-action]")) {
  button.addEventListener("click", () => {
    const action = button.getAttribute("data-action");
    if (!action) return;
    setStatus("Opening...");
    vscode.postMessage({ kind: "welcomeAction", action });
  });
}

document.getElementById("disable").addEventListener("click", () => {
  vscode.postMessage({ kind: "disableWelcome" });
  setStatus("Welcome disabled for future launches.", "ok");
});

window.addEventListener("message", (event) => {
  const data = event.data;
  if (data.kind === "welcomeStatus") {
    setStatus(data.message, data.tone || "");
  }
});
