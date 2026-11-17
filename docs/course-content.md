# 课程内容层与 Worker 能力边界

状态：第一批已实现（讲义与群文件）。目标是不再为每种内容类型新增一个工具，而是把课程内容放进统一的内容层，由角色决定可见范围。

## 内容模型

| 字段 | 说明 |
|---|---|
| `ref` | 稳定引用，如 `task/<taskId>/result`、`task/<taskId>/file/<sha256>` |
| `kind` | `material`（讲义正文）、`group-file`（群文件）、`submission`（本人提交，预留） |
| `visibility` | `published` / `draft` / `private` |
| `source` | 任务或产物的来源，便于回溯 |
| `version` | 与任务版本绑定，旧答案不会引用新版本 |

发布判定：任务有**已发送到群**的交付即 `published`；否则是 `draft`。教师撤回发送后，下次索引会回到草稿可见性。

## 学生答疑的工具

- `search_course_content(query, kinds?)`：只检索已发布内容；返回 `ref`、标题、版本、片段。
- `open_course_content(ref)`：打开正文；群文件返回文件信息（二进制内容不进模型）。
- `list_course_files()` / `read_course_file(path, page?)`：文件已经在服务器上时，直接按路径读取；文本给正文，图片与 PDF 页可直接看。

文件层只登记路径与可见性，不复制、不改写原文件；读取时校验路径必须落在本课程目录内。当前接入的是 DSH 任务产物目录（`<workspace>/<course>/<task>/artifacts`）和群文件目录（`<data>/files/group/<sha>/<name>`）。群文件在收到上传通知时下载一次并登记，worker 之后直接按 path 读取，不再回 QQ 下载。

学生提交附件在登记时写到 `<data>/files/submission/<requestId>/<n>-<name>`，`coursework_submission_paths` 记录路径与 sha，数据库里的 blob 置空；旧数据没有路径时读取方回退到原 blob。邮件附件仍保留在 `course_mail_files`，因为教师复核与重新批改依赖原邮件，且不向学生暴露。

群文件不会以“文件 + 文字”的消息形式出现，只走 `group_upload` 通知，因此不需要处理消息里的文件段。

学生问“讲义第 2 题”“上周群里那个文件”时，先检索再打开，不再为“讲义”“群文件”各做一个工具。教材仍走教材检索，因为它是独立的页码/章节体系。

## 边界

- 学生只能看 `published`；教师可通过 `teacher: true` 看草稿。
- 提交类内容预留 `private` + `owner`，只允许本人读取。
- 索引只读任务结果与产物，不改业务表；写入仍走讲义、邮件、提交各自入口。
- 已知限制：群文件二进制内容目前只给元数据，不能解压 zip；PDF 页图仍走教材页图通道。

## 下一步

- 把 `read_my_submission` 迁移到 `submission` 内容引用，减少按类型工具；
- 为群文件增加按需下载/解压；
- 教师端增加“撤回发布”入口。
