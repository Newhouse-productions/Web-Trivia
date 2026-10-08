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
import { buildResultsCsv } from '../results.js';
import { capText } from '../text.js';

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
  // First open only — mirrors markRevealed's guard exactly. Drives
  // pre-flight detection (has any real round-1 question ever opened) and
  // the optional timer's start point.
  const markOpened = db.prepare('UPDATE questions SET opened_at = ? WHERE id = ? AND opened_at IS NULL');

  const getAnsweredGrid = db.prepare(`
    SELECT t.id AS team_id, t.table_number,
           EXISTS(SELECT 1 FROM answers a WHERE a.team_id = t.id AND a.question_id = ?) AS answered
    FROM teams t WHERE t.event_id = ? AND t.archived = 0
    ORDER BY CAST(t.table_number AS INTEGER)
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
  // Practice and reserve questions are excluded from every aggregate here
  // (technical-design §12.2: "never counted in the points total") — round
  // alone doesn't do this, since a reserve question run as sudden death has
  // round = NULL but a practice question could in principle still collide
  // with round 2/3 if authored carelessly.
  const getScores = db.prepare(`
    SELECT t.id AS team_id, t.table_number, t.team_name, t.colour,
           COALESCE(SUM(CASE WHEN a.is_correct = 1 AND q.is_skipped = 0 AND q.is_practice = 0 AND q.is_reserve = 0 THEN q.points ELSE 0 END), 0) AS answer_points,
           COALESCE((SELECT SUM(points) FROM bonuses b WHERE b.team_id = t.id), 0) AS bonus_points,
           COALESCE(SUM(CASE WHEN a.is_correct = 1 AND q.is_skipped = 0 AND q.round = 3 THEN q.points ELSE 0 END), 0) AS round3_points,
           COALESCE(SUM(CASE WHEN a.is_correct = 1 AND q.is_skipped = 0 AND q.round = 2 THEN q.points ELSE 0 END), 0) AS round2_points,
           COALESCE(SUM(CASE WHEN a.is_correct = 1 AND q.type = 'text' AND q.is_practice = 0 AND q.is_reserve = 0 THEN 1 ELSE 0 END), 0) AS text_correct_count
    FROM teams t
    LEFT JOIN answers a ON a.team_id = t.id
    LEFT JOIN questions q ON q.id = a.question_id
    WHERE t.event_id = ? AND t.archived = 0
    GROUP BY t.id
    ORDER BY (answer_points + bonus_points) DESC, round3_points DESC, round2_points DESC,
             text_correct_count DESC, CAST(t.table_number AS INTEGER)
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
  const addTimerPausedMs = db.prepare(
    'UPDATE questions SET timer_paused_ms = timer_paused_ms + ? WHERE id = ?'
  );
  const upsertRound = db.prepare(`
    INSERT INTO rounds (event_id, number, phase, published_leaderboard)
    VALUES (?, ?, 'PUBLISHED', ?)
    ON CONFLICT(event_id, number) DO UPDATE SET phase = 'PUBLISHED', published_leaderboard = excluded.published_leaderboard
  `);
  const setEventRoundPhase = db.prepare("UPDATE event_state SET round_phase = 'PUBLISHED' WHERE event_id = ?");
  // Publishing waits for marking (CLAUDE.md #7) — but warns rather than
  // blocks, so a host can force it and move on (technical-design §2.5).
  const getRoundUnmarkedCount = db.prepare(`
    SELECT COUNT(*) AS n FROM answers a JOIN questions q ON q.id = a.question_id
    WHERE q.event_id = ? AND q.round = ? AND q.type = 'text' AND a.is_correct IS NULL
  `);
  const getRoundQuestionCount = db.prepare(
    'SELECT COUNT(*) AS n FROM questions WHERE event_id = ? AND round = ? AND is_practice = 0 AND is_reserve = 0'
  );
  // Never opened by publish time = SKIPPED, excluded from the points total
  // (technical-design §12.3). opened_at is stamped on first open and never
  // cleared, so it's exactly "was this ever asked".
  const getRoundUnaskedCount = db.prepare(`
    SELECT COUNT(*) AS n FROM questions
    WHERE event_id = ? AND round = ? AND is_practice = 0 AND is_reserve = 0 AND opened_at IS NULL
  `);
  const skipUnaskedInRound = db.prepare(`
    UPDATE questions SET is_skipped = 1
    WHERE event_id = ? AND round = ? AND is_practice = 0 AND is_reserve = 0 AND opened_at IS NULL
  `);
  // A skipped question the host goes back and actually asks counts again.
  const unskipQuestion = db.prepare('UPDATE questions SET is_skipped = 0 WHERE id = ?');
  const getRoundPublished = db.prepare(
    "SELECT 1 FROM rounds WHERE event_id = ? AND number = ? AND phase = 'PUBLISHED'"
  );

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
    const name = capText(req.body?.name, 20) || role[0].toUpperCase() + role.slice(1);
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

    // Phase is resolved here, once, server-side — the client renders
    // whichever view it's told, it never infers "are we done yet" itself
    // (same principle as the theme cascade, CLAUDE.md #21). Opening the
    // practice question deliberately doesn't end pre-flight — only a real
    // round-1 question does.
    const anyRealQuestionOpened = questions.some((qu) => !qu.is_practice && qu.opened_at);
    const highestPublished = q.getPublishedRound.get(event.id);
    const phase = !anyRealQuestionOpened
      ? 'preflight'
      : (event.total_rounds && highestPublished && highestPublished.number >= event.total_rounds)
        ? 'final'
        : 'active';

    const practiceQuestion = questions.find((qu) => qu.is_practice);

    // The round the host would publish next: the current question's, if
    // it's a real round question (practice/reserve sit outside rounds).
    const publishRound = current && current.round != null && !current.is_practice && !current.is_reserve
      ? current.round : null;

    return {
      version: event.version,
      poll_ms: q.pollIntervals(event.id).operator,
      phase,
      total_rounds: event.total_rounds,
      round_phase: es.round_phase,
      paused: event.paused ? JSON.parse(event.paused) : null,
      theme: q.resolveCurrentTheme(event, current),
      timer: q.resolveTimer(event, current, es.question_status),
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
        prompt: qu.prompt, points: qu.points, is_practice: !!qu.is_practice, is_reserve: !!qu.is_reserve,
        is_skipped: !!qu.is_skipped
      })),
      publish: publishRound != null ? {
        round: publishRound,
        published: !!getRoundPublished.get(event.id, publishRound),
        unmarked: getRoundUnmarkedCount.get(event.id, publishRound).n,
        unasked: getRoundUnaskedCount.get(event.id, publishRound).n
      } : null,
      preflight: phase === 'preflight' ? {
        question_count: questions.length,
        av_cue_count: questions.filter((qu) => qu.av_cue).length,
        av_alt_missing: questions.filter((qu) => qu.av_cue && !qu.av_alt).length,
        themes: q.allResolvedThemes(event.id),
        practice_question: practiceQuestion ? { id: practiceQuestion.id, prompt: practiceQuestion.prompt } : null
      } : null
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
      if (targetState === 'OPEN') {
        markOpened.run(new Date().toISOString(), questionId);
        if (question.is_skipped) unskipQuestion.run(questionId);
      }
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

    const reason = capText(req.body?.reason, 40);
    const message = capText(req.body?.message, 200);
    // Re-pausing to change the message keeps the original start time, so
    // the timer credit on resume covers the whole pause.
    const previousAt = event.paused ? JSON.parse(event.paused).at : null;
    const paused = { at: previousAt || new Date().toISOString(), by: ops.name, reason, message };

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

    // Time paused while a question was OPEN doesn't count against its
    // timer — the countdown resumes where it stopped (CLAUDE.md #17).
    const es = q.getEventState.get(event.id);
    const pausedAt = event.paused ? Date.parse(JSON.parse(event.paused).at) : NaN;
    const pausedMs = Number.isFinite(pausedAt) ? Math.max(0, Date.now() - pausedAt) : 0;

    const newVersion = db.transaction(() => {
      setPaused.run(null, event.id);
      if (es.current_question_id && es.question_status === 'OPEN' && pausedMs) {
        addTimerPausedMs.run(pausedMs, es.current_question_id);
      }
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
    if (getRoundQuestionCount.get(event.id, round).n === 0) {
      return reply.code(400).send({ error: 'unknown_round' });
    }

    const force = req.body?.force === true;
    const unmarked = getRoundUnmarkedCount.get(event.id, round).n;
    if (unmarked > 0 && !force) {
      return reply.code(409).send({ error: 'unmarked_answers', unmarked });
    }

    const result = db.transaction(() => {
      const skipped = skipUnaskedInRound.run(event.id, round).changes;
      const scores = getScores.all(event.id).map((r) => ({
        team_id: r.team_id, table_number: r.table_number,
        team_name: r.team_name || `Table ${r.table_number}`,
        colour: r.colour ? JSON.parse(r.colour) : null,
        score: r.answer_points + r.bonus_points
      }));
      upsertRound.run(event.id, round, JSON.stringify(scores));
      setEventRoundPhase.run(event.id);
      const { version } = q.bumpEventVersion.get(event.id);
      const notes = [`${scores.length} teams`];
      if (skipped) notes.push(`${skipped} skipped`);
      if (unmarked) notes.push(`forced with ${unmarked} unmarked`);
      logAudit({
        eventId: event.id, role: 'host', operator: ops.name, action: 'publishRound',
        target: `round:${round}`, reason: notes.join(', ')
      });
      return { version, skipped };
    })();

    return { ok: true, version: result.version, skipped: result.skipped };
  });

  // --- host: scores, bonuses, table support (CLAUDE.md #13, scope §2) ----

  app.get('/host/scores', async (req, reply) => {
    const ops = readOpsSession(req);
    if (!ops || ops.role !== 'host') return reply.code(403).send({ error: 'forbidden' });
    const event = q.getEventById.get(ops.eventId);
    if (!event || event.status !== 'active') return reply.code(409).send({ error: 'event_not_running' });

    const rows = getScores.all(event.id);
    const scores = rows.map((r) => ({
      team_id: r.team_id,
      table_number: r.table_number,
      team_name: r.team_name || `Table ${r.table_number}`,
      colour: r.colour ? JSON.parse(r.colour) : null,
      score: r.answer_points + r.bonus_points
    }));

    // Sudden death (technical-design §12.1 step 4): countback is
    // deterministic through round 3, round 2, then correct-free-text-count;
    // if the top position is STILL tied after all three, the host runs a
    // reserve question. This only detects and surfaces the tie — it never
    // picks a winner, and bonuses are excluded from the countback
    // comparison itself even though they're part of the headline score
    // that made them tied in the first place (§12.1: "not evidence of quiz
    // ability").
    let suddenDeath = null;
    if (rows.length >= 2) {
      const top = rows[0];
      const topTotal = top.answer_points + top.bonus_points;
      const tied = rows.filter((r) =>
        (r.answer_points + r.bonus_points) === topTotal &&
        r.round3_points === top.round3_points &&
        r.round2_points === top.round2_points &&
        r.text_correct_count === top.text_correct_count
      );
      if (tied.length >= 2) {
        suddenDeath = {
          tied_teams: tied.map((r) => ({
            team_id: r.team_id, table_number: r.table_number, team_name: r.team_name || `Table ${r.table_number}`
          }))
        };
      }
    }

    return { scores, recent_bonuses: getRecentBonuses.all(event.id), sudden_death: suddenDeath };
  });

  // Same CSV as the admin export (src/results.js) — the host's own session
  // can't hit an admin-guarded route, and the final screen is where this is
  // actually needed on the night.
  app.get('/host/results/export', async (req, reply) => {
    const ops = readOpsSession(req);
    if (!ops || ops.role !== 'host') return reply.code(403).send({ error: 'forbidden' });
    const event = q.getEventById.get(ops.eventId);
    if (!event || event.status !== 'active') return reply.code(409).send({ error: 'event_not_running' });

    reply.header('Content-Disposition', `attachment; filename="results-${event.id}.csv"`);
    return reply.type('text/csv').send(buildResultsCsv(db, event.id));
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

    const value = capText(req.body?.value, 200, { trim: false });
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
