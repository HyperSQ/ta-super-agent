-- 课程文件层：把已落在服务器上的任务产物登记为可按路径读取的文件。
CREATE TABLE IF NOT EXISTS course_files(
  course_id TEXT NOT NULL,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  visibility TEXT NOT NULL,
  source TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(course_id, path)
);
