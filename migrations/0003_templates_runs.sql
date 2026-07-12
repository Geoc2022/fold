-- Activities become persistent templates/tiles (like Stack Exchange "sites").
-- Each proposal/gathering is now a "run" with its own lifecycle, participants,
-- and room state. Grouping shape (single/tiling, min/max/step) and the stable
-- 4-letter room code live on the activity; time/location/status live on the
-- run. Stats (times_run, players_served, interest_total, commit_total) are
-- rolled up onto the activity when a run ends.
--
-- The local D1 has no production data yet (pre-launch, uncommitted), so this
-- rebuilds the affected tables directly instead of attempting in-place data
-- preservation across the activity/run split.

PRAGMA foreign_keys = OFF;

DROP TABLE IF EXISTS notifications;
DROP TABLE IF EXISTS participations;
DROP TABLE IF EXISTS runs;
DROP TABLE IF EXISTS activities;

CREATE TABLE activities (
  id               TEXT PRIMARY KEY,
  code             TEXT NOT NULL,             -- stable 4-letter room code for this tile
  emoji            TEXT NOT NULL DEFAULT '🎲',
  title            TEXT NOT NULL,
  description      TEXT,
  category         TEXT NOT NULL DEFAULT 'general',
  proposer_id      TEXT NOT NULL REFERENCES people(id),
  min_people       INTEGER NOT NULL,
  max_people       INTEGER,                   -- NULL = unlimited
  group_multiple   INTEGER NOT NULL DEFAULT 1,
  grouping_mode    TEXT NOT NULL DEFAULT 'single'
                     CHECK (grouping_mode IN ('single', 'tiling')),
  allow_guests     INTEGER NOT NULL DEFAULT 1,
  current_run_id   TEXT,                      -- active/open run, if any (NULL = room is empty)
  times_run        INTEGER NOT NULL DEFAULT 0, -- runs that reached >=1 complete group
  players_served   INTEGER NOT NULL DEFAULT 0, -- lifetime distinct participants across ended runs
  interest_total   INTEGER NOT NULL DEFAULT 0, -- lifetime participants whose final state was 'interested'
  commit_total     INTEGER NOT NULL DEFAULT 0, -- lifetime participants whose final state was 'committed'
  last_active_at   INTEGER NOT NULL,           -- drives the 7-day homepage visibility window
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_activities_code        ON activities (code);
CREATE INDEX idx_activities_category           ON activities (category);
CREATE INDEX idx_activities_last_active        ON activities (last_active_at);

CREATE TABLE runs (
  id               TEXT PRIMARY KEY,
  activity_id      TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  status           TEXT NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','ready','scheduled','closed','cancelled')),
  location         TEXT,
  details          TEXT,                      -- optional per-run notes
  scheduled_for    INTEGER,
  expires_at       INTEGER,
  interested_count INTEGER NOT NULL DEFAULT 0, -- denormalized
  committed_count  INTEGER NOT NULL DEFAULT 0, -- denormalized
  reached_ready    INTEGER NOT NULL DEFAULT 0, -- 1 once >=1 complete group ever formed (sticky)
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  ended_at         INTEGER
);

CREATE INDEX idx_runs_activity ON runs (activity_id);
CREATE INDEX idx_runs_status   ON runs (status);
CREATE INDEX idx_runs_expires  ON runs (expires_at);

CREATE TABLE participations (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  person_id    TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  state        TEXT NOT NULL CHECK (state IN ('interested','committed')),
  arrival_at   INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (run_id, person_id)
);

CREATE INDEX idx_participations_run    ON participations (run_id);
CREATE INDEX idx_participations_person ON participations (person_id);

CREATE TABLE notifications (
  id           TEXT PRIMARY KEY,
  recipient_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  activity_id  TEXT REFERENCES activities(id) ON DELETE CASCADE,
  run_id       TEXT REFERENCES runs(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  message      TEXT NOT NULL,
  read_at      INTEGER,
  created_at   INTEGER NOT NULL
);

CREATE INDEX idx_notifications_recipient ON notifications (recipient_id, read_at);

PRAGMA foreign_keys = ON;
