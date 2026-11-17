let extensionView;
const extensionRoute = id => `/v1/assignments/${encodeURIComponent(id)}/extensions`;
const extensionDate = value => new Date(value).toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
async function openExtensions(button) {
  const assignment = state.assignments.find(item => item.id === button.dataset.id);
  if (!assignment) return;
  const profile = state.profile;
  const data = await api('GET', extensionRoute(assignment.id));
  if (!button.isConnected || state.courseId !== assignment.courseId || profile !== state.profile) return;
  extensionView = { assignment, data, name: '' };
  state.page = 'extensions';
  state.dirty = false;
  render();
}

function extensionsPage() {
  const { assignment, data, name } = extensionView;
  const selected = data.students.find(student => student.studentName === name);
  const saved = data.students.filter(student => student.deadline);
  const back = '<button class="button secondary" data-action="page" data-page="assignments">返回作业管理</button>';
  return pageHead('个别学生延期', escape(assignment.title), back) + `
    <div class="form-columns">
      <section class="card">
        <div class="card-title"><h2>个人截止时间</h2>${pill('已有延期 ' + saved.length + ' 人')}</div>
        <p class="muted">全班截止时间 ${escape(extensionDate(data.deadline))}</p>
        ${saved.map(student => `<div class="assignment-item"><div class="spacer"><h3>${escape(student.studentName)}</h3>
          <small>实际截止 ${escape(extensionDate(student.effectiveDeadline))}${student.effectiveDeadline === data.deadline ? '（全班截止时间更晚）' : ''}</small></div>
          <button type="button" class="button ghost small" data-extension-student="${escape(student.studentName)}">查看或修改</button></div>`).join('')
          || '<p class="muted section-gap">目前没有学生设置延期。</p>'}
      </section>
      <section class="card">
        <h2>设置延期</h2>
        <label class="section-gap">学生<select id="extension-student"><option value="">请选择学生</option>
          ${data.students.map(student => `<option value="${escape(student.studentName)}" ${student.studentName === name ? 'selected' : ''}>${escape(student.studentName)}</option>`).join('')}</select></label>
        ${data.students.length ? '' : '<p class="muted">请先在课程设置中添加学生名单。</p>'}
        ${selected ? `<form id="extension-form" class="assignment-editor section-gap">
          <label>延期截止时间<input type="datetime-local" name="deadline" ${selected.deadline ? `value="${localTime(selected.deadline)}"` : ''} required></label>
          <label>备注（仅工作台可见）<textarea name="reason" maxlength="500" rows="3">${escape(selected.reason)}</textarea></label>
          <div class="row"><button class="button" type="submit">保存延期</button>
          ${selected.deadline ? '<button class="button danger" type="button" id="extension-revoke">撤销延期</button>' : ''}</div>
          <p class="muted">仅调整此学生的截止时间，操作不会发送 QQ 通知。</p>
        </form>` : ''}
      </section>
    </div>`;
}

function selectExtensionStudent(name) {
  if (!canLeave()) return false;
  extensionView.name = name;
  state.dirty = false;
  render();
  return true;
}
async function saveExtension(form, revoke = false) {
  const view = extensionView;
  const student = view.data.students.find(item => item.studentName === view.name);
  if (!student || form.dataset.saving) return;
  if (revoke && !window.confirm(`撤销 ${student.studentName} 的延期，恢复按全班截止时间？`)) return;
  form.dataset.saving = 'true';
  const buttons = [...form.querySelectorAll('button')];
  buttons.forEach(button => { button.disabled = true; });
  try {
    const data = await api('PUT', extensionRoute(view.assignment.id) + '/' + encodeURIComponent(student.studentName), {
      deadline: revoke ? null : new Date(form.elements.deadline.value).toISOString(),
      reason: revoke ? '' : form.elements.reason.value,
      revision: student.revision,
      assignmentRevision: view.data.assignmentRevision,
    });
    if (!form.isConnected || extensionView !== view) return;
    view.data = data;
    state.dirty = false;
    render();
    toast(revoke ? '已撤销延期' : '已保存延期');
  } catch (error) {
    toast(error.status === 409 ? error.message + '。请返回作业列表后重新打开。' : error.message, true);
  } finally {
    delete form.dataset.saving;
    buttons.forEach(button => { button.disabled = false; });
  }
}

document.addEventListener('change', event => {
  if (event.target.id === 'extension-student' && !selectExtensionStudent(event.target.value)) event.target.value = extensionView.name;
});
document.addEventListener('click', event => {
  const student = event.target.closest('[data-extension-student]');
  if (student) selectExtensionStudent(student.dataset.extensionStudent);
  if (event.target.closest('#extension-revoke')) void saveExtension(document.querySelector('#extension-form'), true);
});
document.addEventListener('submit', event => {
  if (event.target.id !== 'extension-form') return;
  event.preventDefault();
  void saveExtension(event.target);
});
