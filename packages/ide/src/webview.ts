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
  :root{--bg:#0a0e15;--panel:#0d1219;--panel2:#121922;--line:rgba(255,255,255,.08);--line2:rgba(51,230,192,.34);--ink:#eef7f5;--muted:#8a97a5;--faint:#56616e;--signal:#33e6c0;--danger:#ff5e76;--warn:#ffd166;--blue:#7ab7ff;--mono:ui-monospace,SFMono-Regular,Menlo,monospace;--sans:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  *{box-sizing:border-box}
  html,body{height:100%}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:13px;letter-spacing:0}
  button,input,textarea{font:inherit}
  button{border:0;cursor:pointer}
  button:disabled,textarea:disabled{opacity:.55;cursor:default}
  .app{height:100vh;display:grid;grid-template-rows:52px 1fr auto;background:radial-gradient(circle at 50% 38%,rgba(51,230,192,.055),transparent 270px),var(--bg)}
  .tabs{height:52px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--line);padding:0 18px;background:#0a0f16}
  .tab-left{display:flex;align-items:center;gap:10px;min-width:0}
  .tab{display:flex;align-items:center;gap:9px;height:32px;padding:0 12px;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--ink);font-weight:700}
  .tab-dot{width:8px;height:8px;border-radius:50%;background:var(--signal);box-shadow:0 0 16px rgba(51,230,192,.65)}
  .icon-btn{width:32px;height:32px;border-radius:8px;border:1px solid var(--line);display:grid;place-items:center;background:var(--panel);color:var(--muted);font-weight:800}
  .icon-btn:hover{border-color:var(--line2);color:var(--ink)}
  .tab-actions{display:flex;align-items:center;gap:8px}
  main{min-height:0;overflow:auto;padding:22px 20px 18px}
  .empty{min-height:100%;display:grid;place-items:start center;padding:30px 0 28px}
  .empty-inner{width:min(720px,100%);display:grid;justify-items:center;text-align:center;padding-top:64px}
  .logo{width:88px;height:88px;margin-bottom:27px}
  .logo svg{width:100%;height:100%;display:block;overflow:visible;transform:translateY(42px) scale(.72);transform-origin:top center}
  h1{margin:0;font-size:44px;line-height:1.04;font-weight:780;letter-spacing:0}
  h1 span{color:var(--signal)}
  .subtitle{margin:15px 0 31px;color:#c8d2dc;font-size:16px;line-height:1.5}
  .shortcuts{width:min(530px,100%);display:grid;gap:10px}
  .shortcut{display:grid;grid-template-columns:38px 1fr;gap:12px;align-items:center;text-align:left;padding:13px 14px;border:1px solid var(--line);border-radius:8px;background:rgba(13,18,25,.78);color:var(--ink)}
  .shortcut:hover{border-color:rgba(51,230,192,.5);background:#111923}
  .shortcut .glyph{width:38px;height:38px;border-radius:8px;border:1px solid var(--line);background:#0a0f16;display:grid;place-items:center;color:var(--signal);font-family:var(--mono);font-weight:800}
  .shortcut b{display:block;font-size:14px}
  .shortcut span{display:block;margin-top:3px;color:var(--muted);font-size:12px;line-height:1.35}
  .diffline{margin-top:23px;color:var(--faint);font-family:var(--mono);font-size:12px}
  .conversation{display:grid;gap:18px;width:min(920px,100%);margin:0 auto;padding-bottom:8px}
  .hidden{display:none!important}
  .message{display:grid;gap:8px}
  .message.user{justify-items:end}
  .bubble{max-width:min(680px,100%);border:1px solid var(--line);border-radius:8px;padding:12px 14px;line-height:1.5;background:#111923;color:#dbe8e5;white-space:pre-wrap}
  .message.user .bubble{background:#10211f;border-color:rgba(51,230,192,.28)}
  .turn{border:1px solid var(--line);border-radius:8px;background:rgba(13,18,25,.88);overflow:hidden}
  .turn-head{display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:1px solid var(--line);padding:12px 14px}
  .turn-title{display:flex;align-items:center;gap:9px;min-width:0;font-weight:760}
  .turn-title span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .badge{border:1px solid var(--line);border-radius:999px;padding:5px 9px;font-family:var(--mono);font-size:11px;font-weight:800;color:var(--warn);white-space:nowrap}
  .badge.ok{color:var(--signal);border-color:rgba(51,230,192,.6)}
  .badge.bad{color:var(--danger);border-color:rgba(255,94,118,.58)}
  .turn-body{display:grid;grid-template-columns:1fr 1fr;gap:12px;padding:14px}
  .section{border:1px solid var(--line);border-radius:8px;background:#0b1118;padding:12px;min-width:0}
  .section.wide{grid-column:1 / -1}
  .section h2{margin:0 0 9px;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:0;font-weight:800}
  ul{margin:0;padding-left:17px;display:grid;gap:6px}
  li{line-height:1.42}
  li span{color:var(--muted);font-family:var(--mono);font-size:11px}
  li.bad b{color:var(--danger)}li.ok b{color:var(--signal)}
  pre{margin:0;white-space:pre-wrap;overflow:auto;max-height:220px;color:#dbe8e5;font-family:var(--mono);font-size:12px;line-height:1.45}
  .evidence{display:grid;grid-template-columns:34px 72px 1fr 88px;gap:8px;align-items:start;border-bottom:1px solid rgba(255,255,255,.055);padding:6px 0;color:var(--muted);font-family:var(--mono);font-size:11px}
  .evidence span:nth-child(3){color:var(--ink);font-family:var(--sans);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .evidence.ok span:nth-child(2){color:var(--signal)}.evidence.bad span:nth-child(2),.evidence.bad span:nth-child(3){color:var(--danger)}
  .turn-foot{display:flex;align-items:center;justify-content:space-between;gap:10px;border-top:1px solid var(--line);padding:10px 14px;color:var(--muted);font-family:var(--mono);font-size:11px}
  .verify-btn{border:1px solid var(--line);border-radius:7px;background:#111923;color:var(--ink);padding:6px 9px;font-weight:800}
  .verify-btn:hover{border-color:var(--line2)}
  .approval{display:flex;align-items:center;gap:8px;color:var(--muted)}
  .approval-card{width:min(680px,100%);justify-self:end;border:1px solid rgba(255,209,102,.42);border-radius:8px;background:#19150a;padding:12px 14px;display:grid;gap:10px;color:#f3df9f}
  .approval-card button{width:max-content;border-radius:7px;background:var(--warn);color:#1b1300;font-weight:800;padding:7px 11px}
  .composer{border-top:1px solid var(--line);background:#0a0f16;padding:14px 18px}
  .composer form{width:min(920px,100%);margin:0 auto;display:grid;grid-template-columns:auto auto 1fr auto auto auto;gap:9px;align-items:center;border:1px solid var(--line);border-radius:12px;background:var(--panel);padding:9px}
  textarea{min-width:0;width:100%;height:40px;max-height:130px;resize:none;background:transparent;border:0;color:var(--ink);outline:none;padding:10px 4px;line-height:1.35}
  textarea::placeholder{color:#65717e}
  .model{border:1px solid var(--line);border-radius:999px;color:#c4d0da;background:#101720;padding:7px 10px;font-family:var(--mono);font-size:11px;white-space:nowrap}
  .toggle{display:flex;align-items:center;gap:7px;border:1px solid var(--line);border-radius:999px;background:#101720;color:var(--muted);padding:5px 8px;font-family:var(--mono);font-size:11px}
  .switch{width:28px;height:16px;border-radius:999px;background:#26303b;position:relative}
  .switch::after{content:"";position:absolute;width:12px;height:12px;border-radius:50%;left:2px;top:2px;background:#8793a0;transition:transform .15s,background .15s}
  .toggle.on{color:var(--signal);border-color:rgba(51,230,192,.45)}
  .toggle.on .switch::after{transform:translateX(12px);background:var(--signal)}
  .send{width:38px;height:38px;border-radius:10px;background:var(--signal);color:#021411;font-size:19px;font-weight:900;display:grid;place-items:center}
  .send:disabled{background:#23313a;color:#71808d}
  .usage{width:min(920px,100%);margin:9px auto 0;display:grid;grid-template-columns:110px 120px minmax(220px,1fr) minmax(260px,1fr);gap:8px;color:var(--muted)}
  .usage div{border:1px solid var(--line);border-radius:8px;background:#0b1118;padding:8px;min-width:0}
  .usage b{display:block;color:var(--signal);font-family:var(--mono);font-size:12px;overflow:hidden;text-overflow:ellipsis}
  .usage span{display:block;margin-top:2px;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  @media (max-width:760px){h1{font-size:34px}.turn-body{grid-template-columns:1fr}.composer form{grid-template-columns:auto auto 1fr auto}.model,.toggle{grid-column:1 / -1;width:max-content}.usage{grid-template-columns:1fr 1fr}.evidence{grid-template-columns:28px 56px 1fr}.evidence span:last-child{display:none}}
  @media (max-height:820px){.empty{padding-top:24px}.empty-inner{padding-top:48px}.logo{width:74px;height:74px;margin-bottom:16px}.subtitle{margin-bottom:18px}.shortcuts{gap:8px}.shortcut{padding:10px 12px}.diffline{margin-top:15px}}
</style>
</head>
<body>
<div class="app">
  <header class="tabs">
    <div class="tab-left">
      <div class="tab"><span class="tab-dot"></span><span>New Session</span></div>
      <button class="icon-btn" id="new-session" type="button" title="New Session">+</button>
    </div>
    <div class="tab-actions">
      <button class="icon-btn" type="button" title="More">...</button>
    </div>
  </header>
  <main id="main">
    <section id="empty" class="empty">
      <div class="empty-inner">
        <div class="logo" aria-label="Reef octopus logo">
          <svg viewBox="0 0 96 96" role="img" aria-hidden="true">
            <defs><linearGradient id="reef-octo" x1="17" x2="81" y1="18" y2="79"><stop stop-color="#10a8ff"/><stop offset=".55" stop-color="#33e6c0"/><stop offset="1" stop-color="#bb35ff"/></linearGradient></defs>
            <path d="M22 57c-6-23 9-42 26-42s32 19 26 42" fill="none" stroke="url(#reef-octo)" stroke-width="16" stroke-linecap="round"/>
            <path d="M39 58c0 11-4 18-13 22 7 4 16 2 22-7M57 58c0 11 4 18 13 22-7 4-16 2-22-7M48 60c0 13-4 20-12 25M48 60c0 13 4 20 12 25" fill="none" stroke="url(#reef-octo)" stroke-width="5" stroke-linecap="round"/>
          </svg>
        </div>
        <h1>Let&rsquo;s <span>build.</span></h1>
        <div class="subtitle">Describe a task &mdash; Reef gets it done, and proves every step.</div>
        <div class="shortcuts">
          <button class="shortcut" type="button" data-shortcut="Spec"><span class="glyph">SP</span><span><b>Spec</b><span>Shape a governed workstate spec before the run.</span></span></button>
          <button class="shortcut" type="button" data-shortcut="Plan"><span class="glyph">PL</span><span><b>Plan</b><span>Ask for the sequence of actions before edits begin.</span></span></button>
          <button class="shortcut" type="button" data-shortcut="Bug Fix"><span class="glyph">BF</span><span><b>Bug Fix</b><span>Trace a failure, patch it, and verify the result.</span></span></button>
          <button class="shortcut" type="button" data-shortcut="Replay"><span class="glyph">RP</span><span><b>Replay</b><span>Re-check evidence and explain what changed.</span></span></button>
        </div>
        <div class="diffline">every action is evidence-chained · verify green, tamper &rarr; red</div>
      </div>
    </section>
    <section id="conversation" class="conversation hidden" aria-live="polite"></section>
  </main>
  <footer class="composer">
    <form id="chat">
      <button id="hash" class="icon-btn" type="button" title="Reference">#</button>
      <button id="attach" class="icon-btn" type="button" title="Attach">&#8679;</button>
      <textarea id="chat-input" spellcheck="false" placeholder="Ask a question or describe a task..."></textarea>
      <div id="model-chip" class="model">Mock · Offline</div>
      <button id="autopilot" class="toggle" type="button" aria-pressed="false"><span class="switch"></span><span>Autopilot</span></button>
      <button id="chat-submit" class="send" type="submit" title="Send">&rsaquo;</button>
    </form>
    <div id="usage" class="usage">
      <div><b>0</b><span>tokens used</span></div>
      <div><b>$0.000000</b><span>cost</span></div>
      <div><b>0 calls</b><span>provider usage from evidence</span></div>
      <div><b>remaining</b><span>not available from the offline mock provider</span></div>
    </div>
  </footer>
</div>
<script src="${scriptUri}"></script>
</body>
</html>`;
}

export function welcomeWebviewHtml(
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
  :root{--deep:#071113;--panel:#0e1c1f;--panel2:#13262a;--line:#244348;--ink:#eff8f6;--muted:#88a7a7;--signal:#3de0be;--blue:#8bb8ff;--warn:#ffd166;--danger:#ff6b6b;--mono:ui-monospace,Menlo,monospace;--sans:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;background:var(--deep);color:var(--ink);font-family:var(--sans);font-size:14px}
  .shell{min-height:100vh;display:grid;grid-template-rows:auto 1fr auto}
  header{display:flex;align-items:center;justify-content:space-between;padding:18px 28px;border-bottom:1px solid var(--line);background:#091719}
  .brand{display:flex;align-items:center;gap:11px;font-weight:750;letter-spacing:0}
  .mark{width:28px;height:28px;display:grid;place-items:center;border:1px solid rgba(61,224,190,.55);border-radius:8px;color:var(--signal);font-family:var(--mono);background:#102326}
  .tag{color:var(--muted);font-size:12px}
  main{display:grid;grid-template-columns:minmax(320px,.95fr) minmax(420px,1.05fr);gap:28px;align-items:center;padding:34px clamp(28px,5vw,68px)}
  h1{font-size:48px;line-height:1.02;margin:0;letter-spacing:0;font-weight:760;max-width:690px}
  .pitch{margin:18px 0 0;color:var(--signal);font-size:17px;font-weight:650}
  .body{margin:14px 0 0;color:var(--muted);font-size:15px;line-height:1.6;max-width:590px}
  .proofline{display:flex;flex-wrap:wrap;gap:8px;margin-top:26px}
  .pill{border:1px solid var(--line);border-radius:999px;padding:6px 10px;color:var(--muted);font-family:var(--mono);font-size:12px;background:#0b181b}
  .pill.signal{color:var(--signal);border-color:rgba(61,224,190,.48)}
  .actions{display:grid;gap:12px}
  .action{width:100%;text-align:left;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--ink);padding:18px 18px;display:grid;grid-template-columns:42px 1fr auto;align-items:center;gap:14px;font:inherit;cursor:pointer}
  .action:hover{border-color:rgba(61,224,190,.65);background:var(--panel2)}
  .action:focus{outline:2px solid rgba(61,224,190,.75);outline-offset:2px}
  .action.primary{background:#102a2d;border-color:rgba(61,224,190,.7)}
  .icon{width:42px;height:42px;border-radius:8px;display:grid;place-items:center;background:#091719;border:1px solid var(--line);font-family:var(--mono);color:var(--signal);font-weight:800}
  .title{display:block;font-weight:760;font-size:16px}
  .desc{display:block;color:var(--muted);font-size:13px;margin-top:4px}
  .arrow{color:var(--muted);font-size:20px}
  footer{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:14px 28px;border-top:1px solid var(--line);background:#091719;color:var(--muted);font-family:var(--mono);font-size:12px}
  .link{background:transparent;border:0;color:var(--muted);font:inherit;text-decoration:underline;cursor:pointer;padding:4px}
  .link:hover{color:var(--ink)}
  .status.ok{color:var(--signal)}.status.bad{color:var(--danger)}
  @media (max-width:850px){main{grid-template-columns:1fr;align-items:start;padding:24px}h1{font-size:36px}header,footer{padding-left:18px;padding-right:18px}.tag{display:none}}
</style>
</head>
<body>
<div class="shell">
  <header>
    <div class="brand"><div class="mark">&#x259A;</div><div>Reef</div></div>
    <div class="tag">governed agentic workspace</div>
  </header>
  <main>
    <section>
      <h1>Start work with proof built in.</h1>
      <div class="pitch">The agentic workspace where every action is provable.</div>
      <p class="body">Open a project, reconnect to recent work, or clone a repository. Reef keeps governed sessions, evidence links, usage, specs, powers, steering, and hooks in one local-first editor surface.</p>
      <div class="proofline" aria-label="Reef proof surfaces">
        <span class="pill signal">tamper-evident evidence</span>
        <span class="pill">offline mock driver</span>
        <span class="pill">BYOK when configured</span>
      </div>
    </section>
    <section class="actions" aria-label="Getting started actions">
      <button class="action primary" type="button" data-action="openProject">
        <span class="icon">OP</span>
        <span><span class="title">Open a project</span><span class="desc">Choose a local folder and start a governed Reef session.</span></span>
        <span class="arrow">&rsaquo;</span>
      </button>
      <button class="action" type="button" data-action="openRecent">
        <span class="icon">RC</span>
        <span><span class="title">Recent projects</span><span class="desc">Jump back into a workspace you already opened.</span></span>
        <span class="arrow">&rsaquo;</span>
      </button>
      <button class="action" type="button" data-action="cloneConnect">
        <span class="icon">CL</span>
        <span><span class="title">Clone or connect</span><span class="desc">Bring in a repository, then let Reef prove what happened.</span></span>
        <span class="arrow">&rsaquo;</span>
      </button>
    </section>
  </main>
  <footer>
    <div id="status" class="status">Ready.</div>
    <button id="disable" class="link" type="button">Do not show on startup</button>
  </footer>
</div>
<script src="${scriptUri}"></script>
</body>
</html>`;
}

export function agentFocusWebviewHtml(
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
  :root{--deep:#071113;--panel:#0e1c1f;--panel2:#13262a;--line:#244348;--ink:#eff8f6;--muted:#88a7a7;--signal:#3de0be;--blue:#8bb8ff;--warn:#ffd166;--danger:#ff6b6b;--mono:ui-monospace,Menlo,monospace;--sans:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  *{box-sizing:border-box}
  body{margin:0;min-height:100vh;background:var(--deep);color:var(--ink);font-family:var(--sans);font-size:13px}
  button,input,textarea{font:inherit}
  button{border:0;border-radius:6px;cursor:pointer}
  button:disabled,textarea:disabled{opacity:.58;cursor:default}
  .shell{min-height:100vh;display:grid;grid-template-rows:auto 1fr auto}
  header{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 16px;border-bottom:1px solid var(--line);background:#091719}
  .brand{display:flex;align-items:center;gap:10px;font-weight:760}
  .mark{width:28px;height:28px;display:grid;place-items:center;border:1px solid rgba(61,224,190,.55);border-radius:8px;color:var(--signal);font-family:var(--mono);background:#102326}
  .mode{color:var(--muted);font-family:var(--mono);font-size:12px}
  .toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .tool{background:var(--panel2);border:1px solid var(--line);color:var(--ink);padding:7px 10px;font-weight:700}
  .tool.primary{background:var(--signal);border-color:var(--signal);color:#001714}
  main{display:grid;grid-template-columns:280px minmax(390px,1fr) 330px;min-height:0}
  aside{border-right:1px solid var(--line);background:#0a1719;padding:14px;display:grid;align-content:start;gap:12px;min-width:0}
  .center{padding:14px;display:grid;grid-template-rows:auto auto 1fr;gap:12px;min-width:0;min-height:0}
  .right{border-left:1px solid var(--line);padding:14px;display:grid;grid-template-rows:auto 1fr;gap:12px;min-width:0;min-height:0;background:#0a1719}
  h2{font-size:12px;letter-spacing:0;text-transform:uppercase;color:var(--muted);margin:0}
  .new{display:flex;justify-content:space-between;gap:8px;align-items:center}
  .task-list{display:grid;gap:8px}
  .task{width:100%;text-align:left;border:1px solid var(--line);border-radius:8px;background:var(--panel);color:var(--ink);padding:10px;display:grid;gap:5px}
  .task.active{border-color:var(--signal);background:#102326}
  .task-title{font-weight:720;line-height:1.3}
  .task-meta{font-family:var(--mono);font-size:11px;color:var(--muted)}
  .task-pill{width:max-content;border:1px solid var(--line);border-radius:999px;padding:2px 7px;color:var(--muted);font-family:var(--mono);font-size:11px}
  .task-pill.ok{color:var(--signal);border-color:rgba(61,224,190,.55)}.task-pill.bad{color:var(--danger);border-color:rgba(255,107,107,.55)}
  .empty{color:var(--muted);border:1px dashed var(--line);border-radius:8px;padding:12px}
  .prompt{border:1px solid var(--line);border-radius:8px;background:var(--panel);padding:12px;display:grid;gap:10px}
  textarea{width:100%;min-height:96px;resize:vertical;background:var(--panel2);border:1px solid var(--line);border-radius:6px;color:var(--ink);padding:10px;outline:none}
  textarea:focus{border-color:var(--signal)}
  .prompt-actions{display:flex;justify-content:space-between;align-items:center;gap:10px}
  .hint{color:var(--muted);font-family:var(--mono);font-size:12px}
  .run{background:var(--signal);color:#001714;font-weight:760;padding:8px 12px}
  .stage-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px;min-height:0}
  .stage{border:1px solid var(--line);border-radius:8px;background:var(--panel);padding:12px;display:grid;align-content:start;gap:10px;min-width:0}
  .stage.wide{grid-column:1 / -1;min-height:180px;overflow:auto}
  ul{margin:0;padding-left:18px;display:grid;gap:6px}
  li{line-height:1.4}li.ok b{color:var(--signal)}li.bad b{color:var(--danger)}li span{color:var(--muted);font-family:var(--mono);font-size:12px}
  pre{margin:0;white-space:pre-wrap;overflow:auto;color:#dbe8e5;font-family:var(--mono);font-size:12px;line-height:1.45}
  .badge{border:1px solid var(--line);border-radius:8px;background:var(--panel);padding:12px;font-family:var(--mono);font-weight:760;line-height:1.45}
  .badge.ok{color:var(--signal);border-color:rgba(61,224,190,.65)}.badge.bad{color:var(--danger);border-color:rgba(255,107,107,.65)}.badge.pending{color:var(--warn);border-color:rgba(255,209,102,.55)}
  .timeline{display:grid;gap:6px;align-content:start;overflow:auto;min-height:0}
  .evidence{display:grid;grid-template-columns:34px 62px 1fr 78px;gap:8px;align-items:start;border-bottom:1px solid rgba(36,67,72,.55);padding:6px 0;color:var(--muted);font-family:var(--mono);font-size:11px}
  .evidence span:nth-child(3){color:var(--ink);font-family:var(--sans);font-size:12px;overflow:hidden;text-overflow:ellipsis}
  .evidence.ok span:nth-child(2){color:var(--signal)}.evidence.bad span:nth-child(2),.evidence.bad span:nth-child(3){color:var(--danger)}
  footer{display:grid;grid-template-columns:1fr auto;gap:12px;align-items:center;border-top:1px solid var(--line);background:#091719;padding:10px 16px}
  .usage{display:grid;grid-template-columns:110px 120px minmax(220px,1fr) minmax(260px,1fr);gap:10px;align-items:stretch}
  .usage div{border:1px solid var(--line);border-radius:8px;background:var(--panel);padding:8px;display:grid;gap:2px;min-width:0}
  .usage b{color:var(--signal)}.usage span{color:var(--muted);font-size:12px;overflow:hidden;text-overflow:ellipsis}
  .status{font-family:var(--mono);color:var(--muted);font-size:12px}.status.ok{color:var(--signal)}.status.bad{color:var(--danger)}.status.warn{color:var(--warn)}
  @media (max-width:1050px){main{grid-template-columns:240px 1fr}.right{grid-column:1 / -1;border-left:0;border-top:1px solid var(--line);min-height:280px}.usage{grid-template-columns:1fr 1fr}.usage .wide{grid-column:auto}}
  @media (max-width:760px){main{grid-template-columns:1fr}aside,.right{border:0;border-bottom:1px solid var(--line)}.stage-grid{grid-template-columns:1fr}footer{grid-template-columns:1fr}.usage{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="shell">
  <header>
    <div class="brand"><div class="mark">&#x259A;</div><div>Reef Agent Focus</div><div id="window-mode" class="mode">IDE window</div></div>
    <div class="toolbar">
      <button id="focus-window" class="tool primary" type="button">Focus</button>
      <button id="ide-window" class="tool" type="button">IDE</button>
      <button id="verify-run" class="tool" type="button">Verify</button>
    </div>
  </header>
  <main>
    <aside>
      <div class="new"><h2>Tasks</h2><button id="new-task" class="tool" type="button">New Task</button></div>
      <div id="task-list" class="task-list"></div>
    </aside>
    <section class="center">
      <div class="prompt">
        <textarea id="task-prompt" spellcheck="false" placeholder="Ask Reef to make a governed change...">N7b offline mock: open Agent Focus and prove the run</textarea>
        <div class="prompt-actions"><span class="hint">Cmd/Ctrl+Enter runs with MockDriver when no key is configured.</span><button id="run-task" class="run" type="button">Run Governed Task</button></div>
      </div>
      <div id="verify-badge" class="badge pending">PENDING</div>
      <div class="stage-grid">
        <div class="stage"><h2>Plan</h2><ul id="plan"><li>Waiting for governed plan.</li></ul></div>
        <div class="stage"><h2>Actions</h2><ul id="actions"><li>Waiting for actions.</li></ul></div>
        <div class="stage wide"><h2>Diff</h2><pre id="diff"></pre></div>
      </div>
    </section>
    <section class="right">
      <h2>Evidence Timeline</h2>
      <div id="timeline" class="timeline"></div>
    </section>
  </main>
  <footer>
    <div id="usage" class="usage">
      <div><b>0</b><span>tokens</span></div>
      <div><b>$0.000000</b><span>cost</span></div>
      <div class="wide"><b>0</b><span>0 provider calls recorded for this governed session.</span></div>
      <div class="wide"><b>remaining</b><span>not available from the offline mock provider</span></div>
    </div>
    <div id="status" class="status">Ready.</div>
  </footer>
</div>
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

export function browserWebviewHtml(
  cspSource: string,
  scriptUri: string,
): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy"
  content="default-src 'none'; frame-src http://127.0.0.1:* http://localhost:* https://127.0.0.1:* https://localhost:*; img-src ${cspSource} data:; style-src ${cspSource} 'unsafe-inline'; script-src ${cspSource};" />
<style>
  :root{--deep:#091315;--panel:#0f1d20;--panel2:#132529;--line:#214044;--ink:#edf6f4;--muted:#86a5a5;--signal:#3de0be;--warn:#ffd166;--danger:#ff6b6b;--mono:ui-monospace,Menlo,monospace}
  *{box-sizing:border-box}
  body{margin:0;background:var(--deep);color:var(--ink);font-family:var(--mono);font-size:13px;min-height:100vh}
  .shell{min-height:100vh;display:grid;grid-template-rows:auto 1fr auto;background:var(--deep)}
  header{display:grid;gap:10px;padding:12px;border-bottom:1px solid var(--line);background:var(--panel)}
  .brand{display:flex;align-items:center;justify-content:space-between;gap:10px}
  .brand b{color:var(--signal)}
  form{display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:center}
  input{min-width:0;background:var(--panel2);border:1px solid var(--line);border-radius:6px;color:var(--ink);font:inherit;padding:8px;outline:none}
  input:focus{border-color:var(--signal)}
  button{background:var(--signal);border:0;border-radius:6px;color:#001714;font:inherit;font-weight:700;padding:8px 10px}
  button.secondary{background:var(--panel2);border:1px solid var(--line);color:var(--ink)}
  button.danger{background:var(--panel2);border:1px solid rgba(255,107,107,.55);color:var(--danger)}
  .actions{display:grid;grid-template-columns:1fr auto auto;gap:8px;align-items:center}
  .preview{min-height:360px;background:#071012;display:grid;position:relative}
  iframe{width:100%;height:100%;min-height:360px;border:0;background:white}
  .empty{position:absolute;inset:0;display:grid;place-items:center;color:var(--muted);padding:20px;text-align:center;pointer-events:none}
  .empty.hidden{display:none}
  .annotation-layer{position:absolute;inset:0;display:none;cursor:crosshair;background:rgba(9,19,21,.08);z-index:2}
  .annotation-layer.active{display:block}
  .annotation-box{position:absolute;border:2px solid var(--signal);background:rgba(61,224,190,.16);box-shadow:0 0 0 9999px rgba(0,0,0,.18);display:none}
  .annotation-box.active{display:block}
  .status{border-left:3px solid var(--line);padding:8px 10px;background:var(--panel);color:var(--muted)}
  .status.ok{border-color:var(--signal);color:var(--signal)}
  .status.bad{border-color:var(--danger);color:var(--danger)}
  .status.warn{border-color:var(--warn);color:var(--warn)}
  footer{display:grid;gap:8px;padding:12px;border-top:1px solid var(--line);background:var(--panel)}
  .note{color:var(--muted);font-size:12px;line-height:1.45}
</style>
</head>
<body>
<div class="shell">
  <header>
    <div class="brand"><div><b>&#x259A; reef</b> browser</div><button id="reload" class="secondary" type="button">Reload</button></div>
    <form id="nav">
      <input id="url" value="http://127.0.0.1:5173/" spellcheck="false" />
      <button type="submit">Open</button>
      <button id="read" class="secondary" type="button">Governed Read</button>
    </form>
    <div class="actions">
      <input id="annotationNote" placeholder="Annotation note" value="Inspect this element" />
      <button id="annotate" class="secondary" type="button">Annotate</button>
      <button id="deny" class="danger" type="button">Prove Denial</button>
    </div>
  </header>
  <main class="preview">
    <iframe id="frame" title="Reef Browser preview" sandbox="allow-forms allow-scripts allow-same-origin"></iframe>
    <div id="annotationLayer" class="annotation-layer"><div id="annotationBox" class="annotation-box"></div></div>
    <div id="empty" class="empty">Open a localhost URL to preview it here.</div>
  </main>
  <footer>
    <div id="status" class="status">Waiting for a local preview URL.</div>
    <div class="note">Preview rendering is an iframe. Governed DOM/content/screenshot reads use local Chrome CDP and are recorded as evidence links.</div>
  </footer>
</div>
<script src="${scriptUri}"></script>
</body>
</html>`;
}

export function specsWebviewHtml(cspSource: string, scriptUri: string): string {
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

export function usageWebviewHtml(cspSource: string, scriptUri: string): string {
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

export function accountWebviewHtml(
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
  *{box-sizing:border-box}
  body{margin:0;background:var(--deep);color:var(--ink);font-family:var(--mono);font-size:13px}
  header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px;border-bottom:1px solid var(--line);background:var(--panel)}
  header b{color:var(--signal)}
  main{padding:16px;display:grid;gap:14px}
  .toolbar{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}
  h2{font-size:12px;letter-spacing:0;text-transform:uppercase;color:var(--muted);margin:0 0 8px}
  .grid{display:grid;grid-template-columns:repeat(2,minmax(220px,1fr));gap:12px}
  .card{border:1px solid var(--line);border-radius:8px;background:var(--panel);padding:12px;display:grid;gap:9px;min-width:0}
  .kv{display:grid;grid-template-columns:112px 1fr;gap:8px;align-items:start}
  .key{color:var(--muted)}.value{color:var(--ink);overflow-wrap:anywhere}
  .totals{display:grid;grid-template-columns:repeat(4,minmax(90px,1fr));gap:8px}
  .tile{border:1px solid var(--line);border-radius:8px;background:#0b1719;padding:10px;min-height:58px}
  .tile .key{font-size:11px}.tile .value{font-size:16px;margin-top:4px;color:var(--signal)}
  .pill{border:1px solid var(--line);border-radius:999px;padding:3px 8px;color:var(--muted);white-space:nowrap;width:max-content}
  .pill.ok{color:var(--signal);border-color:rgba(61,224,190,.55)}.pill.warn{color:var(--warn);border-color:rgba(255,209,102,.55)}.pill.bad{color:var(--danger);border-color:rgba(255,107,107,.55)}
  button{background:var(--panel2);border:1px solid var(--line);border-radius:6px;color:var(--ink);font:inherit;font-weight:700;padding:7px 10px}
  button.primary{background:var(--signal);border-color:var(--signal);color:#001714}
  button:disabled{opacity:.55}
  .status{border-left:3px solid var(--line);padding:8px 10px;background:var(--panel);color:var(--muted)}
  .status.ok{border-color:var(--signal);color:var(--signal)}.status.bad{border-color:var(--danger);color:var(--danger)}.status.warn{border-color:var(--warn);color:var(--warn)}
  @media (max-width:760px){.grid,.totals{grid-template-columns:1fr}.kv{grid-template-columns:1fr}}
</style>
</head>
<body>
<header>
  <div><b>&#x259A; reef</b> account &amp; plan</div>
  <div class="toolbar">
    <button id="refresh" type="button">Refresh</button>
    <button id="evidence" type="button">Record Evidence</button>
  </div>
</header>
<main>
  <section class="grid">
    <article class="card">
      <h2>Identity</h2>
      <div id="edition" class="pill">loading</div>
      <div class="kv"><div class="key">Provider</div><div id="identity" class="value">loading</div></div>
      <div class="kv"><div class="key">Source</div><div id="identity-source" class="value">loading</div></div>
    </article>
    <article class="card">
      <h2>Account</h2>
      <div id="entitlement" class="pill">loading</div>
      <div class="kv"><div class="key">User</div><div id="user" class="value">loading</div></div>
      <div class="kv"><div class="key">License Hash</div><div id="license" class="value">not available</div></div>
      <div class="toolbar">
        <button id="signin" class="primary" type="button">Sign In Stub</button>
        <button id="signout" type="button">Sign Out</button>
        <button id="copy" type="button">Copy User ID</button>
      </div>
    </article>
  </section>
  <section class="card">
    <h2>Usage</h2>
    <div id="usage" class="totals"></div>
    <div id="usage-source" class="value">N6 session evidence aggregation</div>
  </section>
  <section class="card">
    <h2>Plan Quota</h2>
    <div id="quota-pill" class="pill">loading</div>
    <div class="kv"><div class="key">Plan</div><div id="plan" class="value">loading</div></div>
    <div class="kv"><div class="key">Used</div><div id="quota-used" class="value">not available</div></div>
    <div class="kv"><div class="key">Remaining</div><div id="quota-remaining" class="value">not available</div></div>
    <div class="kv"><div class="key">Source</div><div id="quota-source" class="value">loading</div></div>
    <div class="toolbar"><button id="upgrade" type="button">Upgrade Plan</button></div>
  </section>
  <div id="status" class="status">Waiting for account state.</div>
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

export function hooksWebviewHtml(cspSource: string, scriptUri: string): string {
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
