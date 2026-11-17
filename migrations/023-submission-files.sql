-- 学生提交附件落盘：数据库只留元数据与路径，正文不再进 SQLite BLOB。
CREATE TABLE IF NOT EXISTS coursework_submission_paths(
  request_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  PRIMARY KEY(request_id, position)
);
