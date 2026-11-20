# 常驻 Router 会话（对照官方原型的第一版）

状态：第一版已实现。借鉴 `dsh-superagent-prototype` 的 main Session / Decision / Worker Report 设计，但保留本项目的内核与权限边界。

## 做了什么

| 原型概念 | 本项目落点 |
|---|---|
| main Session 常驻 | `router_sessions` + `router_messages`，教师同一课程跨 QQ 私聊、DSH 和工作台共用会话，群聊按线程处理 |
| Decision 记录 | `router_decisions`：create / control，含任务 ID 与原因 |
| Worker Report 回传 | Worker 完成、阻塞、等待教师时，报告摘要写入同一会话 |
| 上下文预算 | 最多持久化 80 条记录；规划模型读取最近 6 条用户输入及经校验的课程汇报 |

## 数据表

```sql
router_sessions(id, course_id, thread_id, summary, revision, created_at, updated_at)
router_messages(session_id, seq, role, content, created_at)
router_decisions(id, course_id, event_id, action, task_id, reason, created_at)
```

## 行为

1. Router 收到消息时确保会话存在，并追加一条 user 消息；
2. 学生答疑、模型 create/control 决策写入 `router_decisions`；
3. Worker 的 `completed` / `blocked` / `waiting_teacher` 报告追加一条 assistant 摘要；
4. 教师规划调用携带最近 6 条协调会话输入以及当前课程计划；
5. 只保留最近 80 条消息，避免无限增长。

## 还没做（下一阶段）

- **报告唤醒**：目前报告只进会话，不主动唤醒 Router 重新规划；下一步加 `router_wakes` 队列；
- **route 工具**：`accept / attach / ignore / stop` 仍由程序分支决定，未做成模型工具；
- **Eval 批处理**：仍用现有消息合并窗口，不是原型按 Thread 批量评估；
- **跨 Worker 计划**：步骤依赖与汇总还没实现。

## 验收

`tests/router-session.test.ts`：学生消息进入会话、决策落库、Worker 报告回传同一线程。
