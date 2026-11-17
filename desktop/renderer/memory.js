async function loadMemories() {
  const courseId = state.courseId, profile = state.profile;
  const [cards, jobs] = courseId ? await Promise.all([
    api('GET', '/v1/courses/' + encodeURIComponent(courseId) + '/memories'),
    api('GET', '/v1/courses/' + encodeURIComponent(courseId) + '/memory-jobs'),
  ]) : [[], []];
  if (state.profile !== profile || state.courseId !== courseId || !state.connected) return;
  state.memories = cards; state.memoryJobs = jobs;
  state.memoryDetail = null;
}
function memoryPage() {
  const labels = { active: '有效', retired: '已停用', invalidated: '来源已修订' };
  const evidence = { 'student-report': '学生发言摘要', observed: '表现观察', 'teacher-confirmed': '教师确认' };
  const filter = state.memoryFilter.trim().toLowerCase();
  const cards = state.memories.filter(c => [c.subjectId, c.observation, ...c.topics].join(' ').toLowerCase().includes(filter));
  const detail = state.memoryDetail;
  const list = cards.length ? '<div class="task-list section-gap">' + cards.map(c =>
    '<section class="card task-row"><div class="row"><strong class="spacer">' + escape(c.subjectId) + '</strong>' +
    pill(labels[c.status] || c.status, c.status === 'active' ? '' : 'orange') +
    '<button class="button secondary small" data-action="memory-open" data-id="' + escape(c.id) + '">查看与纠正</button></div>' +
    '<p class="section-gap">' + escape(c.observation) + '</p><p class="help section-gap">' +
    escape(c.topics.join(' · ')) + ' · ' + escape(evidence[c.evidenceType] || c.evidenceType) + ' · ' + fmt(c.occurredAt) + '</p></section>'
  ).join('') + '</div>' : empty('尚无匹配的学习记忆', '完成答疑后，系统根据学生原文提取学习经历；没有充分证据时可以不生成记忆。');
  const editor = detail ? '<section class="card section-gap"><div class="row"><h2 class="spacer">记忆依据与修订</h2><button class="button secondary small" data-action="memory-close">关闭</button></div><p class="help section-gap">' + escape(detail.card.subjectId) + ' · 版本 ' + detail.card.revision + '</p>' +
    '<form id="memory-form" class="stack section-gap"><label>学习观察<textarea name="observation" maxlength="1600" required>' + escape(detail.card.observation) + '</textarea></label><label>后续表现<textarea name="outcome" maxlength="1200">' + escape(detail.card.outcome) + '</textarea></label><label>知识点（每行一个）<textarea name="topics">' + escape(detail.card.topics.join('\n')) + '</textarea></label><div class="row"><button class="button" ' + (detail.valid ? '' : 'disabled') + '>保存并标为教师确认</button><button type="button" class="button secondary" data-action="memory-retire" ' + (detail.card.status === 'retired' ? 'disabled' : '') + '>停用这条记忆</button></div></form>' +
    '<h3 class="section-gap">原始依据</h3>' + detail.sources.map(s => '<details class="section-gap"><summary>' + escape(s.event?.actor.id || '') + ' · ' + fmt(s.event?.receivedAt) + ' · 消息 ' + escape(s.eventId) + '</summary><pre class="memory-source">' + escape(s.event?.text || s.quote) + '</pre></details>').join('') + '</section>' : '';
  const failed = state.memoryJobs.filter(j => j.status === 'failed');
  const jobs = failed.length ? '<section class="card section-gap"><h2>待处理的记忆提取</h2>' + failed.map(j => '<div class="row section-gap"><p class="spacer help">' + escape(j.error || '提取失败') + '</p><button class="button secondary small" data-action="memory-retry" data-id="' + escape(j.id) + '">重试</button></div>').join('') + '</section>' : '';
  return pageHead('学习记忆', '按课程与真实消息作者归档，可追溯、纠正和停用。展示最近200条记录。', '<button class="button secondary" data-action="refresh">刷新</button>') +
    '<div class="note">学习经历用于调整教学解释。正式成绩与提交情况以业务记录为准。来源发生线程纠正后，相关记忆会失效。</div>' +
    '<label class="section-gap">筛选学生或知识点<input id="memory-filter" value="' + escape(state.memoryFilter) + '" placeholder="输入QQ用户标识、概念或关键词"></label>' + editor + list + jobs;
}
document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]'); if (!button) return;
  const action = button.dataset.action;
  if (!action.startsWith('memory-')) return;
  try {
    if (action !== 'memory-retry' && !canLeave()) return;
    if (action === 'memory-open') {
      const profile = state.profile, courseId = state.courseId;
      const detail = await api('GET', '/v1/memories/' + encodeURIComponent(button.dataset.id));
      if (state.profile !== profile || state.courseId !== courseId || state.page !== 'memory' || !state.connected) return;
      state.memoryDetail = detail; state.dirty = false; render();
    }
    if (action === 'memory-close') { state.memoryDetail = null; state.dirty = false; render(); }
    if (action === 'memory-retire') {
      const card = state.memoryDetail.card;
      if (!window.confirm('停用这条记忆？原始依据和修订记录会保留。')) return;
      await api('POST', '/v1/memories/' + encodeURIComponent(card.id) + '/retire', { revision: card.revision });
      state.dirty = false; await loadMemories(); render(); toast('记忆已停用');
    }
    if (action === 'memory-retry') {
      await api('POST', '/v1/memory-jobs/' + encodeURIComponent(button.dataset.id) + '/retry', {});
      toast('已加入记忆提取队列');
      if (!state.dirty) { await loadMemories(); render(); }
    }
  } catch (error) { toast(error.message, true); }
});
document.addEventListener('submit', async event => {
  const form = event.target; if (form.id !== 'memory-form') return;
  event.preventDefault(); if (!form.reportValidity()) return;
  const card = state.memoryDetail.card, data = Object.fromEntries(new FormData(form));
  form.classList.add('busy');
  try {
    await api('PUT', '/v1/memories/' + encodeURIComponent(card.id), {
      revision: card.revision, observation: data.observation, outcome: data.outcome,
      topics: data.topics.split(/\r?\n/).map(t => t.trim()).filter(Boolean),
    });
    state.dirty = false; await loadMemories(); render(); toast('记忆已修订');
  } catch (error) { toast(error.message, true); }
  finally { form.classList.remove('busy'); }
});
document.addEventListener('input', event => {
  if (event.target.id !== 'memory-filter') return;
  if (state.dirty) return;
  const position = event.target.selectionStart;
  state.memoryFilter = event.target.value; render();
  const input = $('#memory-filter'); input.focus(); input.setSelectionRange(position, position);
});
