// Floor: walks the room with a phone, held at chest height. Never sees
// correct answers — that screen is readable over a shoulder in a crowded
// room (technical-design §13.2). Every floor action is logged with a
// reason and appears in the admin audit log.
import QRCode from 'qrcode';
import { readOpsSession } from '../opsSession.js';
import { makeAuditLogger } from '../audit.js';
import { capText } from '../text.js';

// Built from the incoming request, never stored (CLAUDE.md #3).
function baseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  return `${proto}://${req.headers.host}`;
}

export function registerFloorRoutes(app, { db, q }) {
  const logAudit = makeAuditLogger(db);
  const getTeamsWithStatus = db.prepare(`
    SELECT t.id AS team_id, t.table_number, t.team_name, t.captain_player_id, t.last_seen_at, t.colour,
           (SELECT COUNT(*) FROM players p WHERE p.team_id = t.id) AS player_count,
           (SELECT username FROM players p WHERE p.id = t.captain_player_id) AS captain_name,
           (SELECT COUNT(*) FROM answers a WHERE a.team_id = t.id AND a.question_id = ?) AS answered_current
    FROM teams t WHERE t.event_id = ? AND t.archived = 0
    ORDER BY CAST(t.table_number AS INTEGER)
  `);
  const getTeamPlayers = db.prepare('SELECT id, username FROM players WHERE team_id = ? ORDER BY username');
  const setTeamName = db.prepare('UPDATE teams SET team_name = ? WHERE id = ?');
  const setCaptain = db.prepare('UPDATE teams SET captain_player_id = ? WHERE id = ?');
  const getOwnActions = db.prepare(`
    SELECT action, target, reason, at FROM audit
    WHERE event_id = ? AND role = 'floor' AND operator IS ?
    ORDER BY at DESC LIMIT 30
  `);

  function requireFloor(req, reply) {
    const ops = readOpsSession(req);
    if (!ops || ops.role !== 'floor') {
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

  app.get('/floor/v', async (req, reply) => {
    const ctx = requireFloor(req, reply);
    if (!ctx) return;
    return { version: ctx.event.version };
  });

  app.get('/floor/teams', async (req, reply) => {
    const ctx = requireFloor(req, reply);
    if (!ctx) return;
    const es = q.getEventState.get(ctx.event.id);
    const currentId = es.current_question_id || 0;
    const current = currentId ? q.getQuestionById.get(currentId) : null;
    const teams = getTeamsWithStatus.all(currentId, ctx.event.id).map((t) => ({
      ...t, colour: t.colour ? JSON.parse(t.colour) : null
    }));
    return { teams, question_open: es.question_status === 'OPEN', theme: q.resolveCurrentTheme(ctx.event, current) };
  });

  app.get('/floor/team/:id', async (req, reply) => {
    const ctx = requireFloor(req, reply);
    if (!ctx) return;
    const team = q.getTeamById.get(Number(req.params.id));
    if (!team || team.event_id !== ctx.event.id) return reply.code(404).send({ error: 'not_found' });

    const es = q.getEventState.get(ctx.event.id);
    const current = es.current_question_id ? q.getQuestionById.get(es.current_question_id) : null;
    const ourAnswer = current ? q.getAnswer.get(team.id, current.id) : null;

    return {
      theme: q.resolveCurrentTheme(ctx.event, current),
      team: {
        id: team.id, table_number: team.table_number, team_name: team.team_name,
        token: team.token, captain_player_id: team.captain_player_id
      },
      players: getTeamPlayers.all(team.id),
      // "Show code and passphrase" is the runbook's first step for a table
      // that can't connect (scope §8). The QR is served by team id, so the
      // token never lands in an image URL.
      join: { code: team.token, passphrase: ctx.event.passphrase, qr: `/floor/team/${team.id}/qr.svg` },
      // No correct_answer, no aliases — floor never sees them (§13.2).
      current_question: current ? {
        id: current.id, prompt: current.prompt, type: current.type,
        options: current.options ? JSON.parse(current.options) : null,
        state: es.question_status
      } : null,
      our_answer: ourAnswer ? { value: ourAnswer.value } : null
    };
  });

  // A QR the table's phone can scan straight off the floor phone.
  app.get('/floor/team/:id/qr.svg', async (req, reply) => {
    const ctx = requireFloor(req, reply);
    if (!ctx) return;
    const team = q.getTeamById.get(Number(req.params.id));
    if (!team || team.event_id !== ctx.event.id || team.archived) return reply.code(404).send({ error: 'not_found' });
    const svg = await QRCode.toString(`${baseUrl(req)}/t/${team.token}`, { type: 'svg', margin: 1, width: 240 });
    return reply.type('image/svg+xml').send(svg);
  });

  // Floor's own action log (scope §4) — what this operator did tonight.
  app.get('/floor/log', async (req, reply) => {
    const ctx = requireFloor(req, reply);
    if (!ctx) return;
    return { entries: getOwnActions.all(ctx.event.id, ctx.ops.name ?? null) };
  });

  app.post('/floor/rename', async (req, reply) => {
    const ctx = requireFloor(req, reply);
    if (!ctx) return;
    const teamId = Number(req.body?.team_id);
    const teamName = capText(req.body?.team_name, 32);
    const team = q.getTeamById.get(teamId);
    if (!team || team.event_id !== ctx.event.id) return reply.code(404).send({ error: 'not_found' });

    db.transaction(() => {
      setTeamName.run(teamName || null, teamId);
      q.bumpTableVersion.run(teamId);
      logAudit({
        eventId: ctx.event.id, role: 'floor', operator: ctx.ops.name, action: 'renameTeam',
        target: `team:${teamId}`, reason: teamName
      });
    })();
    return { ok: true };
  });

  app.post('/floor/reassign-captain', async (req, reply) => {
    const ctx = requireFloor(req, reply);
    if (!ctx) return;
    const teamId = Number(req.body?.team_id);
    const playerId = Number(req.body?.player_id);
    const team = q.getTeamById.get(teamId);
    if (!team || team.event_id !== ctx.event.id) return reply.code(404).send({ error: 'not_found' });
    const player = q.getPlayerById.get(playerId);
    if (!player || player.team_id !== teamId) return reply.code(400).send({ error: 'unknown_player' });

    db.transaction(() => {
      setCaptain.run(playerId, teamId);
      q.bumpTableVersion.run(teamId);
      logAudit({
        eventId: ctx.event.id, role: 'floor', operator: ctx.ops.name, action: 'reassignCaptain',
        target: `team:${teamId}`, reason: `now ${player.username}`
      });
    })();
    return { ok: true };
  });

  app.post('/floor/answer-on-behalf', async (req, reply) => {
    const ctx = requireFloor(req, reply);
    if (!ctx) return;
    const { event } = ctx;

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

    // Floor dictates on the table's behalf, so scoring stays hidden from
    // them too — the value goes in, matching is still resolved server-side.
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
      q.upsertAnswer.run(event.id, teamId, questionId, value, null, new Date().toISOString(), isCorrect);
      q.bumpTableVersion.run(teamId);
      logAudit({
        eventId: event.id, role: 'floor', operator: ctx.ops.name, action: 'answerOnBehalf',
        target: `question:${questionId} team:${teamId}`, reason: value
      });
    })();

    return { ok: true };
  });
}
