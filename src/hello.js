// Enablement smoke test. Proves: Fastify, SQLite, Secure cookies,
// and URLs derived from the request rather than stored.
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(ROOT, 'data'), { recursive: true });

const db = new Database(join(ROOT, 'data', 'test.db'));
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');
db.exec(`CREATE TABLE IF NOT EXISTS smoke (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  note TEXT NOT NULL,
  at TEXT NOT NULL
)`);

const app = Fastify({ logger: false });
await app.register(cookie, { secret: 'dev-only-not-a-real-secret' });

// Invariant: never store an absolute URL. Build it from the request.
const baseUrl = (req) => {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  return `${proto}://${req.headers.host}`;
};

app.get('/', async (req) => ({
  ok: true,
  node: process.version,
  baseUrl: baseUrl(req),
  hint: 'Try /db, /cookie/set then /cookie/check, and /qr'
}));

app.get('/db', async () => {
  db.prepare('INSERT INTO smoke (note, at) VALUES (?, ?)')
    .run('enablement check', new Date().toISOString());
  const rows = db.prepare('SELECT * FROM smoke ORDER BY id DESC LIMIT 5').all();
  const { n } = db.prepare('SELECT COUNT(*) AS n FROM smoke').get();
  return { wrote: true, total: n, latest: rows };
});

app.get('/cookie/set', async (req, reply) => {
  reply.setCookie('smoke', `set-at-${Date.now()}`, {
    path: '/',
    httpOnly: true,
    secure: true,          // requires HTTPS — the tunnel provides it
    sameSite: 'lax',
    signed: true,
    maxAge: 60 * 60 * 12
  });
  return { set: true, next: `${baseUrl(req)}/cookie/check` };
});

app.get('/cookie/check', async (req) => {
  const raw = req.cookies.smoke;
  if (!raw) return { readBack: false, why: 'No cookie. Over plain HTTP a Secure cookie is silently dropped.' };
  const un = req.unsignCookie(raw);
  return { readBack: un.valid, value: un.value };
});

app.get('/qr', async (req, reply) => {
  const url = baseUrl(req);
  reply.type('text/html');
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<body style="font-family:system-ui;padding:24px">
<h1 style="font-size:16px">Current host</h1>
<p style="font-family:ui-monospace;word-break:break-all">${url}</p>
<p>Rendered from the request. Restart the tunnel and this page is still correct.</p>`;
});

const port = Number(process.env.PORT || 3000);
await app.listen({ port, host: '127.0.0.1' });
console.log(`hello server on http://localhost:${port}`);