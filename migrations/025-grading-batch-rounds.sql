-- A due node can have a supplemental batch when a grade becomes available later.
CREATE TABLE grading_batches_next(
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL,
  node_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  approved_at INTEGER
);
INSERT INTO grading_batches_next SELECT id,course_id,node_at,status,data,created_at,approved_at FROM grading_batches;
DROP TABLE grading_batches;
ALTER TABLE grading_batches_next RENAME TO grading_batches;
CREATE INDEX grading_batches_pending ON grading_batches(course_id, status, node_at);
