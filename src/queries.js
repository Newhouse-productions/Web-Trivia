// Prepared statements and payload builders shared by the player and ops
// route modules. Payloads are built by naming fields to include, never by
// deleting sensitive ones (CLAUDE.md #1).
export function buildQueries(db) {
  const getEventById = db.prepare('SELECT * FROM events WHERE id = ?');
  const getTeamById = db.prepare('SELECT * FROM teams WHERE id = ?');
  const getTeamByToken = db.prepare(`
    SELECT teams.*, events.status AS event_status, events.passphrase AS event_passphrase
    FROM teams JOIN events ON events.id = teams.event_id
    WHERE teams.token = ?
  `);
  const getPlayerById = db.prepare('SELECT * FROM players WHERE id = ?');
  const getTeamUsernames = db.prepare('SELECT username FROM players WHERE team_id = ?');
  const insertPlayer = db.prepare('INSERT INTO players (event_id, team_id, username) VALUES (?, ?, ?)');
  const assignCaptainIfEmpty = db.prepare(
    'UPDATE teams SET captain_player_id = ? WHERE id = ? AND captain_player_id IS NULL'
  );
  const setCaptainCas = db.prepare(
    'UPDATE teams SET captain_player_id = ? WHERE id = ? AND captain_player_id IS ?'
  );
  const bumpTableVersion = db.prepare('UPDATE teams SET table_version = table_version + 1 WHERE id = ?');
  const bumpEventVersion = db.prepare('UPDATE events SET version = version + 1 WHERE id = ? RETURNING version');

  const getEventState = db.prepare('SELECT * FROM event_state WHERE event_id = ?');
  const setEventStateQuestion = db.prepare(
    'UPDATE event_state SET current_question_id = ?, question_status = ? WHERE event_id = ?'
  );
  const setRoundPhase = db.prepare('UPDATE event_state SET round_phase = ? WHERE event_id = ?');

  const getCurrentQuestion = db.prepare(`
    SELECT es.question_status, q.id AS question_id, q.event_id, q.round, q.type, q.prompt,
           q.options, q.correct_answer, q.aliases, q.points, q.image_ref, q.image_alt,
           q.video_url, q.av_cue, q.is_practice
    FROM event_state es
    JOIN questions q ON q.id = es.current_question_id
    WHERE es.event_id = ?
  `);
  const getMediaHash = db.prepare(
    'SELECT sha256 FROM media_manifest WHERE event_id = ? AND filename = ?'
  );

  function resolveMediaUrl(eventId, filename) {
    if (!filename) return null;
    const row = getMediaHash.get(eventId, filename);
    return row ? `/media/${row.sha256}.webp` : null;
  }
  const getQuestionById = db.prepare('SELECT * FROM questions WHERE id = ?');
  const getQuestionsForEvent = db.prepare(
    'SELECT * FROM questions WHERE event_id = ? ORDER BY round, order_no'
  );

  const getAnswer = db.prepare('SELECT * FROM answers WHERE team_id = ? AND question_id = ?');
  const upsertAnswer = db.prepare(`
    INSERT INTO answers (event_id, team_id, question_id, value, submitted_by, submitted_at, is_correct)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(team_id, question_id) DO UPDATE SET
      value = excluded.value,
      submitted_by = excluded.submitted_by,
      submitted_at = excluded.submitted_at,
      is_correct = excluded.is_correct
  `);

  const getTeamsForEvent = db.prepare(
    'SELECT * FROM teams WHERE event_id = ? AND archived = 0 ORDER BY table_number'
  );

  function resolveSessionContext(session) {
    if (!session) return null;
    const event = getEventById.get(session.eventId);
    const team = getTeamById.get(session.teamId);
    if (!event || event.status !== 'active' || !team || team.archived) return null;
    return { event, team };
  }

  function playerQuestionPayload(row) {
    const payload = {
      id: row.question_id,
      state: row.question_status,
      type: row.type,
      prompt: row.prompt,
      options: row.options ? JSON.parse(row.options) : null,
      points: row.points,
      image: resolveMediaUrl(row.event_id, row.image_ref),
      image_alt: row.image_alt || null
    };
    // Never sent before REVEALED (CLAUDE.md #1).
    if (row.question_status === 'REVEALED') {
      payload.correct_answer = row.correct_answer;
      if (row.video_url) payload.video_url = row.video_url;
    }
    return payload;
  }

  function playerAnswerPayload(answer, questionStatus) {
    if (!answer) return null;
    const payload = { value: answer.value, submitted_at: answer.submitted_at };
    if (questionStatus === 'REVEALED' && answer.is_correct !== null) {
      payload.is_correct = !!answer.is_correct;
    }
    return payload;
  }

  function hostQuestionPayload(row, questionStatus) {
    return {
      id: row.id,
      round: row.round,
      order_no: row.order_no,
      type: row.type,
      prompt: row.prompt,
      options: row.options ? JSON.parse(row.options) : null,
      correct_answer: row.correct_answer,
      aliases: row.aliases ? JSON.parse(row.aliases) : null,
      points: row.points,
      image: resolveMediaUrl(row.event_id, row.image_ref),
      image_alt: row.image_alt,
      video_url: row.video_url,
      av_cue: row.av_cue,
      is_practice: !!row.is_practice,
      is_reserve: !!row.is_reserve,
      state: questionStatus
    };
  }

  return {
    getEventById, getTeamById, getTeamByToken, getPlayerById, getTeamUsernames,
    insertPlayer, assignCaptainIfEmpty, setCaptainCas, bumpTableVersion, bumpEventVersion,
    getEventState, setEventStateQuestion, setRoundPhase,
    getCurrentQuestion, getQuestionById, getQuestionsForEvent,
    getAnswer, upsertAnswer, getTeamsForEvent, resolveMediaUrl,
    resolveSessionContext, playerQuestionPayload, playerAnswerPayload, hostQuestionPayload
  };
}
