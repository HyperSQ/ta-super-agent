-- 常驻 Router 会话：跨消息保留协调上下文与决策记录。
CREATE TABLE IF NOT EXISTS router_sessions(
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(course_id, thread_id)
);
CREATE TABLE IF NOT EXISTS router_messages(
  session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(session_id, seq)
);
CREATE TABLE IF NOT EXISTS router_decisions(
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL,
  event_id TEXT,
  action TEXT NOT NULL,
  task_id TEXT,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS router_decisions_course ON router_decisions(course_id, created_at DESC);
