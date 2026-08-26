// Local one-page UI for the migration tool. No external dependencies.
//   npm run ui   ->   open http://127.0.0.1:4321
// It writes creds to .env, runs Stage 1 / Stage 2 (the same CLIs the terminal uses),
// streams live logs, and lets you download the generated report.
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.cwd();
const PORT = Number(process.env.UI_PORT || 4321);
const ENV_PATH = path.join(ROOT, '.env');
const MIGRATIONS = path.join(ROOT, 'migrations');
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// ---- .env read/write (merge, preserve unknown keys) ----
function readEnv() {
  const map = {};
  if (fs.existsSync(ENV_PATH)) for (const line of fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const i = line.indexOf('='); if (i < 0 || line.trim().startsWith('#')) continue;
    map[line.slice(0, i).trim()] = line.slice(i + 1);
  }
  return map;
}
function writeEnv(updates) {
  const map = { ...readEnv(), ...updates };
  const out = Object.entries(map).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';
  fs.writeFileSync(ENV_PATH, out);
}
const mask = (v) => (v ? (v.length > 10 ? v.slice(0, 4) + '…' + v.slice(-4) : '••••') : '');

// ---- run manager (one run at a time) ----
const runs = {}; // id -> { lines, done, exitCode, label }
let current = null;
function startRun(label, args, extraEnv = {}) {
  if (current && !runs[current].done) return { error: 'A run is already in progress.' };
  const id = String(Date.now());
  runs[id] = { lines: [], done: false, exitCode: null, label, paused: false, child: null };
  current = id;
  const child = spawn('node', args, { cwd: ROOT, env: { ...process.env, ...extraEnv } });
  runs[id].child = child;
  const push = (buf) => { for (const l of buf.toString().split(/\r?\n/)) if (l.length) runs[id].lines.push(l); };
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  child.on('close', (code) => { runs[id].done = true; runs[id].exitCode = code; runs[id].lines.push(`\n=== finished (exit ${code}) ===`); });
  child.on('error', (e) => { runs[id].lines.push('ERROR: ' + e.message); runs[id].done = true; runs[id].exitCode = 1; });
  return { runId: id };
}

// ---- helpers ----
const send = (res, code, body, type = 'application/json') => { res.writeHead(code, { 'Content-Type': type }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => { try { resolve(d ? JSON.parse(d) : {}); } catch { resolve({}); } }); });
function listFiles(pattern) {
  const out = [];
  if (!fs.existsSync(MIGRATIONS)) return out;
  for (const slug of fs.readdirSync(MIGRATIONS)) {
    const dir = path.join(MIGRATIONS, slug);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) if (pattern.test(f)) {
      const full = path.join(dir, f);
      out.push({ slug, file: f, rel: path.join('migrations', slug, f), mtime: fs.statSync(full).mtimeMs });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  try {
    // --- static ---
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) {
      return send(res, 200, fs.readFileSync(path.join(PUBLIC, 'index.html')), 'text/html; charset=utf-8');
    }
    // --- env ---
    if (u.pathname === '/api/env' && req.method === 'GET') {
      const e = readEnv();
      return send(res, 200, {
        SHOPIFY_STORE_DOMAIN: e.SHOPIFY_STORE_DOMAIN || '', SHOPIFY_API_VERSION: e.SHOPIFY_API_VERSION || '2026-01',
        OPENSTORE_BASE_URL: e.OPENSTORE_BASE_URL || 'https://gkx.gokwik.co', OPENSTORE_MERCHANT_ID: e.OPENSTORE_MERCHANT_ID || '',
        SHOPIFY_ADMIN_TOKEN_set: !!e.SHOPIFY_ADMIN_TOKEN, SHOPIFY_ADMIN_TOKEN_mask: mask(e.SHOPIFY_ADMIN_TOKEN),
        OPENSTORE_COOKIE_set: !!e.OPENSTORE_COOKIE, OPENSTORE_COOKIE_mask: mask(e.OPENSTORE_COOKIE),
      });
    }
    if (u.pathname === '/api/env' && req.method === 'POST') {
      const b = await readBody(req);
      const upd = {};
      for (const k of ['SHOPIFY_STORE_DOMAIN', 'SHOPIFY_API_VERSION', 'OPENSTORE_BASE_URL', 'OPENSTORE_MERCHANT_ID']) if (b[k] != null && b[k] !== '') upd[k] = b[k];
      // secrets: only overwrite if a non-empty value was provided
      if (b.SHOPIFY_ADMIN_TOKEN) upd.SHOPIFY_ADMIN_TOKEN = b.SHOPIFY_ADMIN_TOKEN;
      if (b.OPENSTORE_COOKIE) upd.OPENSTORE_COOKIE = b.OPENSTORE_COOKIE;
      writeEnv(upd);
      return send(res, 200, { ok: true });
    }
    if (u.pathname === '/api/env/clear' && req.method === 'POST') {
      const map = readEnv();
      for (const k of ['SHOPIFY_STORE_DOMAIN', 'SHOPIFY_ADMIN_TOKEN', 'SHOPIFY_API_VERSION', 'OPENSTORE_BASE_URL', 'OPENSTORE_MERCHANT_ID', 'OPENSTORE_COOKIE']) delete map[k];
      const out = Object.entries(map).map(([k, v]) => `${k}=${v}`).join('\n');
      fs.writeFileSync(ENV_PATH, out ? out + '\n' : '');
      return send(res, 200, { ok: true });
    }
    // --- lists ---
    if (u.pathname === '/api/extracts' && req.method === 'GET') return send(res, 200, listFiles(/^discounts_.*\.json$/));
    if (u.pathname === '/api/reports' && req.method === 'GET') return send(res, 200, listFiles(/^migration_report_.*\.(xlsx|csv)$/));
    // --- runs ---
    if (u.pathname === '/api/run/stage1' && req.method === 'POST') {
      const b = await readBody(req);
      const slug = (b.merchant || 'store').replace(/[^a-zA-Z0-9_-]/g, '') || 'store';
      const args = ['./src/cli.mjs', `--merchant=${slug}`, `--status=${b.status === 'all' ? 'all' : 'active'}`];
      return send(res, 200, startRun('Stage 1 — extract', args, { NODE_OPTIONS: '--max-old-space-size=8192' }));
    }
    if (u.pathname === '/api/run/stage2' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b.file) return send(res, 400, { error: 'No extract file selected.' });
      const abs = path.resolve(ROOT, b.file);
      if (!abs.startsWith(MIGRATIONS) || !fs.existsSync(abs)) return send(res, 400, { error: 'Invalid file.' });
      const args = ['./src/cli-stage2.mjs', b.file, '--status=all', '--concurrency=1'];
      if (b.skipSets) args.push('--skip-sets=true');
      if (b.skipCustomerSpecific) args.push('--skip-customer-specific=true');
      if (b.resetLedger) args.push('--resetLedger=true');
      return send(res, 200, startRun('Stage 2 — migrate', args, { NODE_OPTIONS: '--max-old-space-size=8192' }));
    }
    if (u.pathname === '/api/run/delete' && req.method === 'POST') {
      const b = await readBody(req);
      const args = ['./src/cli-delete.mjs'];
      if (b.mode === 'all') args.push('--all');
      else if (b.mode === 'draft' || b.mode === 'published') args.push(`--status=${b.mode}`);
      else if (b.mode === 'codes') {
        const codes = String(b.codes || '').split(',').map((c) => c.trim()).filter(Boolean);
        if (!codes.length) return send(res, 400, { error: 'Enter at least one code.' });
        args.push(`--codes=${codes.join(',')}`);
      } else return send(res, 400, { error: 'Pick a delete target.' });
      if (b.confirm) args.push('--confirm');
      return send(res, 200, startRun(`Delete (${b.mode}${b.confirm ? ', confirm' : ', dry-run'})`, args));
    }
    if (u.pathname === '/api/logs' && req.method === 'GET') {
      const id = u.searchParams.get('runId'); const from = Number(u.searchParams.get('from') || 0);
      const r = runs[id]; if (!r) return send(res, 404, { error: 'unknown run' });
      return send(res, 200, { lines: r.lines.slice(from), next: r.lines.length, done: r.done, exitCode: r.exitCode, paused: r.paused });
    }
    if (u.pathname === '/api/run/control' && req.method === 'POST') {
      const b = await readBody(req);
      const r = runs[b.runId];
      if (!r || !r.child || r.done) return send(res, 400, { error: 'no active run' });
      try {
        if (b.action === 'pause') { process.kill(r.child.pid, 'SIGSTOP'); r.paused = true; r.lines.push('=== paused ==='); }
        else if (b.action === 'resume') { process.kill(r.child.pid, 'SIGCONT'); r.paused = false; r.lines.push('=== resumed ==='); }
        else if (b.action === 'stop') { try { process.kill(r.child.pid, 'SIGCONT'); } catch {} r.child.kill('SIGKILL'); r.lines.push('=== stopped by user (progress is saved; re-run to resume) ==='); }
        else return send(res, 400, { error: 'bad action' });
      } catch (e) { return send(res, 500, { error: e.message }); }
      return send(res, 200, { ok: true, paused: r.paused });
    }
    // --- download (safe: only within migrations/) ---
    if (u.pathname === '/api/download' && req.method === 'GET') {
      const rel = u.searchParams.get('file') || '';
      const abs = path.resolve(ROOT, rel);
      if (!abs.startsWith(MIGRATIONS) || !fs.existsSync(abs)) return send(res, 400, 'invalid file', 'text/plain');
      const name = path.basename(abs);
      const type = name.endsWith('.xlsx') ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : (name.endsWith('.csv') ? 'text/csv' : 'application/octet-stream');
      res.writeHead(200, { 'Content-Type': type, 'Content-Disposition': `attachment; filename="${name}"` });
      return fs.createReadStream(abs).pipe(res);
    }
    send(res, 404, { error: 'not found' });
  } catch (e) { send(res, 500, { error: e.message }); }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Discount Migration UI running at:  http://127.0.0.1:${PORT}\n  (Ctrl+C to stop. The terminal commands still work too.)\n`);
});
