# 0.1 首版实现范围

日期：2026-11-02。

2026-11-03补充：已实现学习记忆、持久提取任务、限权混合检索、教材包预检索、ContextBuilder及桌面记忆管理。本文其余内容记录首版范围；最新状态见[学习记忆与教材RAG](memory-rag.md)。

## 已交付链路

```text
LLBot HTTP消息上报 → 认证 → 真实QQ ID识别 → 课程/引用线程定位
→ SQLite事件事务 → 订阅输入或Router → 持久任务
→ 并发Runner → 基础答疑模型 → 版本/输入/租约校验
→ 持久交付队列 → 可选LLBot外发 → 回复映射
```

教师可以通过管理 API 或 QQ 明确命令控制任务。教师自然语言规划依赖已配置模型；学生新问题直接建立限权答疑任务，不进入教师规划器。教师消息先分类，再将内容交给 Worker，避免控制要求提前被当作普通答疑处理。同课程教师路由按接收顺序串行，其他讨论仍可推进。

## 关键实现位置

| 文件 | 实际职责 |
| --- | --- |
| `src/application/task-engine.ts` | 事务内创建、订阅输入、控制、领取运行、提交结果、交付授权 |
| `src/application/task-runner.ts` | 有界并发、单任务互斥、取消信号、结束检查 |
| `src/application/runtime.ts` | 事件路由、同课程控制规划串行、租约恢复、服务生命周期 |
| `src/application/delivery-outbox.ts` | 队列外发、回执、未知结果保留 |
| `src/security/policy.ts` | 主体身份与任务授权范围 |
| `src/agents/router.ts` | 教师意图建议、固定命令与输出结构校验 |
| `src/agents/thread-classifier.ts` | 根据反馈提出归属修订，Engine校验后迁移QA上下文 |
| `src/agents/workers/qa-worker.ts` | 独立上下文、原始作者标记、基础问答 |
| `src/adapters/models/client.ts` | 可配置Chat Completions模型适配、超时与取消 |
| `src/adapters/qq/llbot.ts` | 全新LLBot/OneBot消息接入与发送适配 |
| `src/adapters/storage/sqlite.ts` | SQLite存储接口与事务 |
| `src/http/server.ts` | 独立管理认证、QQ接入认证、结构化API |

状态分为 `queued/running/paused/cancelled/superseded/completed/blocked`。superseded表示线程结构变化后原答疑任务已被替代。结果提交必须匹配当前任务版本、输入版本和有效租约。`completed` 表示模型结果和待交付事务已落库，外发状态单独查询，不能据此宣称QQ已经收到。

## 当前边界

- 当前完成的是运行骨架和基础文字答疑，不是完整助教产品。
- 模型/LLBot 适配器用本地模拟 HTTP 服务验证，未使用用户真实凭据或接入线上机器人。
- QQ 首版接受结构化消息数组；新群讨论需要 @机器人，明确引用已知讨论可续接。未引用的含混消息不进行语义猜测。图片、转发和公式图片尚未接入。
- 基础答疑没有教材索引，不应当作已核对教材的课程答案。课程基础资料已支持版本化编辑，当前进度进入答疑上下文。
- QA Worker 当前执行单次模型调用；通用 ReAct 工具循环、知识检索与持久多步骤业务尚待接入。
- 可建立 `lesson` 任务用于验证教师授权和控制，但默认 Worker 将其标记为 `blocked`。
- 已支持评分规则保存和线下登记，未实现邮箱与自动批改，也不创建截止提醒。后续接入邮箱须遵循“正常批改完成后才回复”和“按实际作业归属判定迟交”。
- 首版所有已配置教师管理本服务内所有课程；按教师划分课程授权尚未实施。管理 API 为单一管理员角色。
- 单实例后端拥有数据库。异常退出后，运行任务等旧租约到期再恢复；正常退出将运行任务退回队列。
- `unknown` 外发需人工核对，不开放“一键盲重发”。已经进入外部发送中的请求可能在取消后完成。
- 当前已提供独立Electron桌面端，支持SSH连接、课程/作业编辑、线下登记和任务查看；部署细节见[桌面与服务器架构](desktop-server.md)。路由失败记入事件错误，教师可通过API明确重试。

## 参考源码与采用方式

本项目参考公开源码的职责边界，自行实现，不复制或依赖其代码，也不安装整个 Harness 插件平台。

| 官方来源 | 参考点 | 本项目采用 |
| --- | --- | --- |
| [Super-agent Engine](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/src/core/engine.ts) | 统一事务入口、领域对象更新与外部效果分离 | TaskEngine 与交付队列 |
| [Super-agent Intake](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/src/core/intake.ts) | 持久触发、订阅扇出、独立输入 | 事件去重、Thread订阅、任务输入游标 |
| [Super-agent Outbox](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/src/app/outbox.ts) | 先保存交付，再执行渠道调用 | SQLite交付记录和外部回执 |
| [Harness Agent Loop](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent-loop/src/index.ts) | 独立Agent生命周期与取消信号 | 独立Worker运行、AbortController |
| [Harness Agent Loop说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/core/agent-loop/README.md) | 收件箱、持久会话与协作式取消 | 任务收件箱、检查点与旧结果拒绝 |

参考日期为2026-11-02；上游分支链接会变化。本项目没有引入上游运行依赖。完整插件体系、Shell能力和开发机接管不属于本项目首版范围。

## 下一阶段

1. 实际LLBot测试群与配置模型联调，确认上报格式和引用回执。
2. 正式课程/作业/评分标准版本服务，以及教材与全部已布置作业索引。教材沿用BM25、向量、RRF及父子块方案，见[教材RAG设计](textbook-rag.md)，兼容导入既有教材产物。
3. 邮箱和线下提交、实际作业定位、逐题评分与最终邮件反馈。
4. 讲义、周期汇报、学校系统适配和教师界面。
