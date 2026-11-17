CREATE TABLE IF NOT EXISTS roster_approvals (
  id TEXT PRIMARY KEY, course_id TEXT NOT NULL REFERENCES courses(id),
  actor TEXT NOT NULL, expires INTEGER NOT NULL, data TEXT NOT NULL
);
