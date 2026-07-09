const vscode = acquireVsCodeApi();
const tl = document.getElementById('timeline');
const pf = document.getElementById('proof');
const form = document.getElementById('chat');
const input = document.getElementById('chat-input');
const submit = document.getElementById('chat-submit');
const KIND = {
  'session.created': 'session',
  'work.transition': 'work',
  observation: 'observe',
  'action.executed': 'action',
  'action.denied': 'denied',
  message: 'message',
  'session.sealed': 'sealed',
};
let lastSnapshot = null;

function busy(value) {
  input.disabled = value;
  submit.disabled = value;
  if (!value) input.focus();
}

function cls(kind) {
  return kind === 'action.executed' || kind === 'session.sealed'
    ? 'exec'
    : kind === 'action.denied'
      ? 'deny'
      : '';
}

function renderProof(snapshot, verify) {
  lastSnapshot = snapshot;
  const ok = verify.ok;
  const checkClass = (value) => (value === 'intact' || value === 'bound' ? '' : 'bad');
  pf.className = `proof ${ok ? 'ok' : 'bad'}`;
  pf.innerHTML =
    `<div class="v">${ok ? '&#10003; VERIFIED' : '&#10007; UNVERIFIED'} <span style="color:var(--muted);font-weight:400">${snapshot.outcome}</span></div>` +
    `<div class="checks">work <b class="${checkClass(verify.work)}">${verify.work}</b> log <b class="${checkClass(verify.log)}">${verify.log}</b> binding <b class="${checkClass(verify.binding)}">${verify.binding}</b></div>` +
    `<div class="chains"><span>${snapshot.workChainLength} work links</span><span>${snapshot.logChainLength} evidence links</span><span>${snapshot.actionsExecuted} executed</span><span>${snapshot.actionsDenied} denied</span></div>`;
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const task = input.value.trim();
  if (!task) return;
  busy(true);
  vscode.postMessage({ kind: 'runTask', task });
});

window.addEventListener('message', (message) => {
  const data = message.data;
  if (data.kind === 'reset') {
    tl.innerHTML = '';
    pf.innerHTML = '';
    lastSnapshot = null;
    document.getElementById('task').textContent = data.task;
  } else if (data.kind === 'event') {
    const event = data.event;
    const row = document.createElement('div');
    row.className = `row ${cls(event.kind)}`;
    row.innerHTML =
      `<span class="k">${String(event.seq).padStart(2, '0')}</span>` +
      `<span class="k">${KIND[event.kind] || event.kind}</span>` +
      '<span class="s"></span><span class="e"></span>';
    row.children[2].textContent = event.summary;
    row.children[3].textContent = (event.evidenceId || '').slice(0, 10);
    tl.appendChild(row);
  } else if (data.kind === 'sealed') {
    busy(false);
    renderProof(data.snapshot, data.verify);
  } else if (data.kind === 'verified' && lastSnapshot !== null) {
    renderProof(lastSnapshot, data.verify);
  } else if (data.kind === 'error') {
    busy(false);
    pf.className = 'proof bad';
    pf.innerHTML = `<div class="v">&#10007; ${data.message}</div>`;
  }
});

vscode.postMessage({ kind: 'ready' });
