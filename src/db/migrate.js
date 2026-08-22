// Additive, idempotent column migrations. schema.sql only ever gains
// CREATE TABLE IF NOT EXISTS statements; columns added after the first
// build land here, guarded by a table_info check so re-running is safe.
export function migrate(db) {
  const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);

  const addColumn = (table, column, definition) => {
    if (!columns(table).includes(column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  };

  addColumn('events', 'host_pin', 'TEXT');
  addColumn('events', 'marker_pin', 'TEXT');
  addColumn('events', 'floor_pin', 'TEXT');
  addColumn('events', 'admin_pin', 'TEXT');
  addColumn('events', 'subtitle', 'TEXT');
  addColumn('events', 'time', 'TEXT');
  addColumn('events', 'venue', 'TEXT');
  addColumn('events', 'entry_fee', 'TEXT');
  addColumn('events', 'beneficiary', 'TEXT');
  addColumn('events', 'chrome', 'TEXT');
  addColumn('teams', 'last_seen_at', 'TEXT');
  // Tracks whether a question has ever been revealed, independent of
  // whether the host has since moved on — needed to gate re-scoring
  // (CLAUDE.md #14): editing after reveal needs an impact preview, editing
  // before it doesn't, and "is this question still current" alone can't
  // tell the two apart once the host advances.
  addColumn('questions', 'revealed_at', 'TEXT');

  // round/order_no started NOT NULL; practice/reserve questions need them
  // nullable. SQLite can't drop a NOT NULL constraint in place, so rebuild.
  const roundInfo = db.prepare('PRAGMA table_info(questions)').all().find((c) => c.name === 'round');
  if (roundInfo && roundInfo.notnull) {
    // Rebuilding drops the table momentarily; answers/event_state/
    // marking_claims still reference its old rows by id, so FK checks must
    // be off for the rebuild (can only be toggled outside a transaction).
    db.pragma('foreign_keys = OFF');
    db.transaction(() => db.exec(`
      CREATE TABLE questions_new (
        id             INTEGER PRIMARY KEY,
        event_id       INTEGER NOT NULL REFERENCES events(id),
        round          INTEGER,
        order_no       INTEGER,
        type           TEXT NOT NULL CHECK (type IN ('mcq', 'text')),
        prompt         TEXT NOT NULL,
        options        TEXT,
        correct_answer TEXT,
        aliases        TEXT,
        points         INTEGER NOT NULL DEFAULT 0,
        image_ref      TEXT,
        image_alt      TEXT,
        video_url      TEXT,
        av_cue         TEXT,
        layout         TEXT,
        is_practice    INTEGER NOT NULL DEFAULT 0,
        is_reserve     INTEGER NOT NULL DEFAULT 0,
        is_skipped     INTEGER NOT NULL DEFAULT 0,
        theme          TEXT,
        UNIQUE (event_id, order_no)
      );
      INSERT INTO questions_new SELECT * FROM questions;
      DROP TABLE questions;
      ALTER TABLE questions_new RENAME TO questions;
    `))();
    db.pragma('foreign_keys = ON');
  }
}
