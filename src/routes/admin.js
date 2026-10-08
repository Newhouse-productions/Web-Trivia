// Admin routes. Question import replaces the whole set (technical-design
// §16.4, §9.4) — CSV import never overwrites an event, it authors one, so
// re-importing into the SAME event fully replaces its question set and is
// blocked once the event has actually been played (CLAUDE.md #6 — config
// import always regenerates/creates, never partially patches).
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import QRCode from 'qrcode';
import { readOpsSession, writeOpsSession } from '../opsSession.js';
import { makeAuditLogger } from '../audit.js';
import { parseQuestionsCsv } from '../import/questionsCsv.js';
import { randomToken, randomPin } from '../tokens.js';
import { LAYOUTS, validateContrast } from '../theme.js';
import { buildResultsCsv } from '../results.js';

const MEDIA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'media');

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Never store an absolute URL (CLAUDE.md #3) — built from the incoming
// request at generation time, same as the QR sheet it's printed on.
function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  return `${proto}://${req.headers.host}`;
}

function parseTablesCsv(text) {
  const records = parse(text.replace(/\r\n/g, '\n'), {
    columns: true, skip_empty_lines: true, trim: true, bom: true
  });
  const errors = [];
  const rows = records.map((r, i) => {
    const tableNumber = String(r.table_number || '').trim();
    const seats = Number(r.seats);
    if (!tableNumber) errors.push(`row ${i + 2}: table_number is required`);
    if (!Number.isInteger(seats) || seats < 1) errors.push(`row ${i + 2}: seats must be a positive integer`);

    const colourRaw = String(r.colour || '').trim();
    let colour = null;
    if (colourRaw) {
      const parts = colourRaw.split('|').map((s) => s.trim()).filter(Boolean);
      colour = parts.length > 1
        ? { type: 'gradient', from: parts[0], to: parts[1], angle: 135 }
        : { type: 'block', from: parts[0] };
    }
    return { tableNumber, seats: Number.isInteger(seats) ? seats : null, colour };
  });
  return { rows, valid: errors.length === 0 && rows.length > 0, errors };
}

export function registerAdminRoutes(app, { db, q }) {
  const logAudit = makeAuditLogger(db);

  app.addContentTypeParser('text/csv', { parseAs: 'string' }, (req, body, done) => done(null, body));

  const getAnswerCount = db.prepare('SELECT COUNT(*) AS n FROM answers WHERE event_id = ?');
  const deleteQuestions = db.prepare('DELETE FROM questions WHERE event_id = ?');
  const clearEventState = db.prepare(
    "UPDATE event_state SET current_question_id = NULL, question_status = 'PENDING' WHERE event_id = ?"
  );
  const setCurrentQuestion = db.prepare(
    "UPDATE event_state SET current_question_id = ?, question_status = 'PENDING' WHERE event_id = ?"
  );
  const getPracticeQuestion = db.prepare(
    'SELECT id FROM questions WHERE event_id = ? AND is_practice = 1 LIMIT 1'
  );
  const getFirstQuestion = db.prepare(
    'SELECT id FROM questions WHERE event_id = ? AND is_practice = 0 AND is_reserve = 0 ORDER BY round, order_no LIMIT 1'
  );
  const insertQuestion = db.prepare(`
    INSERT INTO questions (event_id, round, order_no, type, prompt, options, correct_answer,
      aliases, points, image_ref, image_alt, video_url, av_cue, layout, is_practice, is_reserve, theme, av_alt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  function requireAdmin(req, reply) {
    const ops = readOpsSession(req);
    if (!ops || ops.role !== 'admin') {
      reply.code(403).send({ error: 'forbidden' });
      return null;
    }
    const event = q.getEventById.get(ops.eventId);
    if (!event) {
      reply.code(409).send({ error: 'event_not_running' });
      return null;
    }
    return event;
  }

  // --- event lifecycle (technical-design §16.5): draft -> active ->
  // finished -> archived. Many configured, exactly one active. Listing is
  // visible to any authenticated admin session regardless of which event
  // it belongs to (name/status/date only, nothing sensitive); mutating an
  // event still requires having authenticated into that specific event —
  // each event's admin PIN is its own, so this is not a privilege escalation.

  const listEvents = db.prepare(`
    SELECT e.id, e.name, e.status, e.date, e.total_rounds,
           (SELECT COUNT(*) FROM questions WHERE event_id = e.id) AS question_count,
           (SELECT COUNT(*) FROM teams WHERE event_id = e.id AND archived = 0) AS table_count
    FROM events e
    ORDER BY (e.status = 'active') DESC, e.date DESC
  `);
  const setTotalRounds = db.prepare('UPDATE events SET total_rounds = ? WHERE id = ?');
  const insertBlankEvent = db.prepare(`
    INSERT INTO events (name, status, passphrase, screen_token, host_pin, marker_pin, floor_pin, admin_pin)
    VALUES (?, 'draft', ?, ?, ?, ?, ?, ?)
  `);
  const insertBlankEventState = db.prepare(
    "INSERT INTO event_state (event_id, question_status, round_phase) VALUES (?, 'PENDING', 'PLAYING')"
  );
  const getActiveEventStmt = db.prepare("SELECT * FROM events WHERE status = 'active'");
  const deactivateEvent = db.prepare("UPDATE events SET status = 'draft' WHERE id = ?");
  const activateEventStmt = db.prepare("UPDATE events SET status = 'active' WHERE id = ?");
  const finishEventStmt = db.prepare("UPDATE events SET status = 'finished', retention_until = ? WHERE id = ?");

  app.get('/admin/events', async (req, reply) => {
    const ops = readOpsSession(req);
    if (!ops || ops.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });
    return { events: listEvents.all(), current_event_id: ops.eventId };
  });

  app.post('/admin/events', async (req, reply) => {
    const ops = readOpsSession(req);
    if (!ops || ops.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });

    const name = String(req.body?.name || '').trim().slice(0, 100) || 'New event';
    const newEventId = db.transaction(() => {
      const { lastInsertRowid: eventId } = insertBlankEvent.run(
        name, randomToken(12).toLowerCase(), randomToken(12),
        randomPin(), randomPin(), randomPin(), randomPin()
      );
      insertBlankEventState.run(eventId);
      logAudit({ eventId, role: 'admin', operator: ops.name, action: 'createEvent', target: 'event', reason: name });
      return eventId;
    })();

    // Move this session into the new event so admin can start configuring
    // it immediately — creating it is the authorization, no PIN re-entry.
    const newEvent = q.getEventById.get(newEventId);
    writeOpsSession(reply, { sid: ops.sid, eventId: newEventId, role: 'admin', name: ops.name, iat: ops.iat });
    return {
      ok: true, event_id: newEventId,
      pins: { host: newEvent.host_pin, marker: newEvent.marker_pin, floor: newEvent.floor_pin, admin: newEvent.admin_pin }
    };
  });

  // Everything needed to run the night that otherwise only lives in the
  // database: passphrase, big-screen link and role PINs. Admin-only, for
  // the event this session authenticated into. The screen link is built
  // from the current request host, never stored (CLAUDE.md #3).
  app.get('/admin/events/:id/access', async (req, reply) => {
    const event = requireAdmin(req, reply);
    if (!event) return;
    if (Number(req.params.id) !== event.id) return reply.code(403).send({ error: 'wrong_event_session' });
    return {
      passphrase: event.passphrase,
      screen_url: `${baseUrl(req)}/screen/${event.screen_token}`,
      pins: { host: event.host_pin, marker: event.marker_pin, floor: event.floor_pin, admin: event.admin_pin }
    };
  });

  // Nullable and admin-set only — drives the host's pre-flight/final phase
  // detection (see /host/state), never auto-inferred from round activity.
  app.put('/admin/events/:id/total-rounds', async (req, reply) => {
    const event = requireAdmin(req, reply);
    if (!event) return;
    if (Number(req.params.id) !== event.id) return reply.code(403).send({ error: 'wrong_event_session' });

    const raw = req.body?.total_rounds;
    const totalRounds = raw === null || raw === '' || raw === undefined ? null : Number(raw);
    if (totalRounds !== null && (!Number.isInteger(totalRounds) || totalRounds < 1)) {
      return reply.code(400).send({ error: 'invalid_total_rounds' });
    }
    setTotalRounds.run(totalRounds, event.id);
    logAudit({
      eventId: event.id, role: 'admin', operator: readOpsSession(req).name,
      action: 'setTotalRounds', target: 'event', reason: String(totalRounds)
    });
    return { ok: true, total_rounds: totalRounds };
  });

  // Minimal on/off toggle only — the settings table has no editor beyond
  // this yet (duration is a fixed constant this pass, src/queries.js's
  // TIMER_SECONDS). Without even this checkbox, timer_enabled would only
  // ever be reachable by hand-editing the database or a JSON config import.
  const upsertSetting = db.prepare(`
    INSERT INTO settings (event_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT(event_id, key) DO UPDATE SET value = excluded.value
  `);

  app.get('/admin/settings', async (req, reply) => {
    const event = requireAdmin(req, reply);
    if (!event) return;
    return { settings: q.getSettings(event.id) };
  });

  // Each setting validates to a stored string, or returns null if invalid.
  // Bounds keep a typo from breaking the night: a 100ms player poll is 2,400
  // requests a second from the room.
  const intIn = (min, max) => (v) => {
    const n = Number(v);
    return Number.isInteger(n) && n >= min && n <= max ? String(n) : null;
  };
  const SETTING_RULES = {
    timer_enabled: (v) => (typeof v === 'boolean' ? String(v) : null),
    timer_seconds: intIn(10, 600),
    player_poll_ms: intIn(1000, 10000),
    operator_poll_ms: intIn(500, 5000),
    leaderboard_cadence: (v) => (['every_round', 'final_only'].includes(v) ? v : null)
  };

  // Partial update: only the keys sent are changed.
  app.put('/admin/settings', async (req, reply) => {
    const event = requireAdmin(req, reply);
    if (!event) return;
    const body = req.body || {};
    const changes = [];
    for (const [key, rule] of Object.entries(SETTING_RULES)) {
      if (body[key] === undefined) continue;
      const value = rule(body[key]);
      if (value === null) return reply.code(400).send({ error: 'invalid_setting', key });
      changes.push([key, value]);
    }
    if (!changes.length) return reply.code(400).send({ error: 'no_settings' });

    db.transaction(() => {
      for (const [key, value] of changes) upsertSetting.run(event.id, key, value);
      // Phones and consoles pick up poll and timer changes on their next fetch.
      q.bumpEventVersion.get(event.id);
      logAudit({
        eventId: event.id, role: 'admin', operator: readOpsSession(req).name,
        action: 'setSettings', target: 'event', reason: changes.map(([k, v]) => `${k}=${v}`).join(', ')
      });
    })();
    return { ok: true, settings: q.getSettings(event.id) };
  });

  app.post('/admin/events/:id/activate', async (req, reply) => {
    const event = requireAdmin(req, reply);
    if (!event) return;
    const targetId = Number(req.params.id);
    if (targetId !== event.id) {
      return reply.code(403).send({ error: 'wrong_event_session' });
    }

    const current = getActiveEventStmt.get();
    if (current && current.id !== targetId) {
      const es = db.prepare('SELECT * FROM event_state WHERE event_id = ?').get(current.id);
      if (es && es.question_status === 'OPEN') {
        return reply.code(409).send({ error: 'active_event_mid_round', active_event_name: current.name });
      }
    }

    // Refuse to activate with a failing resolved theme (CLAUDE.md #21) —
    // validate the resolved combination, never the layers in isolation.
    const themes = q.allResolvedThemes(targetId);
    const failing = [themes.event_default.validation.pass ? null : 'event default']
      .concat(themes.questions.filter((r) => !r.validation.pass).map((r) => `Q${r.order_no ?? r.question_id}`))
      .filter(Boolean);
    if (failing.length) {
      return reply.code(409).send({ error: 'theme_contrast_failing', failing });
    }

    db.transaction(() => {
      if (current && current.id !== targetId) deactivateEvent.run(current.id);
      activateEventStmt.run(targetId);
      logAudit({
        eventId: targetId, role: 'admin', operator: readOpsSession(req).name, action: 'activateEvent',
        target: 'event', reason: current ? `deactivated ${current.name}` : 'first activation'
      });
    })();

    return { ok: true };
  });

  app.post('/admin/events/:id/finish', async (req, reply) => {
    const event = requireAdmin(req, reply);
    if (!event) return;
    if (Number(req.params.id) !== event.id) return reply.code(403).send({ error: 'wrong_event_session' });

    const retentionUntil = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    db.transaction(() => {
      finishEventStmt.run(retentionUntil, event.id);
      logAudit({
        eventId: event.id, role: 'admin', operator: readOpsSession(req).name, action: 'finishEvent',
        target: 'event', reason: `retained until ${retentionUntil}`
      });
    })();
    return { ok: true };
  });

  // finished -> archived (technical-design §16.5): put away, kept until its
  // retention date like any finished event. Only a finished event can be
  // archived — an active one is finished first, so its retention clock runs.
  const archiveEventStmt = db.prepare("UPDATE events SET status = 'archived' WHERE id = ? AND status = 'finished'");

  app.post('/admin/events/:id/archive', async (req, reply) => {
    const event = requireAdmin(req, reply);
    if (!event) return;
    if (Number(req.params.id) !== event.id) return reply.code(403).send({ error: 'wrong_event_session' });
    if (event.status !== 'finished') return reply.code(409).send({ error: 'not_finished' });
    db.transaction(() => {
      archiveEventStmt.run(event.id);
      logAudit({
        eventId: event.id, role: 'admin', operator: readOpsSession(req).name, action: 'archiveEvent',
        target: 'event', reason: `retained until ${event.retention_until}`
      });
    })();
    return { ok: true };
  });

  // --- listings: admin sees full detail, unlike every other role ---------

  app.get('/admin/questions', async (req, reply) => {
    const event = requireAdmin(req, reply);
    if (!event) return;
    const questions = q.getQuestionsForEvent.all(event.id).map((row) => q.hostQuestionPayload(row, null));
    return { questions };
  });

  // --- single-question editor with re-score impact preview (CLAUDE.md #14)
  // "Never re-score silently." Editing OPEN is blocked outright; editing a
  // revealed question requires a preview (tables and points) before commit.

  const getAnswersForQuestion2 = db.prepare(
    'SELECT team_id, value, is_correct, marked_by FROM answers WHERE question_id = ?'
  );
  const setMarkForRescore = db.prepare(
    'UPDATE answers SET is_correct = ? WHERE team_id = ? AND question_id = ?'
  );
  // Back to the marking queue: clear who marked it too, so the next re-score
  // doesn't mistake it for a marker's judgement.
  const requeueForRescore = db.prepare(
    'UPDATE answers SET is_correct = NULL, marked_by = NULL, marked_at = NULL WHERE team_id = ? AND question_id = ?'
  );
  const getAnyPublishedFromRound = db.prepare(
    "SELECT COUNT(*) AS n FROM rounds WHERE event_id = ? AND number >= ? AND phase = 'PUBLISHED'"
  );
  const updateQuestionFields = db.prepare(`
    UPDATE questions SET
      prompt = ?, options = ?, correct_answer = ?, aliases = ?, points = ?,
      image_ref = ?, image_alt = ?, video_url = ?, av_cue = ?, av_alt = ?
    WHERE id = ? AND event_id = ?
  `);

  function normalize(s) { return String(s || '').trim().toLowerCase(); }

  // A marker's own judgement — not an auto-match at submission (marked_by
  // NULL) and not a bulk alias acceptance ('alias:<marker>').
  const isHumanMark = (a) => a.is_correct !== null && a.marked_by && !a.marked_by.startsWith('alias:');

  // What would change if this question's answer key became {correctAnswer,
  // aliases} and its value became newPoints — used both for the preview
  // and to actually apply the re-score, so the number shown is exactly the
  // number that lands (CLAUDE.md #14).
  //
  // Free text: an answer the new key accepts is correct. One it doesn't
  // keep a marker's own judgement — accepting "Paris, France" by hand
  // must survive an alias edit — and anything that was only auto-matched
  // goes back to the marking queue rather than silently scoring zero.
  function computeRescore(question, correctAnswer, aliases, newPoints = question.points) {
    const accepted = new Set([normalize(correctAnswer), ...aliases.map(normalize)]);
    const rows = getAnswersForQuestion2.all(question.id);
    const changes = rows.map((a) => {
      let newCorrect;
      if (question.type === 'mcq') newCorrect = a.value === correctAnswer ? 1 : 0;
      else if (accepted.has(normalize(a.value))) newCorrect = 1;
      else newCorrect = isHumanMark(a) ? a.is_correct : null;
      const pointsBefore = a.is_correct === 1 ? question.points : 0;
      const pointsAfter = newCorrect === 1 ? newPoints : 0;
      return {
        team_id: a.team_id, was: a.is_correct, now: newCorrect,
        changed: a.is_correct !== newCorrect, points_change: pointsAfter - pointsBefore
      };
    });
    const flippedToCorrect = changes.filter((c) => c.changed && c.now === 1 && c.was !== 1);
    const flippedToWrong = changes.filter((c) => c.changed && c.was === 1 && c.now !== 1);
    const requeued = changes.filter((c) => c.changed && c.now === null);
    const scoreChanged = changes.filter((c) => c.points_change !== 0);
    return {
      changes, flipped_to_correct: flippedToCorrect.length, flipped_to_wrong: flippedToWrong.length,
      requeued: requeued.length,
      tables_affected: scoreChanged.length,
      unaffected: changes.length - scoreChanged.length,
      points_delta: changes.reduce((sum, c) => sum + c.points_change, 0)
    };
  }

  function parsePoints(raw, fallback) {
    if (raw === undefined || raw === null || raw === '') return fallback;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : NaN;
  }

  app.get('/admin/questions/:id', async (req, reply) => {
    const event = requireAdmin(req, reply);
    if (!event) return;
    const question = q.getQuestionById.get(Number(req.params.id));
    if (!question || question.event_id !== event.id) return reply.code(404).send({ error: 'not_found' });

    const es = q.getEventState.get(event.id);
    const isCurrent = es.current_question_id === question.id;
    return {
      question: {
        ...question,
        options: question.options ? JSON.parse(question.options) : null,
        aliases: question.aliases ? JSON.parse(question.aliases) : null
      },
      edit_state: !isCurrent && !question.revealed_at && getAnswersForQuestion2.all(question.id).length === 0
        ? 'free'
        : isCurrent && es.question_status === 'OPEN' ? 'blocked'
        : question.revealed_at ? 'revealed' : 'closed'
    };
  });

  app.post('/admin/questions/:id/preview-impact', async (req, reply) => {
    const event = requireAdmin(req, reply);
    if (!event) return;
    const question = q.getQuestionById.get(Number(req.params.id));
    if (!question || question.event_id !== event.id) return reply.code(404).send({ error: 'not_found' });

    const correctAnswer = String(req.body?.correct_answer ?? question.correct_answer);
    const aliases = req.body?.aliases ?? (question.aliases ? JSON.parse(question.aliases) : []);
    const points = parsePoints(req.body?.points, question.points);
    if (Number.isNaN(points)) return reply.code(400).send({ error: 'invalid_points' });
    const impact = computeRescore(question, correctAnswer, aliases, points);
    const needsRepublish = getAnyPublishedFromRound.get(event.id, question.round ?? 0).n > 0;
    return {
      tables_affected: impact.tables_affected,
      flipped_to_correct: impact.flipped_to_correct, flipped_to_wrong: impact.flipped_to_wrong,
      requeued: impact.requeued,
      unaffected: impact.unaffected, points_delta: impact.points_delta, needs_republish: needsRepublish
    };
  });

  app.put('/admin/questions/:id', async (req, reply) => {
    const event = requireAdmin(req, reply);
    if (!event) return;
    const question = q.getQuestionById.get(Number(req.params.id));
    if (!question || question.event_id !== event.id) return reply.code(404).send({ error: 'not_found' });

    const es = q.getEventState.get(event.id);
    if (es.current_question_id === question.id && es.question_status === 'OPEN') {
      return reply.code(409).send({ error: 'question_open', message: 'Close the question before editing it.' });
    }

    const body = req.body || {};
    const correctAnswer = body.correct_answer ?? question.correct_answer;
    const aliases = body.aliases ?? (question.aliases ? JSON.parse(question.aliases) : []);
    const answerKeyChanged = correctAnswer !== question.correct_answer ||
      JSON.stringify(aliases) !== JSON.stringify(question.aliases ? JSON.parse(question.aliases) : []);
    const points = parsePoints(body.points, question.points);
    if (Number.isNaN(points)) return reply.code(400).send({ error: 'invalid_points' });
    // A points change re-scores every table that got it right — as much a
    // re-score as a new answer key (CLAUDE.md #14).
    const pointsChanged = points !== question.points;
    const scoringChanged = answerKeyChanged || pointsChanged;

    const hasAnswers = getAnswersForQuestion2.all(question.id).length > 0;
    if (hasAnswers && scoringChanged && !body.confirm) {
      // Never re-score silently — the caller must have seen the impact
      // preview and confirmed it (CLAUDE.md #14).
      return reply.code(428).send({ error: 'confirm_required', message: 'Preview the impact and confirm before saving.' });
    }

    const ops = readOpsSession(req);
    const result = db.transaction(() => {
      updateQuestionFields.run(
        body.prompt ?? question.prompt,
        body.options !== undefined ? JSON.stringify(body.options) : question.options,
        correctAnswer,
        JSON.stringify(aliases),
        points,
        body.image_ref ?? question.image_ref, body.image_alt ?? question.image_alt,
        body.video_url ?? question.video_url, body.av_cue ?? question.av_cue,
        body.av_alt !== undefined ? (String(body.av_alt).trim().slice(0, 500) || null) : question.av_alt,
        question.id, event.id
      );

      let impact = null;
      if (scoringChanged && hasAnswers) {
        impact = computeRescore(question, correctAnswer, aliases, points);
        for (const c of impact.changes) {
          if (c.changed) {
            if (c.now === null) requeueForRescore.run(c.team_id, question.id);
            else setMarkForRescore.run(c.now, c.team_id, question.id);
          }
          // A points change moves a table's score without flipping its mark.
          if (c.changed || c.points_change) q.bumpTableVersion.run(c.team_id);
        }
      }

      logAudit({
        eventId: event.id, role: 'admin', operator: ops.name, action: 'editQuestion',
        target: `question:${question.id}`,
        reason: impact
          ? `re-scored: +${impact.flipped_to_correct}/-${impact.flipped_to_wrong} tables, ` +
            `${impact.requeued} re-queued, ${impact.points_delta >= 0 ? '+' : ''}${impact.points_delta} points` +
            (pointsChanged ? ` (points ${question.points} -> ${points})` : '')
          : 'content edit'
      });
      return impact;
    })();

    return { ok: true, impact: result };
  });

  app.get('/admin/tables', async (req, reply) => {
    const event = requireAdmin(req, reply);
    if (!event) return;
    const tables = db.prepare(
      'SELECT id, table_number, seats, colour, archived, token FROM teams WHERE event_id = ? ORDER BY CAST(table_number AS INTEGER)'
    ).all(event.id);
    return { tables };
  });

  app.post('/admin/questions/preview', async (req, reply) => {
    const event = requireAdmin(req, reply);
    if (!event) return;
    return parseQuestionsCsv(String(req.body || ''));
  });

  app.post('/admin/questions/import', async (req, reply) => {
    const event = requireAdmin(req, reply);
    if (!event) return;

    if (getAnswerCount.get(event.id).n > 0) {
      return reply.code(409).send({
        error: 'event_started',
        message: 'Replace-all is blocked once the event has started.'
      });
    }

    const result = parseQuestionsCsv(String(req.body || ''));
    if (!result.valid) {
      return reply.code(422).send({ error: 'invalid_csv', rows: result.rows });
    }

    db.transaction(() => {
      clearEventState.run(event.id);
      deleteQuestions.run(event.id);
      for (const row of result.rows) {
        insertQuestion.run(
          event.id, row.round, row.order_no, row.type, row.prompt,
          row.options ? JSON.stringify(row.options) : null,
          row.correct_answer,
          row.aliases ? JSON.stringify(row.aliases) : null,
          row.points, row.image_ref, row.image_alt, row.video_url, row.av_cue, row.layout,
          row.is_practice ? 1 : 0, row.is_reserve ? 1 : 0, null, row.av_alt
        );
      }

      const practice = getPracticeQuestion.get(event.id);
      const first = practice || getFirstQuestion.get(event.id);
      if (first) setCurrentQuestion.run(first.id, event.id);

      q.bumpEventVersion.get(event.id);
      logAudit({
        eventId: event.id, role: 'admin', operator: readOpsSession(req).name, action: 'import_questions',
        target: 'questions', reason: `${result.rows.length} rows`
      });
    })();

    return { ok: true, imported: result.rows.length };
  });

  // --- tables: CSV import is additive/upsert, never destructive ----------
  // (technical-design §9.2 — renumbering is safe, removing a live table
  // isn't, so import only ever adds or edits, never deletes).

  const getTeamByTableNumber = db.prepare(
    'SELECT * FROM teams WHERE event_id = ? AND table_number = ?'
  );
  const insertTeamRow = db.prepare(`
    INSERT INTO teams (event_id, table_number, seats, token, colour)
    VALUES (?, ?, ?, ?, ?)
  `);
  const updateTeamRow = db.prepare('UPDATE teams SET seats = ?, colour = ? WHERE id = ?');
  const getTeamAnswerCount = db.prepare('SELECT COUNT(*) AS n FROM answers WHERE team_id = ?');
  const archiveTeam = db.prepare('UPDATE teams SET archived = 1 WHERE id = ?');

  app.post('/admin/tables/import', async (req, reply) => {
    const event = requireAdmin(req, reply);
    if (!event) return;

    const result = parseTablesCsv(String(req.body || ''));
    if (!result.valid) return reply.code(422).send({ error: 'invalid_csv', errors: result.errors });

    let added = 0;
    let updated = 0;
    db.transaction(() => {
      for (const row of result.rows) {
        const existing = getTeamByTableNumber.get(event.id, row.tableNumber);
        const colourJson = row.colour ? JSON.stringify(row.colour) : null;
        if (existing) {
          updateTeamRow.run(row.seats, colourJson ?? existing.colour, existing.id);
          updated++;
        } else {
          insertTeamRow.run(event.id, row.tableNumber, row.seats, randomToken(8), colourJson);
          added++;
        }
      }
      logAudit({
        eventId: event.id, role: 'admin', operator: readOpsSession(req).name, action: 'import_tables',
        target: 'teams', reason: `${added} added, ${updated} updated`
      });
    })();

    return { ok: true, added, updated };
  });

  app.post('/admin/tables/:id/archive', async (req, reply) => {
    const event = requireAdmin(req, reply);
    if (!event) return;
    const team = q.getTeamById.get(Number(req.params.id));
    if (!team || team.event_id !== event.id) return reply.code(404).send({ error: 'not_found' });

    db.transaction(() => {
      archiveTeam.run(team.id);
      logAudit({
        eventId: event.id, role: 'admin', operator: readOpsSession(req).name, action: 'archiveTable',
        target: `team:${team.id}`, reason: `${getTeamAnswerCount.get(team.id).n} answers retained`
      });
    })();
    return { ok: true };
  });

  // Reissue a table's code (scope §5, table support) — for a code that has
  // leaked or been shared with the wrong table. Phones already at the table
  // keep working: their session cookie carries the team id, not the token
  // (CLAUDE.md #4). Only the old QR stops working, so reprint that card.
  const setTeamToken = db.prepare('UPDATE teams SET token = ? WHERE id = ?');

  app.post('/admin/tables/:id/reissue', async (req, reply) => {
    const event = requireAdmin(req, reply);
    if (!event) return;
    const team = q.getTeamById.get(Number(req.params.id));
    if (!team || team.event_id !== event.id || team.archived) return reply.code(404).send({ error: 'not_found' });

    db.transaction(() => {
      setTeamToken.run(randomToken(8), team.id);
      logAudit({
        eventId: event.id, role: 'admin', operator: readOpsSession(req).name, action: 'reissueCode',
        target: `team:${team.id}`, reason: `table ${team.table_number}`
      });
    })();
    return { ok: true };
  });

  // --- QR sheet: one code per table, built from the live request host,
  // never stored (CLAUDE.md #3) — a restart with a new tunnel hostname
  // just means reprinting, not a broken link.

  // The sheet's styles live in their own file: the app's CSP is
  // style-src 'self', which blocks an inline <style> block and style=""
  // attributes (CLAUDE.md #2). Team colour swatches are SVG fills instead.
  const QR_SHEET_CSS = `
  body { font-family: system-ui, sans-serif; margin: 24px; }
  .sheet { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; }
  .card { border: 1px solid #ccc; border-radius: 8px; padding: 16px; text-align: center; page-break-inside: avoid; break-inside: avoid; }
  .qr svg { width: 100%; height: auto; }
  .num { font-size: 22px; font-weight: 700; margin-top: 8px; }
  .swatch { display: block; width: 100%; height: 10px; margin-bottom: 10px; }
  @media print { body { margin: 0; } .intro { display: none; } .card { border: 1px solid #999; } }
`;
  app.get('/qr-sheet.css', async (req, reply) => reply.type('text/css').send(QR_SHEET_CSS));

  function swatchSvg(colour, id) {
    if (!colour?.from) return '';
    const from = escapeHtml(colour.from);
    if (colour.type === 'gradient' && colour.to) {
      return `<svg class="swatch" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">` +
        `<defs><linearGradient id="g${id}"><stop offset="0" stop-color="${from}"/>` +
        `<stop offset="1" stop-color="${escapeHtml(colour.to)}"/></linearGradient></defs>` +
        `<rect width="100" height="10" rx="2" fill="url(#g${id})"/></svg>`;
    }
    return `<svg class="swatch" viewBox="0 0 100 10" preserveAspectRatio="none" aria-hidden="true">` +
      `<rect width="100" height="10" rx="2" fill="${from}"/></svg>`;
  }

  app.get('/admin/tables/qr-sheet', async (req, reply) => {
    const event = requireAdmin(req, reply);
    if (!event) return;

    const tables = db.prepare(
      'SELECT table_number, token, colour FROM teams WHERE event_id = ? AND archived = 0 ORDER BY CAST(table_number AS INTEGER)'
    ).all(event.id);

    const base = baseUrl(req);
    const cards = await Promise.all(tables.map(async (t, i) => {
      const url = `${base}/t/${t.token}`;
      const svg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 220 });
      const colour = t.colour ? JSON.parse(t.colour) : null;
      // Printed card carries the same identifier swatch as everywhere else
      // (CLAUDE.md #18) — table number stays in plain text beside it.
      const swatch = swatchSvg(colour, i);
      return `<div class="card">${swatch}<div class="qr">${svg}</div><div class="num">Table ${escapeHtml(t.table_number)}</div></div>`;
    }));

    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>QR sheet — ${escapeHtml(event.name)}</title>
<link rel="stylesheet" href="/qr-sheet.css">
</head><body>
<h1>${escapeHtml(event.name)} — ${tables.length} tables</h1>
<p class="intro">Print this page. One code per table; the table number appears in plain text beside it so anyone can confirm they scanned their own.</p>
<div class="sheet">${cards.join('')}</div>
</body></html>`;

    return reply.type('text/html').send(html);
  });

  // --- theme: event/round/question cascade, resolved and validated
  // server-side (CLAUDE.md #18-22). An event can't activate with a failing
  // resolved theme (enforced in the activate route above).

  const setEventTheme = db.prepare('UPDATE events SET theme = ? WHERE id = ?');
  const setEventChrome = db.prepare('UPDATE events SET chrome = ? WHERE id = ?');
  const upsertRoundTheme = db.prepare(`
    INSERT INTO rounds (event_id, number, phase, theme) VALUES (?, ?, 'PLAYING', ?)
    ON CONFLICT(event_id, number) DO UPDATE SET theme = excluded.theme
  `);
  const setQuestionTheme = db.prepare('UPDATE questions SET theme = ?, layout = ? WHERE id = ? AND event_id = ?');

  app.get('/admin/theme', async (req, reply) => {
    const event = requireAdmin(req, reply);
    if (!event) return;
    return q.allResolvedThemes(event.id);
  });

  // Live preview for whichever level/target the theme editor currently has
  // selected — previously the preview only ever showed the event default,
  // even while editing a round or question. Resolved server-side from
  // already-saved data, same principle as everywhere else theme is
  // resolved (CLAUDE.md #21): the client never re-derives the cascade.
  app.get('/admin/theme/preview', async (req, reply) => {
    const event = requireAdmin(req, reply);
    if (!event) return;
    const level = String(req.query?.level || 'event');

    let resolved;
    if (level === 'event') {
      resolved = q.resolveCurrentTheme(event, null);
    } else if (level === 'round') {
      const roundNumber = Number(req.query?.target);
      if (!Number.isInteger(roundNumber)) return reply.code(400).send({ error: 'invalid_target' });
      resolved = q.resolveRoundTheme(event, roundNumber);
    } else if (level === 'question') {
      const question = q.getQuestionById.get(Number(req.query?.target));
      if (!question || question.event_id !== event.id) return reply.code(404).send({ error: 'not_found' });
      resolved = q.resolveCurrentTheme(event, question);
    } else {
      return reply.code(400).send({ error: 'invalid_level' });
    }

    return { resolved, validation: validateContrast(resolved.colour) };
  });

  app.put('/admin/theme/event', async (req, reply) => {
    const event = requireAdmin(req, reply);
    if (!event) return;
    const theme = req.body?.theme || {};
    setEventTheme.run(JSON.stringify(theme), event.id);
    logAudit({
      eventId: event.id, role: 'admin', operator: readOpsSession(req).name,
      action: 'setTheme', target: 'event', reason: JSON.stringify(theme)
    });
    return { ok: true };
  });

  app.put('/admin/theme/chrome', async (req, reply) => {
    const event = requireAdmin(req, reply);
    if (!event) return;
    const chrome = req.body?.chrome || {};
    setEventChrome.run(JSON.stringify(chrome), event.id);
    logAudit({
      eventId: event.id, role: 'admin', operator: readOpsSession(req).name,
      action: 'setChrome', target: 'event', reason: JSON.stringify(chrome)
    });
    return { ok: true };
  });

  app.put('/admin/theme/round/:number', async (req, reply) => {
    const event = requireAdmin(req, reply);
    if (!event) return;
    const number = Number(req.params.number);
    const theme = req.body?.theme || {};
    upsertRoundTheme.run(event.id, number, JSON.stringify(theme));
    logAudit({
      eventId: event.id, role: 'admin', operator: readOpsSession(req).name,
      action: 'setTheme', target: `round:${number}`, reason: JSON.stringify(theme)
    });
    return { ok: true };
  });

  app.put('/admin/theme/question/:id', async (req, reply) => {
    const event = requireAdmin(req, reply);
    if (!event) return;
    const question = q.getQuestionById.get(Number(req.params.id));
    if (!question || question.event_id !== event.id) return reply.code(404).send({ error: 'not_found' });

    const theme = req.body?.theme || {};
    if (theme.layout && !LAYOUTS.includes(theme.layout)) {
      return reply.code(400).send({ error: 'invalid_layout' });
    }
    setQuestionTheme.run(JSON.stringify(theme), theme.layout || null, question.id, event.id);
    logAudit({
      eventId: event.id, role: 'admin', operator: readOpsSession(req).name,
      action: 'setTheme', target: `question:${question.id}`, reason: JSON.stringify(theme)
    });
    return { ok: true };
  });

  // --- results export: per-table, per-question CSV (host mockup "Export
  // results"). Team names and scores only, no usernames — same rule as the
  // retention export (CLAUDE.md/scope §6 data retention).

  app.get('/admin/results/export', async (req, reply) => {
    const event = requireAdmin(req, reply);
    if (!event) return;

    reply.header('Content-Disposition', `attachment; filename="results-${event.id}.csv"`);
    return reply.type('text/csv').send(buildResultsCsv(db, event.id));
  });

  // --- audit log + database backup (technical-design §9.3, §18) ----------

  const getAuditLog = db.prepare('SELECT * FROM audit WHERE event_id = ? ORDER BY at DESC LIMIT 500');

  app.get('/admin/audit', async (req, reply) => {
    const event = requireAdmin(req, reply);
    if (!event) return;
    return { entries: getAuditLog.all(event.id) };
  });

  app.get('/admin/backup/database', async (req, reply) => {
    const ops = readOpsSession(req);
    if (!ops || ops.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });
    // Whole database is one file (technical-design §8.2) — checkpoint WAL
    // first so the copy on disk is actually current.
    db.pragma('wal_checkpoint(TRUNCATE)');
    const dbPath = db.name;
    reply.header('Content-Disposition', 'attachment; filename="quiz-backup.db"');
    return reply.type('application/octet-stream').send(readFileSync(dbPath));
  });

  // --- config export/import: portable, separate from the DB backup -------
  // Creates a NEW event, never overwrites (CLAUDE.md #6); tokens and PINs
  // always regenerate (technical-design §16.4). Nested to carry the full
  // theme cascade (event/round/question) and event metadata, not just
  // questions and tables.

  const SCHEMA_VERSION = 1;
  const getTablesForExport = db.prepare(
    'SELECT table_number, seats, colour FROM teams WHERE event_id = ? AND archived = 0 ORDER BY CAST(table_number AS INTEGER)'
  );
  const getSettingsForExport = db.prepare('SELECT key, value FROM settings WHERE event_id = ?');
  const getRoundsForExport = db.prepare('SELECT number, theme FROM rounds WHERE event_id = ? ORDER BY number');
  const getMediaForExport = db.prepare(
    'SELECT filename, sha256, uploaded_at FROM media_manifest WHERE event_id = ?'
  );
  const insertEventDraft = db.prepare(`
    INSERT INTO events (
      name, subtitle, date, time, venue, entry_fee, beneficiary,
      status, passphrase, screen_token, host_pin, marker_pin, floor_pin, admin_pin, theme, chrome, total_rounds
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSettingRow = db.prepare('INSERT INTO settings (event_id, key, value) VALUES (?, ?, ?)');
  const insertEventState = db.prepare(
    "INSERT INTO event_state (event_id, question_status, round_phase) VALUES (?, 'PENDING', 'PLAYING')"
  );
  const insertRoundRow = db.prepare(
    'INSERT INTO rounds (event_id, number, phase, theme) VALUES (?, ?, ?, ?)'
  );
  const insertManifestRow = db.prepare(`
    INSERT OR REPLACE INTO media_manifest (event_id, filename, sha256, uploaded_at) VALUES (?, ?, ?, ?)
  `);

  app.get('/admin/config/export', async (req, reply) => {
    const event = requireAdmin(req, reply);
    if (!event) return;

    const questions = q.getQuestionsForEvent.all(event.id).map((row) => ({
      round: row.round, order_no: row.order_no, type: row.type, prompt: row.prompt,
      options: row.options ? JSON.parse(row.options) : null,
      correct_answer: row.correct_answer,
      aliases: row.aliases ? JSON.parse(row.aliases) : null,
      points: row.points, image_ref: row.image_ref, image_alt: row.image_alt,
      video_url: row.video_url, av_cue: row.av_cue, av_alt: row.av_alt,
      is_practice: !!row.is_practice, is_reserve: !!row.is_reserve,
      theme: row.theme ? JSON.parse(row.theme) : (row.layout ? { layout: row.layout } : null)
    }));

    return {
      schema_version: SCHEMA_VERSION,
      exported_at: new Date().toISOString(),
      event: {
        name: event.name, subtitle: event.subtitle, date: event.date, time: event.time,
        venue: event.venue, entry_fee: event.entry_fee, beneficiary: event.beneficiary,
        total_rounds: event.total_rounds,
        theme: event.theme ? JSON.parse(event.theme) : null,
        chrome: event.chrome ? JSON.parse(event.chrome) : null,
        settings: Object.fromEntries(getSettingsForExport.all(event.id).map((s) => [s.key, s.value]))
      },
      rounds: getRoundsForExport.all(event.id).map((r) => ({
        number: r.number, theme: r.theme ? JSON.parse(r.theme) : null
      })),
      questions,
      tables: getTablesForExport.all(event.id).map((t) => ({
        table_number: t.table_number, seats: t.seats,
        colour: t.colour ? JSON.parse(t.colour) : null
      })),
      media_manifest: getMediaForExport.all(event.id),
      // Never exported (technical-design §9.3): answers, marks, bonuses,
      // players, team names, table tokens, screen token, passphrase, PINs,
      // audit log. Media files themselves — upload the media folder alongside.
    };
  });

  app.post('/admin/config/import', async (req, reply) => {
    const ops = readOpsSession(req);
    if (!ops || ops.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });

    const config = req.body;
    if (!config || config.schema_version !== SCHEMA_VERSION) {
      return reply.code(422).send({ error: 'unsupported_schema_version' });
    }
    const ev = config.event || {};

    // Chrome is set once and never cascades (CLAUDE.md #20) — kept in its
    // own column, separate from the theme it sits beside. Some source files
    // nest it at event.theme.chrome instead of a sibling event.chrome; strip
    // it out of the theme wherever it landed so the two never conflate.
    const chrome = ev.chrome ?? ev.theme?.chrome ?? null;
    const themeOnly = ev.theme ? { ...ev.theme } : null;
    if (themeOnly) delete themeOnly.chrome;

    let mediaCount = 0;
    const mediaMissing = [];
    const newEventId = db.transaction(() => {
      const { lastInsertRowid: eventId } = insertEventDraft.run(
        String(ev.name || config.name || 'Imported event').slice(0, 100),
        ev.subtitle ?? null, ev.date ?? null, ev.time ?? null, ev.venue ?? null,
        ev.entry_fee ?? null, ev.beneficiary ?? null,
        randomToken(12).toLowerCase(), randomToken(12),
        randomPin(), randomPin(), randomPin(), randomPin(),
        themeOnly ? JSON.stringify(themeOnly) : null,
        chrome ? JSON.stringify(chrome) : null,
        Number.isInteger(ev.total_rounds) ? ev.total_rounds : null
      );

      for (const t of config.tables || []) {
        insertTeamRow.run(
          eventId, String(t.table_number), Number(t.seats) || 8,
          randomToken(8), t.colour ? JSON.stringify(t.colour) : null
        );
      }
      for (const r of config.rounds || []) {
        insertRoundRow.run(eventId, r.number, 'PLAYING', r.theme ? JSON.stringify(r.theme) : null);
      }
      for (const qu of config.questions || []) {
        const theme = qu.theme ? JSON.stringify(qu.theme) : (qu.layout ? JSON.stringify({ layout: qu.layout }) : null);
        insertQuestion.run(
          eventId, qu.round ?? null, qu.order_no ?? null, qu.type, qu.prompt,
          qu.options ? JSON.stringify(qu.options) : null, qu.correct_answer ?? null,
          qu.aliases ? JSON.stringify(qu.aliases) : null, qu.points ?? 0,
          qu.image_ref ?? null, qu.image_alt ?? null, qu.video_url ?? null,
          qu.av_cue ?? null, qu.theme?.layout ?? qu.layout ?? null, qu.is_practice ? 1 : 0, qu.is_reserve ? 1 : 0,
          theme, qu.av_alt ?? null
        );
      }
      // Same validation as the settings editor; anything unknown or out of
      // range is dropped and falls back to the default.
      // Older config files used these names.
      const LEGACY_SETTING_NAMES = { poll_interval_ms: 'player_poll_ms', timer_duration_seconds: 'timer_seconds' };
      for (const [rawKey, raw] of Object.entries(ev.settings || config.settings || {})) {
        const key = LEGACY_SETTING_NAMES[rawKey] || rawKey;
        const rule = SETTING_RULES[key];
        const coerced = key === 'timer_enabled' && typeof raw === 'string' ? raw === 'true' : raw;
        const value = rule ? rule(coerced) : null;
        if (value !== null) insertSettingRow.run(eventId, key, value);
      }
      insertEventState.run(eventId);

      // Media files are stored once, by content hash, and shared between
      // events — so a clone only needs the filename -> hash map to find its
      // images. A hash whose file isn't on this server (a config from
      // another machine) is still mapped, and counted so admin knows to
      // re-upload that image.
      for (const m of config.media_manifest || []) {
        const filename = String(m.filename || '').trim().toLowerCase().slice(0, 200);
        const sha256 = String(m.sha256 || '');
        if (!filename || !/^[a-f0-9]{64}$/.test(sha256)) continue;
        insertManifestRow.run(eventId, filename, sha256, m.uploaded_at || new Date().toISOString());
        mediaCount++;
        if (!existsSync(join(MEDIA_DIR, `${sha256}.webp`))) mediaMissing.push(filename);
      }

      logAudit({
        eventId, role: 'admin', operator: ops.name, action: 'importConfig',
        target: 'event', reason: `cloned as event ${eventId}, status draft`
      });
      return eventId;
    })();

    // Move this session into the new event and hand back its PINs — this
    // import is the only moment they're knowable (CLAUDE.md #6: always
    // regenerated, never the old ones).
    const newEvent = q.getEventById.get(newEventId);
    writeOpsSession(reply, { sid: ops.sid, eventId: newEventId, role: 'admin', name: ops.name, iat: ops.iat });
    return {
      ok: true, event_id: newEventId, status: 'draft',
      media: { mapped: mediaCount, missing: mediaMissing },
      pins: { host: newEvent.host_pin, marker: newEvent.marker_pin, floor: newEvent.floor_pin, admin: newEvent.admin_pin }
    };
  });
}
