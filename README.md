# 助教 Super Agent

课程作业的操作步骤、验收用例和答辩留证见 [使用与验收手册](docs/user-guide.md)。
逐项目标、进度和当前验收步骤见 [目标与验收清单](docs/goals-checklist.md)。

面向真实课程事务、持续在线的独立助教系统。系统通过 LLBot 接入 QQ，通过邮箱接收作业，并提供教师管理界面；以持久任务、订阅、评分标准和程序权限约束完成答疑、批改、讲义与汇报。

当前版本为可运行的第一阶段原型：新系统独立开发，不导入、不依赖 AI-chat 的代码或运行状态；教材资料包支持独立导入。

已实现：

- SQLite 持久事件、任务、检查点、订阅与交付队列。
- LLBot 结构化消息接入、按引用关联讨论、多任务并发与单任务串行。
- 基于后续反馈修正线程归属，重建上下文并失效旧结果；原始消息与修订历史保留。
- 独立 Windows 桌面工作台通过 SSH 连接服务器，支持课程编辑、作业题图及线下批量录入分数。
- 工作台支持给名单中的指定学生设置、修改和撤销作业延期，保留全班截止和原有分数。
- 后台活动可追踪 Router、Worker、模型与交付记录；DSH 助教预设可按需连接服务器。
- LLBot状态检测和离线二维码刷新；不修改现有机器人服务。
- 教师身份校验、程序授权、修改/暂停/恢复/取消、过期执行结果拒绝提交。
- 可配置模型的基础答疑 Worker、教师自然语言路由与结构化管理 API。
- 教师 QQ 私信可生成新建作业、修改作业和登记分数的草稿，教师确认后写入工作台共用的正式记录。
- 发送回执关联、未知发送结果不自动重发；默认关闭真实 QQ 外发。
- 带来源与版本的学生学习记忆、持久提取队列、限定范围混合检索及thread纠正联动；桌面可查看、纠正和停用。
- 独立教材包检索、父块扩展与知识点关联；Embedding未配置或不兼容时如实使用关键词检索。

- 明确题号优先从教材编号索引核对原文跨度。教师可补充作业截止日期，QQ 公式答复可渲染为图片。

答疑 Worker 可按需查询学生可见作业、精确题号、教材和引用。配置视觉模型和 Poppler 后，可核对教材 PDF 原页及已上传的作业题图。答复明确选择文字、渲染或静默，仍通过任务版本与持久交付队列。详见 [答疑工具与验收](docs/qa-tools.md)。

工作台支持按需生成习题课讲义草稿。尚未实现：QQ 自由上传的图片和文件识别、学生私信申请延期、邮件收取与自动批改、每周定时备课、周月汇报。

## 快速验证

需要 Node.js 24.15 或更高版本。使用 Node 原生 TypeScript 执行和内置 SQLite；开发依赖仅用于类型检查。

```powershell
npm ci
npm run check
npm run demo
```

`demo` 使用内存数据库与模拟 Worker/Sender，展示两个独立讨论和引用追问，不连接模型、邮箱或 QQ。

## 启动服务

将 `.env.example` 复制为 `.env`，配置两个不同的随机令牌及模型参数，再运行：

```powershell
npm start
```

不填模型密钥仍可操作管理 API，答疑任务会保留为 `blocked`。配置真实模型后重启并恢复任务。只有显式设置 `QQ_SEND_ENABLED=true` 才会连接 LLBot 发消息；启动不需要改动现有机器人。不要把两个机器人同时配置成响应同一个测试群。

具体配置、接入和 API 示例见运行说明。

- [架构与项目文件规划](docs/architecture.md)
- [当前架构简图、情景流转与DeepSeek对照（2026-11-04）](docs/architecture-overview-2026-11-04.md)
- [运行、配置与 API](docs/operations.md)
- [首版实现范围与源码参考](docs/implementation.md)
- [教材 RAG 混合检索设计](docs/textbook-rag.md)
- [学习记忆与教材 RAG：架构、实现和API](docs/memory-rag.md)
- [任务汇报与课程计划](docs/task-reports.md)
- [跨跳召回、批处理、监督与退避](docs/runtime-guardrails.md)
- [教师待办收件箱与建议](docs/inbox.md)
- [学生查询本人作业情况](docs/student-self-service.md)
- [课程内容层与 Worker 能力边界](docs/course-content.md)
- [批改批次：截止节点统一审核与回信](docs/grading-batches.md)
- [课程群白名单与群成员私信](docs/qq-course-access.md)
- [可修正的 Thread 分类](docs/thread-routing.md)
- [桌面端启动与打包](desktop/README.md)
- [服务器内核与桌面工作台](docs/desktop-server.md)
- [指定服务器部署记录](docs/deployment-2026-11-02.md)
- [双LLBot实例隔离与当前待授权状态](docs/dedicated-llbot.md)

架构文档包含 Mermaid 图，可在支持 Mermaid 的 Markdown 阅读器中查看。
