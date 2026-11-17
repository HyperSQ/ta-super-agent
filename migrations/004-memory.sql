CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id),
  subject_id TEXT NOT NULL,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS memories_scope ON memories(course_id,subject_id,status);
CREATE TABLE IF NOT EXISTS memory_sources (
  memory_id TEXT NOT NULL REFERENCES memories(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  thread_revision INTEGER NOT NULL,
  PRIMARY KEY(memory_id,event_id)
);
CREATE INDEX IF NOT EXISTS memory_source_events ON memory_sources(event_id);
CREATE TABLE IF NOT EXISTS memory_jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL,
  error TEXT
);
CREATE TABLE IF NOT EXISTS memory_vectors (
  memory_id TEXT PRIMARY KEY REFERENCES memories(id),
  revision INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  data TEXT NOT NULL
);
