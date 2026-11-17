-- 监督告警：规则型 Watchdog 的去重结果，供工作台与后续收件箱读取。
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL,
  rule TEXT NOT NULL,
  target_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  detail TEXT NOT NULL,
  at INTEGER NOT NULL,
  UNIQUE(course_id, rule, target_id)
);
CREATE INDEX IF NOT EXISTS alerts_course_at ON alerts(course_id, at DESC);
