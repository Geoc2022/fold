CREATE TRIGGER participations_commit_capacity_insert
BEFORE INSERT ON participations
WHEN NEW.state = 'committed'
BEGIN
  SELECT RAISE(ABORT, 'activity is full') WHERE EXISTS (
    SELECT 1
    FROM runs r
    JOIN activities a ON a.id = r.activity_id
    WHERE r.id = NEW.run_id
      AND a.max_people IS NOT NULL
      AND (SELECT COUNT(*) FROM participations p
           WHERE p.run_id = NEW.run_id AND p.state = 'committed') >= a.max_people
  );
END;

CREATE TRIGGER participations_commit_capacity_update
BEFORE UPDATE OF state ON participations
WHEN NEW.state = 'committed' AND OLD.state != 'committed'
BEGIN
  SELECT RAISE(ABORT, 'activity is full') WHERE EXISTS (
    SELECT 1
    FROM runs r
    JOIN activities a ON a.id = r.activity_id
    WHERE r.id = NEW.run_id
      AND a.max_people IS NOT NULL
      AND (SELECT COUNT(*) FROM participations p
           WHERE p.run_id = NEW.run_id AND p.state = 'committed') >= a.max_people
  );
END;
