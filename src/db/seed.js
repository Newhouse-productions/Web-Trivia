// Dev seed: one active event, 30 tables, one open question. Safe to re-run —
// wipes prior dev data first. Not for production use (CLAUDE.md: config
// import always creates a new event, never overwrites).
import { getDb } from './index.js';
import { randomToken } from '../tokens.js';

const db = getDb();

const seed = db.transaction(() => {
  db.exec(`
    DELETE FROM answers;
    DELETE FROM bonuses;
    DELETE FROM marking_claims;
    DELETE FROM event_state;
    DELETE FROM rounds;
    DELETE FROM settings;
    DELETE FROM audit;
    DELETE FROM media_manifest;
    DELETE FROM questions;
    UPDATE teams SET captain_player_id = NULL;
    DELETE FROM players;
    DELETE FROM teams;
    DELETE FROM events;
  `);

  const { lastInsertRowid: eventId } = db.prepare(`
    INSERT INTO events (name, date, status, passphrase, screen_token, host_pin, marker_pin, floor_pin, admin_pin, total_rounds)
    VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'Dev Trivia Night', '2026-08-22', 'amber otter', randomToken(12),
    '111111', '222222', '333333', '444444', 3
  );

  // A few distinct swatches cycling across the 30 tables (CLAUDE.md #18: an
  // identifier, not a theme) so the floor grid and leaderboard look like a
  // real room instead of 30 identical grey blocks.
  const PALETTE = [
    { type: 'block', from: '#6B7280' },
    { type: 'block', from: '#B45309' },
    { type: 'gradient', from: '#1D4ED8', to: '#1E3A8A' },
    { type: 'block', from: '#15803D' },
    { type: 'gradient', from: '#BE123C', to: '#7F1D1D' },
    { type: 'block', from: '#7C3AED' }
  ];
  const insertTeam = db.prepare(`
    INSERT INTO teams (event_id, table_number, seats, token, colour)
    VALUES (?, ?, 8, ?, ?)
  `);
  for (let n = 1; n <= 30; n++) {
    insertTeam.run(eventId, String(n), randomToken(8), JSON.stringify(PALETTE[n % PALETTE.length]));
  }

  const insertQuestion = db.prepare(`
    INSERT INTO questions (event_id, round, order_no, type, prompt, options, correct_answer, points)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const QUESTIONS = [
    [1, 1, 'mcq', 'Which Australian city hosted the 2000 Olympics?',
      ['Melbourne', 'Sydney', 'Brisbane', 'Perth'], 'Sydney', 1],
    [1, 2, 'mcq', 'Who wrote Great Expectations?',
      ['Charles Dickens', 'Jane Austen', 'Mark Twain', 'Leo Tolstoy'], 'Charles Dickens', 1],
    [1, 3, 'text', 'Name the largest planet in our solar system.', null, 'Jupiter', 2],
    [2, 4, 'mcq', 'What is the capital of Japan?',
      ['Tokyo', 'Kyoto', 'Osaka', 'Nagoya'], 'Tokyo', 2],
    [2, 5, 'text', 'Which decade was the first iPhone released?', null, '2000s', 2],
    [3, 6, 'mcq', 'How many strings does a standard violin have?',
      ['4', '5', '6', '7'], '4', 3],
    [3, 7, 'text', 'What is the chemical symbol for gold?', null, 'Au', 3]
  ];
  let firstQuestionId = null;
  for (const [round, orderNo, type, prompt, options, correctAnswer, points] of QUESTIONS) {
    const { lastInsertRowid } = insertQuestion.run(
      eventId, round, orderNo, type, prompt, options ? JSON.stringify(options) : null, correctAnswer, points
    );
    if (firstQuestionId === null) firstQuestionId = lastInsertRowid;
  }

  db.prepare(`
    INSERT INTO questions (event_id, round, order_no, type, prompt, options, correct_answer, points, is_practice)
    VALUES (?, NULL, NULL, 'mcq', ?, ?, ?, 0, 1)
  `).run(
    eventId, 'What colour is the sky?',
    JSON.stringify(['Blue', 'Green', 'Purple']), 'Blue'
  );

  // Reserve question — sudden death for a countback tie that survives all
  // three rounds (technical-design §12.1/§12.2). Excluded from normal
  // scoring via is_reserve; the host opens it manually if needed.
  db.prepare(`
    INSERT INTO questions (event_id, round, order_no, type, prompt, options, correct_answer, points, is_reserve)
    VALUES (?, NULL, NULL, 'mcq', ?, ?, ?, 1, 1)
  `).run(
    eventId, 'Sudden death: what is the smallest prime number?',
    JSON.stringify(['0', '1', '2', '3']), '2'
  );

  // Round 2 and 3 each carry a theme override, cascaded over the event
  // default (CLAUDE.md #21) — round 1 stays on the event default so the
  // difference is visible when the host moves between rounds.
  const insertRound = db.prepare('INSERT INTO rounds (event_id, number, phase, theme) VALUES (?, ?, ?, ?)');
  insertRound.run(eventId, 1, 'PLAYING', null);
  insertRound.run(eventId, 2, 'PLAYING', JSON.stringify({
    bg: '#0f2a2c', bg2: '#173b3d', accent: '#5fd6c4', layout: 'standard'
  }));
  insertRound.run(eventId, 3, 'PLAYING', JSON.stringify({
    bg: '#170c0d', bg2: '#241012', accent: '#f28b81', layout: 'standard'
  }));

  db.prepare(`
    INSERT INTO event_state (event_id, current_question_id, question_status, round_phase)
    VALUES (?, ?, 'PENDING', 'PLAYING')
  `).run(eventId, firstQuestionId);

  const insertSetting = db.prepare('INSERT INTO settings (event_id, key, value) VALUES (?, ?, ?)');
  insertSetting.run(eventId, 'player_poll_ms', '3000');
  insertSetting.run(eventId, 'operator_poll_ms', '1000');
  insertSetting.run(eventId, 'timer_enabled', 'false');
  insertSetting.run(eventId, 'leaderboard_cadence', 'every_round');

  return { eventId, questionCount: QUESTIONS.length };
});

const { eventId, questionCount } = seed();
console.log(`Seeded event ${eventId}: 30 tables, 3 rounds, ${questionCount} scored questions + 1 practice + 1 reserve, current is PENDING.`);
