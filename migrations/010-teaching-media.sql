CREATE TABLE IF NOT EXISTS teaching_images (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id),
  png BLOB NOT NULL,
  source TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS teaching_replies (
  delivery_id TEXT PRIMARY KEY REFERENCES deliveries(id),
  image_id TEXT NOT NULL REFERENCES teaching_images(id)
);
CREATE TABLE IF NOT EXISTS dsh_writes (
  request_id TEXT PRIMARY KEY,
  payload TEXT NOT NULL,
  result TEXT NOT NULL
);
