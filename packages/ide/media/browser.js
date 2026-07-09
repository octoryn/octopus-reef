const vscode = acquireVsCodeApi();

const nav = document.getElementById("nav");
const urlInput = document.getElementById("url");
const frame = document.getElementById("frame");
const empty = document.getElementById("empty");
const reload = document.getElementById("reload");
const read = document.getElementById("read");
const deny = document.getElementById("deny");
const statusEl = document.getElementById("status");
const annotate = document.getElementById("annotate");
const annotationNote = document.getElementById("annotationNote");
const annotationLayer = document.getElementById("annotationLayer");
const annotationBox = document.getElementById("annotationBox");

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
  setAnnotationMode(false);
  setStatus(`Previewing ${url}`, "ok");
  vscode.postMessage({ kind: "browserPreview", url });
}

let annotationMode = false;
let dragStart = undefined;

function setAnnotationMode(enabled) {
  annotationMode = enabled;
  dragStart = undefined;
  annotationLayer.classList.toggle("active", enabled);
  annotationBox.classList.remove("active");
  annotate.textContent = enabled ? "Cancel" : "Annotate";
  if (enabled) {
    setStatus("Drag over the preview to annotate a local element.", "warn");
  }
}

function layerPoint(event) {
  const rect = annotationLayer.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(rect.width, event.clientX - rect.left)),
    y: Math.max(0, Math.min(rect.height, event.clientY - rect.top)),
    viewportWidth: rect.width,
    viewportHeight: rect.height,
  };
}

function drawAnnotationBox(start, end) {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  const width = Math.max(4, Math.abs(end.x - start.x));
  const height = Math.max(4, Math.abs(end.y - start.y));
  annotationBox.style.left = `${x}px`;
  annotationBox.style.top = `${y}px`;
  annotationBox.style.width = `${width}px`;
  annotationBox.style.height = `${height}px`;
  annotationBox.classList.add("active");
  return {
    x,
    y,
    width,
    height,
    viewportWidth: start.viewportWidth,
    viewportHeight: start.viewportHeight,
  };
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

annotate.addEventListener("click", () => {
  try {
    if (!annotationMode) {
      currentUrl();
    }
    setAnnotationMode(!annotationMode);
  } catch (error) {
    setStatus(error.message || String(error), "bad");
  }
});

annotationLayer.addEventListener("mousedown", (event) => {
  if (!annotationMode) return;
  dragStart = layerPoint(event);
  drawAnnotationBox(dragStart, dragStart);
});

annotationLayer.addEventListener("mousemove", (event) => {
  if (!annotationMode || dragStart === undefined) return;
  drawAnnotationBox(dragStart, layerPoint(event));
});

annotationLayer.addEventListener("mouseup", (event) => {
  if (!annotationMode || dragStart === undefined) return;
  try {
    const bbox = drawAnnotationBox(dragStart, layerPoint(event));
    const url = currentUrl();
    const note = annotationNote.value.trim() || "Annotated browser region";
    setAnnotationMode(false);
    annotationBox.classList.add("active");
    setStatus("Resolving annotation through governed browser Power...", "warn");
    vscode.postMessage({
      kind: "runBrowserAnnotation",
      url,
      note,
      bbox,
    });
  } catch (error) {
    setStatus(error.message || String(error), "bad");
  }
});

window.addEventListener("message", (message) => {
  const data = message.data || {};
  if (data.kind === "status") {
    setStatus(data.message, data.tone || "");
  } else if (data.kind === "annotationSealed") {
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
