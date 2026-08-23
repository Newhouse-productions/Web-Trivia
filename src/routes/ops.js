// Operator routes. Only the host may change question/round state, and
// commands are absolute with a version guard, never relative (CLAUDE.md #8).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomToken } from '../tokens.js';
import { readOpsSession, writeOpsSession } from '../opsSession.js';
import {
  checkSessionLimiter, recordSessionFailure, recordSessionSuccess,
  checkRoleLockout, recordRoleFailure, recordRoleSuccess
} from '../pinLimiter.js';
import { makeAuditLogger } from '../audit.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC_DIR = join(ROOT, 'public');
const OPS_HTML = readFileSync(join(PUBLIC_DIR, 'ops.html'), 'utf8');
const OPS_JS = readFileSync(join(PUBLIC_DIR, 'ops.js'), 'utf8');

const ROLES = ['host', 'marker', 'floor', 'admin'];

// PENDING -> OPEN -> CLOSED -> REVEALED, with reopen back to OPEN from either
// CLOSED or REVEALED (technical-design §2.1, §2.5).
const NEXT_STATES = {
  PENDING: ['OPEN'],
  OPEN: ['CLOSED'],
  CLOSED: ['OPEN', 'REVEALED'],
  REVEALED: ['OPEN']
};

function canTransition(current, target) {
  if (current === target) return true;
  return (NEXT_STATES[current] || []).includes(target);
}

export function registerOpsRoutes(app, { db, q }) {
  const logAudit = makeAuditLogger(db);
  const getActiveEvent = db.prepare("SELECT * FROM events WHERE status = 'active'");
  const deleteMarkingClaim = db.prepare('DELETE FROM marking_claims WHERE question_id = ?');
  const markRevealed = db.prepare('UPDATE questions SET revealed_at = ? WHERE id = ? AND revealed_at IS NULL');

  const getAnsweredGrid = db.prepare(`
    SELECT t.id AS team_id, t.table_number,
           EXISTS(SELECT 1 FROM answers a WHERE a.team_id = t.id AND a.question_id = ?) AS answered
    FROM teams t WHERE t.event_id = ? AND t.archived = 0
    ORDER BY t.table_number
  `);

  // "Live" is a presence heuristic for the vitals strip and pre-flight, not
  // an invariant — a table not seen in 30s (10x the 3s poll interval) reads
  // as dropped off.
  const PRESENCE_WINDOW_MS = 30000;
  const getLiveCount = db.prepare(`
    SELECT COUNT(*) AS n FROM teams
    WHERE event_id = ? AND archived = 0 AND last_seen_at IS NOT NULL
      AND (unixepoch('now') - unixepoch(last_seen_at)) * 1000 < ?
  `);
  const getTeamCount = db.prepare('SELECT COUNT(*) AS n FROM teams WHERE event_id = ? AND archived = 0');

  // Marking progress across the event: text questions that have at least
  // one answer are "in the queue"; fully marked means no NULLs remain.
  const getMarkingProgress = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN unmarked = 0 THEN 1 ELSE 0 END) AS marked
    FROM (
      SELECT q.id, SUM(CASE WHEN a.is_correct IS NULL THEN 1 ELSE 0 END) AS unmarked
      FROM questions q JOIN answers a ON a.question_id = q.id
      WHERE q.event_id = ? AND q.type = 'text'
      GROUP BY q.id
    )
  `);

  // Scores are derived from answers + bonuses on read, never stored
  // (CLAUDE.md #13) — there is no running total to corrupt. Ties resolve by
  // countback, excluding bonuses deliberately (technical-design §12.1):
  // round 3, then round 2, then free-text questions answered correctly.
  const getScores = db.prepare(`
    SELECT t.id AS team_id, t.table_number, t.team_name, t.colour,
           COALESCE(SUM(CASE WHEN a.is_correct = 1 AND q.is_skipped = 0 THEN q.points ELSE 0 END), 0) AS answer_points,
           COALESCE((SELECT SUM(points) FROM bonuses b WHERE b.team_id = t.id), 0) AS bonus_points,
           COALESCE(SUM(CASE WHEN a.is_correct = 1 AND q.is_skipped = 0 AND q.round = 3 THEN q.points ELSE 0 END), 0) AS round3_points,
           COALESCE(SUM(CASE WHEN a.is_correct = 1 AND q.is_skipped = 0 AND q.round = 2 THEN q.points ELSE 0 END), 0) AS round2_points,
           COALESCE(SUM(CASE WHEN a.is_correct = 1 AND q.type = 'text' THEN 1 ELSE 0 END), 0) AS text_correct_count
    FROM teams t
    LEFT JOIN answers a ON a.team_id = t.id
    LEFT JOIN questions q ON q.id = a.question_id
    WHERE t.event_id = ? AND t.archived = 0
    GROUP BY t.id
    ORDER BY (answer_points + bonus_points) DESC, round3_points DESC, round2_points DESC,
             text_correct_count DESC, t.table_number
  `);
  const getRecentBonuses = db.prepare(`
    SELECT b.team_id, t.table_number, b.points, b.reason, b.awarded_by, b.awarded_at
    FROM bonuses b JOIN teams t ON t.id = b.team_id
    WHERE b.event_id = ?
    ORDER BY b.awarded_at DESC LIMIT 10
  `);
  const insertBonus = db.prepare(`
    INSERT INTO bonuses (event_id, team_id, round, points, reason, awarded_by, awarded_at, idempotency_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const getBonusByKey = db.prepare('SELECT * FROM bonuses WHERE idempotency_key = ?');
  const setPaused = db.prepare('UPDATE events SET paused = ? WHERE id = ?');
  const upsertRound = db.prepare(`
    INSERT INTO rounds (event_id, number, phase, published_leaderboard)
    VALUES (?, ?, 'PUBLISHED', ?)
    ON CONFLICT(event_id, number) DO UPDATE SET phase = 'PUBLISHED', published_leaderboard = excluded.published_leaderboard
  `);
  const setEventRoundPhase = db.prepare("UPDATE event_state SET round_phase = 'PUBLISHED' WHERE event_id = ?");

  app.get('/ops', async (req, reply) => {
    if (!readOpsSession(req)) {
      writeOpsSession(reply, { sid: randomToken(16), eventId: null, role: null });
    }
    return reply.type('text/html').send(OPS_HTML);
  });

  app.get('/ops.js', async (req, reply) => reply.type('application/javascript').send(OPS_JS));

  app.post('/ops/login', async (req, reply) => {
    const existing = readOpsSession(req);
    const sid = existing?.sid || randomToken(16);

    const role = String(req.body?.role || '');
    if (!ROLES.includes(role)) return reply.code(400).send({ error: 'invalid_role' });

    const sessionLimit = checkSessionLimiter(sid);
    if (!sessionLimit.allowed) {
      return reply.code(429).send({ ok: false, retry_after_ms: sessionLimit.retryAfterMs });
    }

    const pin = String(req.body?.pin || '');

    // Host/Marker/Floor land directly in the active event — sequential
    // events cost nothing and a PIN that could select among several running
    // events is exactly the graceless-recovery scenario CLAUDE.md #6 rejects.
    // Admin alone picks from a list (technical-design §16.2), so its PIN is
    // checked across every configured event, not just the active one.
    let event;
    if (role === 'admin') {
      event = db.prepare('SELECT * FROM events WHERE admin_pin = ?').get(pin);
      if (event) {
        const roleLock = checkRoleLockout(event.id, role);
        if (!roleLock.allowed) return reply.code(423).send({ error: 'role_locked' });
      }
    } else {
      event = getActiveEvent.get();
      if (!event) return reply.code(503).send({ error: 'no_active_event' });
      const roleLock = checkRoleLockout(event.id, role);
      if (!roleLock.allowed) return reply.code(423).send({ error: 'role_locked' });
    }

    const expected = event ? event[`${role}_pin`] : null;
    if (!event || !expected || pin !== expected) {
      recordSessionFailure(sid);
      if (event) recordRoleFailure(event.id, role);
      return reply.code(401).send({ ok: false, message: 'Incorrect PIN.' });
    }

    recordSessionSuccess(sid);
    recordRoleSuccess(event.id, role);
    const name = String(req.body?.name || '').trim().slice(0, 20) || role[0].toUpperCase() + role.slice(1);
    writeOpsSession(reply, { sid, eventId: event.id, role, name });
    return { ok: true, role, name };
  });

  app.post('/ops/logout', async (req, reply) => {
    writeOpsSession(reply, { sid: randomToken(16), eventId: null, role: null });
    return { ok: true };
  });

  // --- host: state + absolute transitions (CLAUDE.md #8) ------------------

  app.get('/host/v', async (req, reply) => {
    const ops = readOpsSession(req);
    if (!ops || ops.role !== 'host') return reply.code(403).send({ error: 'forbidden' });
    const event = q.getEventById.get(ops.eventId);
    if (!event) return reply.code(409).send({ error: 'event_not_running' });
    return { version: event.version };
  });

  app.get('/host/state', async (req, reply) => {
    const ops = readOpsSession(req);
    if (!ops || ops.role !== 'host') return reply.code(403).send({ error: 'forbidden' });

    const event = q.getEventById.get(ops.eventId);
    if (!event || event.status !== 'active') return reply.code(409).send({ error: 'event_not_running' });

    const es = q.getEventState.get(event.id);
    const questions = q.getQuestionsForEvent.all(event.id);
    const current = es.current_question_id ? q.getQuestionById.get(es.current_question_id) : null;
    const grid = current ? getAnsweredGrid.all(current.id, event.id) : [];
    const marking = getMarkingProgress.get(event.id);
    const roundQuestions = current
      ? questions.filter((qu) => qu.round === current.round && !qu.is_practice && !qu.is_reserve)
      : [];
    const questionIndexInRound = current ? roundQuestions.findIndex((qu) => qu.id === current.id) : -1;

    return {
      version: event.version,
      round_phase: es.round_phase,
      paused: event.paused ? JSON.parse(event.paused) : null,
      theme: q.resolveCurrentTheme(event, current),
      round_progress: current && questionIndexInRound !== -1
        ? { number: current.round, index: questionIndexInRound + 1, total: roundQuestions.length }
        : null,
      current: current ? q.hostQuestionPayload(current, es.question_status) : null,
      answered: {
        count: grid.filter((r) => r.answered).length,
        total: grid.length,
        outstanding: grid.filter((r) => !r.answered).map((r) => r.table_number),
        tables: grid.map((r) => ({ team_id: r.team_id, table_number: r.table_number, answered: !!r.answered }))
      },
      marking: { marked: marking.marked || 0, total: marking.total || 0 },
      tables_live: { live: getLiveCount.get(event.id, PRESENCE_WINDOW_MS).n, total: getTeamCount.get(event.id).n },
      questions: questions.map((qu) => ({
        id: qu.id, round: qu.round, order_no: qu.order_no, type: qu.type,
        prompt: qu.prompt, points: qu.points, is_practice: !!qu.is_practice
      }))
    };
  });

  app.post('/host/state', async (req, reply) => {
    const ops = readOpsSession(req);
    if (!ops || ops.role !== 'host') return reply.code(403).send({ error: 'forbidden' });

    const event = q.getEventById.get(ops.eventId);
    if (!event || event.status !== 'active') return reply.code(409).send({ error: 'event_not_running' });

    const questionId = Number(req.body?.question_id);
    const targetState = String(req.body?.state || '');
    const expectsVersion = Number(req.body?.expects_version);

    if (expectsVersion !== event.version) {
      return reply.code(409).send({ error: 'stale', current_version: event.version });
    }

    if (!['PENDING', 'OPEN', 'CLOSED', 'REVEALED'].includes(targetState)) {
      return reply.code(400).send({ error: 'invalid_state' });
    }

    const question = q.getQuestionById.get(questionId);
    if (!question || question.event_id !== event.id) {
      return reply.code(400).send({ error: 'unknown_question' });
    }

    const es = q.getEventState.get(event.id);
    const switchingQuestion = es.current_question_id !== questionId;
    const isReopen = !switchingQuestion &&
      (es.question_status === 'CLOSED' || es.question_status === 'REVEALED') &&
      targetState === 'OPEN';

    if (switchingQuestion) {
      if (targetState !== 'PENDING') return reply.code(400).send({ error: 'invalid_transition' });
    } else if (es.question_status === targetState) {
      // Idempotent no-op: two hosts, a double-tap, or a retry must all
      // produce the same result (CLAUDE.md #8) — nothing changed, so don't
      // bump the version and wake every phone for no reason.
      return { ok: true, version: event.version, question_id: questionId, state: targetState };
    } else if (!canTransition(es.question_status, targetState)) {
      return reply.code(400).send({ error: 'invalid_transition' });
    }

    const newVersion = db.transaction(() => {
      const { version } = q.bumpEventVersion.get(event.id);
      q.setEventStateQuestion.run(questionId, targetState, event.id);
      // Advancing to a new question resumes active play — a fresh round
      // starts PLAYING, and re-opening mid-round after a MARKING/PUBLISHED
      // detour (host jumped back) should too.
      if (switchingQuestion) q.setRoundPhase.run('PLAYING', event.id);
      // Reopening force-releases the claim — host and marker are both
      // acting legitimately in opposite directions; the host wins
      // (technical-design §6.2).
      if (isReopen) deleteMarkingClaim.run(questionId);
      if (targetState === 'REVEALED') markRevealed.run(new Date().toISOString(), questionId);
      logAudit({
        eventId: event.id, role: 'host', operator: ops.name, action: 'setQuestion',
        target: `question:${questionId}`, reason: `${targetState}${isReopen ? ' (reopen)' : ''}`
      });
      return version;
    })();

    return { ok: true, version: newVersion, question_id: questionId, state: targetState };
  });

  // --- host: pause (CLAUDE.md #17) — a flag on the event, not a state. It
  // overlays whatever is happening and resumes to exactly that: hides the
  // question, rejects player writes, stops the timer, but marking, floor
  // and admin keep working.

  app.post('/host/pause', async (req, reply) => {
    const ops = readOpsSession(req);
    if (!ops || ops.role !== 'host') return reply.code(403).send({ error: 'forbidden' });
    const event = q.getEventById.get(ops.eventId);
    if (!event || event.status !== 'active') return reply.code(409).send({ error: 'event_not_running' });

    const expectsVersion = Number(req.body?.expects_version);
    if (expectsVersion !== event.version) {
      return reply.code(409).send({ error: 'stale', current_version: event.version });
    }

    const reason = String(req.body?.reason || '').trim().slice(0, 40);
    const message = String(req.body?.message || '').trim().slice(0, 200);
    const paused = { at: new Date().toISOString(), by: ops.name, reason, message };

    const newVersion = db.transaction(() => {
      setPaused.run(JSON.stringify(paused), event.id);
      const { version } = q.bumpEventVersion.get(event.id);
      logAudit({
        eventId: event.id, role: 'host', operator: ops.name, action: 'pause',
        target: 'event', reason: `${reason}: ${message}`
      });
      return version;
    })();

    return { ok: true, version: newVersion };
  });

  app.post('/host/resume', async (req, reply) => {
    const ops = readOpsSession(req);
    if (!ops || ops.role !== 'host') return reply.code(403).send({ error: 'forbidden' });
    const event = q.getEventById.get(ops.eventId);
    if (!event || event.status !== 'active') return reply.code(409).send({ error: 'event_not_running' });

    const expectsVersion = Number(req.body?.expects_version);
    if (expectsVersion !== event.version) {
      return reply.code(409).send({ error: 'stale', current_version: event.version });
    }

    const newVersion = db.transaction(() => {
      setPaused.run(null, event.id);
      const { version } = q.bumpEventVersion.get(event.id);
      logAudit({ eventId: event.id, role: 'host', operator: ops.name, action: 'resume', target: 'event' });
      return version;
    })();

    return { ok: true, version: newVersion };
  });

  // --- host: round publish (scope §2 "Publishing", CLAUDE.md #13) --------

  app.post('/host/publish', async (req, reply) => {
    const ops = readOpsSession(req);
    if (!ops || ops.role !== 'host') return reply.code(403).send({ error: 'forbidden' });
    const event = q.getEventById.get(ops.eventId);
    if (!event || event.status !== 'active') return reply.code(409).send({ error: 'event_not_running' });

    const expectsVersion = Number(req.body?.expects_version);
    if (expectsVersion !== event.version) {
      return reply.code(409).send({ error: 'stale', current_version: event.version });
    }

    const round = Number(req.body?.round);
    if (!Number.isInteger(round) || round < 1) return reply.code(400).send({ error: 'round_required' });

    const scores = getScores.all(event.id).map((r) => ({
      team_id: r.team_id, table_number: r.table_number,
      team_name: r.team_name || `Table ${r.table_number}`,
      colour: r.colour ? JSON.parse(r.colour) : null,
      score: r.answer_points + r.bonus_points
    }));

    const newVersion = db.transaction(() => {
      upsertRound.run(event.id, round, JSON.stringify(scores));
      setEventRoundPhase.run(event.id);
      const { version } = q.bumpEventVersion.get(event.id);
      logAudit({
        eventId: event.id, role: 'host', operator: ops.name, action: 'publishRound',
        target: `round:${round}`, reason: `${scores.length} teams`
      });
      return version;
    })();

    return { ok: true, version: newVersion };
  });

  // --- host: scores, bonuses, table support (CLAUDE.md #13, scope §2) ----

  app.get('/host/scores', async (req, reply) => {
    const ops = readOpsSession(req);
    if (!ops || ops.role !== 'host') return reply.code(403).send({ error: 'forbidden' });
    const event = q.getEventById.get(ops.eventId);
    if (!event || event.status !== 'active') return reply.code(409).send({ error: 'event_not_running' });

    const scores = getScores.all(event.id).map((r) => ({
      team_id: r.team_id,
      table_number: r.table_number,
      team_name: r.team_name || `Table ${r.table_number}`,
      colour: r.colour ? JSON.parse(r.colour) : null,
      score: r.answer_points + r.bonus_points
    }));

    return { scores, recent_bonuses: getRecentBonuses.all(event.id) };
  });

  app.post('/host/bonus', async (req, reply) => {
    const ops = readOpsSession(req);
    if (!ops || ops.role !== 'host') return reply.code(403).send({ error: 'forbidden' });
    const event = q.getEventById.get(ops.eventId);
    if (!event || event.status !== 'active') return reply.code(409).send({ error: 'event_not_running' });

    const teamId = Number(req.body?.team_id);
    const points = Number(req.body?.points);
    const reason = String(req.body?.reason || '').trim();
    const idempotencyKey = req.body?.idempotency_key ? String(req.body.idempotency_key) : null;

    if (!Number.isInteger(points) || points <= 0) {
      return reply.code(400).send({ error: 'points_must_be_positive' });
    }
    if (!reason) return reply.code(400).send({ error: 'reason_required' });

    const team = q.getTeamById.get(teamId);
    if (!team || team.event_id !== event.id) return reply.code(400).send({ error: 'unknown_team' });

    if (idempotencyKey && getBonusByKey.get(idempotencyKey)) {
      // Already applied — a double-tap or a retry must be harmless (CLAUDE.md #8).
      return { ok: true, duplicate: true };
    }

    const es = q.getEventState.get(event.id);
    const round = es.current_question_id ? q.getQuestionById.get(es.current_question_id)?.round || 0 : 0;

    db.transaction(() => {
      insertBonus.run(event.id, teamId, round, points, reason, ops.name, new Date().toISOString(), idempotencyKey);
      q.bumpTableVersion.run(teamId);
      logAudit({
        eventId: event.id, role: 'host', operator: ops.name, action: 'awardBonus',
        target: `team:${teamId}`, reason: `+${points}: ${reason}`
      });
    })();

    return { ok: true };
  });

  app.post('/host/answer-on-behalf', async (req, reply) => {
    const ops = readOpsSession(req);
    if (!ops || ops.role !== 'host') return reply.code(403).send({ error: 'forbidden' });
    const event = q.getEventById.get(ops.eventId);
    if (!event || event.status !== 'active') return reply.code(409).send({ error: 'event_not_running' });

    const teamId = Number(req.body?.team_id);
    const questionId = Number(req.body?.question_id);
    const team = q.getTeamById.get(teamId);
    if (!team || team.event_id !== event.id) return reply.code(400).send({ error: 'unknown_team' });

    const current = q.getCurrentQuestion.get(event.id);
    if (!current || current.question_id !== questionId || current.question_status !== 'OPEN') {
      return reply.code(409).send({ error: 'question_not_open' });
    }

    const value = String(req.body?.value ?? '').slice(0, 200);
    if (current.type === 'mcq') {
      const options = current.options ? JSON.parse(current.options) : [];
      if (!options.includes(value)) return reply.code(400).send({ error: 'invalid_option' });
    } else if (!value) {
      return reply.code(400).send({ error: 'value_required' });
    }

    let isCorrect = null;
    if (current.type === 'mcq') {
      isCorrect = value === current.correct_answer ? 1 : 0;
    } else {
      const normalize = (s) => String(s || '').trim().toLowerCase();
      const aliases = current.aliases ? JSON.parse(current.aliases) : [];
      const accepted = new Set([normalize(current.correct_answer), ...aliases.map(normalize)]);
      isCorrect = accepted.has(normalize(value)) ? 1 : null;
    }

    db.transaction(() => {
      // submitted_by is left null — this is entered on the table's behalf,
      // not by any of their players (Conventions: logged with role/operator).
      q.upsertAnswer.run(event.id, teamId, questionId, value, null, new Date().toISOString(), isCorrect);
      q.bumpTableVersion.run(teamId);
      logAudit({
        eventId: event.id, role: 'host', operator: ops.name, action: 'answerOnBehalf',
        target: `question:${questionId} team:${teamId}`, reason: value
      });
    })();

    return { ok: true };
  });
}
