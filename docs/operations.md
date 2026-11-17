# 运行与 API

## 1. 本地启动

需要 Node.js >=24.15。项目直接执行原生 TypeScript，无需编译；`npm ci` 安装类型检查工具。

```powershell
npm ci
npm run check
npm run demo
Copy-Item -LiteralPath .env.example -Destination .env
```

编辑 `.env`：

- `ADMIN_TOKEN`：管理 API 的独立随机令牌，至少16字符。
- `QQ_WEBHOOK_TOKEN`：LLBot消息上报使用的另一个随机令牌，不与管理令牌相同。
- `TEACHER_QQ_IDS`：实际教师 QQ ID，逗号分隔；昵称与群备注不能授权。
- `MODEL_API_KEY/MODEL_BASE_URL/MODEL_NAME`：选择的模型服务；密钥只留在本地配置。
- `QQ_SEND_ENABLED`：默认false，只生成待交付内容；确认测试群后可开启。
- `LLBOT_HTTP_URL/LLBOT_ACCESS_TOKEN`：LLBot的HTTP API及其令牌。
- 学生私信自动通过该LLBot核实课程群成员资格；配置方法和选课指令见[课程群与私信权限](qq-course-access.md)。

```powershell
npm start
```

服务默认监听 `127.0.0.1:8787`，数据库为 `var/db/ta.sqlite`。LLBot在其他机器时通过受控网络和HTTPS反向代理接入；不把管理端口直接暴露到公网。

## 2. 管理 API 示例

以下代码在另一个 PowerShell 中执行。令牌需与 `.env` 中一致；示例不读取或打印真实配置。

```powershell
$adminHeaders = @{ Authorization = 'Bearer <ADMIN_TOKEN>' }
$baseUrl = 'http://127.0.0.1:8787'

$courseBody = @{
  id = 'math-analysis-2026'
  title = '数学分析'
  groupId = '<测试群数字群号>'
  instructions = '关注推导步骤；缺少原题时先询问。'
} | ConvertTo-Json
Invoke-RestMethod "$baseUrl/v1/courses" -Method Post -Headers $adminHeaders -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($courseBody))

$taskBody = @{ courseId = 'math-analysis-2026'; kind = 'qa'; goal = '解释一致连续与连续的区别' } | ConvertTo-Json
$task = Invoke-RestMethod "$baseUrl/v1/tasks" -Method Post -Headers $adminHeaders -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($taskBody))

Invoke-RestMethod "$baseUrl/v1/tasks" -Headers $adminHeaders
Invoke-RestMethod "$baseUrl/v1/deliveries" -Headers $adminHeaders
Invoke-RestMethod "$baseUrl/v1/events" -Headers $adminHeaders
```

管理 API 创建的任务只在任务列表中保存结果，不向任意 QQ 号外发。

控制动作 `revise/pause/resume/cancel` 必须携带刚读取的 `revision`；不匹配返回409。

```powershell
$current = (Invoke-RestMethod "$baseUrl/v1/tasks" -Headers $adminHeaders) | Where-Object id -EQ $task.id
$controlBody = @{ action = 'revise'; revision = $current.revision; goal = '用简短反例说明，并减少公式' } | ConvertTo-Json
Invoke-RestMethod "$baseUrl/v1/tasks/$($task.id)/control" -Method Post -Headers $adminHeaders -ContentType 'application/json; charset=utf-8' -Body ([Text.Encoding]::UTF8.GetBytes($controlBody))
```

## 3. LLBot 接入

在LLBot配置HTTP消息上报：

```text
POST /hooks/qq
X-Signature: sha1=<用 QQ_WEBHOOK_TOKEN 对原始请求体计算的 HMAC-SHA1>
Content-Type: application/json
```

在 LLBot 的 HTTP 上报配置中将 `token` 设为 `QQ_WEBHOOK_TOKEN`。内核对原始请求体校验签名，成功接收时返回 204。Bearer 认证供受控 API 联调使用。群消息按绑定群定位课程，私聊由课程群成员资格和选课记录确定课程。

需要OneBot结构化 `message` 数组，包含文本、@或引用段；`user_id/self_id/message_id` 来自实际事件。客户端提交的 `role`、昵称、自称和转发内容不参与教师认证。非消息上报会忽略。

群中 @机器人创建新讨论；引用已知提问或已发答复继续讨论。首版不处理图片题目。

教师可私聊自然语言，或使用不依赖模型的明确命令：

```text
/task pause <任务ID>
/task resume <任务ID>
/task cancel <任务ID>
/task revise <任务ID> <完整新目标>
/lesson <讲义要求>
```

`/lesson` 创建教师讲义草稿任务。也可以从工作台「运行任务」提交并查看学生版、教师版和参考资料。草稿不会进入 QQ 交付队列。暂停、修改和恢复通过原有任务控制命令进行。

## 4. 状态与处理

| 状态 | 含义与处理 |
| --- | --- |
| queued | 等待执行 |
| running | 已持有执行租约 |
| completed | 结果已保存；QQ是否收到还需看交付记录 |
| blocked | 无模型配置、模型错误、未实现Worker等；排除原因后教师resume |
| paused | 教师暂停，保留输入和检查点 |
| cancelled | 本次任务结束，不可自动恢复 |
| superseded | 线程重分类后旧答疑任务已被替代，不可恢复旧上下文 |
| delivery.pending | 等待外发；默认关闭外发时会停留在此 |
| delivery.sent | LLBot已返回成功消息ID |
| delivery.withdrawn | 版本过期、权限失效或任务变更，未外发 |
| delivery.unknown | 请求结果不明或发送中进程退出，需核对，不自动重发 |

`GET /v1/events` 显示最近100条事件的路由状态与错误。排除模型配置等原因后可用管理令牌 `POST /v1/events/<事件ID>/retry` 明确重试。该操作不会改变原始作者或提升学生权限。

正常退出使用Ctrl+C。异常退出的执行任务等租约到期后重新领取，防止旧进程结果被接纳。首版只运行一个后端实例。

备份时先停止服务，再备份整个 `var/db` 目录；后续有文件资料时同时备份原件和产物目录。真实凭据、数据库和学生材料不提交Git。

## 5. 验证范围

线程纠错可通过 `THREAD_RECLASSIFY_ENABLED=true` 开启反馈复核，也可由管理API明确触发。配置、迁移语义和API示例见 [Thread分类与纠正](thread-routing.md)。

`npm run check` 执行类型检查及场景/集成测试；HTTP测试只连接本机临时服务，模型调用使用模拟端点，不调用真实API。若运行环境禁止回环连接，需要允许测试进程访问其本机测试服务器。

`npm run demo` 不需要令牌或模型，可直接查看独立讨论与订阅续接的确定性演示。
