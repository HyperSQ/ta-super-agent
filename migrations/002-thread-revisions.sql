CREATE TABLE IF NOT EXISTS event_threads (
  event_id TEXT PRIMARY KEY REFERENCES events(id), thread_id TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1
);
INSERT OR IGNORE INTO event_threads(event_id,thread_id) SELECT id,thread_id FROM events;
CREATE TABLE IF NOT EXISTS thread_changes (
  id TEXT PRIMARY KEY, feedback_event_id TEXT NOT NULL REFERENCES events(id),
  at INTEGER NOT NULL, reason TEXT NOT NULL, data TEXT NOT NULL
);
