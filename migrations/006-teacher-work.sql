CREATE TABLE IF NOT EXISTS teacher_work_drafts (
  code TEXT PRIMARY KEY, event_id TEXT NOT NULL UNIQUE REFERENCES events(id),
  course_id TEXT NOT NULL REFERENCES courses(id), actor_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL
);
