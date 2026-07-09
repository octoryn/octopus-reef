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

export function powersWebviewHtml(
  cspSource: string,
  scriptUri: string,
): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src ${cspSource};" />
<style>
  :root{--deep:#091315;--panel:#0f1d20;--panel2:#132529;--line:#214044;--ink:#edf6f4;--muted:#86a5a5;--signal:#3de0be;--warn:#ffd166;--danger:#ff6b6b;--mono:ui-monospace,Menlo,monospace}
  body{margin:0;background:var(--deep);color:var(--ink);font-family:var(--mono);font-size:13px}
  header{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--line);background:var(--panel)}
  header b{color:var(--signal)}
  main{padding:16px;display:grid;gap:16px}
  h2{font-size:12px;letter-spacing:0;text-transform:uppercase;color:var(--muted);margin:0 0 8px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  .list{display:grid;gap:8px}
  .item{border:1px solid var(--line);border-radius:8px;background:var(--panel);padding:12px;display:grid;gap:8px}
  .top{display:flex;align-items:center;justify-content:space-between;gap:10px}
  .name{font-weight:700;color:var(--ink)}
  .meta{color:var(--muted);font-size:12px}
  .tools{display:flex;flex-wrap:wrap;gap:6px}
  .tool{border:1px solid var(--line);border-radius:999px;padding:2px 8px;color:var(--muted)}
  .tool.allow{color:var(--signal);border-color:rgba(61,224,190,.5)}
  button{background:var(--signal);border:0;border-radius:6px;color:#001714;font:inherit;font-weight:700;padding:7px 10px}
  button.secondary{background:var(--panel2);border:1px solid var(--line);color:var(--ink)}
  button.danger{background:var(--panel2);border:1px solid rgba(255,107,107,.55);color:var(--danger)}
  form{border:1px solid var(--line);border-radius:8px;background:var(--panel);padding:12px;display:grid;gap:8px}
  label{display:grid;gap:4px;color:var(--muted)}
  input,textarea{min-width:0;background:var(--panel2);border:1px solid var(--line);border-radius:6px;color:var(--ink);font:inherit;padding:8px;outline:none}
  textarea{min-height:88px;resize:vertical}
  input:focus,textarea:focus{border-color:var(--signal)}
  .actions{display:flex;gap:8px;flex-wrap:wrap}
  .status{border-left:3px solid var(--line);padding:8px 10px;background:var(--panel);color:var(--muted)}
  .status.ok{border-color:var(--signal);color:var(--signal)}
  .status.bad{border-color:var(--danger);color:var(--danger)}
  .status.warn{border-color:var(--warn);color:var(--warn)}
  @media (max-width:860px){.grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<header><div><b>&#x259A; reef</b> powers</div><button id="refresh" class="secondary" type="button">Refresh</button></header>
<main>
  <section class="grid">
    <div><h2>Installed</h2><div id="installed" class="list"></div></div>
    <div><h2>Available</h2><div id="available" class="list"></div></div>
  </section>
  <section>
    <h2>Add Custom Power</h2>
    <form id="custom">
      <label>Name<input id="custom-name" placeholder="Local filesystem MCP" /></label>
      <label>Command<input id="custom-command" placeholder="/path/to/server" /></label>
      <label>Args JSON<textarea id="custom-args" spellcheck="false" placeholder='["--root", "/tmp"]'></textarea></label>
      <label>URL<input id="custom-url" placeholder="http://127.0.0.1:9000/mcp" /></label>
      <label>Tools JSON<textarea id="custom-tools" spellcheck="false" placeholder='[{"name":"echo","description":"Echo text","inputSchema":{"type":"object"}}]'></textarea></label>
      <div class="actions"><button type="submit">Add Custom Power</button></div>
    </form>
  </section>
  <section>
    <h2>Governed Demo</h2>
    <div class="actions">
      <button id="run-allowed" type="button">Call Allowed MCP Tool</button>
      <button id="run-denied" class="danger" type="button">Prove Denial</button>
    </div>
  </section>
  <div id="status" class="status">Waiting for Powers.</div>
</main>
<script src="${scriptUri}"></script>
</body>
</html>`;
}

export function specsWebviewHtml(
  cspSource: string,
  scriptUri: string,
): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src ${cspSource};" />
<style>
  :root{--deep:#091315;--panel:#0f1d20;--panel2:#132529;--line:#214044;--ink:#edf6f4;--muted:#86a5a5;--signal:#3de0be;--warn:#ffd166;--danger:#ff6b6b;--blue:#8bb8ff;--mono:ui-monospace,Menlo,monospace}
  body{margin:0;background:var(--deep);color:var(--ink);font-family:var(--mono);font-size:13px}
  header{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--line);background:var(--panel)}
  header b{color:var(--signal)}
  main{display:grid;grid-template-columns:290px 1fr;min-height:calc(100vh - 50px)}
  aside{border-right:1px solid var(--line);padding:14px;display:grid;align-content:start;gap:12px;background:#0b1719}
  section{padding:16px;display:grid;align-content:start;gap:14px}
  h2{font-size:12px;letter-spacing:0;text-transform:uppercase;color:var(--muted);margin:0}
  form{border:1px solid var(--line);border-radius:8px;background:var(--panel);padding:12px;display:grid;gap:8px}
  label{display:grid;gap:4px;color:var(--muted)}
  input,textarea,select{min-width:0;background:var(--panel2);border:1px solid var(--line);border-radius:6px;color:var(--ink);font:inherit;padding:8px;outline:none}
  textarea{min-height:92px;resize:vertical}
  input:focus,textarea:focus,select:focus{border-color:var(--signal)}
  button{background:var(--signal);border:0;border-radius:6px;color:#001714;font:inherit;font-weight:700;padding:7px 10px}
  button.secondary{background:var(--panel2);border:1px solid var(--line);color:var(--ink)}
  button.danger{background:var(--panel2);border:1px solid rgba(255,107,107,.55);color:var(--danger)}
  .list{display:grid;gap:8px}.spec{border:1px solid var(--line);border-radius:8px;background:var(--panel);padding:10px;text-align:left;color:var(--ink)}
  .spec.active{border-color:var(--signal)}.spec .name{font-weight:700}.meta{color:var(--muted);font-size:12px}
  .summary{display:flex;gap:8px;flex-wrap:wrap}.pill{border:1px solid var(--line);border-radius:999px;padding:2px 8px;color:var(--muted)}
  .pill.ok{color:var(--signal);border-color:rgba(61,224,190,.5)}.pill.bad{color:var(--danger);border-color:rgba(255,107,107,.55)}
  .task{border:1px solid var(--line);border-radius:8px;background:var(--panel);padding:12px;display:grid;gap:8px}
  .task-head{display:flex;justify-content:space-between;gap:12px;align-items:start}.state{color:var(--blue)}
  .actions{display:flex;gap:8px;flex-wrap:wrap}.history{display:grid;gap:4px}
  .transition{display:grid;grid-template-columns:48px 1fr auto;gap:8px;color:var(--muted)}
  .transition b{color:var(--ink);font-weight:400}.evidence{color:var(--signal)}
  .status{border-left:3px solid var(--line);padding:8px 10px;background:var(--panel);color:var(--muted)}
  .status.ok{border-color:var(--signal);color:var(--signal)}.status.bad{border-color:var(--danger);color:var(--danger)}.status.warn{border-color:var(--warn);color:var(--warn)}
  @media (max-width:880px){main{grid-template-columns:1fr}aside{border-right:0;border-bottom:1px solid var(--line)}}
</style>
</head>
<body>
<header><div><b>&#x259A; reef</b> specs</div><div class="actions"><button id="refresh" class="secondary" type="button">Refresh</button><button id="verify" class="secondary" type="button">Verify</button></div></header>
<main>
  <aside>
    <h2>Specs</h2>
    <div id="specs" class="list"></div>
    <form id="create">
      <h2>Create New Spec</h2>
      <label>Title<input id="title" placeholder="Governed work plan" /></label>
      <label>Tasks<textarea id="tasks" spellcheck="false">Clarify requirements
Design governed change
Implement and verify</textarea></label>
      <button type="submit">Create New Spec</button>
    </form>
  </aside>
  <section>
    <div id="detail"></div>
    <div id="status" class="status">Waiting for Specs.</div>
  </section>
</main>
<script src="${scriptUri}"></script>
</body>
</html>`;
}

export function usageWebviewHtml(
  cspSource: string,
  scriptUri: string,
): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src ${cspSource};" />
<style>
  :root{--deep:#091315;--panel:#0f1d20;--panel2:#132529;--line:#214044;--ink:#edf6f4;--muted:#86a5a5;--signal:#3de0be;--warn:#ffd166;--danger:#ff6b6b;--blue:#8bb8ff;--mono:ui-monospace,Menlo,monospace}
  body{margin:0;background:var(--deep);color:var(--ink);font-family:var(--mono);font-size:13px}
  header{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--line);background:var(--panel)}
  header b{color:var(--signal)}
  main{padding:16px;display:grid;gap:16px}
  h2{font-size:12px;letter-spacing:0;text-transform:uppercase;color:var(--muted);margin:0 0 8px}
  .totals{display:grid;grid-template-columns:repeat(4,minmax(120px,1fr));gap:10px}
  .tile{border:1px solid var(--line);border-radius:8px;background:var(--panel);padding:12px;min-height:66px}
  .label{color:var(--muted);font-size:12px}.value{font-size:19px;color:var(--ink);margin-top:6px}
  .grid{display:grid;grid-template-columns:1.1fr .9fr;gap:14px}
  .list{display:grid;gap:8px}.row{border:1px solid var(--line);border-radius:8px;background:var(--panel);padding:10px;display:grid;gap:6px}
  .top{display:flex;justify-content:space-between;gap:10px}.name{font-weight:700}.meta{color:var(--muted);font-size:12px}
  .pill{border:1px solid var(--line);border-radius:999px;padding:2px 8px;color:var(--muted);white-space:nowrap}
  .pill.ok{color:var(--signal);border-color:rgba(61,224,190,.5)}.pill.warn{color:var(--warn);border-color:rgba(255,209,102,.55)}
  .pill.bad{color:var(--danger);border-color:rgba(255,107,107,.55)}
  button{background:var(--panel2);border:1px solid var(--line);border-radius:6px;color:var(--ink);font:inherit;font-weight:700;padding:7px 10px}
  .status{border-left:3px solid var(--line);padding:8px 10px;background:var(--panel);color:var(--muted)}
  .status.ok{border-color:var(--signal);color:var(--signal)}.status.bad{border-color:var(--danger);color:var(--danger)}.status.warn{border-color:var(--warn);color:var(--warn)}
  @media (max-width:880px){.grid,.totals{grid-template-columns:1fr}}
</style>
</head>
<body>
<header><div><b>&#x259A; reef</b> usage</div><button id="refresh" type="button">Refresh</button></header>
<main>
  <section>
    <h2>Used</h2>
    <div id="totals" class="totals"></div>
  </section>
  <section class="grid">
    <div><h2>Sessions</h2><div id="sessions" class="list"></div></div>
    <div><h2>Providers</h2><div id="providers" class="list"></div></div>
  </section>
  <section>
    <h2>Remaining</h2>
    <div id="remaining" class="list"></div>
  </section>
  <div id="status" class="status">Waiting for usage.</div>
</main>
<script src="${scriptUri}"></script>
</body>
</html>`;
}

export function steeringWebviewHtml(
  cspSource: string,
  scriptUri: string,
): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src ${cspSource};" />
<style>
  :root{--deep:#091315;--panel:#0f1d20;--panel2:#132529;--line:#214044;--ink:#edf6f4;--muted:#86a5a5;--signal:#3de0be;--warn:#ffd166;--danger:#ff6b6b;--blue:#8bb8ff;--mono:ui-monospace,Menlo,monospace}
  body{margin:0;background:var(--deep);color:var(--ink);font-family:var(--mono);font-size:13px}
  header{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--line);background:var(--panel)}
  header b{color:var(--signal)}
  main{display:grid;grid-template-columns:minmax(300px,.95fr) 1fr;min-height:calc(100vh - 50px)}
  aside{border-right:1px solid var(--line);padding:14px;display:grid;align-content:start;gap:12px;background:#0b1719}
  section{padding:16px;display:grid;align-content:start;gap:14px}
  h2{font-size:12px;letter-spacing:0;text-transform:uppercase;color:var(--muted);margin:0}
  .list{display:grid;gap:8px}.item{border:1px solid var(--line);border-radius:8px;background:var(--panel);padding:10px;display:grid;gap:7px}
  .top{display:flex;justify-content:space-between;gap:10px;align-items:start}.name{font-weight:700}.meta{color:var(--muted);font-size:12px}
  .hash{color:var(--signal)}.pill{border:1px solid var(--line);border-radius:999px;padding:2px 8px;color:var(--muted);white-space:nowrap}
  .pill.ok{color:var(--signal);border-color:rgba(61,224,190,.5)}
  label.check{display:flex;gap:8px;align-items:flex-start;color:var(--ink)}input[type="checkbox"]{margin-top:2px}
  form{border:1px solid var(--line);border-radius:8px;background:var(--panel);padding:12px;display:grid;gap:8px}
  label.field{display:grid;gap:4px;color:var(--muted)}
  input,textarea,select{min-width:0;background:var(--panel2);border:1px solid var(--line);border-radius:6px;color:var(--ink);font:inherit;padding:8px;outline:none}
  textarea{min-height:86px;resize:vertical}input:focus,textarea:focus,select:focus{border-color:var(--signal)}
  button{background:var(--signal);border:0;border-radius:6px;color:#001714;font:inherit;font-weight:700;padding:7px 10px}
  button.secondary{background:var(--panel2);border:1px solid var(--line);color:var(--ink)}
  .actions{display:flex;gap:8px;flex-wrap:wrap}.status{border-left:3px solid var(--line);padding:8px 10px;background:var(--panel);color:var(--muted)}
  .status.ok{border-color:var(--signal);color:var(--signal)}.status.bad{border-color:var(--danger);color:var(--danger)}.status.warn{border-color:var(--warn);color:var(--warn)}
  @media (max-width:880px){main{grid-template-columns:1fr}aside{border-right:0;border-bottom:1px solid var(--line)}}
</style>
</head>
<body>
<header><div><b>&#x259A; reef</b> steering</div><div class="actions"><button id="refresh" class="secondary" type="button">Refresh</button><button id="run" type="button">Run Mock Session</button></div></header>
<main>
  <aside>
    <h2>Available</h2>
    <div id="available" class="list"></div>
    <div class="actions"><button id="apply" type="button">Apply Active Set</button></div>
  </aside>
  <section>
    <h2>Active Set</h2>
    <div id="active" class="list"></div>
    <form id="custom">
      <h2>Add Custom Steering</h2>
      <label class="field">Title<input id="custom-title" placeholder="Review discipline" /></label>
      <label class="field">Kind<select id="custom-kind"><option value="doc">doc</option><option value="skill">skill</option></select></label>
      <label class="field">Content<textarea id="custom-content" spellcheck="false"></textarea></label>
      <label class="field">Mock Effect<input id="custom-effect" placeholder="N3 steering applied: ..." /></label>
      <button type="submit">Add Custom Steering</button>
    </form>
    <div id="status" class="status">Waiting for steering.</div>
  </section>
</main>
<script src="${scriptUri}"></script>
</body>
</html>`;
}

export function hooksWebviewHtml(
  cspSource: string,
  scriptUri: string,
): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src ${cspSource};" />
<style>
  :root{--deep:#091315;--panel:#0f1d20;--panel2:#132529;--line:#214044;--ink:#edf6f4;--muted:#86a5a5;--signal:#3de0be;--warn:#ffd166;--danger:#ff6b6b;--mono:ui-monospace,Menlo,monospace}
  body{margin:0;background:var(--deep);color:var(--ink);font-family:var(--mono);font-size:13px}
  header{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--line);background:var(--panel)}
  header b{color:var(--signal)}
  main{display:grid;grid-template-columns:310px 1fr;min-height:calc(100vh - 50px)}
  aside{border-right:1px solid var(--line);padding:14px;display:grid;align-content:start;gap:12px;background:#0b1719}
  section{padding:16px;display:grid;align-content:start;gap:14px}
  h2{font-size:12px;letter-spacing:0;text-transform:uppercase;color:var(--muted);margin:0}
  form{border:1px solid var(--line);border-radius:8px;background:var(--panel);padding:12px;display:grid;gap:8px}
  label{display:grid;gap:4px;color:var(--muted)}
  input,select{min-width:0;background:var(--panel2);border:1px solid var(--line);border-radius:6px;color:var(--ink);font:inherit;padding:8px;outline:none}
  input:focus,select:focus{border-color:var(--signal)}
  button{background:var(--signal);border:0;border-radius:6px;color:#001714;font:inherit;font-weight:700;padding:7px 10px}
  button.secondary{background:var(--panel2);border:1px solid var(--line);color:var(--ink)}
  .actions{display:flex;gap:8px;flex-wrap:wrap}.list{display:grid;gap:8px}.hook{border:1px solid var(--line);border-radius:8px;background:var(--panel);padding:10px;display:grid;gap:7px}
  .top{display:flex;justify-content:space-between;gap:10px}.name{font-weight:700}.meta{color:var(--muted);font-size:12px}
  .pill{border:1px solid var(--line);border-radius:999px;padding:2px 8px;color:var(--muted);white-space:nowrap}.pill.ok{color:var(--signal);border-color:rgba(61,224,190,.5)}
  .status{border-left:3px solid var(--line);padding:8px 10px;background:var(--panel);color:var(--muted)}
  .status.ok{border-color:var(--signal);color:var(--signal)}.status.bad{border-color:var(--danger);color:var(--danger)}.status.warn{border-color:var(--warn);color:var(--warn)}
  @media (max-width:880px){main{grid-template-columns:1fr}aside{border-right:0;border-bottom:1px solid var(--line)}}
</style>
</head>
<body>
<header><div><b>&#x259A; reef</b> hooks</div><button id="refresh" class="secondary" type="button">Refresh</button></header>
<main>
  <aside>
    <h2>Define Hook</h2>
    <form id="create">
      <label>Name<input id="hook-name" placeholder="On save verifier" /></label>
      <label>Trigger<select id="hook-trigger"><option value="on-demand">on-demand</option><option value="on-save">on-save</option></select></label>
      <label>Task<input id="hook-task" placeholder="Run governed mock session" /></label>
      <button type="submit">Create Hook</button>
    </form>
  </aside>
  <section>
    <h2>Hooks</h2>
    <div id="hooks" class="list"></div>
    <div id="status" class="status">Waiting for hooks.</div>
  </section>
</main>
<script src="${scriptUri}"></script>
</body>
</html>`;
}
