CREATE TABLE IF NOT EXISTS course_details (
  course_id TEXT PRIMARY KEY REFERENCES courses(id), data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS coursework_assignments (
  id TEXT PRIMARY KEY, course_id TEXT NOT NULL REFERENCES courses(id), data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS offline_submissions (
  assignment_id TEXT NOT NULL REFERENCES coursework_assignments(id), student_name TEXT NOT NULL,
  data TEXT NOT NULL, PRIMARY KEY(assignment_id,student_name)
);
