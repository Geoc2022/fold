-- Preserve the newest commitment if legacy/test data contains duplicates.
DELETE FROM participations
WHERE state = 'committed'
  AND id NOT IN (
    SELECT p.id
    FROM participations p
    WHERE p.state = 'committed'
      AND p.id = (
        SELECT newest.id
        FROM participations newest
        WHERE newest.person_id = p.person_id AND newest.state = 'committed'
        ORDER BY newest.updated_at DESC, newest.id DESC
        LIMIT 1
      )
  );

CREATE UNIQUE INDEX idx_participations_one_commit
  ON participations (person_id) WHERE state = 'committed';

UPDATE runs
SET interested_count = (
      SELECT COUNT(*) FROM participations p
      WHERE p.run_id = runs.id AND p.state = 'interested'
    ),
    committed_count = (
      SELECT COUNT(*) FROM participations p
      WHERE p.run_id = runs.id AND p.state = 'committed'
    );
