CREATE TABLE IF NOT EXISTS teacher_work_followups (
  course_id TEXT NOT NULL REFERENCES courses(id), actor_id TEXT NOT NULL,
  thread_id TEXT NOT NULL, expires_at INTEGER NOT NULL, data TEXT NOT NULL,
  PRIMARY KEY(course_id,actor_id,thread_id)
);
