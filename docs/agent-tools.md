# 助教 Agent 工具目录

DSH 原生工具负责读写文件、搜索工作区、运行代码、检查产物和打包。助教工具提供课程资料与业务操作。任务可以根据需要组合这些能力。

参数后的 `?` 表示可选。表中的参数和返回值是桌面助教会话的接口。现有 QQ 答疑和定时 Worker 通过自己的授权使用部分底层能力。接入 headless 后，Router 应给每次运行绑定课程，工具从运行授权取得课程范围。

## 获取资料

| 工具 | 参数 | 说明 | 主要返回值 |
|---|---|---|---|
| `ta_courses` | 无 | 列出可选课程及绑定群 | `[{id, title, groupId?}]` |
| `ta_class_context` | `courseId, days?, qq?, student?` | 读取进度、作业统计、群聊样本和学习记录。按姓名可查个人登记及截止时间 | `{course, coverage, assignments, group}` |
| `ta_read_messages` | `courseId, before?, messageId?, teacher?` | 按消息 ID 或游标读取原话与助教答复，可切换教师交流范围 | `{messages, replies, nextBefore?}` |
| `ta_read_attachment` | `courseId, eventId, index` | 按消息和序号读取本课群附件或教师私信附件，最大 3 MiB | 图片预览，或可供 DSH 原生文件工具读取的本地只读路径 |
| `ta_textbook` | `courseId, action, bookId?, query?, sectionId?, page?` | 题号查找、知识点检索、查节范围、看原 PDF 页 | 检索或章节结果；查看原页时附图 |
| `ta_assignments` | `courseId, assignmentId?, attachment?` | 列目录、读单份作业或查看指定题图 | 作业数组，或单份作业与题图目录；指定题图时附图 |
| `ta_roster_list` | `courseId` | 读取姓名名单 | `{title, names}` |

`ta_class_context` 适合开始备课时收集概况。需要引用原话、查特定题目或核验教材时，继续用对应的精确查询。

## 准备与交付

| 工具 | 参数 | 说明 | 主要返回值 |
|---|---|---|---|
| `ta_render_image` | `courseId, text` | 渲染公式并返回本次预览 | `{imageId, bytes}`，附 PNG |
| `ta_view_image` | `courseId, imageId` | 回看已生成或已发且留存的图片 | 图片附件 |
| `ta_send_group` | `courseId, text, imageId?` | 发文字或已渲染的图到课程绑定群 | 发送请求回执 |
| `ta_send_group_file` | `courseId, filePath` | 把准备好的文件发到课程绑定群。ZIP、PDF 等共用此工具 | 发送请求回执 |
| `ta_request_status` | `eventId` | 查询请求进度、交付和教师答复 | `{eventId, courseId, status, result?, answer?, error?, externalId?, externalFileId?}` |

渲染时直接带预览，模型可以及时检查。有返工时可重新渲染。发送仍单独形成一条可确认、有回执的操作。

## 更新业务记录

| 工具 | 参数 | 说明 | 主要返回值 |
|---|---|---|---|
| `ta_save_assignment` | `courseId, title, instructions, deadline, assignmentId?, revision?, gradingPolicy?, studentVisible?` | 创建或编辑作业，编辑须带当前版本，教师确认 | 作业 ID、版本和可见性 |
| `ta_record_score` | `courseId, assignmentId, name, score, revision` | 教师确认后登记或更正一名学生的线下成绩 | 登记记录数组 |
| `ta_roster_add` | `courseId, names` | 追加姓名，去重 | `{added, total}` |
| `ta_roster_import` | `courseId, filePath` | 解析表格，追加姓名，去重 | `{added, total}` |
| `ta_roster_remove` | `courseId, names` | 教师核对姓名后移除，保留历史记录 | `{removed}` 或取消 |

名单导入保留为一次操作，解析、校验和写入可以一并完成。名单移除需要独立的确认。保存作业与发布通知各有自己的业务状态。

## 保留的组合工具与 Router 入口

| 能力 | 参数 | 保留理由 |
|---|---|---|
| `ta_dispatch_assignment` | `courseId, assignmentId` | 由服务端从已发布的作业版本生成标准通知，核对群和作业版本后交付。适合正式布置作业。 |
| `prepare_lesson`（现有定时 Worker） | `goal?` | 已有选题、教材范围校验和学生版／教师版输出流程，可供标准习题课复用。 |
| `ta_contact` | `courseId, request` | 把需要服务器处理的请求交给 Router，并返回事件编号。 |
| `ta_ask_teacher` | `courseId, text` | 桌面确认后私信课程定时任务里配置的唯一教师。教师引用回复后，通过回执查询答案。 |

现有答疑 Worker 还有 `read_quoted_message`、`read_qq_image` 及回复、渲染或静默的输出协议。它们随当前会话授权。入站附件和教师联络已接入桌面助教，后续可由 headless Worker 复用。实验包等开放任务使用原生执行工具和上面的资料、交付工具。
