CREATE TABLE IF NOT EXISTS assignment_extensions (
  assignment_id TEXT NOT NULL REFERENCES coursework_assignments(id),
  student_name TEXT NOT NULL,
  deadline TEXT,
  reason TEXT NOT NULL,
  revision INTEGER NOT NULL,
  PRIMARY KEY(assignment_id, student_name)
);
