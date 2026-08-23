// Marking is a live queue, not a round-end batch (CLAUDE.md #7). A free-text
// question's answers are derived straight from `answers` — any text question
// with an unmarked row belongs in the queue, regardless of whether the host
// has since moved on to a later question. Markers claim a whole question,
// never a row (CLAUDE.md #23) — accepting a spelling for every table
// rewrites the alias list and re-scores every other table's answer, so two
// markers on one question is the bug this makes structurally impossible.
import { readOpsSession, writeOpsSession } from '../opsSession.js';
import { makeAuditLogger } from '../audit.js';

const CLAIM_DURATION_MS = 2 * 60 * 1000;

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

export function registerMarkerRoutes(app, { db, q }) {
  const logAudit = makeAuditLogger(db);

  const getMarkingQueue = db.prepare(`
    SELECT q.id, q.round, q.order_no, q.prompt,
           COUNT(a.question_id) AS total_answers,
           SUM(CASE WHEN a.is_correct IS NULL THEN 1 ELSE 0 END) AS unmarked_count
    FROM questions q
    JOIN answers a ON a.question_id = q.id
    WHERE q.event_id = ? AND q.type = 'text'
    GROUP BY q.id
    HAVING unmarked_count > 0
    ORDER BY q.round, q.order_no
  `);
  const getClaim = db.prepare('SELECT * FROM marking_claims WHERE question_id = ?');
  const upsertClaim = db.prepare(`
    INSERT INTO marking_claims (event_id, question_id, marker, claimed_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(question_id) DO UPDATE SET
      marker = excluded.marker, claimed_at = excluded.claimed_at, expires_at = excluded.expires_at
  `);
  const deleteClaim = db.prepare('DELETE FROM marking_claims WHERE question_id = ?');
  const getQuestionAnswers = db.prepare(`
    SELECT a.team_id, a.value, a.is_correct, a.marked_by, a.marked_at, a.submitted_at,
           t.table_number, t.team_name
    FROM answers a JOIN teams t ON t.id = a.team_id
    WHERE a.question_id = ?
    ORDER BY CAST(t.table_number AS INTEGER)
  `);
  const setMark = db.prepare(
    'UPDATE answers SET is_correct = ?, marked_by = ?, marked_at = ? WHERE team_id = ? AND question_id = ?'
  );
  const updateAliases = db.prepare('UPDATE questions SET aliases = ? WHERE id = ?');
  const getAnswersForQuestion = db.prepare('SELECT team_id, value FROM answers WHERE question_id = ?');

  function requireMarker(req, reply) {
    const ops = readOpsSession(req);
    if (!ops || ops.role !== 'marker') {
      reply.code(403).send({ error: 'forbidden' });
      return null;
    }
    const event = q.getEventById.get(ops.eventId);
    if (!event || event.status !== 'active') {
      reply.code(409).send({ error: 'event_not_running' });
      return null;
    }
    return { ops, event };
  }

  function claimStatus(questionId) {
    const claim = getClaim.get(questionId);
    if (!claim) return { held: false };
    const expired = new Date(claim.expires_at).getTime() < Date.now();
    return expired ? { held: false } : { held: true, marker: claim.marker, expires_at: claim.expires_at };
  }

  // Any interaction renews the lease — a marker deliberating over one
  // awkward answer must not lose the claim silently (technical-design §6.2).
  function renewClaim(event, questionId, markerName) {
    const now = Date.now();
    upsertClaim.run(
      event.id, questionId, markerName,
      new Date(now).toISOString(), new Date(now + CLAIM_DURATION_MS).toISOString()
    );
  }

  app.get('/marker/v', async (req, reply) => {
    const ctx = requireMarker(req, reply);
    if (!ctx) return;
    return { version: ctx.event.version };
  });

  app.get('/marker/queue', async (req, reply) => {
    const ctx = requireMarker(req, reply);
    if (!ctx) return;
    const { event } = ctx;

    const es = q.getEventState.get(event.id);
    const rows = getMarkingQueue.all(event.id).filter(
      (row) => !(row.id === es.current_question_id && es.question_status === 'OPEN')
    );

    return {
      version: event.version,
      theme: q.resolveCurrentTheme(event, null),
      questions: rows.map((row) => ({
        id: row.id, round: row.round, order_no: row.order_no, prompt: row.prompt,
        total_answers: row.total_answers, unmarked_count: row.unmarked_count,
        claim: claimStatus(row.id)
      }))
    };
  });

  app.post('/marker/claim', async (req, reply) => {
    const ctx = requireMarker(req, reply);
    if (!ctx) return;
    const { ops, event } = ctx;
    const markerName = ops.name || 'Marker';
    const questionId = Number(req.body?.question_id);

    const status = claimStatus(questionId);
    if (status.held && status.marker !== markerName) {
      return reply.code(409).send({ error: 'claimed', holder: status.marker });
    }

    renewClaim(event, questionId, markerName);
    return { ok: true };
  });

  app.post('/marker/release', async (req, reply) => {
    const ctx = requireMarker(req, reply);
    if (!ctx) return;
    const { ops } = ctx;
    const questionId = Number(req.body?.question_id);
    const claim = getClaim.get(questionId);
    if (claim && claim.marker === (ops.name || 'Marker')) {
      deleteClaim.run(questionId);
    }
    return { ok: true };
  });

  app.get('/marker/question/:id', async (req, reply) => {
    const ctx = requireMarker(req, reply);
    if (!ctx) return;
    const { ops, event } = ctx;
    const markerName = ops.name || 'Marker';
    const questionId = Number(req.params.id);

    const question = q.getQuestionById.get(questionId);
    if (!question || question.event_id !== event.id) {
      return reply.code(404).send({ error: 'not_found' });
    }

    const status = claimStatus(questionId);
    if (status.held && status.marker !== markerName) {
      return reply.code(409).send({ error: 'claimed', holder: status.marker });
    }
    renewClaim(event, questionId, markerName);

    return {
      theme: q.resolveCurrentTheme(event, question),
      question: {
        id: question.id, prompt: question.prompt,
        correct_answer: question.correct_answer,
        aliases: question.aliases ? JSON.parse(question.aliases) : []
      },
      answers: getQuestionAnswers.all(questionId).map((a) => ({
        team_id: a.team_id, table_number: a.table_number, team_name: a.team_name,
        value: a.value, is_correct: a.is_correct === null ? null : !!a.is_correct,
        marked_by: a.marked_by, marked_at: a.marked_at
      }))
    };
  });

  app.post('/marker/mark', async (req, reply) => {
    const ctx = requireMarker(req, reply);
    if (!ctx) return;
    const { ops, event } = ctx;
    const markerName = ops.name || 'Marker';

    const questionId = Number(req.body?.question_id);
    const teamId = Number(req.body?.team_id);
    const correct = !!req.body?.correct;

    const status = claimStatus(questionId);
    if (status.held && status.marker !== markerName) {
      return reply.code(409).send({ error: 'claimed', holder: status.marker });
    }
    renewClaim(event, questionId, markerName);

    db.transaction(() => {
      setMark.run(correct ? 1 : 0, markerName, new Date().toISOString(), teamId, questionId);
      q.bumpTableVersion.run(teamId);
      logAudit({
        eventId: event.id, role: 'marker', operator: markerName, action: 'setMark',
        target: `question:${questionId} team:${teamId}`, reason: correct ? 'correct' : 'incorrect'
      });
    })();

    return { ok: true };
  });

  // "Accept this spelling for every table" — rewrites the alias list and
  // re-scores every table's answer to this question, not just one row
  // (CLAUDE.md #23, technical-design §6.3).
  app.post('/marker/alias', async (req, reply) => {
    const ctx = requireMarker(req, reply);
    if (!ctx) return;
    const { ops, event } = ctx;
    const markerName = ops.name || 'Marker';

    const questionId = Number(req.body?.question_id);
    const alias = String(req.body?.alias || '').trim();
    if (!alias) return reply.code(400).send({ error: 'alias_required' });

    const status = claimStatus(questionId);
    if (status.held && status.marker !== markerName) {
      return reply.code(409).send({ error: 'claimed', holder: status.marker });
    }

    const question = q.getQuestionById.get(questionId);
    if (!question || question.event_id !== event.id) {
      return reply.code(404).send({ error: 'not_found' });
    }

    renewClaim(event, questionId, markerName);

    const existingAliases = question.aliases ? JSON.parse(question.aliases) : [];
    const alreadyPresent = existingAliases.some((a) => normalize(a) === normalize(alias));
    const newAliases = alreadyPresent ? existingAliases : [...existingAliases, alias];

    const acceptedValues = new Set([normalize(question.correct_answer), ...newAliases.map(normalize)]);
    const matchingTeamIds = getAnswersForQuestion.all(questionId)
      .filter((a) => acceptedValues.has(normalize(a.value)))
      .map((a) => a.team_id);

    db.transaction(() => {
      if (!alreadyPresent) updateAliases.run(JSON.stringify(newAliases), questionId);
      for (const teamId of matchingTeamIds) {
        setMark.run(1, `alias:${markerName}`, new Date().toISOString(), teamId, questionId);
        q.bumpTableVersion.run(teamId);
      }
      logAudit({
        eventId: event.id, role: 'marker', operator: markerName, action: 'addAlias',
        target: `question:${questionId}`, reason: `"${alias}" — ${matchingTeamIds.length} tables rescored`
      });
    })();

    return { ok: true, aliases: newAliases, rescored: matchingTeamIds.length };
  });
}
