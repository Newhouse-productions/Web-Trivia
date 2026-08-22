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
    INSERT INTO events (name, date, status, passphrase, screen_token, host_pin, marker_pin, floor_pin, admin_pin)
    VALUES (?, ?, 'active', ?, ?, ?, ?, ?, ?)
  `).run(
    'Dev Trivia Night', '2026-08-22', 'amber otter', randomToken(12),
    '111111', '222222', '333333', '444444'
  );

  const insertTeam = db.prepare(`
    INSERT INTO teams (event_id, table_number, seats, token, colour)
    VALUES (?, ?, 8, ?, ?)
  `);
  for (let n = 1; n <= 30; n++) {
    insertTeam.run(eventId, String(n), randomToken(8), JSON.stringify({ type: 'block', from: '#6B7280' }));
  }

  const insertQuestion = db.prepare(`
    INSERT INTO questions (event_id, round, order_no, type, prompt, options, correct_answer, points)
    VALUES (?, 1, ?, 'mcq', ?, ?, ?, 1)
  `);
  const { lastInsertRowid: questionId } = insertQuestion.run(
    eventId, 1,
    'Which Australian city hosted the 2000 Olympics?',
    JSON.stringify(['Melbourne', 'Sydney', 'Brisbane', 'Perth']),
    'Sydney'
  );
  insertQuestion.run(
    eventId, 2,
    'Who wrote Great Expectations?',
    JSON.stringify(['Charles Dickens', 'Jane Austen', 'Mark Twain', 'Leo Tolstoy']),
    'Charles Dickens'
  );

  db.prepare(`INSERT INTO rounds (event_id, number, phase) VALUES (?, 1, 'PLAYING')`).run(eventId);

  db.prepare(`
    INSERT INTO event_state (event_id, current_question_id, question_status, round_phase)
    VALUES (?, ?, 'PENDING', 'PLAYING')
  `).run(eventId, questionId);

  const insertSetting = db.prepare('INSERT INTO settings (event_id, key, value) VALUES (?, ?, ?)');
  insertSetting.run(eventId, 'player_poll_ms', '3000');
  insertSetting.run(eventId, 'operator_poll_ms', '1000');
  insertSetting.run(eventId, 'timer_enabled', 'false');
  insertSetting.run(eventId, 'leaderboard_cadence', 'every_round');

  return eventId;
});

const eventId = seed();
console.log(`Seeded event ${eventId}: 30 tables, 2 questions, current is PENDING.`);
