const vscode = acquireVsCodeApi();

const empty = document.getElementById("empty");
const conversation = document.getElementById("conversation");
const main = document.getElementById("main");
const form = document.getElementById("chat");
const input = document.getElementById("chat-input");
const submit = document.getElementById("chat-submit");
const autopilotButton = document.getElementById("autopilot");
const modelChip = document.getElementById("model-chip");
const usageBox = document.getElementById("usage");
const newSessionTab = document.getElementById("new-session-tab");
const newSessionPlus = document.getElementById("new-session-plus");
const agentFocus = document.getElementById("agent-focus");
const headerMore = document.getElementById("header-more");
const headerMenu = document.getElementById("header-menu");
const picker = document.getElementById("affordance-picker");

const KIND = {
  "session.created": "session",
  "work.transition": "work",
  observation: "observe",
  "action.executed": "action",
  "action.denied": "denied",
  message: "plan",
  "session.sealed": "sealed",
};

let conversationId = `reef-chat-${Date.now().toString(36)}`;
let nextTurn = 1;
let autopilot = false;
let busy = false;
let legacyTurnId = "";
const turns = new Map();
let affordances = {
  commands: [
    {
      token: "/spec",
      label: "Spec",
      description: "Shape a governed workstate spec before the run.",
    },
    {
      token: "/plan",
      label: "Plan",
      description: "Ask Reef to plan before edits begin.",
    },
    {
      token: "/bug-fix",
      label: "Bug Fix",
      description: "Trace, patch, and verify a failure.",
    },
    {
      token: "/replay",
      label: "Replay",
      description: "Re-check evidence and explain what changed.",
    },
    {
      token: "/verify",
      label: "Verify",
      description: "Verify the latest governed turn.",
    },
    {
      token: "/new-session",
      label: "New Session",
      description: "Start a new governed chat thread.",
    },
  ],
  routes: [
    {
      token: "@code",
      label: "Code Worker",
      description: "Route the turn to the code worker.",
    },
    {
      token: "@tool",
      label: "Tool Worker",
      description: "Route the turn to the tool worker.",
    },
    {
      token: "@cli:claude",
      label: "Claude CLI Worker",
      description: "Route through the Claude CLI worker.",
    },
    {
      token: "@cli:codex",
      label: "Codex CLI Worker",
      description: "Route through the Codex CLI worker.",
    },
    {
      token: "@cli:gemini",
      label: "Gemini CLI Worker",
      description: "Route through the Gemini CLI worker.",
    },
  ],
  tasks: [],
};
let activePicker = {
  trigger: "",
  start: 0,
  end: 0,
  items: [],
  index: 0,
};

function setBusy(value) {
  busy = value;
  input.disabled = value;
  submit.disabled = value;
  if (!value) input.focus();
}

function setActive() {
  empty.classList.add("hidden");
  conversation.classList.remove("hidden");
}

function setEmpty() {
  conversation.innerHTML = "";
  conversation.classList.add("hidden");
  empty.classList.remove("hidden");
  turns.clear();
  nextTurn = 1;
  legacyTurnId = "";
  input.value = "";
  resizeComposerInput();
  setBusy(false);
}

function resetConversation(nextConversationId) {
  conversationId = nextConversationId || `reef-chat-${Date.now().toString(36)}`;
  setEmpty();
}

function requestNewSession(source) {
  resetConversation();
  vscode.postMessage({ kind: "newSession", source });
}

function setHeaderMenu(open) {
  headerMenu.classList.toggle("hidden", !open);
  headerMore.setAttribute("aria-expanded", String(open));
}

function appendText(parent, tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  parent.appendChild(node);
  return node;
}

function addUserMessage(task) {
  setActive();
  const message = document.createElement("div");
  message.className = "message user";
  appendText(message, "div", "bubble", task);
  conversation.appendChild(message);
  scrollBottom();
}

function addApprovalCard(task) {
  setActive();
  const turnId = `turn-${Date.now().toString(36)}-${nextTurn}`;
  const turnNumber = nextTurn++;
  const card = document.createElement("div");
  card.className = "approval-card";
  appendText(
    card,
    "div",
    "",
    "Approval required before this governed turn runs.",
  );
  const approve = appendText(card, "button", "", "Approve and Run");
  approve.type = "button";
  approve.addEventListener("click", () => {
    card.remove();
    startTurn({ task, turnId, turn: turnNumber, autopilot: false });
  });
  conversation.appendChild(card);
  scrollBottom();
}

function startTurn({ task, turnId, turn, autopilot: auto }) {
  setActive();
  createTurn({
    turnId,
    task,
    turn,
    autopilot: auto,
    approval: auto
      ? "Autopilot auto-approved"
      : "Approval requested and granted",
  });
  setBusy(true);
  vscode.postMessage({
    kind: "sendChatTurn",
    task,
    turnId,
    conversationId,
    turn,
    autopilot: auto,
  });
}

function createTurn({ turnId, task, turn, autopilot: auto, approval }) {
  let record = turns.get(turnId);
  if (record) return record;

  const wrapper = document.createElement("article");
  wrapper.className = "turn";
  wrapper.dataset.turnId = turnId;

  const head = document.createElement("div");
  head.className = "turn-head";
  const title = document.createElement("div");
  title.className = "turn-title";
  appendText(title, "span", "tab-dot", "");
  appendText(title, "span", "", `Turn ${turn}: ${task}`);
  const badge = appendText(head, "div", "badge pending", "PENDING");
  head.prepend(title);

  const body = document.createElement("div");
  body.className = "turn-body";
  const plan = section("Plan", "ul");
  const actions = section("Actions", "ul");
  const diff = section("Diff", "pre", true);
  const evidence = section("Evidence Timeline", "div", true);
  evidence.content.className = "timeline";
  body.append(plan.box, actions.box, diff.box, evidence.box);

  const foot = document.createElement("div");
  foot.className = "turn-foot";
  const approvalLine = appendText(
    foot,
    "div",
    "approval",
    `${approval} · ${auto ? "Autopilot on" : "Autopilot off"}`,
  );
  const verify = appendText(foot, "button", "verify-btn", "Verify");
  verify.type = "button";
  verify.addEventListener("click", () => {
    vscode.postMessage({ kind: "verifyChatTurn", turnId });
  });
  foot.append(approvalLine, verify);

  wrapper.append(head, body, foot);
  conversation.appendChild(wrapper);

  record = {
    turnId,
    task,
    turn,
    element: wrapper,
    badge,
    plan: plan.content,
    actions: actions.content,
    diff: diff.content,
    evidence: evidence.content,
    events: [],
    verify: undefined,
  };
  turns.set(turnId, record);
  applyView(record, localView(record));
  scrollBottom();
  return record;
}

function section(title, contentTag, wide = false) {
  const box = document.createElement("section");
  box.className = wide ? "section wide" : "section";
  appendText(box, "h2", "", title);
  const content = document.createElement(contentTag);
  box.appendChild(content);
  return { box, content };
}

function applyView(record, view) {
  renderList(record.plan, view.plan, "Waiting for the governed plan.");
  renderActions(record.actions, view.actions);
  record.diff.textContent = view.diff || "";
  renderEvidence(record.evidence, view.evidence);
  record.badge.className = `badge ${view.verifyTone}`;
  record.badge.textContent = view.verifyLabel;
  renderUsage(view.usage);
}

function renderList(parent, items, fallback) {
  parent.innerHTML = "";
  const values = items && items.length ? items : [fallback];
  for (const item of values) appendText(parent, "li", "", item);
}

function renderActions(parent, actions) {
  parent.innerHTML = "";
  if (!actions || actions.length === 0) {
    appendText(parent, "li", "", "Waiting for governed actions.");
    return;
  }
  for (const action of actions) {
    const li = document.createElement("li");
    li.className = action.tone === "bad" ? "bad" : "ok";
    const b = appendText(li, "b", "", action.type);
    b.after(document.createTextNode(` ${action.summary}`));
    if (action.command || action.target) {
      appendText(li, "span", "", ` ${action.command || action.target}`);
    }
    parent.appendChild(li);
  }
}

function renderEvidence(parent, evidence) {
  parent.innerHTML = "";
  if (!evidence || evidence.length === 0) {
    appendText(parent, "div", "evidence", "Waiting for evidence links.");
    return;
  }
  for (const item of evidence) {
    const row = document.createElement("div");
    row.className = `evidence ${item.tone === "bad" ? "bad" : item.tone === "ok" ? "ok" : ""}`;
    appendText(row, "span", "", String(item.seq).padStart(2, "0"));
    appendText(row, "span", "", item.label);
    appendText(row, "span", "", item.summary);
    appendText(row, "span", "", (item.evidenceId || "").slice(0, 12));
    parent.appendChild(row);
  }
}

function renderUsage(usage) {
  if (!usage) return;
  usageBox.innerHTML = "";
  usageCell(formatInteger(usage.totalTokens || 0), "tokens used");
  usageCell(usage.cost || "$0.000000", "cost");
  usageCell(
    `${formatInteger(usage.calls || 0)} calls`,
    usage.summary || "provider usage from evidence",
  );
  usageCell("remaining", usage.remaining || "not available from this provider");
}

function usageCell(value, label) {
  const cell = document.createElement("div");
  appendText(cell, "b", "", value);
  appendText(cell, "span", "", label);
  usageBox.appendChild(cell);
}

function localView(record) {
  const plan = record.events
    .filter((event) => event.kind === "message")
    .map((event) => event.summary.replace(/^Plan:\s*/i, "").trim())
    .filter(Boolean);
  const actions = record.events
    .filter(
      (event) =>
        event.kind === "action.executed" || event.kind === "action.denied",
    )
    .map((event) => {
      const payload =
        event.data && typeof event.data.payload === "object"
          ? event.data.payload
          : {};
      return {
        type: event.data?.actionType || "action",
        summary: event.summary,
        target: event.data?.target,
        command: payload?.command || payload?.tool,
        tone: event.kind === "action.denied" ? "bad" : "ok",
      };
    });
  const evidence = record.events.map((event) => ({
    seq: event.seq,
    label: KIND[event.kind] || event.kind,
    summary: event.summary,
    evidenceId: event.evidenceId || "",
    tone:
      event.kind === "action.denied"
        ? "bad"
        : event.kind === "action.executed" || event.kind === "session.sealed"
          ? "ok"
          : "neutral",
  }));
  const verifyLabel = record.verify
    ? record.verify.ok
      ? `VERIFIED: work ${record.verify.work}, log ${record.verify.log}, binding ${record.verify.binding}`
      : `UNVERIFIED: work ${record.verify.work}, log ${record.verify.log}, binding ${record.verify.binding}`
    : "PENDING";
  const verifyTone = record.verify
    ? record.verify.ok
      ? "ok"
      : "bad"
    : "pending";
  const diff = [
    "--- reef-chat/task",
    "+++ reef-chat/governed-turn",
    "@@",
    `+ task: ${record.task}`,
    `+ plan: ${plan.join(" ") || "Waiting for the governed plan."}`,
    `+ evidence-links: ${record.events.length}`,
    ...actions.map(
      (action, index) =>
        `+ action[${index + 1}:${action.type}:${action.tone}]: ${action.summary}${action.command ? ` command=${action.command}` : action.target ? ` target=${action.target}` : ""}`,
    ),
    `+ verify: ${verifyLabel}`,
  ].join("\n");
  return {
    plan: plan.length ? plan : ["Waiting for the governed plan."],
    actions,
    evidence,
    diff,
    verifyTone,
    verifyLabel,
    usage: zeroUsage(),
  };
}

function zeroUsage() {
  return {
    calls: 0,
    totalTokens: 0,
    cost: "$0.000000",
    summary: "0 provider calls recorded for this governed session.",
    remaining:
      "Remaining balance: not available from the offline mock provider.",
  };
}

function formatInteger(value) {
  return Number(value || 0).toLocaleString("en-US");
}

function scrollBottom() {
  requestAnimationFrame(() => {
    main.scrollTop = main.scrollHeight;
  });
}

function updateAutopilot() {
  autopilotButton.classList.toggle("on", autopilot);
  autopilotButton.setAttribute("aria-pressed", String(autopilot));
}

function resizeComposerInput() {
  const maxHeight = 132;
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, maxHeight)}px`;
  input.style.overflowY = input.scrollHeight > maxHeight ? "auto" : "hidden";
}

function insertPrompt(prefix) {
  input.value = prefix;
  resizeComposerInput();
  input.focus();
  updatePicker();
}

function tokenAtCaret() {
  const end = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, end);
  const match = before.match(/(^|\s)([\/#@][^\s]*)$/);
  if (!match) return undefined;
  const token = match[2] || "";
  if (token.length === 0) return undefined;
  return {
    trigger: token[0],
    query: token.slice(1).toLowerCase(),
    start: end - token.length,
    end,
  };
}

function updatePicker() {
  const token = tokenAtCaret();
  if (!token || !["/", "#", "@"].includes(token.trigger)) {
    hidePicker();
    return;
  }
  const items = filterPickerItems(token.trigger, token.query).slice(0, 8);
  if (items.length === 0) {
    hidePicker();
    return;
  }
  activePicker = {
    trigger: token.trigger,
    start: token.start,
    end: token.end,
    items,
    index: Math.min(activePicker.index, items.length - 1),
  };
  renderPicker();
}

function filterPickerItems(trigger, query) {
  const q = query.toLowerCase();
  if (trigger === "/") {
    return affordances.commands.filter((item) => includesPickerText(item, q));
  }
  if (trigger === "@") {
    return affordances.routes.filter((item) => includesPickerText(item, q));
  }
  return affordances.tasks.filter((item) => {
    const haystack =
      `${item.itemId || ""} ${item.title || ""} ${item.specTitle || ""}`.toLowerCase();
    return haystack.includes(q);
  });
}

function includesPickerText(item, query) {
  return `${item.token || ""} ${item.label || ""} ${item.description || ""}`
    .toLowerCase()
    .includes(query);
}

function renderPicker() {
  picker.innerHTML = "";
  activePicker.items.forEach((item, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = index === activePicker.index ? "active" : "";
    button.dataset.index = String(index);
    appendText(button, "span", "token", pickerToken(item));
    appendText(button, "span", "label", pickerLabel(item));
    appendText(button, "span", "meta", pickerMeta(item));
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      choosePickerItem(index);
    });
    picker.appendChild(button);
  });
  picker.classList.remove("hidden");
}

function pickerToken(item) {
  if (activePicker.trigger === "#") return `#${item.itemId || ""}`;
  return item.token || "";
}

function pickerLabel(item) {
  if (activePicker.trigger === "#") return item.title || item.itemId || "Task";
  return item.label || item.token || "";
}

function pickerMeta(item) {
  if (activePicker.trigger === "#") {
    return `${item.state || "open"} · ${item.specTitle || item.specId || "spec"}`;
  }
  return item.description || "";
}

function choosePickerItem(index) {
  const item = activePicker.items[index];
  if (!item) return;
  const token = pickerToken(item);
  const before = input.value.slice(0, activePicker.start);
  const after = input.value.slice(activePicker.end);
  const needsSpace = after.length === 0 || !after.startsWith(" ");
  input.value = `${before}${token}${needsSpace ? " " : ""}${after}`;
  resizeComposerInput();
  const caret = before.length + token.length + (needsSpace ? 1 : 0);
  input.setSelectionRange(caret, caret);
  input.focus();
  hidePicker();
}

function hidePicker() {
  activePicker = { trigger: "", start: 0, end: 0, items: [], index: 0 };
  picker.classList.add("hidden");
  picker.innerHTML = "";
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (busy) return;
  const task = input.value.trim();
  if (!task) return;
  input.value = "";
  resizeComposerInput();
  addUserMessage(task);
  if (autopilot) {
    const turnId = `turn-${Date.now().toString(36)}-${nextTurn}`;
    startTurn({ task, turnId, turn: nextTurn++, autopilot: true });
  } else {
    addApprovalCard(task);
  }
});

input.addEventListener("keydown", (event) => {
  if (!picker.classList.contains("hidden")) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      activePicker.index = (activePicker.index + 1) % activePicker.items.length;
      renderPicker();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      activePicker.index =
        (activePicker.index - 1 + activePicker.items.length) %
        activePicker.items.length;
      renderPicker();
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      choosePickerItem(activePicker.index);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      hidePicker();
      return;
    }
  }
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    form.requestSubmit();
  }
});

input.addEventListener("input", () => {
  resizeComposerInput();
  updatePicker();
});
input.addEventListener("click", () => updatePicker());

autopilotButton.addEventListener("click", () => {
  autopilot = !autopilot;
  updateAutopilot();
});

agentFocus.addEventListener("click", () => {
  vscode.postMessage({ kind: "openAgentFocus" });
});

newSessionTab.addEventListener("click", () => requestNewSession("tab"));
newSessionPlus.addEventListener("click", () => requestNewSession("plus"));

headerMore.addEventListener("click", () => {
  vscode.postMessage({ kind: "showSessionMenu" });
});

headerMenu.addEventListener("click", (event) => {
  const action = event.target.closest("[data-menu-action]")?.dataset.menuAction;
  if (action === "new-session") requestNewSession("menu");
  else if (action === "agent-focus") vscode.postMessage({ kind: "openAgentFocus" });
  else if (action === "refresh-usage") vscode.postMessage({ kind: "refreshChatUsage" });
  setHeaderMenu(false);
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".tab-actions")) setHeaderMenu(false);
});

document.querySelectorAll("[data-shortcut]").forEach((button) => {
  button.addEventListener("click", () => {
    const mode = button.getAttribute("data-shortcut") || "Plan";
    const token = mode.toLowerCase().replace(/\s+/g, "-");
    insertPrompt(`/${token} `);
  });
});

document.getElementById("hash").addEventListener("click", () => {
  insertPrompt(`${input.value}#`);
});

document.getElementById("attach").addEventListener("click", () => {
  insertPrompt(`${input.value}Attach: `);
});

window.addEventListener("message", (message) => {
  const data = message.data || {};
  if (data.kind === "chatConfig") {
    if (typeof data.conversationId === "string")
      conversationId = data.conversationId;
    if (data.modelChip?.label) {
      modelChip.textContent = data.modelChip.label;
      modelChip.title = data.modelChip.label;
    }
    affordances = {
      commands: Array.isArray(data.commands)
        ? data.commands
        : affordances.commands,
      routes: Array.isArray(data.routes) ? data.routes : affordances.routes,
      tasks: Array.isArray(data.tasks) ? data.tasks : [],
    };
    renderUsage(data.usage || zeroUsage());
  } else if (data.kind === "chatSessionReset") {
    resetConversation(data.conversationId);
  } else if (data.kind === "sessionMenu") {
    setHeaderMenu(data.open === true);
  } else if (data.kind === "chatUsage") {
    renderUsage(data.usage || zeroUsage());
  } else if (data.kind === "chatTurnStarted") {
    const record = turns.get(data.turnId);
    if (record && data.modelChip?.label) {
      modelChip.textContent = data.modelChip.label;
      modelChip.title = data.modelChip.label;
    }
  } else if (data.kind === "chatTurnSession") {
    const record = turns.get(data.turnId);
    if (record) record.sessionId = data.sessionId;
  } else if (data.kind === "chatTurnEvent") {
    const record = turns.get(data.turnId);
    if (!record) return;
    record.events.push(data.event);
    applyView(record, data.view || localView(record));
  } else if (data.kind === "chatTurnSealed") {
    const record = turns.get(data.turnId);
    if (!record) return;
    record.verify = data.verify;
    applyView(record, data.view || localView(record));
    setBusy(false);
  } else if (data.kind === "chatTurnVerified") {
    const record = turns.get(data.turnId);
    if (!record) return;
    record.verify = data.verify;
    applyView(record, data.view || localView(record));
  } else if (data.kind === "chatError") {
    setBusy(false);
    const record = turns.get(data.turnId);
    if (record) {
      record.badge.className = "badge bad";
      record.badge.textContent = `ERROR: ${data.message || "failed"}`;
    }
  } else if (data.kind === "reset") {
    setEmpty();
    addUserMessage(data.task || "Governed session");
    legacyTurnId = `legacy-${Date.now().toString(36)}`;
    createTurn({
      turnId: legacyTurnId,
      task: data.task || "Governed session",
      turn: nextTurn++,
      autopilot: true,
      approval: "Command palette run",
    });
    setBusy(true);
  } else if (data.kind === "event") {
    const record = turns.get(legacyTurnId);
    if (!record) return;
    record.events.push(data.event);
    applyView(record, localView(record));
  } else if (data.kind === "sealed") {
    const record = turns.get(legacyTurnId);
    if (!record) return;
    record.verify = data.verify;
    applyView(record, localView(record));
    setBusy(false);
  } else if (data.kind === "verified") {
    const record = turns.get(legacyTurnId);
    if (!record) return;
    record.verify = data.verify;
    applyView(record, localView(record));
  } else if (data.kind === "error") {
    setBusy(false);
  }
  scrollBottom();
});

updateAutopilot();
resizeComposerInput();
renderUsage(zeroUsage());
vscode.postMessage({ kind: "chatReady" });
