let scheduleEditor;
const scheduleTools = {
  class_context: '查看近期课程、作业和群聊', list_assignments: '列出课程作业',
  read_assignment: '查看作业题目', lookup_textbook: '按章节与题号查教材',
  search_textbook: '按主题检索教材', textbook_section: '按节号查教材范围', view_textbook_page: '查看教材原页', prepare_lesson: '生成习题课讲义',
  read_messages: '读课程群消息', read_attachment: '读附件', ask_teacher: '私信课程教师', send_group_file: '发送课程群文件',
};
const scheduleRoute = id => `/v1/courses/${encodeURIComponent(id)}/schedules`;
async function loadSchedules() {
  if (!state.courseId) return;
  const editor = scheduleEditor = { courseId: state.courseId, loading: true };
  try { Object.assign(editor, await api('GET', scheduleRoute(editor.courseId))); }
  catch (error) { editor.error = error.message; }
  finally { editor.loading = false; }
}
function schedulesPage() {
  const editor = scheduleEditor;
  const heading = pageHead('定时任务', '按北京时间每周运行。执行过程与结果可在「运行任务」和「后台活动」查看。',
    '<button class="button secondary" data-action="reload-schedules">刷新</button>');
  if (!editor || editor.loading || editor.courseId !== state.courseId) return heading + '<p class="muted">正在读取定时任务…</p>';
  if (editor.error) return heading + `<p class="connection-error" role="alert">${escape(editor.error)}</p>`;
  const cards = editor.tasks.map((task, i) => `<section class="card schedule-card" data-schedule-id="${escape(task.id)}">
    <div class="card-title"><h2>定时任务 ${i + 1}</h2><div class="row"><button type="button" class="button secondary small" data-action="run-schedule" data-id="${escape(task.id)}">立即运行</button><button type="button" class="button ghost small" data-action="remove-schedule" data-id="${escape(task.id)}">删除</button></div></div>
    <div class="grid2">
      <label>任务名称<input name="title" value="${escape(task.title)}" required maxlength="100"></label>
      <label class="schedule-checkbox"><input type="checkbox" name="enabled" ${task.enabled ? 'checked' : ''}>启用</label>
      <label>星期<select name="weekday">${['日','一','二','三','四','五','六'].map((day, n) => `<option value="${n}" ${task.weekday === n ? 'selected' : ''}>周${day}</option>`).join('')}</select></label>
      <label>时间<input name="time" type="time" value="${escape(task.time)}" required></label>
      <label>执行方式<select name="worker"><option value="native">原有 Worker</option><option value="dsh" ${task.worker === 'dsh' ? 'selected' : ''} ${editor.dshAvailable ? '' : 'disabled'}>DSH headless</option></select></label>
      <label class="field-wide">进度过期时询问的教师 QQ（可选）<input name="teacherQQ" inputmode="numeric" pattern="[0-9]*" value="${escape(task.teacherQQ)}"></label>
      <label class="field-wide">任务提示词<textarea name="prompt" rows="5" maxlength="8000" required>${escape(task.prompt)}</textarea></label>
    </div>
    <fieldset class="schedule-tools"><legend>允许使用的工具</legend>${editor.availableTools.filter(name => editor.dshAvailable || !editor.dshOnlyTools?.includes(name)).map(name => `<label class="schedule-checkbox"><input type="checkbox" name="tools" value="${escape(name)}" ${task.tools.includes(name) ? 'checked' : ''}>${escape(scheduleTools[name] || name)}${editor.dshOnlyTools?.includes(name) ? '（DSH）' : ''}</label>`).join('')}</fieldset>
  </section>`).join('');
  return heading + `<form id="schedules-form" class="schedules-form">
    ${cards || empty('暂无定时任务', '可以添加习题课备课、实验文档准备等周期任务。')}
    <div class="form-footer"><button type="button" class="button secondary spacer" data-action="add-schedule">${icon('plus')}增加任务</button><button class="button" type="submit">保存任务</button></div>
  </form>`;
}
function captureScheduleEdits() {
  scheduleEditor.tasks = [...document.querySelectorAll('[data-schedule-id]')].map(section => {
    const read = name => section.querySelector(`[name="${name}"]`);
    return { id: section.dataset.scheduleId, title: read('title').value, enabled: read('enabled').checked,
      weekday: Number(read('weekday').value), time: read('time').value, teacherQQ: read('teacherQQ').value, worker: read('worker').value,
      prompt: read('prompt').value, tools: [...section.querySelectorAll('[name="tools"]:checked')].map(input => input.value) };
  });
}
async function saveSchedules() {
  captureScheduleEdits();
  const editor = scheduleEditor;
  const saved = await api('PUT', scheduleRoute(editor.courseId), { revision: editor.revision, tasks: editor.tasks });
  if (state.page !== 'schedules' || editor !== scheduleEditor || state.courseId !== editor.courseId) return;
  Object.assign(editor, saved);
  course().revision = saved.revision;
  state.dirty = false;
  render();
  toast('已保存定时任务');
}
async function handleScheduleAction(action, id) {
  if (action === 'run-schedule') {
    if (state.dirty) throw new Error('请先保存定时任务配置');
    const task = scheduleEditor.tasks.find(item => item.id === id);
    if (!task || !window.confirm(`立即运行「${task.title}」并使用其已保存的工具权限？`)) return;
    await api('POST', scheduleRoute(scheduleEditor.courseId) + '/' + encodeURIComponent(id) + '/run');
    toast('任务已进入 Router');
    return;
  }
  if (action === 'reload-schedules') {
    if (!canLeave()) return;
    state.dirty = false;
    const pending = loadSchedules();
    render();
    await pending;
    if (state.page === 'schedules') render();
    return;
  }
  captureScheduleEdits();
  if (action === 'add-schedule') {
    if (scheduleEditor.tasks.length >= 24) throw new Error('每门课最多配置 24 个定时任务');
    scheduleEditor.tasks.push({ id: crypto.randomUUID(), title: '', enabled: true, weekday: 5, time: '19:00', prompt: '', tools: [] });
  } else scheduleEditor.tasks = scheduleEditor.tasks.filter(task => task.id !== id);
  state.dirty = true;
  render();
}
