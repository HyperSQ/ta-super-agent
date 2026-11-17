# 助教专属 LLBot：双实例隔离

更新：2026-11-09。当前状态：已使用用户指定文件中的Auth Token完成专属PMHQ配置，授权校验通过，专属QQ客户端已启动；WebUI二维码已实际显示，等待专属QQ账号扫码登录。

本次仅重启ta-llbot-pmhq.service，并将新内核.env中的LLBOT_SETUP_STATE改为ready；桌面重新连接后可获取二维码。原llbot.service、hyperbot.service及hyperbot-admin.service的PID与本次操作前一致。下文保留2026-11-02部署及待授权阶段的历史说明，以本段最新状态为准。

## 对上一版设计的纠正

0.1.1工作台曾指向原机器人的LLBot登录面板，这不符合要求。0.1.2起只管理助教专属实例。请使用新版，旧0.1.1不应用于新助教的QQ登录。

旧LLBot、旧QQ登录态、旧机器人配置和服务保持原状。新实例只复制兼容的程序文件，未复制旧data、QQ用户目录、Auth Token、WebUI令牌、OneBot令牌或旧QQ号。

## 实例对照

| 项目 | 原聊天机器人 | 新助教 |
| --- | --- | --- |
| LLBot服务 | llbot.service | ta-llbot.service |
| PMHQ服务 | 由原启动器管理 | ta-llbot-pmhq.service |
| 服务用户 | qqbot | ta-qqbot |
| 程序目录 | /home/qqbot/LLBot | /opt/ta-llbot |
| LLBot数据 | 原bin/llbot/data | /var/lib/ta-llbot/data |
| QQ用户目录 | 原qq-home | /var/lib/ta-llbot/qq-home |
| WebUI端口 | 3080 | 13080 |
| PMHQ端口 | 13000 | 13200 |
| OneBot HTTP/WS | 3000 / 3001 | 13010 / 13011，登录后生效 |
| QQ登录态 | 原账号继续运行 | 空白，等待新账号扫码 |

所有新端口绑定127.0.0.1，由桌面SSH通道访问。新实例应使用另一独立QQ账号扫码，不能用原聊天机器人的QQ账号重复登录。

## 服务器与桌面绑定

新内核.env中独立保存：

```dotenv
LLBOT_INSTANCE_ID=ta-llbot
LLBOT_WEBUI_PORT=13080
LLBOT_PMHQ_PORT=13200
LLBOT_DATA_DIR=/var/lib/ta-llbot/data
LLBOT_SETUP_STATE=awaiting-auth
LLBOT_HTTP_URL=http://127.0.0.1:13010
QQ_SEND_ENABLED=false
```

桌面连接后以这些字段为准，覆盖本机旧profile中的3080端口和旧数据目录。服务器没有声明ta-llbot时拒绝LLBot访问，不回退到原实例。桌面仍可连接内核编辑课程。

待授权状态显示明确说明，不调用二维码接口。用户提供Auth Token后，配置仅写入新实例，验证QQ客户端启动成功，再将setup状态更新为ready。桌面重新连接后显示新实例自己的二维码。

## 资源与进程隔离

新内核、ta-llbot、ta-llbot-pmhq位于独立ta-assistant.slice，CPU总配额1核、内存上限1GiB；旧服务不属于该资源组。新QQ与LLBot使用独立系统用户、HOME、XDG_CONFIG_HOME、运行目录和临时目录。

当前因Auth Token缺失，PMHQ只启动本机API而不启动QQ。新服务组实测内存约290MB。原LLBot服务主进程399323、旧QQ进程399371、旧机器人304140、旧管理面板232753均保持不变。

## 后续授权

### 登录顺序（2026-11-09核对）

1. 先登录[官方授权平台](https://auth.luckylillia.com/login)，按页面提供的账号方式完成平台登录，取得Auth Token。官方前端包含GitHub登录入口；其他登录方式以页面实际开放为准。
2. 将Token配置到助教专属PMHQ；[官方配置说明](https://github.com/linyuchen/PMHQ/blob/main/doc/config.md)明确auth_token是manager-server鉴权凭证且为必需项。
3. PMHQ启动自己的QQ客户端，LLBot取得二维码，再由专属机器人QQ账号扫码登录。官方授权平台说明QQ会在Bot使用Token登录后自动绑定，因此不必先登录机器人QQ来换取Token。
4. WebUI访问密码只用于进入管理网页，独立于官方Auth Token及QQ扫码登录。

当前已安装LLBot 8.3.2的/api/auth-token/status在PMHQ模式返回applicable=false；网页内的Auth Token录入流程不适用于该模式。缺少PMHQ授权时可能只有扫码提示而没有二维码，需先配置专属PMHQ。2026-11-09读取的新实例配置仍未包含auth_token；本次核对未修改或重启服务。

用户已说明暂时没有新Auth Token，会在准备好后通知。当前不复用旧实例授权，也不尝试旧账号快速登录。拿到Token后只操作以下新服务：

```text
ta-llbot-pmhq.service
ta-llbot.service
```

本轮没有重启llbot.service、hyperbot.service或hyperbot-admin.service。

## 实现与验证

- 三个服务单元和资源组配置位于deploy目录。
- 桌面端读取服务端实例声明，测试覆盖旧profile覆盖、无实例拒绝回退、待授权不取码及离线刷新。
- 新旧3080/13080和13000/13200端口同时存在，属于不同PID和系统用户。
- 真实桌面SSH适配器用于核对新实例与待授权状态；未对旧QQ执行登录、退出或重启。
