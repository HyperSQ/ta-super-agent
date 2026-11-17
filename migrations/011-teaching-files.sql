CREATE TABLE IF NOT EXISTS teaching_files (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id),
  name TEXT NOT NULL,
  content BLOB
);
