# 任务汇报与课程计划

状态：P0-A 已实现。Worker 完成后在同一事务留下结构化汇报，Router 下次决策时读取课程计划。P0-B（教师待办收件箱）与 P1–P3 未在本轮实现。

## 汇报何时写入

`TaskEngine.finish` 与 `fail` 在原有事务内调用 `recordTaskReport`，汇报与任务状态、结果和交付队列一起提交。

| 场景 | 是否写汇报 | 说明 |
|---|---|---|
| Worker 返回结果 | 写 `completed` | `TaskRunner` 提交时传 `{ source: 'worker' }` |
| Worker 调用 `complete(result)` 提前提交 | 写 `completed` | 同一运行只写一份；`(task_id, run_id)` 唯一 |
| 静默结束 | 写 `completed` | 汇报不含正文，也不产生交付 |
| 真正停在 `waiting_teacher` | 写 `waiting_teacher` | `next=answer_teacher_question` |
| 教师已在运行中答复、任务回队 | 不写 | 直接回到 `queued` |
| 有效运行最终 `blocked` | 写 `blocked` | 只写阻塞类别，不写异常原文 |
| 旧租约、输入或课程版本变化 | 不写 | 任务重新排队，不是当前失败 |
| 同步业务回执（教师私信回执、群发、作业通知） | 不写 | 走原路径，`finish` 默认 `source: 'receipt'` |

`claim` 前置校验直接拒绝、没有运行的任务仍以 `blocked` 出现在课程计划里，只是没有汇报。

## 数据与字段

`migrations/017-task-reports.sql` 建 `task_reports`：`course_id`、`task_id`、`revision`、`input_epoch`、`run_id`、`at`、`outcome` 与 `data`；`(task_id, run_id)` 唯一，`(course_id, at)` 建索引。迁移为 `CREATE TABLE IF NOT EXISTS`，旧库升级后没有历史汇报也能正常启动。

`data` 由程序确定性生成，不调用模型：

```ts
type TaskReport = {
  taskId: string; courseId: string; kind: TaskKind;
  revision: number; inputEpoch: number; at: number;
  outcome: 'completed' | 'waiting_teacher' | 'blocked';
  summary: string;
  evidence: { kind: 'event' | 'assignment' | 'artifact' | 'teacher_question'; id: string; revision?: number }[];
  unresolved: string[];
  next: 'none' | 'review_output' | 'answer_teacher_question' | 'inspect_blocker';
};
```

- 材料任务（`lesson` / `scheduled`）的摘要带教师目标短标题；其余职责只用固定名称（学生答疑、作业邮件、教学事务）。
- 学生原文、成绩、邮件正文、附件内容、邮箱与存储路径、底层异常文本都不进入摘要。阻塞只映射为「权限或范围不符／依据已过期／输出或参数无效／依赖记录不存在／状态冲突／外部能力不可用／模型调用失败／缺少配置／执行失败」。
- 证据只是引用，不授予读取权限。

## 课程计划

`buildRouterContext(engine, event)` 按 `courseId` 汇总：

- 未完成任务：`waiting_teacher`、`blocked`、`paused`、`queued`、`running`，最多 8 条；排除一次性回执与学生私聊任务。
- 最近汇报：最多 6 条；`qa` 与 `coursework` 只给计数，不展示内容。
- 待处理事项：等待教师答复、阻塞、待查看产物。
- 序列化后超过约 4000 字符时，依次丢弃汇报、低优先级任务和多余待办。

`formatCoursePlan` 是教师问「本课程还有什么没做完」时的确定性回答，不调用模型，含任务 ID 与版本；暂停、排队、运行中的任务也会列出。

## 使用入口

- 教师 QQ 私聊、工作台与 DSH 助教会话说「本课程还有什么等我决定」「/plan」：直接回答课程计划，不调用规划模型。
- 教师自然语言触发通用规划时，输入增加 `plan` 字段；提示词要求模型只引用 `plan` 中存在的任务 ID 与版本。模型给出的控制目标若不在本次计划的候选内，不执行，回复要求用任务 ID 明确指定。
- 「继续刚才那份讲义」按当前任务与汇报消歧：唯一且暂停则恢复原任务（ID 不变）；等待教师时说明还缺什么；阻塞时给出类别并提示用「重试任务 ID」；多份候选只列出请教师选择。
- 学生路径不读课程计划，普通答疑不新增规划模型调用。

## 验收

`tests/task-reports.test.ts` 覆盖：两种提交路径、静默、等待教师、已回答回队、阻塞、旧运行失效、同步回执不写汇报、计划内容与去敏、版本失效、确定性回答、暂停止续跑、多候选澄清、跨课程隔离、重启后仍可读、模型编造任务 ID 与旧版本不生效、DSH 会话回写。

可重复轨迹：

1. 教师私聊 `/lesson 准备一致收敛讲义`，用 `TaskRunner` 执行；`task_reports` 出现一条 `completed`。
2. 关闭并用同一数据库路径重启，`/plan` 仍能看到完成状态。
3. 暂停该任务后说「继续刚才那份讲义」，任务回到 `queued`，任务 ID 与课程内任务数不变。
4. 同一课程再建一份材料任务后重复第 3 步，只得到澄清，两份任务都不被修改。

## 仍未做

- P1 订阅扩展：按方案推迟到出现第二种真实作用域之后再迁移。
- 汇报尚未通过管理 API 暴露给工作台；本轮只被 Router 与确定性回答使用。

跨跳召回、批处理、Watchdog 与瞬态退避见[运行时护栏](runtime-guardrails.md)；教师待办聚合见[收件箱](inbox.md)。
