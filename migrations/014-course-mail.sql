CREATE TABLE IF NOT EXISTS course_mailboxes (
  course_id TEXT PRIMARY KEY REFERENCES courses(id),
  mailbox_key TEXT NOT NULL UNIQUE,
  data TEXT NOT NULL,
  secret TEXT NOT NULL,
  cursor TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS course_mail_messages (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id),
  source_key TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  data TEXT NOT NULL,
  UNIQUE(course_id, source_key)
);
CREATE INDEX IF NOT EXISTS course_mail_recent ON course_mail_messages(course_id,received_at DESC);
CREATE TABLE IF NOT EXISTS course_mail_files (
  mail_id TEXT NOT NULL REFERENCES course_mail_messages(id),
  position INTEGER NOT NULL,
  name TEXT NOT NULL,
  content BLOB NOT NULL,
  PRIMARY KEY(mail_id, position)
);
