/**
 * The webview document — pure presentation. The extension host owns the daemon
 * connection and posts `ServerEvent`s in; this renders the live evidence
 * timeline and the proof block, in the shared deep-sea + signal-teal language.
 */
export function webviewHtml(cspSource: string, nonce: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  :root{--deep:#0a1416;--deep2:#0f1e21;--line:#1b3034;--ink:#eaf2f0;--muted:#7c9a9b;--signal:#3de0be;--danger:#ff6b6b;--mono:ui-monospace,Menlo,monospace}
  body{margin:0;background:var(--deep);color:var(--ink);font-family:var(--mono);font-size:13px;padding:16px}
  .hd{color:var(--muted);border-bottom:1px solid var(--line);padding-bottom:10px;margin-bottom:12px}
  .hd b{color:var(--signal)}
  .chat{display:grid;grid-template-columns:1fr auto;gap:8px;margin-bottom:14px}
  .chat input{min-width:0;background:var(--deep2);border:1px solid var(--line);border-radius:6px;color:var(--ink);font:inherit;padding:9px 10px;outline:none}
  .chat input:focus{border-color:var(--signal)}
  .chat button{background:var(--signal);border:0;border-radius:6px;color:#001714;font:inherit;font-weight:700;padding:0 14px}
  .chat button:disabled,.chat input:disabled{opacity:.55}
  .row{display:grid;grid-template-columns:26px 74px 1fr auto;gap:10px;padding:5px 0;border-bottom:1px solid rgba(27,48,52,.5)}
  .row .k{color:var(--muted)}
  .row.exec .k,.row.seal .k{color:var(--signal)}
  .row.deny .k,.row.deny .s{color:var(--danger)}
  .row .s{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .row .e{color:var(--muted);opacity:.6}
  .proof{margin-top:14px;border:1px solid var(--line);border-radius:10px;padding:14px;background:var(--deep2)}
  .proof.ok{border-color:var(--signal)}.proof.bad{border-color:var(--danger)}
  .proof .v{font-weight:700;letter-spacing:.04em}
  .proof.ok .v{color:var(--signal)}.proof.bad .v{color:var(--danger)}
  .checks{display:flex;gap:18px;margin:10px 0;color:var(--muted)}
  .checks b{color:var(--signal)}.checks b.bad{color:var(--danger)}
  .chains{color:var(--muted);display:flex;gap:14px;flex-wrap:wrap}
</style>
</head>
<body>
<div class="hd"><b>&#x259A; reef</b> — <span id="task">idle</span></div>
<form class="chat" id="chat"><input id="chat-input" autocomplete="off" placeholder="Let's build..." /><button id="chat-submit" type="submit">Run</button></form>
<div id="timeline"></div>
<div id="proof"></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const tl = document.getElementById('timeline');
const pf = document.getElementById('proof');
const form = document.getElementById('chat');
const input = document.getElementById('chat-input');
const submit = document.getElementById('chat-submit');
const KIND = {'session.created':'session','work.transition':'work',observation:'observe','action.executed':'action','action.denied':'denied',message:'message','session.sealed':'sealed'};
let lastSnapshot = null;
function busy(value) {
  input.disabled = value;
  submit.disabled = value;
  if (!value) input.focus();
}
function cls(k){return k==='action.executed'||k==='session.sealed'?'exec':k==='action.denied'?'deny':''}
function renderProof(snapshot, verify) {
  lastSnapshot = snapshot;
  const ok = verify.ok;
  const c = (v)=> (v==='intact'||v==='bound');
  pf.className = 'proof ' + (ok?'ok':'bad');
  pf.innerHTML = '<div class="v">'+(ok?'✓ VERIFIED':'✗ UNVERIFIED')+' <span style="color:var(--muted);font-weight:400">'+snapshot.outcome+'</span></div>'+
    '<div class="checks">work <b class="'+(c(verify.work)?'':'bad')+'">'+verify.work+'</b> log <b class="'+(c(verify.log)?'':'bad')+'">'+verify.log+'</b> binding <b class="'+(c(verify.binding)?'':'bad')+'">'+verify.binding+'</b></div>'+
    '<div class="chains"><span>'+snapshot.workChainLength+' work links</span><span>'+snapshot.logChainLength+' evidence links</span><span>'+snapshot.actionsExecuted+' executed</span><span>'+snapshot.actionsDenied+' denied</span></div>';
}
form.addEventListener('submit', (event) => {
  event.preventDefault();
  const task = input.value.trim();
  if (!task) return;
  busy(true);
  vscode.postMessage({ kind: 'runTask', task });
});
window.addEventListener('message', (m) => {
  const d = m.data;
  if (d.kind === 'reset') { tl.innerHTML=''; pf.innerHTML=''; lastSnapshot=null; document.getElementById('task').textContent=d.task; }
  else if (d.kind === 'event') {
    const e = d.event;
    const row = document.createElement('div');
    row.className = 'row ' + cls(e.kind);
    row.innerHTML = '<span class="k">'+String(e.seq).padStart(2,'0')+'</span>'+
      '<span class="k">'+(KIND[e.kind]||e.kind)+'</span>'+
      '<span class="s"></span><span class="e"></span>';
    row.children[2].textContent = e.summary;
    row.children[3].textContent = (e.evidenceId||'').slice(0,10);
    tl.appendChild(row);
  } else if (d.kind === 'sealed') {
    busy(false);
    renderProof(d.snapshot, d.verify);
  } else if (d.kind === 'verified' && lastSnapshot !== null) {
    renderProof(lastSnapshot, d.verify);
  } else if (d.kind === 'error') {
    busy(false);
    pf.className='proof bad'; pf.innerHTML='<div class="v">✗ '+d.message+'</div>';
  }
});
vscode.postMessage({ kind: 'ready' });
</script>
</body>
</html>`;
}
