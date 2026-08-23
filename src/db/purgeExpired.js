// Deletes finished events past their retention date (scope §2 "Technical":
// "30 days after the event, then delete"). Not run automatically by the
// server — this project has no in-process scheduler by design (CLAUDE.md:
// "Resist adding dependencies... no queue"), so this is a standalone script
// meant to be invoked by an external scheduler.
//
// On the VPS: a systemd timer calling `npm run purge` daily is the natural
// fit alongside the existing systemd service (CLAUDE.md's "Stack — hold the
// line" already assumes systemd). A cron entry works identically:
//   0 4 * * *  cd /path/to/app && npm run purge >> /var/log/trivia-purge.log 2>&1
//
// Safe to run any time, any number of times — an event is only ever
// selected once its retention_until has actually passed, and deleting zero
// rows is a no-op.
import { getDb } from './index.js';

const db = getDb();

const expired = db.prepare(`
  SELECT id, name, retention_until FROM events
  WHERE status = 'finished' AND retention_until IS NOT NULL AND retention_until < ?
`).all(new Date().toISOString());

if (!expired.length) {
  console.log('No expired events to purge.');
  process.exit(0);
}

// Same dependency order as db/seed.js's dev wipe — children before parents,
// captain_player_id nulled first to break the teams<->players FK cycle.
const purgeOne = db.transaction((eventId) => {
  db.prepare('DELETE FROM answers WHERE event_id = ?').run(eventId);
  db.prepare('DELETE FROM bonuses WHERE event_id = ?').run(eventId);
  db.prepare('DELETE FROM marking_claims WHERE event_id = ?').run(eventId);
  db.prepare('DELETE FROM event_state WHERE event_id = ?').run(eventId);
  db.prepare('DELETE FROM rounds WHERE event_id = ?').run(eventId);
  db.prepare('DELETE FROM settings WHERE event_id = ?').run(eventId);
  db.prepare('DELETE FROM audit WHERE event_id = ?').run(eventId);
  db.prepare('DELETE FROM media_manifest WHERE event_id = ?').run(eventId);
  db.prepare('DELETE FROM questions WHERE event_id = ?').run(eventId);
  db.prepare('UPDATE teams SET captain_player_id = NULL WHERE event_id = ?').run(eventId);
  db.prepare('DELETE FROM players WHERE event_id = ?').run(eventId);
  db.prepare('DELETE FROM teams WHERE event_id = ?').run(eventId);
  db.prepare('DELETE FROM events WHERE id = ?').run(eventId);
});

for (const event of expired) {
  purgeOne(event.id);
  console.log(`Purged event ${event.id} (${event.name}) — retained until ${event.retention_until}`);
}

console.log(`Purged ${expired.length} event(s).`);

// Deliberately does not touch files under public/media/ — content-hashed
// filenames (CLAUDE.md) mean two events could coincidentally share one, so
// deleting on a single event's purge risks breaking another event's media.
// Media is quiz images, not personal data; leftover files cost disk space,
// not privacy, so this is left as a manual/occasional cleanup rather than
// something this script guesses at.
