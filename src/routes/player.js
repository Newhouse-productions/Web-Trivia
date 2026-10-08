// Player-facing routes: token exchange, passphrase gate, name picker with
// captain auto-assign, takeover, answering, and the polling endpoints.
import { randomToken } from '../tokens.js';
import { readSession, writeSession } from '../session.js';
import { checkLimiter, recordFailure, recordSuccess } from '../passphraseLimiter.js';
import { makeAuditLogger } from '../audit.js';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function messagePage(message) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trivia</title><link rel="stylesheet" href="/style.css"></head>
<body><p>${escapeHtml(message)}</p></body></html>`;
}

export function registerPlayerRoutes(app, { db, q }) {
  const logAudit = makeAuditLogger(db);
  const setTeamName = db.prepare('UPDATE teams SET team_name = ? WHERE id = ?');

  // --- token exchange (CLAUDE.md #4) --------------------------------------

  app.get('/t/:token', async (req, reply) => {
    const row = q.getTeamByToken.get(req.params.token);
    if (!row || row.archived) {
      return reply.code(404).type('text/html').send(messagePage("This code isn't recognised."));
    }
    // A real code for an event that isn't live (finished, or not started)
    // gets a plain message, not a 404 and not stale state (scope §7).
    if (row.event_status !== 'active') {
      return reply.type('text/html').send(messagePage("This event isn't running right now."));
    }

    const existing = readSession(req);
    const sameEvent = existing && existing.eventId === row.event_id;
    const sameTeam = sameEvent && existing.teamId === row.id;

    writeSession(reply, {
      sid: existing?.sid || randomToken(16),
      eventId: row.event_id,
      teamId: row.id,
      playerId: sameTeam ? existing.playerId : null,
      gateOk: sameEvent ? existing.gateOk : false
    });

    // Direct-link convenience (see public/play.js's renderGate): forward an
    // explicit ?passphrase= so it survives this redirect and can auto-fill
    // the gate. Only this one known param is forwarded, never the raw query
    // string, and it never touches the session — the gate still runs the
    // same POST /gate + rate limiter either way.
    const passphrase = req.query?.passphrase;
    const dest = passphrase ? `/play?passphrase=${encodeURIComponent(passphrase)}` : '/play';
    return reply.redirect(dest, 302);
  });

  // --- state / version (technical-design §4-5) ----------------------------

  app.get('/v', async (req, reply) => {
    const session = readSession(req);
    const ctx = q.resolveSessionContext(session);
    if (!ctx) return reply.code(401).send({ error: 'no_session' });
    // Presence for the host/floor "is this table still with us" views —
    // informational only, never bumps table_version (a poll isn't a change).
    q.touchLastSeen.run(new Date().toISOString(), ctx.team.id);
    // Two independent counters, not merged into one (CLAUDE.md #5). A
    // max() of two independently-incrementing values isn't injective —
    // once table_version numerically overtakes event_version (it does
    // almost immediately, from the player's own join), a later
    // event_version bump can be masked because the max doesn't move.
    // The client must compare both, not a collapsed scalar.
    return { event_version: ctx.event.version, table_version: ctx.team.table_version };
  });

  app.get('/state', async (req, reply) => {
    const session = readSession(req);
    if (!session) return { stage: 'no_session' };

    const ctx = q.resolveSessionContext(session);
    if (!ctx) return { stage: 'event_not_running' };
    const { event, team } = ctx;

    if (!session.gateOk) return { stage: 'gate' };

    if (!session.playerId) {
      return { stage: 'name', team: { table_number: team.table_number, team_name: team.team_name } };
    }

    const player = q.getPlayerById.get(session.playerId);
    if (!player) {
      return { stage: 'name', team: { table_number: team.table_number, team_name: team.team_name } };
    }

    // Pause overlays whatever was happening — the question is hidden, not
    // greyed, so nobody reads ahead while the room is doing something else
    // (CLAUDE.md #17). Resuming restores exactly what was showing.
    if (event.paused) {
      const paused = JSON.parse(event.paused);
      return {
        stage: 'paused',
        event_version: event.version,
        table_version: team.table_version,
        message: paused.message,
        team: { table_number: team.table_number, team_name: team.team_name }
      };
    }

    // A published round shows the leaderboard on the phone too, not just the
    // big screen — the room reads their own result while marking wraps up.
    const es = q.getEventState.get(event.id);
    if (es.round_phase === 'PUBLISHED') {
      const round = q.getPublishedRound.get(event.id);
      if (round) {
        const board = JSON.parse(round.published_leaderboard);
        const place = board.findIndex((r) => r.team_id === team.id);
        return {
          stage: 'leaderboard',
          event_version: event.version,
          table_version: team.table_version,
          round: round.number,
          leaderboard: board,
          our_place: place === -1 ? null : place + 1,
          team: { table_number: team.table_number, team_name: team.team_name },
          theme: q.resolveCurrentTheme(event, null)
        };
      }
    }

    const current = q.getCurrentQuestion.get(event.id);
    const ourAnswer = current ? q.getAnswer.get(team.id, current.question_id) : null;
    const captain = team.captain_player_id ? q.getPlayerById.get(team.captain_player_id) : null;

    return {
      stage: 'play',
      event_version: event.version,
      table_version: team.table_version,
      round: current ? current.round : null,
      theme: q.resolveCurrentTheme(event, current),
      timer: q.resolveTimer(event, current, current?.question_status),
      question: current ? q.playerQuestionPayload(current) : null,
      our_answer: current ? q.playerAnswerPayload(ourAnswer, current.question_status) : null,
      team: {
        table_number: team.table_number,
        team_name: team.team_name,
        colour: team.colour ? JSON.parse(team.colour) : null,
        score: q.teamScore(team.id),
        is_captain: team.captain_player_id === player.id,
        can_rename: team.captain_player_id === player.id && !q.roundOneStarted(event.id),
        captain_player_id: team.captain_player_id,
        captain_name: captain ? captain.username : null
      }
    };
  });

  // --- passphrase gate (CLAUDE.md #10, technical-design §7.3-7.4) --------

  app.post('/gate', async (req, reply) => {
    const session = readSession(req);
    if (!session) return reply.code(401).send({ error: 'no_session' });

    const limiter = checkLimiter(session.sid);
    if (!limiter.allowed) {
      return reply.code(429).send({ ok: false, retry_after_ms: limiter.retryAfterMs });
    }

    const event = q.getEventById.get(session.eventId);
    if (!event || event.status !== 'active') {
      return reply.code(401).send({ error: 'event_not_running' });
    }

    const supplied = String(req.body?.passphrase || '').trim().toLowerCase();
    const expected = event.passphrase.trim().toLowerCase();

    if (!supplied || supplied !== expected) {
      recordFailure(session.sid);
      return reply.code(401).send({ ok: false, message: 'Incorrect passphrase.' });
    }

    recordSuccess(session.sid);
    writeSession(reply, { ...session, gateOk: true });
    return { ok: true };
  });

  // --- name picker + captain auto-assign (CLAUDE.md #12, §18.4) ----------

  app.post('/join', async (req, reply) => {
    const session = readSession(req);
    if (!session || !session.gateOk) return reply.code(401).send({ error: 'not_ready' });

    const ctx = q.resolveSessionContext(session);
    if (!ctx) return reply.code(401).send({ error: 'event_not_running' });
    const { event, team } = ctx;
    if (event.paused) return reply.code(423).send({ error: 'paused' });

    const username = String(req.body?.username || '').trim().slice(0, 20);
    if (!username) return reply.code(400).send({ error: 'username_required' });

    const taken = q.getTeamUsernames.all(team.id).map((r) => r.username.toLowerCase());
    if (taken.includes(username.toLowerCase())) {
      let n = 2;
      while (taken.includes(`${username.toLowerCase()} ${n}`)) n++;
      return reply.code(409).send({ error: 'username_taken', suggested: `${username} ${n}` });
    }

    let playerId;
    try {
      const join = db.transaction(() => {
        const { lastInsertRowid } = q.insertPlayer.run(event.id, team.id, username);
        q.assignCaptainIfEmpty.run(lastInsertRowid, team.id);
        // Which round was live when this table's first player showed up —
        // scope: "Late tables score zero for missed rounds... joined_at_round
        // recorded." Only the current question's round is known here (no
        // dedicated round-number field on event_state), and it may be null
        // for a practice/reserve question — that's fine, it just means we
        // couldn't attribute a round yet, not that anything is broken.
        const es = q.getEventState.get(event.id);
        const current = es?.current_question_id ? q.getQuestionById.get(es.current_question_id) : null;
        if (current?.round != null) q.setJoinedAtRoundIfEmpty.run(current.round, team.id);
        q.bumpTableVersion.run(team.id);
        return lastInsertRowid;
      });
      playerId = join();
    } catch (err) {
      if (String(err.code).startsWith('SQLITE_CONSTRAINT')) {
        return reply.code(409).send({ error: 'username_taken', suggested: `${username} 2` });
      }
      throw err;
    }

    writeSession(reply, { ...session, playerId });
    return { ok: true };
  });

  // --- captain takeover (CLAUDE.md #12, technical-design §6.1, §11.2) ----

  app.post('/takeover', async (req, reply) => {
    const session = readSession(req);
    if (!session || !session.gateOk || !session.playerId) {
      return reply.code(401).send({ error: 'not_ready' });
    }

    const ctx = q.resolveSessionContext(session);
    if (!ctx) return reply.code(401).send({ error: 'event_not_running' });
    const { event, team } = ctx;
    if (event.paused) return reply.code(423).send({ error: 'paused' });

    const expectsCaptain = req.body?.expects_captain_player_id ?? null;

    const changed = db.transaction(() => {
      const info = q.setCaptainCas.run(session.playerId, team.id, expectsCaptain);
      if (info.changes === 0) return false;
      q.bumpTableVersion.run(team.id);
      // Handover is announced and logged (scope §2) — dispute evidence for
      // "who was answering for table 12 when that went in".
      const player = q.getPlayerById.get(session.playerId);
      const previous = expectsCaptain ? q.getPlayerById.get(expectsCaptain) : null;
      logAudit({
        eventId: event.id, role: 'player', operator: player?.username ?? null, action: 'takeover',
        target: `team:${team.id}`, reason: previous ? `from ${previous.username}` : 'no previous captain'
      });
      return true;
    })();

    if (!changed) {
      const fresh = q.getTeamById.get(team.id);
      const currentCaptain = fresh.captain_player_id ? q.getPlayerById.get(fresh.captain_player_id) : null;
      return reply.code(409).send({
        error: 'captain_changed',
        current_captain_id: fresh.captain_player_id,
        current_captain: currentCaptain ? currentCaptain.username : null
      });
    }

    return { ok: true };
  });

  // --- team name: the captain sets it until round 1 starts (scope §2) -----

  app.post('/team-name', async (req, reply) => {
    const session = readSession(req);
    if (!session || !session.gateOk || !session.playerId) {
      return reply.code(401).send({ error: 'not_ready' });
    }

    const ctx = q.resolveSessionContext(session);
    if (!ctx) return reply.code(401).send({ error: 'event_not_running' });
    const { event, team } = ctx;
    if (event.paused) return reply.code(423).send({ error: 'paused' });

    if (team.captain_player_id !== session.playerId) {
      return reply.code(403).send({ error: 'not_captain' });
    }
    // After round 1 starts the name is on the leaderboard; changes go
    // through Floor, which is logged with an operator.
    if (q.roundOneStarted(event.id)) {
      return reply.code(409).send({ error: 'rename_closed' });
    }

    // Capped at the API, not the input field (CLAUDE.md #2); same cap as Floor.
    const teamName = String(req.body?.team_name ?? '').trim().slice(0, 32);

    db.transaction(() => {
      setTeamName.run(teamName || null, team.id);
      q.bumpTableVersion.run(team.id);
      const player = q.getPlayerById.get(session.playerId);
      logAudit({
        eventId: event.id, role: 'player', operator: player?.username ?? null, action: 'renameTeam',
        target: `team:${team.id}`, reason: teamName || '(cleared)'
      });
    })();

    return { ok: true, team_name: teamName || null };
  });

  // --- answer (CLAUDE.md #12) ---------------------------------------------

  app.post('/answer', async (req, reply) => {
    const session = readSession(req);
    if (!session || !session.gateOk || !session.playerId) {
      return reply.code(401).send({ error: 'not_ready' });
    }

    const ctx = q.resolveSessionContext(session);
    if (!ctx) return reply.code(401).send({ error: 'event_not_running' });
    const { event, team } = ctx;
    if (event.paused) return reply.code(423).send({ error: 'paused' });

    if (team.captain_player_id !== session.playerId) {
      return reply.code(403).send({ error: 'not_captain' });
    }

    const questionId = Number(req.body?.question_id);
    const current = q.getCurrentQuestion.get(event.id);

    if (!current || current.question_id !== questionId) {
      return reply.code(409).send({ error: 'question_not_open' });
    }
    if (current.question_status === 'CLOSED' || current.question_status === 'REVEALED') {
      // Own message: an answer arriving the instant a question closes is
      // correct behaviour, not a bug (technical-design §5).
      return reply.code(409).send({
        error: 'closed_before_arrival',
        message: 'The question closed before your answer arrived.'
      });
    }
    if (current.question_status !== 'OPEN') {
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
      // Alias auto-match (CLAUDE.md build order: "alias matching behaves
      // like P0"). Anything not matching the correct answer or a known
      // alias needs a human — it lands in the marking queue once CLOSED.
      const normalize = (s) => String(s || '').trim().toLowerCase();
      const aliases = current.aliases ? JSON.parse(current.aliases) : [];
      const accepted = new Set([normalize(current.correct_answer), ...aliases.map(normalize)]);
      isCorrect = accepted.has(normalize(value)) ? 1 : null;
    }
    const now = new Date().toISOString();

    db.transaction(() => {
      q.upsertAnswer.run(event.id, team.id, questionId, value, session.playerId, now, isCorrect);
      q.bumpTableVersion.run(team.id);
    })();

    return { ok: true };
  });
}
