-- Trivia night schema. event_id on every table (CLAUDE.md #6) — many events
-- configured, exactly one active. Scores are never stored (#13): answers and
-- bonuses are the only ledger, everything else is derived on read.

CREATE TABLE IF NOT EXISTS events (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  subtitle        TEXT,
  date            TEXT,
  time            TEXT,
  venue           TEXT,
  entry_fee       TEXT,
  beneficiary     TEXT,
  status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'active', 'finished', 'archived')),
  passphrase      TEXT NOT NULL,
  screen_token    TEXT NOT NULL UNIQUE,
  version         INTEGER NOT NULL DEFAULT 0,
  paused          TEXT,
  theme           TEXT,
  chrome          TEXT,
  total_rounds    INTEGER,
  retention_until TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Only one event may be active (CLAUDE.md #6, technical-design §16.1).
CREATE UNIQUE INDEX IF NOT EXISTS events_one_active
  ON events (status) WHERE status = 'active';

CREATE TABLE IF NOT EXISTS teams (
  id                 INTEGER PRIMARY KEY,
  event_id           INTEGER NOT NULL REFERENCES events(id),
  table_number       TEXT NOT NULL,
  seats              INTEGER,
  token              TEXT NOT NULL UNIQUE,
  team_name          TEXT,
  captain_player_id  INTEGER REFERENCES players(id),
  colour             TEXT,
  joined_at_round    INTEGER,
  table_version      INTEGER NOT NULL DEFAULT 0,
  archived           INTEGER NOT NULL DEFAULT 0,
  last_seen_at       TEXT,
  UNIQUE (event_id, table_number)
);

CREATE TABLE IF NOT EXISTS players (
  id         INTEGER PRIMARY KEY,
  event_id   INTEGER NOT NULL REFERENCES events(id),
  team_id    INTEGER NOT NULL REFERENCES teams(id),
  username   TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (team_id, username COLLATE NOCASE)
);

-- round/order_no are nullable: practice and reserve questions sit outside
-- the numbered rounds entirely (technical-design §12.2, §14).
CREATE TABLE IF NOT EXISTS questions (
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
  opened_at      TEXT,
  revealed_at    TEXT,
  UNIQUE (event_id, order_no)
);

CREATE TABLE IF NOT EXISTS answers (
  event_id      INTEGER NOT NULL REFERENCES events(id),
  team_id       INTEGER NOT NULL REFERENCES teams(id),
  question_id   INTEGER NOT NULL REFERENCES questions(id),
  value         TEXT NOT NULL,
  submitted_by  INTEGER REFERENCES players(id),
  submitted_at  TEXT NOT NULL,
  is_correct    INTEGER,
  marked_by     TEXT,
  marked_at     TEXT,
  PRIMARY KEY (team_id, question_id)
);

CREATE TABLE IF NOT EXISTS bonuses (
  id               INTEGER PRIMARY KEY,
  event_id         INTEGER NOT NULL REFERENCES events(id),
  team_id          INTEGER NOT NULL REFERENCES teams(id),
  round            INTEGER NOT NULL,
  points           INTEGER NOT NULL,
  reason           TEXT NOT NULL,
  awarded_by       TEXT NOT NULL,
  awarded_at       TEXT NOT NULL,
  idempotency_key  TEXT UNIQUE
);

-- Claimed at question level, never per row (CLAUDE.md #23) — accepting an
-- alias for every table re-scores the whole question, so two markers on one
-- question is the bug to make structurally impossible.
CREATE TABLE IF NOT EXISTS marking_claims (
  event_id     INTEGER NOT NULL REFERENCES events(id),
  question_id  INTEGER NOT NULL REFERENCES questions(id) PRIMARY KEY,
  marker       TEXT NOT NULL,
  claimed_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS event_state (
  event_id             INTEGER PRIMARY KEY REFERENCES events(id),
  current_question_id INTEGER REFERENCES questions(id),
  question_status      TEXT NOT NULL DEFAULT 'PENDING'
                          CHECK (question_status IN ('PENDING', 'OPEN', 'CLOSED', 'REVEALED')),
  round_phase          TEXT NOT NULL DEFAULT 'PLAYING'
                          CHECK (round_phase IN ('PLAYING', 'MARKING', 'PUBLISHED'))
);

CREATE TABLE IF NOT EXISTS rounds (
  event_id               INTEGER NOT NULL REFERENCES events(id),
  number                 INTEGER NOT NULL,
  theme                  TEXT,
  phase                  TEXT NOT NULL DEFAULT 'PLAYING',
  published_leaderboard  TEXT,
  PRIMARY KEY (event_id, number)
);

CREATE TABLE IF NOT EXISTS settings (
  event_id  INTEGER NOT NULL REFERENCES events(id),
  key       TEXT NOT NULL,
  value     TEXT NOT NULL,
  PRIMARY KEY (event_id, key)
);

-- Dispute evidence, not a security control (CLAUDE.md "Conventions").
CREATE TABLE IF NOT EXISTS audit (
  id        INTEGER PRIMARY KEY,
  event_id  INTEGER NOT NULL REFERENCES events(id),
  role      TEXT NOT NULL,
  operator  TEXT,
  action    TEXT NOT NULL,
  target    TEXT,
  reason    TEXT,
  at        TEXT NOT NULL
);

-- Maps the friendly filename authored in CSV/admin to the content-hashed
-- name it's actually served under. Media is protected by an unguessable
-- filename, not an access check (technical-design §7.1) — gating and
-- CDN-caching are mutually exclusive.
CREATE TABLE IF NOT EXISTS media_manifest (
  event_id    INTEGER NOT NULL REFERENCES events(id),
  filename    TEXT NOT NULL,
  sha256      TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  PRIMARY KEY (event_id, filename)
);
