// REGOS front end — plain JS, no build step.

const state = {
  projects: [],
  current: null,     // project id or null (home)
  source: null,      // EventSource for the open project
  running: false,
  drafts: {},
};

const CHIPS = {
  code: ['Where did I leave off?', 'Give me a 30-minute task for right now', 'Review my uncommitted changes'],
  pm: ['Where did I leave off?', 'Critique the deck like a hiring manager', 'Draft the LinkedIn post for this'],
  hq: ['What should I work on today?', 'Plan my week across projects', 'I want to start a new project — talk me through it'],
};

// ---------- helpers ----------

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function md(text) {
  if (window.marked && window.DOMPurify) return DOMPurify.sanitize(marked.parse(text || '', { gfm: true, breaks: false }));
  return `<p>${esc(text).replace(/\n/g, '<br>')}</p>`;
}
function mdInline(text) {
  if (window.marked && window.DOMPurify) return DOMPurify.sanitize(marked.parseInline(text || ''));
  return esc(text);
}
function ago(ms) {
  if (!ms) return 'never';
  const d = (Date.now() - ms) / 1000;
  if (d < 90) return 'just now';
  if (d < 3600) return `${Math.round(d / 60)}m ago`;
  if (d < 86400) return `${Math.round(d / 3600)}h ago`;
  const days = Math.round(d / 86400);
  return days === 1 ? 'yesterday' : `${days}d ago`;
}
function freshness(p) {
  if (p.running) return 'running';
  if (!p.lastTouched) return '';
  const days = (Date.now() - p.lastTouched) / 86400000;
  return days < 2 ? 'fresh' : days < 7 ? 'stale' : 'cold';
}
function store(key, val) {
  try { if (val === undefined) return localStorage.getItem(key); localStorage.setItem(key, val); } catch { return null; }
}
function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3200);
}
async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}
function gitBadges(p) {
  const out = [];
  if (p.type === 'hq') return out;
  if (p.exists === false) out.push(['danger', 'folder missing']);
  else if (!p.git?.isRepo) out.push(['danger', 'no git']);
  else {
    if (p.git.branch) out.push(['', p.git.branch]);
    if (p.git.uncommitted) out.push([p.git.uncommitted > 10 ? 'warn' : '', `${p.git.uncommitted} uncommitted`]);
    if (p.git.ahead) out.push(['warn', `${p.git.ahead} unpushed`]);
    if (!p.git.uncommitted && !p.git.ahead) out.push(['ok', 'clean']);
  }
  return out;
}
const badgeHtml = (list) => list.map(([cls, text]) => `<span class="badge ${cls}">${esc(String(text).toUpperCase())}</span>`).join('');

// ---------- data ----------

async function loadProjects() {
  try {
    state.projects = await api('/api/projects');
  } catch (e) {
    toast(`Could not load projects: ${e.message}`);
    return;
  }
  renderNav();
  if (!state.current) renderHome();
  else updateProjectHeader();
}
const project = (id) => state.projects.find((p) => p.id === id);

// ---------- theme (same idea as the portfolio's per-section --bg/--fg/--acc) ----------

const HOME_THEME = { bg: '#1a0033', fg: '#ffffff', acc: '#ffe600', band: 'THINK WEIRD ★ BUILD WEIRD ★ SHIP WEIRD ★' };

// Relative luminance, used to pick the darker of bg/fg as "ink" for text on accent surfaces.
function lum(hex) {
  const n = parseInt(hex.replace('#', '').padEnd(6, '0').slice(0, 6), 16);
  const ch = [n >> 16, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
const inkOf = (t) => (lum(t.bg) < lum(t.fg) ? t.bg : t.fg);
const themeOf = (p) => ({ ...HOME_THEME, ...(p?.theme || {}) });

function applyTheme(p) {
  const t = themeOf(p);
  const root = document.documentElement.style;
  root.setProperty('--bg', t.bg);
  root.setProperty('--fg', t.fg);
  root.setProperty('--acc', t.acc);
  root.setProperty('--ink', inkOf(t));
  document.body.className = [t.style, p?.type === 'hq' ? 'hq' : ''].filter(Boolean).join(' ');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t.bg);
}
// Inline CSS vars that paint one card in its own level's palette.
function cardVars(p) {
  const t = themeOf(p);
  return `--c-bg:${t.bg};--c-fg:${t.fg};--c-acc:${t.acc};--c-ink:${inkOf(t)}`;
}
const levelTag = (p) => (p.type === 'hq' ? 'HQ // CHIEF OF STAFF' : `LEVEL ${String(p.level ?? '?').padStart(2, '0')} ${p.theme?.style === 'so' ? '·' : '//'} ${p.name.toUpperCase()}`);
function bandHtml(text) {
  const run = `${text} `.repeat(8);
  return `<div class="band" aria-hidden="true"><div class="track"><span>${esc(run)}</span><span>${esc(run)}</span></div></div>`;
}
function xpBar(p) {
  if (!p.steps.length) return '';
  const done = p.steps.filter((s) => s.done).length;
  const cells = p.steps.map((s) => `<i class="${s.done ? 'on' : ''}"></i>`).join('');
  return `<div class="xp" title="${done}/${p.steps.length} steps done"><span>XP</span><div class="xp-bar">${cells}</div><span>${done}/${p.steps.length}</span></div>`;
}

// ---------- sidebar ----------

function navItem(p) {
  const sub = p.type === 'hq' ? 'plan across levels' : `${ago(p.lastTouched)}${p.nextStep ? ' · ' + p.nextStep.replace(/`/g, '') : ''}`;
  const t = themeOf(p);
  return `<button class="nav-item${state.current === p.id ? ' active' : ''}" data-id="${esc(p.id)}" title="${esc(p.blurb || '')}">
    <span class="swatch" style="background:${esc(t.acc)}"><span class="dot ${freshness(p)}"></span></span>
    <span class="nav-text"><span class="nav-lvl">${p.type === 'hq' ? 'HQ' : 'LVL ' + String(p.level ?? '?').padStart(2, '0')}</span><span class="nav-label">${esc(p.name.toUpperCase())}</span><span class="nav-sub">${esc(sub)}</span></span>
  </button>`;
}
function renderNav() {
  const byLevel = (a, b) => (a.level ?? 99) - (b.level ?? 99);
  $('#project-nav').innerHTML = state.projects.filter((p) => p.type !== 'hq').sort(byLevel).map(navItem).join('');
  $('#hq-nav').innerHTML = state.projects.filter((p) => p.type === 'hq').map(navItem).join('');
  $('[data-view="home"]').classList.toggle('active', !state.current);
}
document.querySelector('.sidebar').addEventListener('click', (e) => {
  const item = e.target.closest('.nav-item');
  if (!item) return;
  location.hash = item.dataset.id ? `#/p/${item.dataset.id}` : '#/';
});

// ---------- home: SELECT LEVEL ----------

function renderHome() {
  applyTheme(null);
  const main = $('#main');
  const active = state.projects.filter((p) => p.type !== 'hq').sort((a, b) => (a.level ?? 99) - (b.level ?? 99));
  const hq = state.projects.find((p) => p.type === 'hq');
  const hour = new Date().getHours();
  const greet = hour < 12 ? 'GOOD MORNING' : hour < 18 ? 'GOOD AFTERNOON' : 'GOOD EVENING';
  const cleared = active.filter((p) => p.steps.length && p.steps.every((s) => s.done)).length;
  // Nudge: the level with a next step that has gone longest without being touched.
  const neglected = [...active].filter((p) => p.nextStep && p.lastTouched).sort((a, b) => a.lastTouched - b.lastTouched)[0];

  main.innerHTML = `<div class="home">
    <p class="tag">${greet}, PLAYER 1_</p>
    <h1>SELECT LEVEL</h1>
    <p class="sub">${active.length} levels in progress · ${cleared}/${active.length} cleared.</p>
    <p class="hint">▶ PICK ONE ★ DO ONE SMALL STEP ★ SAVE GAME</p>
    ${neglected ? `<div class="focus">
      <div class="focus-body">
        <div class="focus-label">⚠ ${esc(levelTag(neglected))} · IDLE ${esc(ago(neglected.lastTouched).toUpperCase())}</div>
        <h2>CONTINUE?</h2>
        <p>Next quest: ${mdInline(neglected.nextStep)}</p>
      </div>
      <button class="btn primary" data-go="${esc(neglected.id)}">CONTINUE ▶</button>
      ${hq ? `<button class="btn ghost" data-go="${esc(hq.id)}">ASK HQ</button>` : ''}
    </div>` : ''}
    <div class="grid">
      ${active.map((p) => `<button class="card ${esc(p.theme?.style || '')}" style="${cardVars(p)}" data-go="${esc(p.id)}">
          <p class="tag">${esc(levelTag(p))}</p>
          <h3>${esc(p.name)}</h3>
          <p class="blurb">${esc(p.blurb || '')}</p>
          <div class="next"><b>NEXT QUEST</b>${p.nextStep ? mdInline(p.nextStep) : 'No quest yet — ask the agent.'}</div>
          ${xpBar(p)}
          <div class="badges"><span class="badge">${esc(ago(p.lastTouched).toUpperCase())}</span>${badgeHtml(gitBadges(p))}${p.running ? '<span class="badge warn">AGENT WORKING</span>' : ''}</div>
        </button>`).join('')}
    </div>
  </div>${bandHtml(HOME_THEME.band)}`;
  main.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => { location.hash = `#/p/${b.dataset.go}`; }));
}

// ---------- project view ----------

function openProject(id) {
  const p = project(id);
  if (!p) { location.hash = '#/'; return; }
  const main = $('#main');
  applyTheme(p); // swap to this level's palette
  main.replaceChildren($('#tpl-project').content.cloneNode(true));
  const root = main.firstElementChild;
  $('.ghost-text', root).textContent = p.name.toUpperCase();
  root.insertAdjacentHTML('beforeend', bandHtml(themeOf(p).band || HOME_THEME.band));

  // tabs
  root.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

  // chips
  const chips = $('.chips', root);
  chips.innerHTML = (CHIPS[p.type] || CHIPS.code).map((c) => `<button class="chip">${esc(c)}</button>`).join('');
  chips.addEventListener('click', (e) => { if (e.target.matches('.chip')) send(e.target.textContent); });

  // mode
  const mode = p.type === 'hq' ? 'talk' : (store(`regos.mode.${id}`) || 'talk');
  setMode(mode);
  root.querySelectorAll('.mode-btn').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
  if (p.type === 'hq') $('.mode', root).hidden = true;

  // composer
  const ta = $('.composer textarea', root);
  ta.value = state.drafts[id] || '';
  ta.addEventListener('input', () => { state.drafts[id] = ta.value; autosize(ta); });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(ta.value); }
  });
  $('.send', root).addEventListener('click', () => send(ta.value));
  $('.stop', root).addEventListener('click', () => api(`/api/projects/${id}/stop`, { method: 'POST' }).catch((e) => toast(e.message)));

  // header actions
  root.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () =>
    api(`/api/projects/${id}/open`, { method: 'POST', body: { target: b.dataset.open } })
      .then(() => b.dataset.open === 'terminal' && toast('Opened in Windows Terminal. Chats there won\'t show up here.'))
      .catch((e) => toast(e.message))));
  $('[data-action="new-session"]', root).addEventListener('click', async () => {
    if (!confirm('Start a new conversation? The agent keeps its PROGRESS.md memory but forgets this chat.')) return;
    try { await api(`/api/projects/${id}/new-session`, { method: 'POST' }); await loadProjects(); } catch (e) { toast(e.message); }
  });
  $('[data-action="save-progress"]', root).addEventListener('click', () =>
    api(`/api/projects/${id}/save-progress`, { method: 'POST' }).catch((e) => toast(e.message)));

  // progress editor
  $('.edit-progress', root).addEventListener('click', () => toggleEdit(true));
  $('.cancel-edit', root).addEventListener('click', () => toggleEdit(false));
  $('.save-edit', root).addEventListener('click', async () => {
    try {
      await api(`/api/projects/${id}/progress`, { method: 'PUT', body: { content: $('.progress-editor').value } });
      toggleEdit(false);
      loadProjects();
    } catch (e) { toast(e.message); }
  });

  updateProjectHeader();
  connect(id);
  if (store(`regos.tab.${id}`) === 'progress') showTab('progress');
  ta.focus();
}

function updateProjectHeader() {
  const p = project(state.current);
  const root = $('.project');
  if (!p || !root) return;
  $('.p-tag', root).textContent = levelTag(p);
  $('.p-name', root).textContent = p.type === 'hq' || p.theme?.style ? p.name : p.name.toUpperCase();
  $('.p-meta', root).innerHTML = `<span class="p-path">${esc(p.path)}</span>${badgeHtml(gitBadges(p))}`;
  $('[data-open="terminal"]', root).hidden = false;
  $('[data-open="vscode"]', root).hidden = p.type === 'hq';
  updateControls();
}

function setMode(mode) {
  const id = state.current;
  store(`regos.mode.${id}`, mode);
  document.querySelectorAll('.mode-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === mode);
    b.setAttribute('aria-checked', b.dataset.mode === mode);
  });
  const p = project(id);
  const hint = $('.mode-hint');
  if (!hint) return;
  const risky = mode === 'build' && p && p.type !== 'hq' && !p.git?.isRepo;
  hint.textContent = mode === 'build'
    ? (risky ? '⚠ Not a git repo — edits can\'t be undone.' : 'Edits files and runs dev commands. Never pushes.')
    : 'Read-only. Plans, reviews and explains.';
  hint.classList.toggle('warn', risky);
}
const currentMode = () => $('.mode-btn.active')?.dataset.mode || 'talk';

function showTab(tab) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === tab));
  $('.chat-pane').hidden = tab !== 'chat';
  $('.progress-pane').hidden = tab !== 'progress';
  store(`regos.tab.${state.current}`, tab);
  if (tab === 'progress') loadProgress();
}

async function loadProgress() {
  if (!$('.progress-pane')) return;
  try {
    const { content, path } = await api(`/api/projects/${state.current}/progress`);
    $('.progress-path').textContent = path;
    $('.progress-view').innerHTML = content ? md(content) : '<p class="empty-chat">No PROGRESS.md yet.</p>';
    $('.progress-editor').value = content;
  } catch (e) { toast(e.message); }
}
function toggleEdit(on) {
  $('.progress-view').hidden = on;
  $('.progress-editor').hidden = !on;
  $('.edit-progress').hidden = on;
  $('.save-edit').hidden = !on;
  $('.cancel-edit').hidden = !on;
  if (on) $('.progress-editor').focus(); else loadProgress();
}

function autosize(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 220) + 'px';
}

async function send(text) {
  text = (text || '').trim();
  if (!text || state.running) return;
  const id = state.current;
  try {
    await api(`/api/projects/${id}/chat`, { method: 'POST', body: { message: text, mode: currentMode() } });
    state.drafts[id] = '';
    const ta = $('.composer textarea');
    ta.value = '';
    autosize(ta);
    showTab('chat');
  } catch (e) { toast(e.message); }
}

// ---------- live chat ----------

function connect(id) {
  state.source?.close();
  const src = new EventSource(`/api/projects/${id}/events`);
  state.source = src;
  src.addEventListener('snapshot', (e) => {
    const { entries, running, kind } = JSON.parse(e.data);
    const box = $('.messages');
    box.innerHTML = '';
    if (!entries.length) box.innerHTML = emptyChat(project(id));
    entries.forEach((en) => box.appendChild(renderEntry(en)));
    setRunning(running, kind);
    scrollDown(true);
  });
  src.addEventListener('entry', (e) => {
    const box = $('.messages');
    if (!box) return;
    $('.empty-chat', box)?.remove();
    const near = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
    box.insertBefore(renderEntry(JSON.parse(e.data)), $('.thinking', box));
    scrollDown(near);
  });
  src.addEventListener('status', (e) => {
    const { running, kind } = JSON.parse(e.data);
    setRunning(running, kind);
    if (!running) loadProjects();
  });
  src.addEventListener('progress', () => { loadProgress(); loadProjects(); });
}

function emptyChat(p) {
  return `<div class="empty-chat"><h3>${esc((p?.name || '').toUpperCase())} AGENT</h3>
    <p>It remembers this level through its quest log (PROGRESS.md). Ask “Where did I leave off?” — and hit SAVE GAME before you quit.</p>
    <p class="hint">▶ PRESS START</p></div>`;
}

function renderEntry(en) {
  const el = document.createElement('div');
  el.className = `msg ${en.kind}`;
  switch (en.kind) {
    case 'user':
      el.innerHTML = `${en.mode === 'build' ? '<span class="mode-tag">build</span>' : ''}${esc(en.text)}`;
      break;
    case 'assistant':
      el.classList.add('markdown');
      el.innerHTML = md(en.text);
      break;
    case 'tool':
      el.innerHTML = `<span class="tname">${esc(en.name)}</span><span class="tdetail" title="${esc(en.detail)}">${esc(en.detail)}</span>`;
      break;
    case 'result':
      if (!en.ok) el.classList.add('err');
      el.innerHTML = en.ok
        ? `✔ DONE IN ${Math.round((en.durationMs || 0) / 1000)}S`
        : `⚠ ${esc(en.error || 'Something went wrong')}`;
      if (en.denials?.length) {
        el.innerHTML += `<span class="denied">Blocked (not allowed in this mode): ${en.denials.map(esc).join(' · ')}</span>`;
      }
      break;
    case 'divider':
      el.textContent = en.text;
      break;
    default:
      el.textContent = en.text;
  }
  return el;
}

function setRunning(running, kind) {
  state.running = running;
  const box = $('.messages');
  if (!box) return;
  $('.thinking', box)?.remove();
  if (running) {
    const t = document.createElement('div');
    t.className = 'thinking';
    t.innerHTML = `${kind === 'progress' ? 'SAVING GAME' : 'AGENT IS THINKING'}`;
    box.appendChild(t);
    scrollDown(true);
  }
  updateControls();
  const p = project(state.current);
  if (p) { p.running = running; renderNav(); }
}

function updateControls() {
  const p = project(state.current);
  if (!$('.project')) return;
  $('.send').hidden = state.running;
  $('.stop').hidden = !state.running;
  document.querySelectorAll('.chip').forEach((c) => { c.disabled = state.running; });
  $('[data-action="save-progress"]').disabled = state.running || !p?.hasSession;
  $('[data-action="new-session"]').disabled = state.running;
}

function scrollDown(force) {
  const box = $('.messages');
  if (box && force) box.scrollTop = box.scrollHeight;
}

// ---------- routing ----------

function route() {
  const m = location.hash.match(/^#\/p\/([\w-]+)/);
  const id = m ? m[1] : null;
  if (id === state.current && $('#main').children.length) return;
  state.source?.close();
  state.source = null;
  state.running = false;
  state.current = id;
  renderNav();
  if (id) openProject(id); else renderHome();
}

window.addEventListener('hashchange', route);
(async () => {
  await loadProjects();
  route();
  setInterval(loadProjects, 30000);
})();
