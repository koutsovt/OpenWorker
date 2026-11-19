// The dashboard page: one self-contained HTML file with no external resources, so it works offline and
// under a strict content security policy. All text from the run is escaped before it is shown.
export const DASHBOARD_PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenWorker live</title>
<style>
:root{--bg:#f6f5f1;--card:#fff;--ink:#1f1e1b;--mute:#6f6d66;--faint:#a9a69c;--line:#e4e1d8;--good:#1f8a5b;--good-bg:#e3f4ea;--warn:#a5640b;--warn-bg:#fbefd9;--bad:#b3352f;--bad-bg:#fbe6e4;--info:#2b62b0;--info-bg:#e5eefb;--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--card:#1f1f1c;--ink:#ecebe6;--mute:#a3a197;--faint:#6d6b63;--line:#33322d;--good:#57c08c;--good-bg:#173126;--warn:#e0a94a;--warn-bg:#342813;--bad:#ec7d75;--bad-bg:#3a1c1a;--info:#7fb0f0;--info-bg:#18273c}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 var(--sans)}
.wrap{max-width:1280px;margin:0 auto;padding:20px}
.frame{background:var(--card);border:1px solid var(--line);border-radius:18px;overflow:hidden}
.bar{display:flex;align-items:center;gap:8px;padding:10px 16px;border-bottom:1px solid var(--line);font:12px var(--mono);color:var(--mute)}
.dot{width:11px;height:11px;border-radius:50%;display:inline-block}
.bar .mid{flex:1;text-align:center}
.pill{font:11px var(--mono);padding:2px 8px;border-radius:6px;border:1px solid currentColor;white-space:nowrap}
header{display:grid;grid-template-columns:auto 1fr auto;gap:24px;align-items:center;padding:22px 24px;border-bottom:1px solid var(--line)}
.disc{width:84px;height:84px;border-radius:50%;border:1px solid var(--line);display:grid;place-items:center;font:28px var(--mono);background:var(--bg)}
.disc.run{animation:breathe 2s ease-in-out infinite}@keyframes breathe{50%{box-shadow:0 0 0 8px var(--info-bg)}}
h1{margin:0;font:600 28px var(--mono);letter-spacing:-.5px}h1 b{color:var(--info);font-weight:600}
.sub{font:13px var(--mono);color:var(--mute);margin-top:4px}
.latest{display:inline-block;margin-top:8px;font:11px var(--mono);text-transform:uppercase;letter-spacing:.5px;padding:3px 8px;border:1px dashed var(--faint);border-radius:6px;color:var(--mute);max-width:520px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tag{font:12px var(--mono);color:var(--faint);margin-top:6px}
.stats{display:grid;grid-template-columns:repeat(2,auto);gap:4px 36px}
.stat b{display:block;font:600 30px var(--mono);letter-spacing:-1px}.stat span{font:11px var(--mono);color:var(--mute)}
.body{display:grid;grid-template-columns:300px 1fr;min-height:600px}
aside{border-right:1px solid var(--line);padding:16px}
.label{font:11px var(--mono);color:var(--mute);text-transform:uppercase;letter-spacing:1px;display:flex;justify-content:space-between;margin:0 0 10px}
.agent{border:1px solid var(--line);border-radius:12px;padding:12px;margin-bottom:10px;transition:box-shadow .3s,border-color .3s}
.agent.busy{border-color:var(--info);box-shadow:0 0 0 3px var(--info-bg)}
.agent .top{display:flex;gap:10px;align-items:flex-start}
.icon{width:34px;height:34px;border-radius:9px;display:grid;place-items:center;font:600 13px var(--mono);flex:none}
.agent .name{font:600 14px var(--mono);text-transform:uppercase;letter-spacing:.5px}
.agent .purpose{font-size:12px;color:var(--mute);line-height:1.35}
.agent .rule{font-size:12px;margin:8px 0 2px;font-style:italic}
.agent .lastline{font:11px var(--mono);color:var(--mute);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.agent .badge{margin-left:auto}
main{padding:16px 20px;display:flex;flex-direction:column;gap:16px;min-width:0}
.panel{border:1px solid var(--line);border-radius:12px;padding:14px}
.flow{display:grid;grid-template-columns:repeat(6,1fr);gap:8px}
.stage{border:1px solid var(--line);border-radius:10px;padding:8px;min-height:120px;background:var(--bg)}
.stage h3{margin:0 0 6px;font:600 11px var(--mono);letter-spacing:1px;color:var(--mute);text-transform:uppercase;display:flex;justify-content:space-between}
.stage.on{border-color:var(--info);background:var(--info-bg)}.stage.on h3{color:var(--info)}
.chip{font:11px var(--mono);border:1px solid var(--line);background:var(--card);border-radius:7px;padding:5px 6px;margin-bottom:5px;display:flex;justify-content:space-between;gap:4px;align-items:center}
.chip .n{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.s-running{border-color:var(--info)}.s-done{border-color:var(--good)}.s-failed,.s-blocked{border-color:var(--bad)}.s-retrying,.s-attention{border-color:var(--warn)}
.sd{width:8px;height:8px;border-radius:50%;flex:none;background:var(--faint)}
.sd.running{background:var(--info);animation:pulse 1s infinite}.sd.done{background:var(--good)}.sd.failed,.sd.blocked{background:var(--bad)}.sd.retrying,.sd.attention{background:var(--warn)}
@keyframes pulse{50%{opacity:.3}}
.ask{border:2px solid var(--warn);background:var(--warn-bg);border-radius:12px;padding:14px}
.ask h2{margin:0 0 8px;font:600 15px var(--mono)}
.ask .tasks div{font:12px var(--mono);padding:4px 0;border-top:1px dashed var(--line)}
.ask pre{font:12px var(--mono);white-space:pre-wrap;max-height:220px;overflow:auto;background:var(--card);padding:8px;border-radius:8px}
.ask textarea{width:100%;min-height:60px;font:13px var(--sans);border:1px solid var(--line);border-radius:8px;padding:8px;background:var(--card);color:var(--ink)}
button{font:600 13px var(--mono);padding:8px 14px;border-radius:8px;border:1px solid var(--ink);background:var(--ink);color:var(--card);cursor:pointer;margin-right:8px}
button.ghost{background:transparent;color:var(--ink)}
.err{color:var(--bad);font-size:12px;margin-top:6px}
.two{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.big{font:600 26px var(--mono)}
table{width:100%;border-collapse:collapse;font-size:12px}td{padding:5px 4px;border-top:1px solid var(--line);vertical-align:top}
.tail{background:#14140f;color:#d8d6cc;border-radius:12px;padding:12px;font:12px/1.55 var(--mono);min-height:200px;max-height:300px;overflow:auto}
.tail .t{color:#8d8a7e}.tail .r{color:#9a978b;padding-left:62px}.tail .good{color:#7fd6a5}.tail .warn{color:#f0c06a}.tail .bad{color:#f39a92}.tail .info{color:#9cc3f5}
.cursor{display:inline-block;width:7px;height:13px;background:#7fd6a5;vertical-align:-2px;animation:pulse 1s steps(1) infinite}
.meter{height:10px;border-radius:6px;background:var(--bg);border:1px solid var(--line);overflow:hidden}.meter i{display:block;height:100%;background:var(--good);transition:width .5s}
.log .row{display:grid;grid-template-columns:64px 92px 1fr;gap:10px;padding:8px 0;border-top:1px solid var(--line);align-items:start}
.log .time{font:12px var(--mono);color:var(--mute)}
.kind{font:600 10px var(--mono);text-align:center;padding:3px 0;border-radius:6px;letter-spacing:.5px}
.good-k{background:var(--good-bg);color:var(--good)}.warn-k{background:var(--warn-bg);color:var(--warn)}.bad-k{background:var(--bad-bg);color:var(--bad)}.info-k{background:var(--info-bg);color:var(--info)}
.log .txt{font:13px var(--mono)}.log .why{font-size:12px;color:var(--mute)}
a{color:var(--info)}
.more{font:600 11px var(--mono);color:var(--info);background:none;border:0;padding:0 0 0 4px;margin:0;cursor:pointer;text-decoration:underline}
.muted{color:var(--mute)}
@media (max-width:900px){.body{grid-template-columns:1fr}aside{border-right:0;border-bottom:1px solid var(--line)}.flow{grid-template-columns:repeat(3,1fr)}.two{grid-template-columns:1fr}header{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="wrap"><div class="frame">
  <div class="bar"><span class="dot" style="background:#e5675e"></span><span class="dot" style="background:#e9b44c"></span><span class="dot" style="background:#5cbf6a"></span>
    <span class="mid" id="barmid">OpenWorker</span><span class="pill" id="conn">connecting</span></div>
  <header>
    <div class="disc" id="disc">··</div>
    <div>
      <h1><b>OpenWorker</b> <span id="title"></span></h1>
      <div class="sub" id="status">connecting…</div>
      <div class="latest" id="latest">waiting for the first event</div>
      <div class="tag">every decision gets a reason · all of it in the audit ledger</div>
    </div>
    <div class="stats">
      <div class="stat"><b id="s-tasks">0/0</b><span>tasks done</span></div>
      <div class="stat"><b id="s-evidence">0</b><span>passages read</span></div>
      <div class="stat"><b id="s-findings">–</b><span>open findings c · m · m</span></div>
      <div class="stat"><b id="s-tokens">0</b><span>tokens in · out</span></div>
    </div>
  </header>
  <div class="body">
    <aside>
      <p class="label"><span>Agents</span><span id="online"></span></p>
      <div id="agents"></div>
      <div class="agent" id="you"><div class="top"><div class="icon" style="background:var(--ink);color:var(--card)">YOU</div>
        <div><div class="name">You</div><div class="purpose">approve the plan, read the brief</div></div><span class="pill badge" id="you-badge">watching</span></div>
        <div class="rule">nothing runs without your yes</div><div class="lastline" id="you-last">plan gate, tool approvals, overrides</div></div>
    </aside>
    <main>
      <div id="question"></div>
      <div class="panel">
        <p class="label"><span>Live flow · plan → approve → work → assure → rework → report</span><span id="stage"></span></p>
        <div class="flow" id="flow"></div>
      </div>
      <div class="two">
        <div class="panel">
          <p class="label"><span>Assurance · latest verdict</span><span id="indep"></span></p>
          <div id="verdict" class="muted">No review yet. The platform reviews every run once the planned work is done.</div>
        </div>
        <div>
          <p class="label"><span>$ tail -f audit ledger</span><span id="tailcount"></span></p>
          <div class="tail" id="tail"></div>
        </div>
      </div>
      <div class="panel">
        <p class="label"><span>Result · progress</span><span id="elapsed2"></span></p>
        <div class="meter"><i id="meter" style="width:0"></i></div>
        <div style="display:flex;justify-content:space-between;margin-top:8px;font:12px var(--mono)" class="muted"><span id="progress-text"></span><span id="reports"></span></div>
      </div>
      <div class="panel log">
        <p class="label"><span>Log</span><span>newest first</span></p>
        <div id="log"></div>
      </div>
    </main>
  </div>
</div></div>
<script>
const token = new URLSearchParams(location.search).get('t') || '';
const $ = (id) => document.getElementById(id);
// Rebuilds a section only when its content changed, so a button is not replaced under a click.
const html = (id, value) => { const el = $(id); if (el.dataset.html !== value) { el.dataset.html = value; el.innerHTML = value; } };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const dur = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; return (h ? String(h).padStart(2,'0') + ':' : '') + String(m).padStart(2,'0') + ':' + String(s % 60).padStart(2,'0'); };
const k = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n);
const hues = [[43,98,176],[31,138,91],[165,100,11],[179,53,47],[120,80,170],[18,120,130],[150,90,40]];
const colour = (id) => { let h = 0; for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0; const [r,g,b] = hues[h % hues.length]; return { fg: 'rgb(' + r + ',' + g + ',' + b + ')', bg: 'rgba(' + r + ',' + g + ',' + b + ',.13)' }; };
const STAGES = [['plan','Plan'],['approve','Approve'],['work','Work'],['assure','Assure'],['rework','Rework'],['report','Report']];
const stageOf = (t) => t.id === 'planning' ? 'plan' : t.id === 'report' ? 'report' : (t.id === 'assurance' || t.id === 'assurance-2') ? 'assure' : t.id.endsWith('-rework') ? 'rework' : t.id === 'assessment' ? 'work' : 'work';
const activeStage = { planning:'plan', approval:'approve', working:'work', assessing:'work', assurance:'assure', rework:'rework', report:'report' };
const STATUS = { planning:'planning', approval:'waiting for approval', working:'agents working', assessing:'assessing capabilities', assurance:'independent review', rework:'rework round', report:'writing the report', done:'finished', held:'held by assurance', failed:'stopped' };
let S = null, answered = null;
// Long text is cut to a few lines; what a person opened stays open across the page's refreshes.
const open = new Set();
const more = (key, text, limit) => {
  const t = String(text ?? '');
  if (t.length <= limit) return esc(t);
  return open.has(key) ? esc(t) + '<button class="more" data-more="' + esc(key) + '">Show less</button>'
    : esc(t.slice(0, limit).replace(/\s+\S*$/, '')) + '…<button class="more" data-more="' + esc(key) + '">Show more</button>';
};
document.addEventListener('click', (e) => {
  const key = e.target && e.target.getAttribute && e.target.getAttribute('data-more');
  if (!key) return;
  if (open.has(key)) open.delete(key); else open.add(key);
  render();
});

function render() {
  if (!S) return;
  const tasks = S.tasks, done = tasks.filter((t) => t.status === 'done').length, now = Date.now(), elapsed = now - S.startedAt;
  const running = !['done','held','failed'].includes(S.stage);
  $('title').textContent = S.title.replace(/^OpenWorker\s*·?\s*/, '');
  $('barmid').textContent = 'OpenWorker live · ' + (S.runId || 'starting') + ' · ' + new Set(tasks.map((t) => t.agent)).size + ' agents · ledger first';
  $('disc').textContent = S.stage === 'done' ? '■' : S.stage === 'held' ? '!' : S.stage === 'failed' ? '✗' : S.question ? '?' : '❚❚';
  $('disc').className = 'disc' + (running && !S.question ? ' run' : '');
  html('status', '<span style="color:' + (S.stage === 'done' ? 'var(--good)' : S.stage === 'held' || S.stage === 'failed' ? 'var(--bad)' : S.question ? 'var(--warn)' : 'var(--info)') + '">●</span> ' + esc(STATUS[S.stage] || S.stage) + ' · ' + dur(elapsed));
  const last = S.events[S.events.length - 1];
  $('latest').textContent = last ? last.text : 'waiting for the first event';
  $('s-tasks').textContent = done + '/' + tasks.length;
  $('s-evidence').textContent = S.totals.evidence;
  $('s-findings').textContent = S.verdict ? S.verdict.critical + '·' + S.verdict.major + '·' + S.verdict.minor : '–';
  $('s-tokens').textContent = k(S.totals.tokensIn) + '·' + k(S.totals.tokensOut);

  const byAgent = new Map();
  for (const t of tasks) { const list = byAgent.get(t.agent) || []; list.push(t); byAgent.set(t.agent, list); }
  const agentIds = [...new Set([...S.agents.map((a) => a.id).filter((id) => byAgent.has(id)), ...byAgent.keys()])].filter(Boolean);
  $('online').textContent = agentIds.length + ' in this run';
  html('agents', agentIds.map((id) => {
    const info = S.agents.find((a) => a.id === id) || { purpose: '', rule: '' };
    const list = byAgent.get(id) || [], live = list.find((t) => t.status === 'running'), latest = live || [...list].reverse().find((t) => t.status !== 'waiting');
    const badge = live ? ['working','info'] : list.some((t) => t.status === 'failed') ? ['failed','bad'] : list.some((t) => t.status === 'retrying') ? ['retry','warn'] : list.length && list.every((t) => t.status === 'done') ? ['done','good'] : ['idle',''];
    const c = colour(id);
    const lastText = live ? live.id + ' · ' + (live.last || 'thinking') : latest ? latest.id + ' · ' + latest.status + (latest.tools ? ' · ' + latest.tools + ' tools' : '') : 'waiting';
    return '<div class="agent' + (live ? ' busy' : '') + '"><div class="top"><div class="icon" style="background:' + c.bg + ';color:' + c.fg + '">' + esc(id.slice(0, 2).toUpperCase()) + '</div>'
      + '<div style="min-width:0"><div class="name" style="color:' + c.fg + '">' + esc(id) + '</div><div class="purpose">' + esc(info.purpose) + '</div></div>'
      + '<span class="pill badge" style="color:' + (badge[1] ? 'var(--' + badge[1] + ')' : 'var(--mute)') + '">' + badge[0] + '</span></div>'
      + '<div class="rule" style="color:' + c.fg + '">' + esc(info.rule) + '</div><div class="lastline">' + esc(lastText) + '</div></div>';
  }).join(''));
  $('you-badge').textContent = S.question ? 'your turn' : running ? 'watching' : 'reading';
  $('you-badge').style.color = S.question ? 'var(--warn)' : 'var(--mute)';
  $('you').className = 'agent' + (S.question ? ' busy' : '');

  const on = activeStage[S.stage];
  $('stage').textContent = 'stage: ' + (STATUS[S.stage] || S.stage);
  html('flow', STAGES.map(([key, name]) => {
    let chips = tasks.filter((t) => stageOf(t) === key);
    if (key === 'approve') chips = S.stage === 'approval' || S.question ? [{ id: S.question ? 'your answer' : 'plan gate', status: 'running', agent: 'you' }] : tasks.some((t) => t.id !== 'planning' && t.status !== 'waiting') ? [{ id: 'approved', status: 'done', agent: 'you' }] : [];
    return '<div class="stage' + (on === key ? ' on' : '') + '"><h3><span>' + name + '</span><span>' + (chips.length || '') + '</span></h3>'
      + chips.map((t) => '<div class="chip s-' + t.status + '" title="' + esc(t.agent) + '"><span class="n">' + esc(t.id) + '</span><span class="sd ' + t.status + '"></span></div>').join('') + '</div>';
  }).join(''));

  renderQuestion();

  if (S.verdict) {
    const v = S.verdict, d = S.details[v.task];
    const findings = d && Array.isArray(d.findings) ? d.findings : [];
    html('indep', v.independent ? '<span style="color:var(--good)">independent</span>' : '<span style="color:var(--warn)">independence reduced</span>');
    html('verdict', '<div style="display:flex;justify-content:space-between;align-items:baseline"><span class="big">' + esc(v.task) + '</span><span class="pill" style="color:var(--' + (v.verdict === 'pass' ? 'good' : v.verdict === 'fail' ? 'bad' : 'warn') + ')">' + esc(v.verdict) + '</span></div>'
      + (d && d.summary ? '<p style="font-size:13px">' + more('summary:' + v.task, d.summary, 280) + '</p>' : '')
      + (findings.length ? '<table>' + findings.slice(0, 8).map((f, i) => '<tr><td style="width:62px;color:var(--' + (f.severity === 'critical' ? 'bad' : f.severity === 'major' ? 'warn' : 'mute') + ');font:600 11px var(--mono)">' + esc(f.severity) + '</td><td style="font:11px var(--mono);width:120px">' + esc(f.task) + '</td><td>' + more('finding:' + v.task + ':' + i, f.issue, 160) + '</td></tr>').join('') + '</table>' : '<p class="muted">No findings.</p>'));
  }

  const tail = S.events.slice(-14);
  $('tailcount').textContent = S.events.length + ' events';
  html('tail', tail.map((e) => '<div><span class="t">' + esc(e.at.slice(11, 19)) + '</span> <span class="' + e.tone + '">' + esc(e.kind.padEnd(9)) + '</span> ' + esc(e.text) + '</div>' + (e.reason ? '<div class="r">' + esc(e.reason) + '</div>' : '')).join('') + '<span class="cursor"></span>');
  $('tail').scrollTop = 1e9;

  const pct = tasks.length ? Math.round(done / tasks.length * 100) : 0;
  $('meter').style.width = pct + '%';
  $('progress-text').textContent = done + ' of ' + tasks.length + ' tasks · ' + S.totals.modelCalls + ' model calls · ' + S.totals.toolCalls + ' tool calls · cost ' + (S.totals.costUnknown ? 'unknown' : '$' + S.totals.costUsd.toFixed(2));
  $('elapsed2').textContent = dur(elapsed);
  html('reports', S.reports.map((r) => '<a target="_blank" href="/report?t=' + encodeURIComponent(token) + '&name=' + encodeURIComponent(r) + '">' + esc(r) + '</a>').join(' · '));

  html('log', [...S.events].reverse().slice(0, 80).map((e) => '<div class="row"><span class="time">' + esc(e.at.slice(11, 16)) + '</span><span class="kind ' + e.tone + '-k">' + esc(e.kind) + '</span><div><div class="txt">' + esc(e.text) + '</div>' + (e.reason ? '<div class="why">reason: ' + more('reason:' + e.seq, e.reason, 220) + '</div>' : '') + '</div></div>').join('') || '<p class="muted">Nothing yet.</p>');
}

function renderQuestion() {
  const q = S.question, box = $('question');
  if (!q) { box.innerHTML = ''; answered = null; return; }
  if (answered === q.id || box.dataset.id === q.id) return;
  box.dataset.id = q.id;
  let detail = '';
  const plan = S.plan;
  if (q.kind === 'confirm' && plan && Array.isArray(plan.tasks) && /plan/i.test(q.title)) {
    detail = '<div class="tasks">' + plan.tasks.map((t) => '<div><b>' + esc(t.id) + '</b> · ' + esc(t.agent) + (t.dependsOn && t.dependsOn.length ? ' · after ' + esc(t.dependsOn.join(', ')) : '') + '<div class="muted" style="font-family:var(--sans)">' + esc(t.objective) + '</div></div>').join('') + '</div>'
      + (plan.uncovered && plan.uncovered.length ? '<p style="color:var(--bad);font:600 12px var(--mono)">NOT COVERED: ' + plan.uncovered.map((u) => esc(u.need)).join('; ') + '</p>' : '')
      + '<p class="muted" style="font-size:12px">Then, run by the platform: independent assurance, one rework round if needed, and the report.</p>';
  } else if (q.body !== null && q.body !== undefined) detail = '<pre>' + esc(typeof q.body === 'string' ? q.body : JSON.stringify(q.body, null, 2)) + '</pre>';
  box.innerHTML = '<div class="ask"><h2>' + esc(q.title) + '</h2>' + detail
    + (q.kind === 'confirm' ? '<button id="yes">Approve</button><button class="ghost" id="no">Deny</button>'
      : '<textarea id="reason" placeholder="The reason, recorded in the ledger and printed in the report"></textarea><div style="margin-top:8px"><button id="send">Override with this reason</button><button class="ghost" id="stop">Stop here</button></div>')
    + '<div class="err" id="err"></div><p class="muted" style="font-size:12px;margin:8px 0 0">You can also answer on the terminal. The same policy checks apply either way.</p></div>';
  const send = async (answer) => {
    const r = await fetch('/answer?t=' + encodeURIComponent(token), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: q.id, answer }) });
    if (r.ok) { answered = q.id; box.innerHTML = '<div class="ask"><h2>Answer sent</h2></div>'; } else $('err').textContent = await r.text();
  };
  if (q.kind === 'confirm') { $('yes').onclick = () => send('y'); $('no').onclick = () => send('n'); }
  else {
    $('send').onclick = () => { const v = $('reason').value.trim(); if (!v) { $('err').textContent = 'Enter a reason first.'; return; } send(v); };
    $('stop').onclick = () => send('');
    $('reason').oninput = () => { $('err').textContent = ''; };
  }
}

const events = new EventSource('/events?t=' + encodeURIComponent(token));
events.onmessage = (m) => { S = JSON.parse(m.data); $('conn').textContent = 'live'; $('conn').style.color = 'var(--good)'; render(); };
events.onerror = () => { $('conn').textContent = S && ['done','held','failed'].includes(S.stage) ? 'run ended' : 'reconnecting'; $('conn').style.color = 'var(--mute)'; };
setInterval(render, 1000);
</script>
</body>
</html>`;
