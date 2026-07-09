const vscode = acquireVsCodeApi();

const empty = document.getElementById('empty');
const conversation = document.getElementById('conversation');
const main = document.getElementById('main');
const form = document.getElementById('chat');
const input = document.getElementById('chat-input');
const submit = document.getElementById('chat-submit');
const autopilotButton = document.getElementById('autopilot');
const modelChip = document.getElementById('model-chip');
const usageBox = document.getElementById('usage');
const newSession = document.getElementById('new-session');

const KIND = {
  'session.created': 'session',
  'work.transition': 'work',
  observation: 'observe',
  'action.executed': 'action',
  'action.denied': 'denied',
  message: 'plan',
  'session.sealed': 'sealed',
};

let conversationId = `reef-chat-${Date.now().toString(36)}`;
let nextTurn = 1;
let autopilot = false;
let busy = false;
let legacyTurnId = '';
const turns = new Map();

function setBusy(value) {
  busy = value;
  input.disabled = value;
  submit.disabled = value;
  if (!value) input.focus();
}

function setActive() {
  empty.classList.add('hidden');
  conversation.classList.remove('hidden');
}

function setEmpty() {
  conversation.innerHTML = '';
  conversation.classList.add('hidden');
  empty.classList.remove('hidden');
  turns.clear();
  nextTurn = 1;
  legacyTurnId = '';
  input.value = '';
  setBusy(false);
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
  const message = document.createElement('div');
  message.className = 'message user';
  appendText(message, 'div', 'bubble', task);
  conversation.appendChild(message);
  scrollBottom();
}

function addApprovalCard(task) {
  setActive();
  const turnId = `turn-${Date.now().toString(36)}-${nextTurn}`;
  const turnNumber = nextTurn++;
  const card = document.createElement('div');
  card.className = 'approval-card';
  appendText(card, 'div', '', 'Approval required before this governed turn runs.');
  const approve = appendText(card, 'button', '', 'Approve and Run');
  approve.type = 'button';
  approve.addEventListener('click', () => {
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
    approval: auto ? 'Autopilot auto-approved' : 'Approval requested and granted',
  });
  setBusy(true);
  vscode.postMessage({
    kind: 'sendChatTurn',
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

  const wrapper = document.createElement('article');
  wrapper.className = 'turn';
  wrapper.dataset.turnId = turnId;

  const head = document.createElement('div');
  head.className = 'turn-head';
  const title = document.createElement('div');
  title.className = 'turn-title';
  appendText(title, 'span', 'tab-dot', '');
  appendText(title, 'span', '', `Turn ${turn}: ${task}`);
  const badge = appendText(head, 'div', 'badge pending', 'PENDING');
  head.prepend(title);

  const body = document.createElement('div');
  body.className = 'turn-body';
  const plan = section('Plan', 'ul');
  const actions = section('Actions', 'ul');
  const diff = section('Diff', 'pre', true);
  const evidence = section('Evidence Timeline', 'div', true);
  evidence.content.className = 'timeline';
  body.append(plan.box, actions.box, diff.box, evidence.box);

  const foot = document.createElement('div');
  foot.className = 'turn-foot';
  const approvalLine = appendText(
    foot,
    'div',
    'approval',
    `${approval} · ${auto ? 'Autopilot on' : 'Autopilot off'}`,
  );
  const verify = appendText(foot, 'button', 'verify-btn', 'Verify');
  verify.type = 'button';
  verify.addEventListener('click', () => {
    vscode.postMessage({ kind: 'verifyChatTurn', turnId });
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
  const box = document.createElement('section');
  box.className = wide ? 'section wide' : 'section';
  appendText(box, 'h2', '', title);
  const content = document.createElement(contentTag);
  box.appendChild(content);
  return { box, content };
}

function applyView(record, view) {
  renderList(record.plan, view.plan, 'Waiting for the governed plan.');
  renderActions(record.actions, view.actions);
  record.diff.textContent = view.diff || '';
  renderEvidence(record.evidence, view.evidence);
  record.badge.className = `badge ${view.verifyTone}`;
  record.badge.textContent = view.verifyLabel;
  renderUsage(view.usage);
}

function renderList(parent, items, fallback) {
  parent.innerHTML = '';
  const values = items && items.length ? items : [fallback];
  for (const item of values) appendText(parent, 'li', '', item);
}

function renderActions(parent, actions) {
  parent.innerHTML = '';
  if (!actions || actions.length === 0) {
    appendText(parent, 'li', '', 'Waiting for governed actions.');
    return;
  }
  for (const action of actions) {
    const li = document.createElement('li');
    li.className = action.tone === 'bad' ? 'bad' : 'ok';
    const b = appendText(li, 'b', '', action.type);
    b.after(document.createTextNode(` ${action.summary}`));
    if (action.command || action.target) {
      appendText(li, 'span', '', ` ${action.command || action.target}`);
    }
    parent.appendChild(li);
  }
}

function renderEvidence(parent, evidence) {
  parent.innerHTML = '';
  if (!evidence || evidence.length === 0) {
    appendText(parent, 'div', 'evidence', 'Waiting for evidence links.');
    return;
  }
  for (const item of evidence) {
    const row = document.createElement('div');
    row.className = `evidence ${item.tone === 'bad' ? 'bad' : item.tone === 'ok' ? 'ok' : ''}`;
    appendText(row, 'span', '', String(item.seq).padStart(2, '0'));
    appendText(row, 'span', '', item.label);
    appendText(row, 'span', '', item.summary);
    appendText(row, 'span', '', (item.evidenceId || '').slice(0, 12));
    parent.appendChild(row);
  }
}

function renderUsage(usage) {
  if (!usage) return;
  usageBox.innerHTML = '';
  usageCell(formatInteger(usage.totalTokens || 0), 'tokens used');
  usageCell(usage.cost || '$0.000000', 'cost');
  usageCell(`${formatInteger(usage.calls || 0)} calls`, usage.summary || 'provider usage from evidence');
  usageCell('remaining', usage.remaining || 'not available from this provider');
}

function usageCell(value, label) {
  const cell = document.createElement('div');
  appendText(cell, 'b', '', value);
  appendText(cell, 'span', '', label);
  usageBox.appendChild(cell);
}

function localView(record) {
  const plan = record.events
    .filter((event) => event.kind === 'message')
    .map((event) => event.summary.replace(/^Plan:\s*/i, '').trim())
    .filter(Boolean);
  const actions = record.events
    .filter((event) => event.kind === 'action.executed' || event.kind === 'action.denied')
    .map((event) => {
      const payload = event.data && typeof event.data.payload === 'object' ? event.data.payload : {};
      return {
        type: event.data?.actionType || 'action',
        summary: event.summary,
        target: event.data?.target,
        command: payload?.command || payload?.tool,
        tone: event.kind === 'action.denied' ? 'bad' : 'ok',
      };
    });
  const evidence = record.events.map((event) => ({
    seq: event.seq,
    label: KIND[event.kind] || event.kind,
    summary: event.summary,
    evidenceId: event.evidenceId || '',
    tone:
      event.kind === 'action.denied'
        ? 'bad'
        : event.kind === 'action.executed' || event.kind === 'session.sealed'
          ? 'ok'
          : 'neutral',
  }));
  const verifyLabel = record.verify
    ? record.verify.ok
      ? `VERIFIED: work ${record.verify.work}, log ${record.verify.log}, binding ${record.verify.binding}`
      : `UNVERIFIED: work ${record.verify.work}, log ${record.verify.log}, binding ${record.verify.binding}`
    : 'PENDING';
  const verifyTone = record.verify ? (record.verify.ok ? 'ok' : 'bad') : 'pending';
  const diff = [
    '--- reef-chat/task',
    '+++ reef-chat/governed-turn',
    '@@',
    `+ task: ${record.task}`,
    `+ plan: ${plan.join(' ') || 'Waiting for the governed plan.'}`,
    `+ evidence-links: ${record.events.length}`,
    ...actions.map(
      (action, index) =>
        `+ action[${index + 1}:${action.type}:${action.tone}]: ${action.summary}${action.command ? ` command=${action.command}` : action.target ? ` target=${action.target}` : ''}`,
    ),
    `+ verify: ${verifyLabel}`,
  ].join('\n');
  return {
    plan: plan.length ? plan : ['Waiting for the governed plan.'],
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
    cost: '$0.000000',
    summary: '0 provider calls recorded for this governed session.',
    remaining: 'Remaining balance: not available from the offline mock provider.',
  };
}

function formatInteger(value) {
  return Number(value || 0).toLocaleString('en-US');
}

function scrollBottom() {
  requestAnimationFrame(() => {
    main.scrollTop = main.scrollHeight;
  });
}

function updateAutopilot() {
  autopilotButton.classList.toggle('on', autopilot);
  autopilotButton.setAttribute('aria-pressed', String(autopilot));
}

function insertPrompt(prefix) {
  input.value = prefix;
  input.focus();
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (busy) return;
  const task = input.value.trim();
  if (!task) return;
  input.value = '';
  addUserMessage(task);
  if (autopilot) {
    const turnId = `turn-${Date.now().toString(36)}-${nextTurn}`;
    startTurn({ task, turnId, turn: nextTurn++, autopilot: true });
  } else {
    addApprovalCard(task);
  }
});

input.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
    form.requestSubmit();
  }
});

autopilotButton.addEventListener('click', () => {
  autopilot = !autopilot;
  updateAutopilot();
});

newSession.addEventListener('click', () => {
  conversationId = `reef-chat-${Date.now().toString(36)}`;
  setEmpty();
  vscode.postMessage({ kind: 'refreshChatUsage' });
});

document.querySelectorAll('[data-shortcut]').forEach((button) => {
  button.addEventListener('click', () => {
    const mode = button.getAttribute('data-shortcut') || 'Plan';
    insertPrompt(`${mode}: `);
  });
});

document.getElementById('hash').addEventListener('click', () => {
  insertPrompt(`${input.value}#`);
});

document.getElementById('attach').addEventListener('click', () => {
  insertPrompt(`${input.value}Attach: `);
});

window.addEventListener('message', (message) => {
  const data = message.data || {};
  if (data.kind === 'chatConfig') {
    if (typeof data.conversationId === 'string') conversationId = data.conversationId;
    if (data.modelChip?.label) modelChip.textContent = data.modelChip.label;
    renderUsage(data.usage || zeroUsage());
  } else if (data.kind === 'chatUsage') {
    renderUsage(data.usage || zeroUsage());
  } else if (data.kind === 'chatTurnStarted') {
    const record = turns.get(data.turnId);
    if (record && data.modelChip?.label) modelChip.textContent = data.modelChip.label;
  } else if (data.kind === 'chatTurnSession') {
    const record = turns.get(data.turnId);
    if (record) record.sessionId = data.sessionId;
  } else if (data.kind === 'chatTurnEvent') {
    const record = turns.get(data.turnId);
    if (!record) return;
    record.events.push(data.event);
    applyView(record, data.view || localView(record));
  } else if (data.kind === 'chatTurnSealed') {
    const record = turns.get(data.turnId);
    if (!record) return;
    record.verify = data.verify;
    applyView(record, data.view || localView(record));
    setBusy(false);
  } else if (data.kind === 'chatTurnVerified') {
    const record = turns.get(data.turnId);
    if (!record) return;
    record.verify = data.verify;
    applyView(record, data.view || localView(record));
  } else if (data.kind === 'chatError') {
    setBusy(false);
    const record = turns.get(data.turnId);
    if (record) {
      record.badge.className = 'badge bad';
      record.badge.textContent = `ERROR: ${data.message || 'failed'}`;
    }
  } else if (data.kind === 'reset') {
    setEmpty();
    addUserMessage(data.task || 'Governed session');
    legacyTurnId = `legacy-${Date.now().toString(36)}`;
    createTurn({
      turnId: legacyTurnId,
      task: data.task || 'Governed session',
      turn: nextTurn++,
      autopilot: true,
      approval: 'Command palette run',
    });
    setBusy(true);
  } else if (data.kind === 'event') {
    const record = turns.get(legacyTurnId);
    if (!record) return;
    record.events.push(data.event);
    applyView(record, localView(record));
  } else if (data.kind === 'sealed') {
    const record = turns.get(legacyTurnId);
    if (!record) return;
    record.verify = data.verify;
    applyView(record, localView(record));
    setBusy(false);
  } else if (data.kind === 'verified') {
    const record = turns.get(legacyTurnId);
    if (!record) return;
    record.verify = data.verify;
    applyView(record, localView(record));
  } else if (data.kind === 'error') {
    setBusy(false);
  }
  scrollBottom();
});

updateAutopilot();
renderUsage(zeroUsage());
vscode.postMessage({ kind: 'chatReady' });
