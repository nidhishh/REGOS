// REGOS — local hub where each project has its own Claude Code agent.
// Zero dependencies: run `node server.js` (or double-click start.cmd).

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.REGOS_PORT || 4242);
const CLAUDE_BIN = process.env.REGOS_CLAUDE_BIN || 'claude';
const PUBLIC_DIR = path.join(ROOT, 'public');

// Tools each mode may use without asking. Everything else is denied in headless runs.
const READ_TOOLS = [
  'Read', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'TodoWrite',
  'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git branch:*)',
  'Bash(ls:*)', 'Bash(pwd)',
];
const BUILD_TOOLS = [
  ...READ_TOOLS, 'Edit', 'Write', 'NotebookEdit',
  'Bash(git add:*)', 'Bash(npm run:*)', 'Bash(npm test:*)', 'Bash(npm install:*)', 'Bash(npm ci:*)',
  'Bash(npx tsx:*)', 'Bash(npx tsc:*)', 'Bash(npx vitest:*)', 'Bash(npx jest:*)', 'Bash(npx vite:*)',
  'Bash(node:*)', 'Bash(python:*)', 'Bash(py:*)', 'Bash(pip install:*)', 'Bash(pytest:*)',
  'Bash(mkdir:*)', 'Bash(cat:*)', 'Bash(head:*)', 'Bash(tail:*)', 'Bash(wc:*)', 'Bash(find:*)',
];
const ALWAYS_DENIED = ['Bash(git push:*)', 'Bash(rm -rf:*)', 'Bash(git reset --hard:*)', 'Bash(git clean:*)'];

// ---------- projects ----------

function loadProjects() {
  const list = JSON.parse(fs.readFileSync(path.join(ROOT, 'projects.json'), 'utf8'));
  return list.map((p) => ({ ...p, path: path.resolve(ROOT, p.path) }));
}
function getProject(id) {
  return loadProjects().find((p) => p.id === id);
}
const progressDir = (id) => path.join(ROOT, 'projects', id);
const progressFile = (id) => path.join(progressDir(id), 'PROGRESS.md');
const dataDir = (id) => path.join(ROOT, 'data', id);
const chatFile = (id) => path.join(dataDir(id), 'chat.jsonl');
const sessionFile = (id) => path.join(dataDir(id), 'session.json');

function readSession(id) {
  try { return JSON.parse(fs.readFileSync(sessionFile(id), 'utf8')).sessionId || null; } catch { return null; }
}
function writeSession(id, sessionId) {
  fs.mkdirSync(dataDir(id), { recursive: true });
  fs.writeFileSync(sessionFile(id), JSON.stringify({ sessionId, updated: new Date().toISOString() }, null, 2));
}

function buildSystemPrompt(project, mode) {
  const read = (f) => { try { return fs.readFileSync(path.join(ROOT, 'agents', f), 'utf8'); } catch { return ''; } };
  const modes = read('modes.md');
  const modeGuide = mode === 'terminal'
    ? '**Terminal** — interactive session; the user approves tool use as it happens.'
    : (modes.split(/<!-- mode: (\w+) -->/).reduce((acc, chunk, i, arr) => (arr[i - 1] === mode ? chunk.trim() : acc), ''));
  let custom = '';
  try { custom = fs.readFileSync(path.join(progressDir(project.id), 'AGENT.md'), 'utf8'); } catch {}
  const text = read('base.md')
    .replaceAll('{{name}}', project.name)
    .replaceAll('{{path}}', project.path)
    .replaceAll('{{progressFile}}', progressFile(project.id))
    .replaceAll('{{typeGuide}}', read(`${project.type}.md`).trim())
    .replaceAll('{{mode}}', mode[0].toUpperCase() + mode.slice(1))
    .replaceAll('{{modeGuide}}', modeGuide);
  const out = path.join(dataDir(project.id), `system-prompt.${mode}.md`);
  fs.mkdirSync(dataDir(project.id), { recursive: true });
  fs.writeFileSync(out, custom ? `${text}\n\n## Project-specific instructions\n${custom}` : text);
  return out;
}

// ---------- status: git, activity, progress ----------

function git(cwd, args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, ...args], { windowsHide: true, timeout: 10000 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

async function gitInfo(dir) {
  const status = await git(dir, ['status', '--porcelain=v1', '-b']);
  if (status === null) return { isRepo: false };
  const lines = status.split('\n').filter(Boolean);
  const head = lines[0] || '';
  const ahead = Number((head.match(/ahead (\d+)/) || [])[1] || 0);
  const last = await git(dir, ['log', '-1', '--format=%cI']);
  return {
    isRepo: true,
    branch: (head.match(/^## (?:No commits yet on )?([^.\s]+)/) || [])[1] || '',
    uncommitted: lines.length - 1,
    ahead,
    lastCommit: last ? last.trim() || null : null,
  };
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv', 'venv', 'coverage', '.cache', 'data']);
async function lastTouched(dir, depth = 0, budget = { n: 4000 }) {
  let newest = 0;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    if (budget.n-- <= 0) break;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || depth >= 5) continue;
      newest = Math.max(newest, await lastTouched(full, depth + 1, budget));
    } else if (e.isFile()) {
      try { newest = Math.max(newest, (await fsp.stat(full)).mtimeMs); } catch {}
    }
  }
  return newest;
}

function parseProgress(md) {
  const section = (name) => {
    const m = md.match(new RegExp(`^##\\s+${name}[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|(?![\\s\\S]))`, 'mi'));
    return m ? m[1] : '';
  };
  const steps = [...section('Next steps').matchAll(/^\s*[-*]\s+\[( |x|X)\]\s+(.+)$/gm)].map((m) => ({ done: m[1] !== ' ', text: m[2].trim() }));
  const goal = section('Goal').split('\n').map((l) => l.trim()).find(Boolean) || '';
  return { goal, steps, nextStep: steps.find((s) => !s.done)?.text || null };
}

const statusCache = new Map();
async function projectStatus(p) {
  const cached = statusCache.get(p.id);
  let slow;
  if (cached && Date.now() - cached.at < 60000) slow = cached.slow;
  else {
    const [gitRes, touched] = await Promise.all([p.type === 'hq' ? null : gitInfo(p.path), lastTouched(p.path)]);
    slow = { git: gitRes, lastTouched: touched || null, exists: fs.existsSync(p.path) };
    statusCache.set(p.id, { at: Date.now(), slow });
  }
  let md = '';
  try { md = fs.readFileSync(progressFile(p.id), 'utf8'); } catch {}
  return { ...p, ...slow, ...parseProgress(md), running: jobs.has(p.id), hasSession: !!readSession(p.id) };
}

// ---------- chat log + live events ----------

const subscribers = new Map(); // id -> Set<res>
const jobs = new Map(); // id -> { child, kind }

function readChat(id) {
  try {
    return fs.readFileSync(chatFile(id), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
function broadcast(id, event, data) {
  for (const res of subscribers.get(id) || []) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
function appendEntry(id, entry) {
  const e = { ts: Date.now(), ...entry };
  fs.mkdirSync(dataDir(id), { recursive: true });
  fs.appendFileSync(chatFile(id), JSON.stringify(e) + '\n');
  broadcast(id, 'entry', e);
  return e;
}
function setRunning(id, job) {
  if (job) jobs.set(id, job); else jobs.delete(id);
  broadcast(id, 'status', { running: !!job, kind: job?.kind || null });
}

function summarizeTool(project, name, input = {}) {
  const rel = (f) => (f ? path.relative(project.path, f) || f : '');
  const clip = (s, n = 140) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');
  switch (name) {
    case 'Read': case 'Edit': case 'Write': case 'NotebookEdit': return rel(input.file_path || input.notebook_path);
    case 'Bash': return clip(input.command);
    case 'Grep': return clip(`${input.pattern}${input.path ? ' in ' + rel(input.path) : ''}`);
    case 'Glob': return clip(input.pattern);
    case 'WebSearch': return clip(input.query);
    case 'WebFetch': return clip(input.url);
    case 'TodoWrite': return 'updated task list';
    case 'Agent': case 'Task': return clip(input.description);
    default: return '';
  }
}

// Run one headless Claude Code turn in the project folder.
function runAgent(project, { prompt, mode, capture = false, retried = false }) {
  return new Promise((resolve) => {
    const sessionId = readSession(project.id);
    const args = [
      '-p', '--output-format', 'stream-json', '--verbose',
      '--append-system-prompt-file', buildSystemPrompt(project, mode),
      '--add-dir', progressDir(project.id),
      '--permission-mode', mode === 'build' ? 'acceptEdits' : 'default',
      '--allowedTools', (mode === 'build' ? BUILD_TOOLS : READ_TOOLS).join(','),
      '--disallowedTools', ALWAYS_DENIED.join(','),
    ];
    if (sessionId) args.push('--resume', sessionId);

    const child = spawn(CLAUDE_BIN, args, { cwd: project.path, windowsHide: true, env: process.env });
    setRunning(project.id, { child, kind: capture ? 'progress' : 'chat' });
    child.stdin.end(prompt);

    let buf = '';
    let stderr = '';
    let captured = '';
    let gotResult = false;
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { continue; }
        if (ev.session_id && ev.session_id !== readSession(project.id)) writeSession(project.id, ev.session_id);
        if (ev.type === 'assistant') {
          for (const block of ev.message?.content || []) {
            if (block.type === 'text' && block.text.trim()) {
              if (capture) captured += block.text;
              else appendEntry(project.id, { kind: 'assistant', text: block.text });
            } else if (block.type === 'tool_use' && !capture) {
              appendEntry(project.id, { kind: 'tool', name: block.name, detail: summarizeTool(project, block.name, block.input) });
            }
          }
        } else if (ev.type === 'result') {
          gotResult = true;
          if (capture) captured = ev.result || captured;
          const denials = (ev.permission_denials || []).map((d) => `${d.tool_name}${summarizeTool(project, d.tool_name, d.tool_input) ? ': ' + summarizeTool(project, d.tool_name, d.tool_input) : ''}`);
          if (!capture || ev.is_error) {
            appendEntry(project.id, {
              kind: 'result', ok: !ev.is_error, durationMs: ev.duration_ms, turns: ev.num_turns,
              error: ev.is_error ? (ev.result || ev.subtype) : null, denials,
            });
          }
        }
      }
    });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (err) => { stderr += String(err); });
    child.on('close', (code) => {
      setRunning(project.id, null);
      statusCache.delete(project.id);
      if (!gotResult && sessionId && !retried && /no conversation found/i.test(stderr)) {
        writeSession(project.id, null); // stale session: start fresh
        return resolve(runAgent(project, { prompt, mode, capture, retried: true }));
      }
      if (!gotResult && !stopped.has(project.id)) {
        appendEntry(project.id, { kind: 'result', ok: false, error: (stderr.trim() || `claude exited with code ${code}`).slice(0, 800) });
      }
      stopped.delete(project.id);
      resolve({ ok: gotResult, captured });
    });
  });
}
const stopped = new Set();

function stopJob(id) {
  const job = jobs.get(id);
  if (!job) return false;
  stopped.add(id);
  if (process.platform === 'win32') execFile('taskkill', ['/pid', String(job.child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  else job.child.kill('SIGTERM');
  appendEntry(id, { kind: 'note', text: 'Stopped.' });
  return true;
}

async function saveProgress(project) {
  const today = new Date().toISOString().slice(0, 10);
  appendEntry(project.id, { kind: 'note', text: 'Updating PROGRESS.md…' });
  const { ok, captured } = await runAgent(project, {
    mode: 'talk',
    capture: true,
    prompt: `Update your progress file (${progressFile(project.id)}) based on this conversation and the current state of the project.
Keep the same sections: Goal, Status (with "_Updated ${today}_"), Next steps, Blockers / open questions, Log.
Next steps: ordered, small (20–60 min each), as "- [ ]" checkboxes; mark finished ones "- [x]" and drop old finished ones.
Add one dated line to the top of Log (today is ${today}) summarizing what happened. Keep at most 15 log lines.
Output ONLY the complete new file content wrapped in <progress> and </progress>. Do not edit any files.`,
  });
  const m = captured.match(/<progress>\s*([\s\S]*?)\s*<\/progress>/);
  if (!ok || !m) {
    appendEntry(project.id, { kind: 'result', ok: false, error: 'Could not update PROGRESS.md (agent returned no <progress> block).' });
    return;
  }
  backupProgress(project.id);
  fs.writeFileSync(progressFile(project.id), m[1].trim() + '\n');
  appendEntry(project.id, { kind: 'note', text: 'PROGRESS.md updated.', progress: true });
  broadcast(project.id, 'progress', {});
}

function backupProgress(id) {
  try {
    const dir = path.join(dataDir(id), 'progress-history');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(progressFile(id), path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.md`));
  } catch {}
}

function openExternal(project, target) {
  const opts = { detached: true, stdio: 'ignore', windowsHide: false };
  if (target === 'folder') return spawn('explorer', [project.path], opts).unref();
  if (target === 'vscode') return spawn('cmd', ['/c', 'code', project.path], { ...opts, windowsHide: true }).unref();
  if (target === 'terminal') {
    const args = ['-d', project.path, '--title', `REGOS · ${project.name}`, CLAUDE_BIN,
      '--append-system-prompt-file', buildSystemPrompt(project, 'terminal'), '--add-dir', progressDir(project.id)];
    const sid = readSession(project.id);
    if (sid) args.push('--resume', sid);
    return spawn('wt.exe', args, opts).unref();
  }
  throw new Error('unknown target');
}

// ---------- http ----------

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
async function readBody(req) {
  let raw = '';
  for await (const c of req) { raw += c; if (raw.length > 2e6) throw new Error('body too large'); }
  return raw ? JSON.parse(raw) : {};
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (parts[0] !== 'api') {
      const file = path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
      if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      return fs.createReadStream(file).pipe(res);
    }

    if (req.method === 'GET' && parts[1] === 'projects' && parts.length === 2) {
      return send(res, 200, await Promise.all(loadProjects().map(projectStatus)));
    }

    const project = parts[1] === 'projects' ? getProject(parts[2]) : null;
    if (!project) return send(res, 404, { error: 'unknown project' });
    const action = parts[3];
    const id = project.id;

    if (req.method === 'GET' && action === 'events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`event: snapshot\ndata: ${JSON.stringify({ entries: readChat(id), running: jobs.has(id), kind: jobs.get(id)?.kind || null })}\n\n`);
      if (!subscribers.has(id)) subscribers.set(id, new Set());
      subscribers.get(id).add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); subscribers.get(id)?.delete(res); });
      return;
    }
    if (req.method === 'GET' && action === 'progress') {
      let content = '';
      try { content = fs.readFileSync(progressFile(id), 'utf8'); } catch {}
      return send(res, 200, { content, path: progressFile(id) });
    }
    if (req.method === 'PUT' && action === 'progress') {
      const { content } = await readBody(req);
      if (typeof content !== 'string') return send(res, 400, { error: 'content required' });
      fs.mkdirSync(progressDir(id), { recursive: true });
      backupProgress(id);
      fs.writeFileSync(progressFile(id), content);
      broadcast(id, 'progress', {});
      return send(res, 200, { ok: true });
    }
    if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });

    if (action === 'chat') {
      const { message, mode } = await readBody(req);
      if (!message?.trim()) return send(res, 400, { error: 'message required' });
      if (jobs.has(id)) return send(res, 409, { error: 'agent is busy' });
      const m = mode === 'build' ? 'build' : 'talk';
      appendEntry(id, { kind: 'user', text: message, mode: m });
      runAgent(project, { prompt: message, mode: m });
      return send(res, 202, { ok: true });
    }
    if (action === 'stop') return send(res, 200, { ok: stopJob(id) });
    if (action === 'new-session') {
      if (jobs.has(id)) return send(res, 409, { error: 'agent is busy' });
      writeSession(id, null);
      appendEntry(id, { kind: 'divider', text: 'New conversation' });
      return send(res, 200, { ok: true });
    }
    if (action === 'save-progress') {
      if (jobs.has(id)) return send(res, 409, { error: 'agent is busy' });
      if (!readSession(id)) return send(res, 400, { error: 'no conversation yet' });
      saveProgress(project);
      return send(res, 202, { ok: true });
    }
    if (action === 'open') {
      const { target } = await readBody(req);
      openExternal(project, target);
      return send(res, 200, { ok: true });
    }
    return send(res, 404, { error: 'not found' });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: String(err.message || err) });
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`REGOS is already running on http://localhost:${PORT}`);
    if (process.argv.includes('--open')) openBrowser();
    process.exit(0);
  }
  throw err;
});

function openBrowser() {
  spawn('cmd', ['/c', 'start', '', `http://localhost:${PORT}`], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`REGOS running at http://localhost:${PORT}  (Ctrl+C to stop)`);
  if (process.argv.includes('--open')) openBrowser();
});

process.on('SIGINT', () => {
  for (const id of jobs.keys()) stopJob(id);
  process.exit(0);
});
