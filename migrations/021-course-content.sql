-- 统一课程内容层：讲义、群文件、提交等共用一套引用与可见性。
CREATE TABLE IF NOT EXISTS course_content(
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL,
  ref TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL,
  owner TEXT,
  source TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  published_at INTEGER,
  revoked_at INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS course_content_lookup ON course_content(course_id, visibility, kind);
