// Shared harness for the platform tests: starts the real server on a
// throwaway database, and gives each simulated phone or operator its own
// cookie jar. No test framework and no extra dependencies — plain Node.
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const PASSPHRASE = 'amber otter';
export const PINS = { host: '111111', marker: '222222', floor: '333333', admin: '444444' };

// Seeds a fresh database in a temp folder and starts the server on it.
// Never touches data/quiz.db.
export async function startServer({ port = 3900 + Math.floor(Math.random() * 90), dir } = {}) {
  dir = dir || mkdtempSync(join(tmpdir(), 'trivia-test-'));
  const env = { ...process.env, DB_PATH: join(dir, 'test.db'), PORT: String(port), INSECURE_COOKIES: 'true' };
  execFileSync(process.execPath, ['src/db/seed.js'], { cwd: ROOT, env, stdio: 'ignore' });
  const server = { port, dir, env, base: `http://127.0.0.1:${port}`, proc: null };
  await launch(server);
  return server;
}

// Starts (or restarts) the process for an existing server's database.
export async function launch(server) {
  server.proc = spawn(process.execPath, ['src/server.js'], { cwd: ROOT, env: server.env, stdio: ['ignore', 'pipe', 'pipe'] });
  server.proc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`${server.base}/ops`);
      if (res.ok) return server;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  throw new Error('server did not start');
}

// Kills the process the hard way — the restart test wants a crash, not a
// graceful shutdown.
export async function kill(server) {
  if (!server.proc) return;
  const exited = new Promise((r) => server.proc.once('exit', r));
  server.proc.kill('SIGKILL');
  await exited;
  server.proc = null;
}

export async function stopServer(server, { keep = false } = {}) {
  await kill(server);
  if (!keep) rmSync(server.dir, { recursive: true, force: true });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One cookie jar per simulated device, over a keep-alive agent. Records
// latency per path so the scripts can report it.
const agent = new http.Agent({ keepAlive: true, maxSockets: 512 });
export const timings = new Map();

export function client(base) {
  const jar = {};
  const call = (path, opts = {}) => new Promise((resolve, reject) => {
    const headers = { ...(opts.headers || {}) };
    const cookie = Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
    if (cookie) headers.cookie = cookie;
    let body = opts.body;
    if (opts.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.json);
    }
    if (body !== undefined) headers['content-length'] = Buffer.byteLength(body);
    const started = performance.now();
    const req = http.request(base + path, { method: opts.method || (body !== undefined ? 'POST' : 'GET'), headers, agent }, (res) => {
      for (const c of res.headers['set-cookie'] || []) {
        const [kv] = c.split(';');
        const i = kv.indexOf('=');
        jar[kv.slice(0, i)] = kv.slice(i + 1);
      }
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => {
        const key = path.split('?')[0].replace(/\/\d+(?=\/|$)/g, '/:id').replace(/^\/(t|screen)\/[A-Za-z0-9]+$/, '/$1/:token');
        if (!timings.has(key)) timings.set(key, []);
        timings.get(key).push(performance.now() - started);
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = JSON.parse(text); } catch { parsed = text; }
        resolve({ status: res.statusCode, body: parsed, headers: res.headers, reused: req.reusedSocket });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
  call.jar = jar;
  return call;
}

export async function player(base, token, username) {
  const p = client(base);
  await p(`/t/${token}`);
  await p('/gate', { json: { passphrase: PASSPHRASE } });
  const r = await p('/join', { json: { username } });
  if (r.status !== 200) throw new Error(`join failed: ${JSON.stringify(r.body)}`);
  return p;
}

export async function operator(base, role, name = role) {
  const o = client(base);
  await o('/ops');
  const r = await o('/ops/login', { json: { role, pin: PINS[role], name } });
  if (r.status !== 200) throw new Error(`${role} login failed: ${JSON.stringify(r.body)}`);
  return o;
}

// Host commands are absolute and version-guarded (CLAUDE.md #8).
export function hostActions(host) {
  const version = async () => (await host('/host/state')).body.version;
  return {
    version,
    async set(questionId, state) {
      const r = await host('/host/state', { json: { question_id: questionId, state, expects_version: await version() } });
      if (r.status !== 200) throw new Error(`setQuestion ${questionId} ${state}: ${JSON.stringify(r.body)}`);
      return r.body;
    },
    async post(path, body = {}) {
      return host(path, { json: { ...body, expects_version: await version() } });
    }
  };
}

// Tokens straight from the database file — the test stands in for the
// printed QR cards.
export function readTokens(server) {
  const out = execFileSync(process.execPath, ['-e', `
    const D = require('better-sqlite3');
    const db = new D(process.env.DB_PATH, { readonly: true });
    const e = db.prepare("SELECT id, screen_token FROM events WHERE status = 'active'").get();
    const t = db.prepare('SELECT id, table_number, token FROM teams WHERE event_id = ? AND archived = 0').all(e.id);
    console.log(JSON.stringify({ eventId: e.id, screen: e.screen_token, tables: t }));
  `], { cwd: ROOT, env: server.env });
  return JSON.parse(out);
}

export function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

export function timingReport(filter = () => true) {
  const rows = [...timings.entries()].filter(([k]) => filter(k)).sort((a, b) => b[1].length - a[1].length);
  return rows.map(([k, v]) =>
    `  ${k.padEnd(28)} n=${String(v.length).padStart(6)}  p50=${percentile(v, 50).toFixed(1).padStart(6)}ms  ` +
    `p95=${percentile(v, 95).toFixed(1).padStart(6)}ms  max=${Math.max(...v).toFixed(1).padStart(7)}ms`
  ).join('\n');
}

// Pass/fail tally shared by every script.
export function checker() {
  const results = [];
  const check = (label, pass, detail) => {
    results.push({ label, pass: !!pass });
    console.log(`${pass ? 'PASS' : 'FAIL'}  ${label}${!pass && detail !== undefined ? `\n      ${JSON.stringify(detail)}` : ''}`);
  };
  check.summary = () => {
    const failed = results.filter((r) => !r.pass);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    return failed.length === 0;
  };
  return check;
}
