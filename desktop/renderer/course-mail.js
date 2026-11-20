let mailScreen;
const mailPath = id => '/v1/courses/' + encodeURIComponent(id) + '/mail';
const ustcMail = { address: '', imapHost: 'mail.ustc.edu.cn', imapPort: 993, folder: 'INBOX',
  smtpHost: 'mail.ustc.edu.cn', smtpPort: 465, smtpMode: 'tls', prefix: '作业', enabled: false, revision: 0 };
const mailStatus = { pending: '待核对', registered: '已登记', ignored: '已忽略' };
function activeMail(screen) { return state.page === 'course-mail' && state.courseId === screen.id && screen === mailScreen; }
async function loadCourseMail() {
  if (!state.courseId) return;
  const screen = mailScreen = { id: state.courseId };
  try { Object.assign(screen, await api('GET', mailPath(screen.id))); }
  catch (error) { screen.error = error.message; }
}
function mailMessageCard(screen, message) {
  const id = escape(message.id);
  const entry = screen.open?.id === message.id ? screen.open : null;
  const choices = rows => rows.map(([value, label]) => '<option value="' + escape(value) + '">' + escape(label) + '</option>').join('');
  const assignments = state.assignments.filter(a => a.studentVisible === true).map(a => [a.id, a.title]);
  const suggestion = entry?.suggestion ?? message.suggestion;
  const candidate = suggestion?.assignment &&
    state.assignments.find(a => a.id === suggestion.assignment.id && a.studentVisible === true && a.revision === suggestion.assignment.revision);
  const attachmentButtons = message.files.map(file => `<button type="button" class="button secondary small" data-action="course-mail-file" data-id="${id}" data-index="${file.index}">${escape(file.name)}</button>`).join('');
  const review = message.state === 'pending' ? `<form id="course-mail-review" data-id="${id}" class="grid2 section-gap">
     <label>作业<select name="assignmentId" required><option value="">请选择</option>${choices(assignments)}</select></label>
     <label>学生<select name="name" required><option value="">请选择</option>${choices(screen.roster.map(name => [name, name]))}</select></label>
     <div class="row"><button class="button small" ${message.issue || !assignments.length ? 'disabled' : ''}>登记提交</button>
     <button type="button" class="button secondary small" data-action="course-mail-reprocess" data-id="${id}">重新匹配</button>
     <button type="button" class="button secondary small" data-action="course-mail-ignore" data-id="${id}">忽略此邮件</button></div></form>` : '';
  const grading = entry?.grading;
  const draft = entry?.grade?.draft;
  const active = !draft && ['queued', 'running'].includes(grading?.status);
  const scoring = entry && message.state === 'registered' ? `<details class="section-gap" ${draft ? 'open' : ''}>
    <summary>批改草稿${draft ? ' · ' + escape(draft.total + ' / ' + draft.maximum) : ''}</summary>
    ${draft ? draft.points.map(point => '<p>' + escape(point.id + ' · ' + point.score + '/' + point.max + ' · ' + point.comment) +
      (point.evidence ? '<br><small>作答原文：' + escape(point.evidence) + '</small>' : '') + '</p>').join('')
      : '<p class="muted">' + escape(grading?.error || (active ? '正在生成草稿，请刷新邮件查看状态。' : '支持文本和有文字层的 PDF。评分细则每行写「评分点 | 满分 | 判分依据」。')) + '</p>'}
    ${!draft && !active ? `<button type="button" class="button secondary small" data-action="course-mail-grade" data-id="${id}">生成草稿</button>` : ''}
    ${draft && entry.gradeFingerprint ? entry.gradeRegistered ? '<p class="muted">成绩已登记</p>' :
      `<button type="button" class="button secondary small" data-action="course-mail-register-grade" data-id="${id}">登记此成绩</button>` : ''}
    <button type="button" class="button ghost small" data-action="course-mail-open" data-id="${id}">刷新邮件</button>
  </details>` : '';
  const feedbackText = draft ? draft.points.map(point => point.id + '：' + point.comment).join('\n') : '';
  const feedback = message.state === 'registered' && !message.feedback ? `<form id="course-mail-reply" data-id="${id}" class="section-gap">
     <label>回复原发件人<textarea name="text" rows="4" required maxlength="12000">${escape(feedbackText)}</textarea></label>
     <button class="button small">发送反馈</button></form>` : '';
  return `<section class="card">
    <div class="card-title"><h2>${escape(message.subject || '无主题')}</h2>${pill(mailStatus[message.state])}</div>
    <p class="muted">${escape(message.from || '未知发件人')} · ${escape(fmt(message.receivedAt))}${message.feedback ? ' · ' + ({sent:'反馈已发送',sending:'发送中',unknown:'发送结果待核对'})[message.feedback.state] : ''}</p>
    ${message.issue ? '<p class="connection-error">' + escape(message.issue) + '</p>' : ''}
    ${message.state === 'pending' && suggestion ? `<div class="note section-gap">
      ${candidate ? '<p>候选作业：' + escape(candidate.title) + '</p>' : suggestion.assignment ? '<p>候选作业已变更，请核对当前版本。</p>' : ''}
      ${suggestion.studentName ? '<p>候选学生：' + escape(suggestion.studentName) + '</p>' : ''}
      ${suggestion.evidence.map(text => '<p class="muted">' + escape(text) + '</p>').join('')}</div>` : ''}
    ${entry ? `<p style="white-space:pre-wrap;overflow-wrap:anywhere">${escape(entry.text)}</p><div class="row">${attachmentButtons}</div>${review}${scoring}${feedback}`
      : `<button class="button secondary small" data-action="course-mail-open" data-id="${id}">查看邮件</button>`}
  </section>`;
}
function courseMailPage() {
  const screen = mailScreen;
  const head = pageHead('作业邮箱', '按课程收取作业邮件，核对后登记并回复。', '');
  if (!state.courseId) return head + '<p>请先选择课程。</p>';
  if (screen?.id !== state.courseId || (!screen.messages && !screen.error)) return head + '<p class="muted">正在读取…</p>';
  if (screen.error) return head + '<p class="connection-error">' + escape(screen.error) + '</p>';
  const cfg = screen.settings ?? ustcMail;
  const input = (name, label, type = 'text') => `<label>${label}<input type="${type}" name="${name}" value="${escape(cfg[name])}" required ${type === 'number' ? 'min="1" max="65535"' : ''}></label>`;
  const smtpSelect = value => cfg.smtpMode === value ? 'selected' : '';
  return head + `<section class="card"><div class="card-title"><h2>邮箱设置</h2>
    <button type="button" class="button secondary small" data-action="course-mail-ustc">套用 USTC 参数</button></div>
    <form id="course-mail-settings" class="grid2 section-gap">
    ${input('address', '完整邮箱地址', 'email')}
    <label>客户端专用密码<input name="password" type="password" maxlength="400" autocomplete="new-password"
      placeholder="${screen.settings ? '留空保留已保存密码' : '在邮箱安全设置中生成'}" ${screen.settings ? '' : 'required'}></label>
    ${input('imapHost','IMAP 服务器')}${input('imapPort','IMAP TLS 端口','number')}
    ${input('smtpHost','SMTP 服务器')}${input('smtpPort','SMTP 端口','number')}
    ${input('folder','IMAP 文件夹')}${input('prefix','作业主题前缀')}
    <label>SMTP 加密方式<select name="smtpMode"><option value="tls" ${smtpSelect('tls')}>TLS</option><option value="starttls" ${smtpSelect('starttls')}>STARTTLS</option></select></label>
    <label class="row"><input name="enabled" type="checkbox" ${cfg.enabled ? 'checked' : ''}>定时收取</label>
    <label class="row"><input name="autoGrade" type="checkbox" ${cfg.autoGrade ? 'checked' : ''}>自动登记提交并生成批改结果</label>
    <label class="row"><input name="autoRegisterGrade" type="checkbox" ${cfg.autoRegisterGrade ? 'checked' : ''}>批改完成后自动登分</label>
    <div class="row"><button class="button">保存</button>${screen.settings ? '<button type="button" class="button secondary" data-action="course-mail-check">测试连接</button><button type="button" class="button secondary" data-action="course-mail-sync">收取新邮件</button>' : ''}</div>
    </form>
    <p class="muted section-gap">按主题前缀筛选邮件。首次保存后收到的匹配邮件才会进入列表。</p>
    ${screen.status?.at ? `<p class="${screen.status.error ? 'connection-error' : 'muted'}">${escape(fmt(screen.status.at))} · ${escape(screen.status.error || '收件完成')}</p>` : ''}
    </section><div class="task-list section-gap">${screen.messages.map(message => mailMessageCard(screen, message)).join('') || '<p class="muted">暂无作业邮件。</p>'}</div>`;
}
async function submitCourseMail(form, data) {
  const screen = mailScreen, path = mailPath(screen.id);
  const button = form.querySelector('button');
  if (button.disabled) return;
  button.disabled = true;
  try {
    if (form.id === 'course-mail-settings') {
      const request = api('PUT', path, { ...data, enabled: data.enabled === 'on', autoGrade: data.autoGrade === 'on', revision: screen.settings?.revision ?? 0,
        autoRegisterGrade: data.autoRegisterGrade === 'on',
        imapPort: Number(data.imapPort), smtpPort: Number(data.smtpPort) });
      form.elements.password.value = '';
      delete data.password;
      Object.assign(screen, await request);
      toast('邮箱设置已保存');
    } else if (form.id === 'course-mail-review') {
      Object.assign(screen, await api('POST', path + '/messages/' + encodeURIComponent(form.dataset.id) + '/review', { ...data, ignore: false }));
      toast('已登记到课程作业');
    } else {
      if (!window.confirm('通过课程邮箱回复原发件人？')) return;
      try {
        Object.assign(screen, await api('POST', path + '/messages/' + encodeURIComponent(form.dataset.id) + '/reply', { text: data.text }));
        toast('反馈已发送');
      } catch (error) {
        Object.assign(screen, await api('GET', path));
        throw error;
      }
    }
    if (activeMail(screen)) { state.dirty = false; render(); }
  } finally { button.disabled = false; }
}
async function courseMailAction(action, attrs) {
  const screen = mailScreen, path = mailPath(screen.id);
  const base = path + '/messages/' + encodeURIComponent(attrs.id ?? '');
  if (action === 'course-mail-file') return downloadCourseFile(base + '/files/' + attrs.index);
  if (action === 'course-mail-ustc') {
    const form = document.querySelector('#course-mail-settings');
    for (const name of ['imapHost','imapPort','smtpHost','smtpPort','smtpMode']) form.elements[name].value = ustcMail[name];
    state.dirty = true;
    return;
  }
  if (state.dirty) { toast('请先保存当前表单'); return; }
  if (action === 'course-mail-open') screen.open = await api('GET', base);
  if (action === 'course-mail-reprocess') {
    const result = await api('POST', base + '/reprocess');
    toast(result.queued ? '已排队重新匹配，稍后刷新邮件' : '当前版本已匹配或正在处理');
  }
  if (action === 'course-mail-register-grade') {
    const entry = screen.open;
    if (entry?.id !== attrs.id || !entry.gradeFingerprint || !window.confirm('将当前批改草稿的分数登记到该学生的这次提交？')) return;
    screen.open = await api('POST', base + '/register-grade', { fingerprint: entry.gradeFingerprint });
    toast('课程成绩已登记');
  }
  if (action === 'course-mail-grade') {
    screen.open = await api('POST', base + '/grade');
    toast('批改任务已提交');
  }
  if (action === 'course-mail-check') { await api('POST', path + '/check'); toast('IMAP 和 SMTP 登录成功，未发送邮件'); }
  if (action === 'course-mail-sync') { Object.assign(screen, await api('POST', path + '/sync')); toast('收件完成'); }
  if (action === 'course-mail-ignore') {
    Object.assign(screen, await api('POST', base + '/review', { ignore: true }));
    screen.open = undefined;
  }
  if (activeMail(screen)) render();
}
