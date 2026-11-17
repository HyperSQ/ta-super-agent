# 教师待办收件箱与建议

状态：P0-B 已实现；随附 P3 的只读建议（候选与理由）。收件箱只读，确认、审批、登记仍走各自原入口。

## 接口

`GET /v1/courses/:courseId/inbox?limit=50`（管理令牌；课程必填；无全局 `/v1/inbox`）。

```json
{
  "items": [{ "kind": "coursework", "id": "…", "createdAt": 1763…, "title": "作业提交待核对 · 张予安", "status": "pending", "entry": "coursework" }],
  "counts": { "total": 7, "teacher_draft": 1, "coursework": 1, "roster": 1, "mail": 1, "memory_job": 1, "task": 1, "alert": 1 },
  "proposals": [{ "rule": "mail_backlog", "title": "有 1 封作业邮件等待核对", "reason": "…", "count": 1, "entry": "course-mail" }]
}
```

- `items` 按 `createdAt` 稳定倒序，最多 `limit` 条；`counts` 统计全部符合条件的记录，不等于当前页条数。
- `entry` 指向工作台已有页面：`coursework`、`course-mail`、`memory`、`tasks`；`qq` 表示需在原 QQ 会话或助教对话处理。
- 不返回确认码、凭据、邮件正文、附件内容或邮箱地址。

## 七个来源

| kind | 条件 | 入口 |
|---|---|---|
| `teacher_draft` | `teacher_work_drafts` 中 `pending` 且未过期 | 原 QQ／助教对话确认；确认码不显示 |
| `coursework` | `coursework_requests` 中 `state='pending'` 的提交或延期 | 「提交与延期」 |
| `roster` | `roster_approvals` 未过期 | 原渠道一次性指令；确认码不显示 |
| `mail` | `course_mail_messages` 中 `state='pending'` | 「作业邮箱」 |
| `memory_job` | `memory_jobs` 中 `status='failed'`（`pending`／运行中属正常后台） | 「学习记忆」重试 |
| `task` | 任务状态 `waiting_teacher` | 「运行任务」 |
| `alert` | Watchdog 告警（P2） | 「运行任务」；不自动重试 |

名单确认码在收件箱里以 `sha256` 截断后的展示 ID 代替；草稿与名单的原始确认码都不出现在响应或界面。

## 建议（P3 只读候选）

`buildProposals(engine, courseId)` 只读既有记录，给出候选与理由，不创建任务、不发消息、不自动执行：

| 规则 | 触发 |
|---|---|
| `coursework_backlog` | 有 `pending` 提交或延期 |
| `mail_backlog` | 有 `pending` 作业邮件 |
| `memory_failures` | 有失败的记忆提取任务 |
| `stalled_task` | `running` 任务超过 3 分钟没有新活动（最多 3 条） |

建议随收件箱一起返回；工作台「待办」页在列表下方显示「建议」区域。自动执行仍不在范围内。

## 桌面

- `desktop/lib/ssh-session.cjs` 白名单只放行 `GET /v1/courses/:id/inbox`（带查询串的请求仍拒绝）。
- 新增左栏「待办」页：顶部是各类型计数，列表按时间倒序，空列表有明确说明，点击「去处理」跳转到已有页面；需要在原 QQ 会话处理的项目直接写明入口。
- 切换课程会随 `refresh()` 重新拉取；演示环境提供示例数据。

## 验收

`tests/inbox.test.ts`：七类聚合与计数、过期/已忽略排除、确认码与正文不外泄、时间排序、`limit` 与 `counts` 分离、课程隔离、接口鉴权与 404、建议规则与「不改数据」、干净课程无建议。

`desktop/tests/ssh-session.test.cjs`：收件箱路由放行、带查询串与 POST 拒绝。

可重复轨迹：

1. 让一名学生在私聊提交作业，工作台「待办」出现一条「作业提交待核对」，点击「去处理」进入「提交与延期」。
2. 在「提交与延期」核对后刷新「待办」，该条消失、计数减一。
3. 在教师 QQ 发起一次建作业草稿，收件箱显示「待确认：新建作业」，并提示回原会话确认；响应中没有确认码。
4. 断开 SSH 前打开「待办」再重连，页面从服务器重新拉取，不保留旧缓存。

## 仍未做

- 收件箱只读：确认、拒绝、登分、重试仍从原页面发起。
- 建议不自动执行，也没有「一键采纳」；按方案先观察候选与理由是否可靠。
