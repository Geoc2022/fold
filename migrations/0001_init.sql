-- fold initial schema
-- Timestamps are unix epoch milliseconds (INTEGER).
-- Counts on `activities` are denormalized (kept in sync transactionally with
-- `participations`) so that GET /api/sync reads O(activities) rows instead of
-- scanning all participations on every poll -- critical for the D1 free-plan
-- 5M rows-read/day budget.

PRAGMA foreign_keys = ON;

CREATE TABLE people (
  id            TEXT PRIMARY KEY,           -- client-generated UUID (also the identity)
  handle        TEXT NOT NULL,              -- display name (NOT unique)
  color         TEXT NOT NULL,              -- node color for the visualization
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);

CREATE TABLE activities (
  id               TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  description      TEXT,
  proposer_id      TEXT NOT NULL REFERENCES people(id),
  min_people       INTEGER NOT NULL,
  max_people       INTEGER,                 -- NULL = unlimited
  group_multiple   INTEGER NOT NULL DEFAULT 1,
  grouping_mode    TEXT NOT NULL DEFAULT 'single'
                     CHECK (grouping_mode IN ('single', 'tiling')),
  status           TEXT NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','ready','scheduled','closed','cancelled','completed')),
  location         TEXT,
  scheduled_for    INTEGER,                 -- optional planned time
  expires_at       INTEGER,                 -- optional auto-expiry
  interested_count INTEGER NOT NULL DEFAULT 0,  -- denormalized
  committed_count  INTEGER NOT NULL DEFAULT 0,  -- denormalized
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE TABLE participations (
  id           TEXT PRIMARY KEY,
  activity_id  TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  person_id    TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  state        TEXT NOT NULL CHECK (state IN ('interested','committed')),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (activity_id, person_id)
);

CREATE TABLE notifications (
  id           TEXT PRIMARY KEY,
  recipient_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  activity_id  TEXT REFERENCES activities(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  message      TEXT NOT NULL,
  read_at      INTEGER,
  created_at   INTEGER NOT NULL
);

-- Web Push (phase 3); table created now so the schema is stable.
CREATE TABLE push_subscriptions (
  id          TEXT PRIMARY KEY,
  person_id   TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE (person_id, endpoint)
);

-- Indexes: keep polling queries off full-table scans.
CREATE INDEX idx_participations_activity ON participations (activity_id);
CREATE INDEX idx_participations_person   ON participations (person_id);
CREATE INDEX idx_notifications_recipient ON notifications (recipient_id, read_at);
CREATE INDEX idx_activities_status       ON activities (status);
CREATE INDEX idx_activities_expires      ON activities (expires_at);
