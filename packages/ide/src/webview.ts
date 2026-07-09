/**
 * The webview document: static HTML/CSS plus one packaged script. The extension
 * host owns the daemon connection and posts `ServerEvent`s in; the script renders
 * the live evidence timeline and proof block.
 */
export function webviewHtml(cspSource: string, scriptUri: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src ${cspSource};" />
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
<div class="hd"><b>&#x259A; reef</b> &mdash; <span id="task">idle</span></div>
<form class="chat" id="chat"><input id="chat-input" autocomplete="off" placeholder="Let's build..." /><button id="chat-submit" type="submit">Run</button></form>
<div id="timeline"></div>
<div id="proof"></div>
<script src="${scriptUri}"></script>
</body>
</html>`;
}
