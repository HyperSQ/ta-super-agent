# 助教工作台（Windows 桌面端）

服务器运行Agent内核，本机运行Electron工作台，通过SSH密码认证访问服务器回环地址上的管理API。关闭工作台只断开连接，不停止内核。

## 使用

便携版位于 `release/TA-Workbench-0.1.4-x64.exe`（执行打包命令后生成）。打开后输入服务器IP、SSH用户名和密码。默认SSH端口22，内核目录 `/opt/ta-super-agent`，内核端口和专属LLBot实例从服务器.env读取。

首次连接会显示服务器SSH主机指纹，核对后确认。只保存连接地址、用户名、端口、目录和已信任指纹；密码和管理令牌不写入本地文件。

服务器需要先运行本仓库内核。SSH账号需允许本地转发，且能够通过SFTP读取内核目录下的 `.env`。工作台从中读取ADMIN_TOKEN，页面不接收该令牌。SSH账号与教师QQ身份是两套独立入口。

## 功能

- 课程总览与课程切换。
- 编辑课程名称、班级、QQ群、教学进度、助教说明、通用评分标准和姓名名单。
- 建立、编辑作业题目、题图、截止时间及本次评分要求。每份作业可保存最多 3 张 PNG、JPEG 或 WebP 图片。
- 按名单批量录入、更正和撤销分数。支持零分和小数分，登记不要求提交时间。
- 查询服务器任务和结果。
- 学习记忆：按学生和知识点筛选、查看消息依据、教师修订、停用及失败提取任务重试。
- LLBot登录管理：每30秒检查状态，离线时显示可刷新的实时二维码，上线后隐藏；不重启或注销LLBot。
- 登录页管理助教专属 ta-llbot，显示在线状态或待授权状态。
- 无需服务器即可体验演示；演示修改只存在于本次内存会话。

桌面当前不包含服务器自动安装、教材上传、扫描件上传、邮件接收和自动批改。服务器教材混合检索和学习记忆已经接入答疑，配置及边界见[记忆与RAG说明](../docs/memory-rag.md)。

## 开发与打包

在仓库根目录：

```powershell
npm --prefix desktop ci
npm run desktop
npm run desktop:test
npm run desktop:dist
```

需要下载Electron运行时。SSH使用纯JavaScript实现，关闭可选原生模块重编译。打包使用electron-builder，默认生成Windows x64便携EXE。

若本地已下载Electron，可使用：

```powershell
npm --prefix desktop run dist -- --config.electronDist=node_modules/electron/dist
```

详细部署与接口说明见 [服务器与桌面端架构](../docs/desktop-server.md)。

指定服务器的实际部署配置见 [部署记录](../docs/deployment-2026-11-02.md)。
双LLBot进程、独立端口与数据说明见 [专属LLBot](../docs/dedicated-llbot.md)。
