let coursework;
const courseworkPath = id => `/v1/courses/${encodeURIComponent(id)}/coursework`;
async function loadCoursework() {
  if (!state.courseId) return;
  const screen = coursework = { courseId: state.courseId };
  try { Object.assign(screen, await api('GET', courseworkPath(screen.courseId))); }
  catch (error) { screen.error = error.message; }
}
async function downloadCourseFile(path, name) {
  const file = await api('GET', path);
  const bytes = Uint8Array.from(atob(file.data), c => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = name || file.name;
    link.click();
  } finally { setTimeout(() => URL.revokeObjectURL(url), 3000); }
}
function courseworkPage() {
  const head = pageHead('提交与延期', '核对 QQ 提交与个别延期申请，查看作业登记。', '<button class="button secondary" data-action="refresh">刷新</button>');
  if (coursework?.courseId !== state.courseId || (!coursework?.requests && !coursework?.error)) return head + '<p class="muted">正在读取…</p>';
  if (coursework.error) return head + `<p class="connection-error">${escape(coursework.error)}</p>`;
  const title = id => state.assignments.find(a => a.id === id)?.title ?? id;
  const cards = coursework.requests.map(row => `<section class="card">
    <div class="card-title"><h2>${escape(title(row.assignmentId))} · ${row.kind === 'extension' ? '延期' : row.source === 'mail' ? '邮件提交' : 'QQ 提交'}</h2>${pill(({pending:'待核对',accepted:'已登记',declined:'已拒绝'})[row.state])}</div>
    <p>${escape(row.name)}${row.source === 'mail' ? '' : ' · QQ ' + escape(row.actor.replace(/^qq:/, ''))} · ${escape(fmt(row.receivedAt))}${row.attempt ? ' · 第 ' + row.attempt + ' 次提交' : ''}${row.late ? ' · 迟交' : ''}</p>
    ${row.graded ? `<p>登记成绩 ${escape(row.graded.total)} / ${escape(row.graded.maximum)}</p>` : ''}
    ${row.deadline ? `<p class="muted">申请截止 ${escape(fmt(row.deadline))} · ${escape(row.reason)}</p>` : ''}
    ${row.decisionNote ? `<p class="muted">${escape(row.decisionNote)}</p>` : ''}
    <div class="row section-gap">${(row.files ?? []).map(file => `<button class="button secondary small" data-action="coursework-file" data-id="${escape(row.id)}" data-index="${file.index}">${escape(file.name)}</button>`).join('')}
    ${row.state === 'pending' ? `<button class="button small" data-action="coursework-review" data-id="${escape(row.id)}" data-accept="true">批准</button><button class="button secondary small" data-action="coursework-review" data-id="${escape(row.id)}" data-accept="false">拒绝</button>` : ''}</div>
  </section>`).join('');
  return head + `<div class="task-list">${cards || empty('暂无 QQ 提交或延期申请', '学生可在课程助教私聊发送 /assignments 查看作业 ID。')}</div>
    <section class="card section-gap"><h2>线下登记</h2><p class="muted">${coursework.offline.length} 条记录</p>
    ${coursework.offline.map(row => `<p class="muted">${escape(title(row.assignmentId))} · ${escape(row.studentName)} · ${escape(row.score ?? '未评分')}</p>`).join('')}</section>`;
}
async function courseworkAction(action, attrs) {
  const base = courseworkPath(state.courseId) + '/' + encodeURIComponent(attrs.id);
  if (action === 'coursework-file') { await downloadCourseFile(base + '/files/' + attrs.index); return; }
  const row = coursework.requests.find(item => item.id === attrs.id);
  const accept = attrs.accept === 'true';
  const name = row?.name;
  if (!row || !window.confirm(`${accept ? '批准并核对 QQ 身份' : '拒绝'}「${name}」的申请？`)) return;
  await api('POST', base + '/review', { revision: row.revision, accept });
  await loadCoursework();
  render();
  toast('已处理，并将通过 QQ 通知学生');
}
