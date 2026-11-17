CREATE TABLE IF NOT EXISTS coursework_requests (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id),
  assignment_id TEXT NOT NULL REFERENCES coursework_assignments(id),
  kind TEXT NOT NULL CHECK(kind IN ('submission','extension')),
  state TEXT NOT NULL CHECK(state IN ('pending','accepted','declined')),
  actor TEXT NOT NULL,
  student_name TEXT NOT NULL,
  event_id TEXT NOT NULL UNIQUE REFERENCES events(id),
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS coursework_requests_course ON coursework_requests(course_id, assignment_id, kind, state);
CREATE TABLE IF NOT EXISTS coursework_submission_files (
  request_id TEXT NOT NULL REFERENCES coursework_requests(id),
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  content BLOB NOT NULL,
  PRIMARY KEY(request_id, position)
);
CREATE TABLE IF NOT EXISTS coursework_submission_drafts (
  course_id TEXT NOT NULL REFERENCES courses(id),
  actor TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY(course_id, actor)
);
CREATE TABLE IF NOT EXISTS coursework_qq_students (
  course_id TEXT NOT NULL REFERENCES courses(id),
  actor TEXT NOT NULL,
  student_name TEXT NOT NULL,
  PRIMARY KEY(course_id, actor),
  UNIQUE(course_id, student_name)
);
