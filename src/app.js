// Fastify factory: security headers, static assets, then the player and ops
// route modules share one db connection and one set of prepared statements.
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDb } from './db/index.js';
import { readOpsSession, writeOpsSession } from './opsSession.js';
import { buildQueries } from './queries.js';
import { registerPlayerRoutes } from './routes/player.js';
import { registerOpsRoutes } from './routes/ops.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerMarkerRoutes } from './routes/marker.js';
import { registerScreenRoutes } from './routes/screen.js';
import { registerMediaRoutes } from './routes/media.js';
import { registerFloorRoutes } from './routes/floor.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'public');

const PLAY_HTML = readFileSync(join(PUBLIC_DIR, 'play.html'), 'utf8');
const STYLE_CSS = readFileSync(join(PUBLIC_DIR, 'style.css'), 'utf8');
const POLL_JS = readFileSync(join(PUBLIC_DIR, 'poll.js'), 'utf8');
const PLAY_JS = readFileSync(join(PUBLIC_DIR, 'play.js'), 'utf8');
const SCREEN_CSS = readFileSync(join(PUBLIC_DIR, 'screen.css'), 'utf8');
const TOKENS_CSS = readFileSync(join(PUBLIC_DIR, 'css', 'tokens.css'), 'utf8');
const COMPONENTS_CSS = readFileSync(join(PUBLIC_DIR, 'css', 'components.css'), 'utf8');
const ARCHIVO_WOFF2 = readFileSync(join(PUBLIC_DIR, 'fonts', 'archivo-variable.woff2'));

// Dynamic, per-request responses that must never be cached (CLAUDE.md
// Conventions + #4/#5). Static assets above are exempt.
const NO_STORE_PREFIXES = [
  '/v', '/state', '/answer', '/gate', '/join', '/takeover', '/team-name',
  '/host/', '/ops/', '/admin/', '/marker/', '/screen/', '/floor/'
];

export function buildApp() {
  const app = Fastify({ logger: false });
  const db = getDb();
  const q = buildQueries(db);

  app.register(cookie, { secret: process.env.COOKIE_SECRET || 'dev-only-not-a-real-secret' });

  // Admin is 2h *idle* (scope §2 "Sessions"): every authenticated admin
  // request reissues the cookie with a fresh `seen`, keeping its iat. A
  // handler that switches event rewrites the cookie again after this.
  app.addHook('preHandler', (req, reply, done) => {
    if (req.url.startsWith('/admin/')) {
      const ops = readOpsSession(req);
      if (ops && ops.role === 'admin') writeOpsSession(reply, ops);
    }
    done();
  });

  app.addHook('onSend', (req, reply, payload, done) => {
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; " +
      "img-src 'self' data:; frame-src https://www.youtube-nocookie.com; " +
      "base-uri 'none'; form-action 'self'"
    );
    const path = req.url.split('?')[0];
    if (NO_STORE_PREFIXES.some((p) => path.startsWith(p))) {
      reply.header('Cache-Control', 'no-store');
    }
    done(null, payload);
  });

  // --- static assets shared by every surface ------------------------------

  app.get('/play', async (req, reply) => reply.type('text/html').send(PLAY_HTML));
  app.get('/style.css', async (req, reply) => reply.type('text/css').send(STYLE_CSS));
  app.get('/poll.js', async (req, reply) => reply.type('application/javascript').send(POLL_JS));
  app.get('/play.js', async (req, reply) => reply.type('application/javascript').send(PLAY_JS));
  app.get('/screen.css', async (req, reply) => reply.type('text/css').send(SCREEN_CSS));
  app.get('/css/tokens.css', async (req, reply) => reply.type('text/css').send(TOKENS_CSS));
  app.get('/css/components.css', async (req, reply) => reply.type('text/css').send(COMPONENTS_CSS));
  app.get('/fonts/archivo-variable.woff2', async (req, reply) => {
    reply.type('font/woff2');
    reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    return reply.send(ARCHIVO_WOFF2);
  });

  registerPlayerRoutes(app, { db, q });
  registerOpsRoutes(app, { db, q });
  registerAdminRoutes(app, { db, q });
  registerMarkerRoutes(app, { db, q });
  registerScreenRoutes(app, { db, q });
  registerMediaRoutes(app, { db, q });
  registerFloorRoutes(app, { db, q });

  return app;
}
