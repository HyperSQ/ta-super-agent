# 课程群与私信权限部署

日期：2026-11-09。

## 已完成

- 后端72项测试及类型检查通过，包含15项新增权限测试。
- 新内核已更新，迁移005保存按QQ和课程隔离的私信Thread。
- 测试课程ID：<TA_TEST_COURSE_ID>，课程名“数学分析B3（测试）”，群<TA_TEST_GROUP_ID>，教材math-analysis-b3。
- 教师QQ<TEACHER_QQ_IDS>已加入新内核TEACHER_QQ_IDS，保留已有教师配置。
- 课程群白名单在接入、领取任务、提交与传输前核验；换群后旧任务不能发向旧群。
- 学生私信按群成员资格校验，教师私信保留管理权限；成员接口故障默认拒绝，出站延后重试。
- 更新前备份新内核src、migrations和var/db至var/backups/pre-qq-access-20261109.tar.gz。
- 仅为专属LLBot配置消息上报到新内核回环地址，未使用原机器人配置或凭据。

## 联调状态

登录后的专属PMHQ曾出现群成员调用超时，随后其/health也无法响应。重启专属LLBot与专属PMHQ后，PMHQ健康接口恢复200，但QQ保存的票据被QQ判定失效。用户再次扫码后已恢复：WebUI显示专属账号<ASSISTANT_QQ>、9个群；专属OneBot的get_group_list返回status=ok、retcode=0，包含测试群<TA_TEST_GROUP_ID>；通过部署中的LLBotMembership调用真实get_group_member_list，确认教师QQ<TEACHER_QQ_IDS>是该群当前成员。

为减轻专属QQ登录后的内存回收压力，将ta-assistant.slice的MemoryHigh从800MiB调整为960MiB，MemoryMax仍为1GiB、CPU总配额仍为1核。仅调整新服务资源组，未调整原机器人资源或服务。

原llbot.service PID498643、hyperbot.service PID304140、hyperbot-admin.service PID232753均与本轮操作前一致。

## 验证范围与运行开关

- 已完成专属QQ登录、测试群存在及真实成员接口验证。
- 使用真实成员接口和独立内存数据库，临时以普通学生权限验证<TEACHER_QQ_IDS>的私信接入及同课程Thread复用，均通过；没有向生产数据库写入模拟消息，也没有发送消息。
- 用户随后明确授权复用现有机器人的模型API。已只读获取原服务的模型配置，将API密钥、基础地址和模型名写入助教内核自己的.env；模型为deepseek-flash，基础地址https://api.deepseek.com。密钥未输出到日志或本地文件，原服务配置未修改。
- 助教模型客户端的真实JSON调用已通过，随后以ta-agent用户读取持久化配置，普通模型调用和内核健康检查也通过。仅重启ta-super-agent.service以加载模型配置；原聊天机器人及两套LLBot的PID均保持不变。更新前的助教.env已备份到服务器var/backups，备份权限0600。
- QQ_SEND_ENABLED仍为false；此次模型配置没有开启QQ自动外发。没有向测试群或任何成员发送测试消息。
