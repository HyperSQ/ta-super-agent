let conversationView;
const conversationPath = id => '/v1/courses/' + encodeURIComponent(id) + '/conversation';
function conversationActive(view) {
  return state.connected && state.page === 'conversation' && state.courseId === view.course && conversationView === view;
}
async function loadConversation() {
  if (!state.courseId) return;
  const view = conversationView = { course: state.courseId, turns: [] };
  if (state.profile.demo) return;
  try { Object.assign(view, await api('GET', conversationPath(view.course))); }
  catch (error) { view.error = error.message; }
}
function conversationPage() {
  const view = conversationView;
  const head = pageHead('课程助教', '查看并继续本课程的教师对话。', '<button class="button secondary" data-action="refresh">刷新对话</button>');
  if (state.profile.demo) return head + '<p class="muted">连接助教服务器后可使用。</p>';
  if (view?.course !== state.courseId) return head + '<p class="muted">正在读取对话…</p>';
  if (view.error) return head + '<p class="connection-error" role="alert">' + escape(view.error) + '</p>';
  const names = { qq: 'QQ', dsh: 'DSH', workbench: '工作台' };
  const turns = view.turns.map(turn => `<article class="conversation-turn">
    <div class="conversation-message"><small>教师 · ${escape(names[turn.surface])} · ${escape(fmt(turn.at))}</small><p>${escape(turn.text)}</p></div>
    <div class="conversation-reply"><small>课程助教</small><p>${escape(turn.reply || turn.error || (turn.pending ? '处理中…' : '已处理'))}</p>
    ${turn.task ? `<button class="button ghost small" data-action="page" data-page="tasks">查看任务列表</button> ${pill(({queued:'等待执行',running:'执行中',paused:'已暂停',waiting_teacher:'等待教师',completed:'已完成',blocked:'待处理',cancelled:'已取消'})[turn.task.status] ?? turn.task.status)}` : ''}
    </div></article>`).join('');
  return head + `<section class="card conversation-panel">
    <div class="conversation-list" aria-label="教师对话">${turns || '<p class="muted">还没有消息。</p>'}</div>
    <form id="conversation-form" class="conversation-compose">
      ${view.sharesQQ === false ? '<p class="muted">本课还未确定唯一关联的教师 QQ，DSH 和工作台可继续共享管理端对话。</p>' : ''}
      <label>发送给课程助教<textarea name="message" rows="3" maxlength="6000" required placeholder="例如，把刚才那份讲义缩到两页"></textarea></label>
      <button class="button" type="submit">发送</button>
    </form></section>`;
}
async function sendConversation(form, message) {
  const view = conversationView;
  if (!conversationActive(view) || !message.trim() || form.elements.namedItem('message').disabled) return;
  const input = form.elements.namedItem('message'), button = form.querySelector('button');
  input.disabled = button.disabled = true;
  const old = view.retry;
  const request = old?.message === message ? old : { message, requestId: crypto.randomUUID() };
  view.retry = request;
  try {
    const turn = await api('POST', conversationPath(view.course), request);
    view.retry = undefined;
    if (!conversationActive(view)) return;
    view.turns = [...view.turns.filter(item => item.eventId !== turn.eventId), turn].slice(-30);
    state.dirty = false;
    render();
    document.querySelector('.conversation-turn:last-child')?.scrollIntoView({ block: 'nearest' });
    if (turn.pending) void refreshConversationTurn(view, turn.eventId);
  } finally { input.disabled = button.disabled = false; }
}
async function refreshConversationTurn(view, id) {
  for (let attempt = 0; attempt < 15; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    if (!conversationActive(view)) return;
    try {
      const turn = await api('GET', conversationPath(view.course) + '/' + encodeURIComponent(id));
      if (turn.pending && !turn.reply) continue;
      if (!conversationActive(view)) return;
      view.turns = view.turns.map(item => item.eventId === id ? turn : item);
      if (!state.dirty) {
        render();
        document.querySelector('.conversation-turn:last-child')?.scrollIntoView({ block: 'nearest' });
      }
      return;
    } catch { return; }
  }
}
