-- 任务汇报：Worker 完成后留下可被 Router 读取的结构化事实。
-- 同一任务同一次运行只允许一份；revision/input_epoch 用于判断汇报是否仍对应任务当前状态。
CREATE TABLE IF NOT EXISTS task_reports (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  revision INTEGER NOT NULL,
  input_epoch INTEGER NOT NULL,
  run_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  data TEXT NOT NULL,
  UNIQUE(task_id, run_id)
);
CREATE INDEX IF NOT EXISTS task_reports_course_at ON task_reports(course_id, at);
