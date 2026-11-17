# 2026-11-02 服务器部署记录

**更新：LLBot登录管理已更正为独立第二实例。当前配置与待授权状态以[专属LLBot部署记录](dedicated-llbot.md)为准。下面关于复用原LLBot登录面板的段落仅记录早期部署过程，已不作为当前使用方式。请使用0.1.2或更新工作台。**

状态：内核已运行，管理API与桌面SSH适配器真实联调通过。模型接口待独立配置；新内核QQ接入保持关闭。

## 连接与服务

| 项目 | 实际配置 |
| --- | --- |
| 服务器 | <TA_SERVER_HOST>，Ubuntu 24.04.2 LTS，x86_64 |
| SSH | 端口22，用户root；密码不在本文档或项目文件保存 |
| SSH主机指纹 | `SHA256:T1OnofwDpeMj3zRMSOp/zgLqAyLI1ZshmIenAahM1/8` |
| 独立目录 | `<TA_SERVER_DIR>` |
| 服务名 | `ta-super-agent.service`，已启用开机启动 |
| 服务账号 | `ta-agent`，独立系统账号、不可交互登录 |
| Node | 使用现有 `/usr/local/bin/node` v24.22.0，未安装或替换系统Node |
| 监听地址 | `127.0.0.1:<TA_SERVER_KERNEL_PORT>`，无需公网开放该端口 |
| 数据库 | `<TA_SERVER_DIR>/var/db/ta.sqlite` |
| 资源限制 | CPU配额50%（半个CPU核）、MemoryHigh256MB、MemoryMax384MB、Nice10 |
| 文件隔离 | ProtectHome=yes，ProtectSystem=strict，仅var目录可写 |

管理令牌和Webhook令牌在服务器上独立随机生成，保存在本服务.env中，未打印、回传或写入本地仓库。服务器当前没有创建样例课程或虚构学生记录。

## 与现有机器人的隔离

现有8787端口属于旧管理面板，因此新服务选择<TA_SERVER_KERNEL_PORT>。部署没有修改旧机器人目录、配置或systemd单元，也没有重启现有服务。

| 原有服务 | 部署前后主进程 | 状态 |
| --- | --- | --- |
| hyperbot.service | 304140 | active，启动时间未变 |
| hyperbot-admin.service | 232753 | active，启动时间未变 |
| llbot.service | 399323 | active，启动时间未变 |

新内核QQ_SEND_ENABLED=false，不配置旧LLBot凭据，不订阅旧QQ消息。其LLBOT_HTTP_URL指向未使用的本机19999端口，以明确避免接管已有LLBot。之后要启用新助教的QQ收发，需要另外确定账号、群范围与消息入口。

新服务没有读取或复制旧机器人的模型密钥。MODEL_API_KEY当前为空：课程编辑、作业管理与线下登记可用；模型答疑任务会进入blocked，等待独立接口配置。

## 桌面连接

使用0.1.1或更新的工作台：输入服务器IP、root和SSH密码。内核目录保持 `<TA_SERVER_DIR>`。

工作台从新内核.env读取实际PORT=<TA_SERVER_KERNEL_PORT>，避免访问旧管理面板的8787。首次连接请核对上表主机指纹。无需在页面输入管理令牌。

LLBot登录管理通过同一个SSH会话访问：

- 数据目录：`/home/qqbot/LLBot/bin/llbot/data`。
- 管理端口：服务器回环3080。
- GET `/api/login-info` 读取登录状态。
- 仅明确离线时调用GET `/api/login-qrcode`，以实时响应显示二维码。
- 凭据在桌面主进程经SFTP读取、哈希后使用，不复制给新内核或页面。
- 不提供重启、注销或修改LLBot配置的操作。

真实联调时LLBot处于在线状态，因此没有请求真实二维码或人为制造掉线。二维码离线刷新与上线后停止返回二维码，已使用本机模拟SSH和接口验证。

## 验证结果

- 新服务active/running，启动后内存约50MB。
- `/health` 返回200，管理凭据验证后的`/v1/courses`返回200和空课程列表。
- 用桌面同一SSHSession实际连接，识别内核端口<TA_SERVER_KERNEL_PORT>，读取课程列表及LLBot在线状态成功。
- 新服务与旧面板分别监听<TA_SERVER_KERNEL_PORT>、8787，LLBot仍监听3080。
- 旧服务主进程和启动时间保持不变。

后续只重启 `ta-super-agent.service` 即可更新本内核，不应对hyperbot、llbot等服务执行关联重启。
