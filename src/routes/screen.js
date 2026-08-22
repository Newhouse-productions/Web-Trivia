// Big screen. Long random screen token in the URL, no PIN — it runs on a
// venue laptop, often started by someone who isn't you (technical-design
// §7.6a). It's a display surface only: same never-before-REVEALED allowlist
// as players, so a shoulder-surfer learns nothing they can't see from their
// seat. The token is exchanged once into a cookie, exactly like a table
// token, so it never appears in the video iframe's Referer or repeated
// access-log lines (CLAUDE.md #4 applied to this surface too).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC_DIR = join(ROOT, 'public');
const SCREEN_HTML = readFileSync(join(PUBLIC_DIR, 'screen.html'), 'utf8');
const SCREEN_JS = readFileSync(join(PUBLIC_DIR, 'screen.js'), 'utf8');

const COOKIE_NAME = 'screen';
const insecureCookies = process.env.INSECURE_COOKIES === 'true';

function readScreenSession(req) {
  const raw = req.cookies?.[COOKIE_NAME];
  if (!raw) return null;
  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid) return null;
  try {
    return JSON.parse(unsigned.value);
  } catch {
    return null;
  }
}

function writeScreenSession(reply, session) {
  reply.setCookie(COOKIE_NAME, JSON.stringify(session), {
    path: '/',
    httpOnly: true,
    secure: !insecureCookies,
    sameSite: 'lax',
    signed: true,
    maxAge: 12 * 60 * 60
  });
}

export function registerScreenRoutes(app, { db, q }) {
  const getEventByScreenToken = db.prepare("SELECT * FROM events WHERE screen_token = ? AND status = 'active'");
  const getAnswerSpread = db.prepare(
    'SELECT value, COUNT(*) AS n FROM answers WHERE question_id = ? GROUP BY value'
  );
  const getAnsweredTotal = db.prepare('SELECT COUNT(*) AS n FROM answers WHERE question_id = ?');
  const getTeamCount = db.prepare('SELECT COUNT(*) AS n FROM teams WHERE event_id = ? AND archived = 0');
  const getPublishedRound = db.prepare(
    "SELECT * FROM rounds WHERE event_id = ? AND phase = 'PUBLISHED' ORDER BY number DESC LIMIT 1"
  );

  app.get('/screen/:token', async (req, reply) => {
    const event = getEventByScreenToken.get(req.params.token);
    if (!event) {
      return reply.code(404).type('text/html').send(
        '<!doctype html><meta charset="utf-8"><p>This screen link isn\'t recognised.</p>'
      );
    }
    writeScreenSession(reply, { eventId: event.id });
    return reply.redirect('/screen', 302);
  });

  app.get('/screen', async (req, reply) => reply.type('text/html').send(SCREEN_HTML));
  app.get('/screen.js', async (req, reply) => reply.type('application/javascript').send(SCREEN_JS));

  app.get('/screen/v', async (req, reply) => {
    const session = readScreenSession(req);
    if (!session) return reply.code(401).send({ error: 'no_session' });
    const event = q.getEventById.get(session.eventId);
    if (!event || event.status !== 'active') return reply.code(409).send({ error: 'event_not_running' });
    return { version: event.version };
  });

  app.get('/screen/state', async (req, reply) => {
    const session = readScreenSession(req);
    if (!session) return { stage: 'no_session' };
    const event = q.getEventById.get(session.eventId);
    if (!event || event.status !== 'active') return { stage: 'event_not_running' };

    const es = q.getEventState.get(event.id);

    if (es.round_phase === 'PUBLISHED') {
      const round = getPublishedRound.get(event.id);
      if (round) {
        const boardTheme = q.resolveCurrentTheme(event, null);
        return {
          stage: 'leaderboard',
          version: event.version,
          event_name: event.name,
          round: round.number,
          theme: boardTheme,
          leaderboard: JSON.parse(round.published_leaderboard),
          chrome: q.resolveChrome(event, boardTheme.colour)
        };
      }
    }

    const current = es.current_question_id ? q.getCurrentQuestion.get(event.id) : null;
    if (!current) {
      const holdingTheme = q.resolveCurrentTheme(event, null);
      return {
        stage: 'holding', version: event.version, event_name: event.name,
        theme: holdingTheme, chrome: q.resolveChrome(event, holdingTheme.colour)
      };
    }

    const payload = q.playerQuestionPayload(current);
    const answeredTotal = getAnsweredTotal.get(current.question_id).n;
    const teamTotal = getTeamCount.get(event.id).n;

    if (current.question_status === 'CLOSED' || current.question_status === 'REVEALED') {
      if (current.type === 'mcq') {
        payload.spread = getAnswerSpread.all(current.question_id).map((r) => ({ option: r.value, count: r.n }));
      }
    }

    const theme = q.resolveCurrentTheme(event, current);
    return {
      stage: 'question',
      version: event.version,
      event_name: event.name,
      round: current.round,
      theme,
      chrome: q.resolveChrome(event, theme.colour),
      question: payload,
      answered: { count: answeredTotal, total: teamTotal }
    };
  });
}
