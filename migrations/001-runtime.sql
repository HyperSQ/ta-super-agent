CREATE TABLE IF NOT EXISTS courses (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, group_id TEXT UNIQUE, instructions TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, source_key TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL,
  course_id TEXT NOT NULL REFERENCES courses(id), data TEXT NOT NULL,
  routed INTEGER NOT NULL DEFAULT 0, error TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, course_id TEXT NOT NULL REFERENCES courses(id),
  status TEXT NOT NULL, data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subscriptions (
  task_id TEXT NOT NULL REFERENCES tasks(id), thread_id TEXT NOT NULL,
  PRIMARY KEY(task_id, thread_id)
);
CREATE TABLE IF NOT EXISTS task_inputs (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id),
  event_id TEXT NOT NULL REFERENCES events(id), UNIQUE(task_id, event_id)
);
CREATE TABLE IF NOT EXISTS deliveries (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
  status TEXT NOT NULL, data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reply_links (
  channel_key TEXT NOT NULL, external_id TEXT NOT NULL, thread_id TEXT NOT NULL,
  PRIMARY KEY(channel_key, external_id)
);
CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_routed ON events(routed);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS inputs_task_seq ON task_inputs(task_id, seq);
CREATE INDEX IF NOT EXISTS deliveries_status ON deliveries(status);
