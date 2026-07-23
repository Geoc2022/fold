-- Server-side policy delivery.
--
-- This migration shipped before the durable policy engine. Keep it in the
-- sequence so existing D1 databases and fresh databases share one history.

PRAGMA foreign_keys = ON;

CREATE TABLE policy_rules (
  id          TEXT PRIMARY KEY,
  person_id   TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  scope       TEXT NOT NULL DEFAULT 'home'
                CHECK (scope IN ('home','room')),
  code        TEXT,
  source      TEXT NOT NULL,
  enabled     INTEGER NOT NULL DEFAULT 1,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX idx_policy_rules_person ON policy_rules (person_id);
CREATE INDEX idx_policy_rules_enabled ON policy_rules (enabled);

CREATE TABLE policy_fires (
  person_id   TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  rule_id     TEXT NOT NULL REFERENCES policy_rules(id) ON DELETE CASCADE,
  run_id      TEXT NOT NULL,
  event_key   TEXT NOT NULL,
  fire_minute INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  UNIQUE (person_id, rule_id, run_id, event_key, fire_minute)
);

ALTER TABLE people ADD COLUMN timezone TEXT;
