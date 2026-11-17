CREATE TABLE IF NOT EXISTS qq_private_contexts (
  user_id TEXT NOT NULL,
  course_id TEXT NOT NULL REFERENCES courses(id),
  thread_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(user_id,course_id)
);
