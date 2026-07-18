ALTER TABLE activities
ADD COLUMN duration_seconds INTEGER NOT NULL DEFAULT 1800;

ALTER TABLE activities
ADD COLUMN max_commit_seconds INTEGER NOT NULL DEFAULT 1800;

UPDATE activities
SET duration_seconds = duration_minutes * 60,
    max_commit_seconds = max_commit_minutes * 60;
