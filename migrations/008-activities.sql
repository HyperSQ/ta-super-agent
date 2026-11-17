CREATE TABLE IF NOT EXISTS activities (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  course_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  task_id TEXT,
  run_id TEXT,
  node TEXT NOT NULL,
  kind TEXT NOT NULL,
  label TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS activities_course_seq ON activities(course_id, seq DESC);
CREATE INDEX IF NOT EXISTS activities_course_event ON activities(course_id, event_id, seq);
