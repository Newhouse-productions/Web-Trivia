// Admin routes. Question import replaces the whole set (technical-design
// §16.4, §9.4) — CSV import never overwrites an event, it authors one, so
// re-importing into the SAME event fully replaces its question set and is
// blocked once the event has actually been played (CLAUDE.md #6 — config
// import always regenerates/creates, never partially patches).
import { readFileSync } from 'node:fs';
import { parse } from 'csv-parse/sync';
import { readOpsSession } from '../opsSession.js';
import { makeAuditLogger } from '../audit.js';
import { parseQuestionsCsv } from '../import/questionsCsv.js';
import { randomToken, randomPin } from '../tokens.js';

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
      aliases, points, image_ref, image_alt, video_url, av_cue, layout, is_practice, is_reserve)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

  // --- listings: admin sees full detail, unlike every other role ---------

  app.get('/admin/questions', async (req, reply) => {
    const event = requireAdmin(req, reply);
    if (!event) return;
    const questions = q.getQuestionsForEvent.all(event.id).map((row) => q.hostQuestionPayload(row, null));
    return { questions };
  });

  app.get('/admin/tables', async (req, reply) => {
    const event = requireAdmin(req, reply);
    if (!event) return;
    const tables = db.prepare(
      'SELECT id, table_number, seats, colour, archived, token FROM teams WHERE event_id = ? ORDER BY table_number'
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
          row.is_practice ? 1 : 0, row.is_reserve ? 1 : 0
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
  // always regenerate (technical-design §16.4).

  const SCHEMA_VERSION = 1;
  const getTablesForExport = db.prepare(
    'SELECT table_number, seats, colour FROM teams WHERE event_id = ? AND archived = 0 ORDER BY table_number'
  );
  const getSettingsForExport = db.prepare('SELECT key, value FROM settings WHERE event_id = ?');
  const insertEventDraft = db.prepare(`
    INSERT INTO events (name, date, status, passphrase, screen_token, host_pin, marker_pin, floor_pin, admin_pin)
    VALUES (?, ?, 'draft', ?, ?, ?, ?, ?, ?)
  `);
  const insertSettingRow = db.prepare('INSERT INTO settings (event_id, key, value) VALUES (?, ?, ?)');
  const insertEventState = db.prepare(
    "INSERT INTO event_state (event_id, question_status, round_phase) VALUES (?, 'PENDING', 'PLAYING')"
  );

  app.get('/admin/config/export', async (req, reply) => {
    const event = requireAdmin(req, reply);
    if (!event) return;

    const questions = q.getQuestionsForEvent.all(event.id).map((row) => ({
      round: row.round, order_no: row.order_no, type: row.type, prompt: row.prompt,
      options: row.options ? JSON.parse(row.options) : null,
      correct_answer: row.correct_answer,
      aliases: row.aliases ? JSON.parse(row.aliases) : null,
      points: row.points, image_ref: row.image_ref, image_alt: row.image_alt,
      video_url: row.video_url, av_cue: row.av_cue, layout: row.layout,
      is_practice: !!row.is_practice, is_reserve: !!row.is_reserve
    }));

    return {
      schema_version: SCHEMA_VERSION,
      name: event.name,
      questions,
      tables: getTablesForExport.all(event.id).map((t) => ({
        table_number: t.table_number, seats: t.seats,
        colour: t.colour ? JSON.parse(t.colour) : null
      })),
      settings: Object.fromEntries(getSettingsForExport.all(event.id).map((s) => [s.key, s.value]))
    };
  });

  app.post('/admin/config/import', async (req, reply) => {
    const ops = readOpsSession(req);
    if (!ops || ops.role !== 'admin') return reply.code(403).send({ error: 'forbidden' });

    const config = req.body;
    if (!config || config.schema_version !== SCHEMA_VERSION) {
      return reply.code(422).send({ error: 'unsupported_schema_version' });
    }

    const newEventId = db.transaction(() => {
      const { lastInsertRowid: eventId } = insertEventDraft.run(
        String(config.name || 'Imported event').slice(0, 100),
        null,
        randomToken(12).toLowerCase(),
        randomToken(12),
        randomPin(), randomPin(), randomPin(), randomPin()
      );

      for (const t of config.tables || []) {
        insertTeamRow.run(
          eventId, String(t.table_number), Number(t.seats) || 8,
          randomToken(8), t.colour ? JSON.stringify(t.colour) : null
        );
      }
      for (const qu of config.questions || []) {
        insertQuestion.run(
          eventId, qu.round ?? null, qu.order_no ?? null, qu.type, qu.prompt,
          qu.options ? JSON.stringify(qu.options) : null, qu.correct_answer ?? null,
          qu.aliases ? JSON.stringify(qu.aliases) : null, qu.points ?? 0,
          qu.image_ref ?? null, qu.image_alt ?? null, qu.video_url ?? null,
          qu.av_cue ?? null, qu.layout ?? null, qu.is_practice ? 1 : 0, qu.is_reserve ? 1 : 0
        );
      }
      for (const [key, value] of Object.entries(config.settings || {})) {
        insertSettingRow.run(eventId, key, String(value));
      }
      insertEventState.run(eventId);

      logAudit({
        eventId, role: 'admin', operator: ops.name, action: 'importConfig',
        target: 'event', reason: `cloned as event ${eventId}, status draft`
      });
      return eventId;
    })();

    return { ok: true, event_id: newEventId, status: 'draft' };
  });
}
