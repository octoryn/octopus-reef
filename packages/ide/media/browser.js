const vscode = acquireVsCodeApi();

const nav = document.getElementById("nav");
const urlInput = document.getElementById("url");
const frame = document.getElementById("frame");
const empty = document.getElementById("empty");
const reload = document.getElementById("reload");
const read = document.getElementById("read");
const deny = document.getElementById("deny");
const statusEl = document.getElementById("status");

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

function setStatus(message, tone = "") {
  statusEl.className = `status ${tone}`;
  statusEl.textContent = message;
}

function localUrl(value) {
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error("Enter a valid http://127.0.0.1 or http://localhost URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http/https localhost previews are allowed.");
  }
  if (!LOCAL_HOSTS.has(parsed.hostname)) {
    throw new Error(`Preview is limited to localhost, not ${parsed.hostname}.`);
  }
  return parsed.href;
}

function currentUrl() {
  return localUrl(urlInput.value);
}

function openPreview(url) {
  frame.src = url;
  empty.classList.add("hidden");
  setStatus(`Previewing ${url}`, "ok");
  vscode.postMessage({ kind: "browserPreview", url });
}

nav.addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    openPreview(currentUrl());
  } catch (error) {
    setStatus(error.message || String(error), "bad");
  }
});

reload.addEventListener("click", () => {
  try {
    const url = currentUrl();
    if (frame.src) {
      frame.src = url;
    } else {
      openPreview(url);
    }
    setStatus(`Reloaded ${url}`, "ok");
  } catch (error) {
    setStatus(error.message || String(error), "bad");
  }
});

read.addEventListener("click", () => {
  try {
    const url = currentUrl();
    setStatus("Starting governed browser read...", "warn");
    vscode.postMessage({ kind: "runBrowserDemo", mode: "allowed", url });
  } catch (error) {
    setStatus(error.message || String(error), "bad");
  }
});

deny.addEventListener("click", () => {
  try {
    const url = currentUrl();
    setStatus("Starting governed browser denial proof...", "warn");
    vscode.postMessage({ kind: "runBrowserDemo", mode: "denied", url });
  } catch (error) {
    setStatus(error.message || String(error), "bad");
  }
});

window.addEventListener("message", (message) => {
  const data = message.data || {};
  if (data.kind === "status") {
    setStatus(data.message, data.tone || "");
  } else if (data.kind === "openUrl" && typeof data.url === "string") {
    try {
      urlInput.value = data.url;
      openPreview(currentUrl());
    } catch (error) {
      setStatus(error.message || String(error), "bad");
    }
  }
});
