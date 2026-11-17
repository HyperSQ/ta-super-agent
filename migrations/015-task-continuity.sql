CREATE TABLE IF NOT EXISTS task_changes (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  revision INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY(task_id,revision)
);
CREATE INDEX IF NOT EXISTS task_changes_events ON task_changes(task_id,event_id);
