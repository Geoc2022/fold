-- Match indexes to hot polling, policy recovery, notification, and scheduled
-- maintenance queries.
CREATE INDEX IF NOT EXISTS idx_participations_person_run
  ON participations (person_id, run_id);

CREATE INDEX IF NOT EXISTS idx_participations_run_updated
  ON participations (run_id, updated_at);

DROP INDEX IF EXISTS idx_participations_person;
DROP INDEX IF EXISTS idx_participations_run;

CREATE INDEX IF NOT EXISTS idx_policy_instances_context
  ON policy_instances (activity_id, run_id);

CREATE INDEX IF NOT EXISTS idx_notifications_unread
  ON notifications (recipient_id, created_at DESC)
  WHERE read_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_notifications_created
  ON notifications (created_at);
