# 记忆系统部署记录

日期：2026-11-03。

## 本次更新

- 仅更新 <TA_SERVER_DIR> 代码与迁移004，重启 ta-super-agent.service。
- 更新前备份自己的src、migrations、package.json和var/db至 var/backups/pre-memory-20261103.tar.gz；未改.env。
- 导入独立教材资料至 var/library/math-analysis-b3：737子块、299父块，保留原PDF和原向量索引。
- 新文件为root:ta-agent，去除其他用户读取权限；内核仍以ta-agent运行、监听127.0.0.1:<TA_SERVER_KERNEL_PORT>，资源限制保留。
- 桌面便携版：desktop/release/TA-Workbench-0.1.3-x64.exe。

## 验证

后端类型检查及57项测试通过，桌面7项测试通过。服务器健康检查和鉴权课程读取正常，课程数仍为0。服务器上以ta-agent运行内存数据库联调：模拟提取1张记忆，新thread召回1张，真实教材返回4条证据并展开父块；没有写入服务器课程记录。

真实教材当前模式为keyword：尚未配置匹配索引的Embedding。QA自动提取还依赖模型密钥，真实教学判断准确率未验证；模拟联调不代表已连接真实模型。

## 保持原运行状态

更新前后以下PID及启动时间均保持一致：hyperbot.service 304140、hyperbot-admin.service 232753、原llbot.service 399323、ta-llbot.service 468049、ta-llbot-pmhq.service 468048。

新内核PID更新为478322。QQ外发仍关闭，专属LLBot仍为awaiting-auth；未复制旧账号、授权、密钥或登录态。

## 界面检查

新版便携包已生成并通过JS语法和管理路由测试。尝试图形检查时检测到用户正在操作窗口，未继续注入界面操作；图形布局与真实SSH界面的本轮人工验收仍待完成。
