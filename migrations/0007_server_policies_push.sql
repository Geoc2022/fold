PRAGMA foreign_keys = ON;

-- Browser authentication. The cookie carries a random token; only its SHA-256
-- digest is stored, so public person ids are no longer bearer credentials.
CREATE TABLE auth_sessions (
  token_hash   TEXT PRIMARY KEY,
  person_id    TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);
CREATE INDEX idx_auth_sessions_person ON auth_sessions (person_id);
CREATE INDEX idx_auth_sessions_expiry ON auth_sessions (expires_at);

UPDATE people SET timezone = 'UTC' WHERE timezone IS NULL;
ALTER TABLE participations ADD COLUMN state_changed_at INTEGER;
UPDATE participations SET state_changed_at = updated_at WHERE state_changed_at IS NULL;

-- Active room viewers without a participation row are policy `lurkers`.
CREATE TABLE room_presence (
  activity_id TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  person_id   TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (activity_id, person_id)
);
CREATE INDEX idx_room_presence_seen ON room_presence (activity_id, last_seen_at);

-- A set is required because an explicit empty room override differs from no
-- override (which inherits the home set).
CREATE TABLE policy_sets (
  id          TEXT PRIMARY KEY,
  person_id   TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  scope       TEXT NOT NULL CHECK (scope IN ('home', 'room')),
  activity_id TEXT REFERENCES activities(id) ON DELETE CASCADE,
  timezone    TEXT NOT NULL DEFAULT 'UTC',
  revision    INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  CHECK ((scope = 'home' AND activity_id IS NULL) OR
         (scope = 'room' AND activity_id IS NOT NULL))
);
CREATE UNIQUE INDEX idx_policy_sets_home
  ON policy_sets (person_id) WHERE scope = 'home';
CREATE UNIQUE INDEX idx_policy_sets_room
  ON policy_sets (person_id, activity_id) WHERE scope = 'room';

-- The previous policy engine stored source-only rules that cannot represent
-- durable action plans. Its rules and idempotency ledger are intentionally
-- discarded during this upgrade.
DROP TABLE policy_fires;
DROP TABLE policy_rules;

CREATE TABLE policy_rules (
  id             TEXT PRIMARY KEY,
  policy_set_id  TEXT NOT NULL REFERENCES policy_sets(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL,
  source         TEXT NOT NULL,
  compiled_json  TEXT NOT NULL,
  source_hash    TEXT NOT NULL,
  time_dependent INTEGER NOT NULL DEFAULT 0,
  enabled        INTEGER NOT NULL DEFAULT 1,
  version        INTEGER NOT NULL DEFAULT 1,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE (policy_set_id, position)
);
CREATE INDEX idx_policy_rules_set ON policy_rules (policy_set_id, position);

-- One instance per effective rule and activity/run context. occurrence rises
-- whenever an inactive rule becomes active (including its first evaluation).
CREATE TABLE policy_instances (
  id                TEXT PRIMARY KEY,
  rule_id           TEXT NOT NULL REFERENCES policy_rules(id) ON DELETE CASCADE,
  activity_id       TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  run_id            TEXT NOT NULL DEFAULT '',
  rule_version      INTEGER NOT NULL,
  active            INTEGER NOT NULL DEFAULT 0,
  occurrence        INTEGER NOT NULL DEFAULT 0,
  origin_at         INTEGER,
  plan_hash         TEXT,
  next_evaluate_at  INTEGER,
  last_evaluated_at INTEGER NOT NULL,
  UNIQUE (rule_id, activity_id, run_id)
);
CREATE INDEX idx_policy_instances_due ON policy_instances (next_evaluate_at);

CREATE TABLE policy_actions (
  id             TEXT PRIMARY KEY,
  instance_id    TEXT NOT NULL REFERENCES policy_instances(id) ON DELETE CASCADE,
  occurrence     INTEGER NOT NULL,
  action_key     TEXT NOT NULL,
  sequence_index INTEGER NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('notify', 'state')),
  payload_json   TEXT NOT NULL,
  due_at         INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending', 'running', 'completed', 'cancelled', 'failed')),
  queued_at      INTEGER,
  attempts       INTEGER NOT NULL DEFAULT 0,
  last_error     TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  UNIQUE (instance_id, occurrence, action_key)
);
CREATE INDEX idx_policy_actions_due ON policy_actions (status, due_at);

-- Domain events are the durable evaluation outbox. Queue publication is an
-- accelerator; the scheduled sweep recovers unqueued/unprocessed rows.
CREATE TABLE domain_events (
  id          TEXT PRIMARY KEY,
  activity_id TEXT NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
  run_id      TEXT,
  kind        TEXT NOT NULL,
  actor_id    TEXT REFERENCES people(id) ON DELETE SET NULL,
  causal_depth INTEGER NOT NULL DEFAULT 0,
  occurred_at INTEGER NOT NULL,
  queued_at   INTEGER,
  processed_at INTEGER
);
CREATE INDEX idx_domain_events_pending ON domain_events (processed_at, occurred_at);

ALTER TABLE notifications ADD COLUMN title TEXT;
ALTER TABLE notifications ADD COLUMN url TEXT;
ALTER TABLE notifications ADD COLUMN dedupe_key TEXT;
CREATE UNIQUE INDEX idx_notifications_dedupe
  ON notifications (recipient_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

-- Existing test subscriptions can be discarded, but make migration robust for
-- local databases by retaining one owner per endpoint before adding uniqueness.
DELETE FROM push_subscriptions
WHERE rowid NOT IN (SELECT MIN(rowid) FROM push_subscriptions GROUP BY endpoint);
CREATE UNIQUE INDEX idx_push_subscriptions_endpoint ON push_subscriptions (endpoint);
ALTER TABLE push_subscriptions ADD COLUMN expiration_time INTEGER;
ALTER TABLE push_subscriptions ADD COLUMN updated_at INTEGER;
ALTER TABLE push_subscriptions ADD COLUMN last_success_at INTEGER;
ALTER TABLE push_subscriptions ADD COLUMN failure_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE push_subscriptions ADD COLUMN disabled_at INTEGER;
UPDATE push_subscriptions SET updated_at = created_at WHERE updated_at IS NULL;

CREATE TABLE push_deliveries (
  id              TEXT PRIMARY KEY,
  notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'sending', 'delivered', 'retry', 'failed')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL,
  queued_at       INTEGER,
  last_status     INTEGER,
  last_error      TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  UNIQUE (notification_id, subscription_id)
);
CREATE INDEX idx_push_deliveries_due ON push_deliveries (status, next_attempt_at);
