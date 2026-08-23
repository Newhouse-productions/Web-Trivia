// Prepared statements and payload builders shared by the player and ops
// route modules. Payloads are built by naming fields to include, never by
// deleting sensitive ones (CLAUDE.md #1).
import { resolveTheme, isDark } from './theme.js';

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
  // Presence only — never bumps table_version. A poll isn't a change; bumping
  // version here would make every /v call look like new state to fetch.
  const touchLastSeen = db.prepare('UPDATE teams SET last_seen_at = ? WHERE id = ?');

  const getEventState = db.prepare('SELECT * FROM event_state WHERE event_id = ?');
  const setEventStateQuestion = db.prepare(
    'UPDATE event_state SET current_question_id = ?, question_status = ? WHERE event_id = ?'
  );
  const setRoundPhase = db.prepare('UPDATE event_state SET round_phase = ? WHERE event_id = ?');
  const getPublishedRound = db.prepare(
    "SELECT * FROM rounds WHERE event_id = ? AND phase = 'PUBLISHED' ORDER BY number DESC LIMIT 1"
  );

  const getCurrentQuestion = db.prepare(`
    SELECT es.question_status, q.id AS question_id, q.event_id, q.round, q.type, q.prompt,
           q.options, q.correct_answer, q.aliases, q.points, q.image_ref, q.image_alt,
           q.video_url, q.av_cue, q.is_practice, q.theme
    FROM event_state es
    JOIN questions q ON q.id = es.current_question_id
    WHERE es.event_id = ?
  `);
  const getMediaHash = db.prepare(
    'SELECT sha256 FROM media_manifest WHERE event_id = ? AND filename = ?'
  );
  const getRoundByNumber = db.prepare('SELECT theme FROM rounds WHERE event_id = ? AND number = ?');

  // Resolved server-side; the client never sees the cascade (CLAUDE.md #21).
  function resolveCurrentTheme(event, current) {
    const eventTheme = event.theme ? JSON.parse(event.theme) : null;
    const roundRow = current && current.round ? getRoundByNumber.get(event.id, current.round) : null;
    const roundTheme = roundRow?.theme ? JSON.parse(roundRow.theme) : null;
    const questionTheme = current?.theme ? JSON.parse(current.theme) : null;
    return resolveTheme({ eventTheme, roundTheme, questionTheme });
  }

  // Chrome is set once at event level and never cascades (CLAUDE.md #20) —
  // logo and footer, picked by the resolved background's luminance since a
  // single logo file won't survive both a light and a dark theme.
  function resolveChrome(event, resolvedColour) {
    if (!event.chrome) return null;
    const chrome = JSON.parse(event.chrome);
    const wantDark = resolvedColour ? isDark(resolvedColour.bg) : true;
    const logoFile = (wantDark ? chrome.logo_dark : chrome.logo_light) || chrome.logo_dark || chrome.logo_light;
    return {
      title: chrome.title || null,
      subtitle: chrome.subtitle || null,
      footer: chrome.footer || null,
      logo: logoFile ? resolveMediaUrl(event.id, logoFile) : null
    };
  }

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
  // Scores are derived on read, never stored (CLAUDE.md #13).
  const getTeamScore = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN a.is_correct = 1 AND q.is_skipped = 0 THEN q.points ELSE 0 END), 0) AS answer_points,
      (SELECT COALESCE(SUM(points), 0) FROM bonuses b WHERE b.team_id = ?) AS bonus_points
    FROM answers a JOIN questions q ON q.id = a.question_id
    WHERE a.team_id = ?
  `);
  function teamScore(teamId) {
    const row = getTeamScore.get(teamId, teamId);
    return row.answer_points + row.bonus_points;
  }
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
    'SELECT * FROM teams WHERE event_id = ? AND archived = 0 ORDER BY CAST(table_number AS INTEGER)'
  );

  function resolveSessionContext(session) {
    if (!session) return null;
    const event = getEventById.get(session.eventId);
    const team = getTeamById.get(session.teamId);
    if (!event || event.status !== 'active' || !team || team.archived) return null;
    return { event, team };
  }

  function playerQuestionPayload(row) {
    // PENDING is a holding screen, not the question (technical-design §2.1's
    // state table: "Holding screen, or 'listen up' if AV cue" / big screen
    // "Round card or AV") — prompt, options and image are never sent before
    // the host actually opens it, same allowlist discipline as the
    // correct-answer gate below (CLAUDE.md #1).
    if (row.question_status === 'PENDING') {
      return { id: row.question_id, state: row.question_status, type: row.type, points: row.points };
    }

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
      theme: row.theme ? JSON.parse(row.theme) : (row.layout ? { layout: row.layout } : null),
      state: questionStatus
    };
  }

  return {
    getEventById, getTeamById, getTeamByToken, getPlayerById, getTeamUsernames,
    insertPlayer, assignCaptainIfEmpty, setCaptainCas, bumpTableVersion, bumpEventVersion, touchLastSeen,
    getEventState, setEventStateQuestion, setRoundPhase, getPublishedRound,
    getCurrentQuestion, getQuestionById, getQuestionsForEvent,
    getAnswer, upsertAnswer, getTeamsForEvent, resolveMediaUrl, teamScore, resolveCurrentTheme, resolveChrome,
    resolveSessionContext, playerQuestionPayload, playerAnswerPayload, hostQuestionPayload
  };
}
