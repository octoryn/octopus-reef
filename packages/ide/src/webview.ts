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
<div id="timeline"></div>
<div id="proof"></div>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const tl = document.getElementById('timeline');
const pf = document.getElementById('proof');
const KIND = {'session.created':'session','work.transition':'work',observation:'observe','action.executed':'action','action.denied':'denied',message:'message','session.sealed':'sealed'};
function cls(k){return k==='action.executed'||k==='session.sealed'?'exec':k==='action.denied'?'deny':''}
window.addEventListener('message', (m) => {
  const d = m.data;
  if (d.kind === 'reset') { tl.innerHTML=''; pf.innerHTML=''; document.getElementById('task').textContent=d.task; }
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
    const ok = d.verify.ok;
    const c = (v)=> (v==='intact'||v==='bound');
    pf.className = 'proof ' + (ok?'ok':'bad');
    pf.innerHTML = '<div class="v">'+(ok?'✓ VERIFIED':'✗ UNVERIFIED')+' <span style="color:var(--muted);font-weight:400">'+d.snapshot.outcome+'</span></div>'+
      '<div class="checks">work <b class="'+(c(d.verify.work)?'':'bad')+'">'+d.verify.work+'</b> log <b class="'+(c(d.verify.log)?'':'bad')+'">'+d.verify.log+'</b> binding <b class="'+(c(d.verify.binding)?'':'bad')+'">'+d.verify.binding+'</b></div>'+
      '<div class="chains"><span>'+d.snapshot.workChainLength+' work links</span><span>'+d.snapshot.logChainLength+' evidence links</span><span>'+d.snapshot.actionsExecuted+' executed</span><span>'+d.snapshot.actionsDenied+' denied</span></div>';
  } else if (d.kind === 'error') {
    pf.className='proof bad'; pf.innerHTML='<div class="v">✗ '+d.message+'</div>';
  }
});
vscode.postMessage({ kind: 'ready' });
</script>
</body>
</html>`;
}
