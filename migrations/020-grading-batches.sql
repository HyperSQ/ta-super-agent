-- 批改节点：每个作业截止时间是一个审核节点；节点前的已批改提交累积成一批。
CREATE TABLE IF NOT EXISTS grading_nodes(
  course_id TEXT NOT NULL,
  node_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(course_id, node_at)
);

CREATE TABLE IF NOT EXISTS grading_batches(
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL,
  node_at INTEGER NOT NULL,
  status TEXT NOT NULL,
  data TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  approved_at INTEGER,
  UNIQUE(course_id, node_at)
);
CREATE INDEX IF NOT EXISTS grading_batches_pending ON grading_batches(course_id, status, node_at);
