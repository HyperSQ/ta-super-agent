const activityNodes = {
  intake: ['消息入口', 'QQ · 工作台 · DSH · 邮箱'],
  router: ['Router', '解析请求 · 路由和控制'],
  worker: ['Worker', '答疑 · 教学事务 · 作业处理 · 教学材料'],
  tools: ['课程工具', '作业 · 教材 · 引用'],
  memory: ['记忆 Worker', '异步整理学习记忆'],
  outbox: ['交付队列', 'QQ 发送 · 外部回执'],
};
let activityView = {};
const activityPath = () => `/v1/courses/${encodeURIComponent(state.courseId)}/activities`;
function activitiesPage() {
  const view = activityView.course === state.courseId ? activityView : {};
  const selected = view.node;
  const graph = ['intake', 'router', 'worker', 'outbox'].map(node => nodeButton(node, selected, view)).join('<span class="activity-arrow" aria-hidden="true">→</span>');
  const entries = (view.entries || []).filter(entry => !selected || entry.node === selected);
  if (view.event) entries.reverse();
  return pageHead('后台活动', '从消息入口追踪到 Router、Worker、工具和交付。', '<button class="button secondary" data-activity="refresh">刷新</button>') +
    `<section class="card activity-graph" aria-label="服务拓扑"><div class="activity-flow">${graph}</div>
      <div class="activity-branches"><span>入口 ⇢ Worker · 已订阅的后续消息</span><div>${nodeButton('memory', selected, view)}${nodeButton('tools', selected, view)}</div></div></section>
    <section class="card activity-timeline"><div class="card-title"><h2>${selected ? activityNodes[selected][0] : '活动时间线'}</h2><div class="row">
      ${view.event ? '<button class="button secondary small" data-activity="all">返回全部事件</button>' : ''}
      ${selected ? '<button class="button secondary small" data-activity="nodes">全部节点</button>' : ''}</div></div>
      ${view.event ? `<div class="muted activity-event">事件 ${escape(view.event)}</div>` : ''}
      ${view.error ? `<p role="alert">${escape(view.error)}</p>` : ''}
      ${view.busy && !entries.length ? '<p class="muted">正在读取活动…</p>' : ''}
      ${entries.map(entry => `<div class="activity-entry"><details data-activity-seq="${entry.seq}"><summary><time>${escape(new Date(entry.at).toLocaleString('zh-CN'))}</time><span class="activity-badge">${escape(activityNodes[entry.node]?.[0] || entry.node)}</span><strong>${escape(entry.label)}</strong><code>${escape(entry.kind)}</code></summary><div class="activity-payload muted">正在读取详情…</div></details>${view.event ? '' : `<button class="button ghost small" data-activity="event" data-event="${escape(entry.eventId)}">看完整通路</button>`}</div>`).join('')}
      ${!entries.length && !view.busy && !view.error ? '<p class="muted">这里还没有记录。新版本上线后产生的活动会出现在这里。</p>' : ''}
      ${view.next ? '<button class="button secondary small" data-activity="more">加载更早的活动</button>' : ''}</section>`;
}
function nodeButton(node, selected, view) {
  const [title, description] = activityNodes[node];
  const hits = (view.entries || []).filter(entry => entry.node === node).length;
  return `<button class="activity-node" data-activity="node" data-node="${node}" aria-pressed="${selected === node}"><strong>${title}</strong><span>${description}</span><small>${hits} 条已加载</small></button>`;
}
async function openActivities({ event, append = false, node } = {}) {
  if (!state.courseId || state.page !== 'activities') return;
  const previous = activityView;
  const view = activityView = { course: state.courseId, node, event, entries: append ? previous.entries : [], busy: true };
  render();
  try {
    const params = new URLSearchParams();
    if (event) params.set('event', event);
    if (append && previous.next) params.set('before', previous.next);
    const page = state.profile.demo ? { entries: [] } : await api('GET', activityPath() + (params.size ? '?' + params : ''));
    view.entries = [...view.entries, ...page.entries];
    view.next = page.next;
  } catch (error) { view.error = error.message; }
  finally {
    view.busy = false;
    if (activityView === view && state.page === 'activities' && view.course === state.courseId) render();
  }
}
document.addEventListener('click', event => {
  const button = event.target.closest('[data-activity]');
  if (!button) return;
  const { activity: action, node, event: eventId } = button.dataset;
  if (action === 'node' || action === 'nodes') { activityView.node = node; render(); return; }
  if (action === 'event') { void openActivities({ event: eventId }); return; }
  const view = activityView;
  if (action === 'all') { void openActivities(); return; }
  if (!view.busy) void openActivities({ event: view.event, node: view.node, append: action === 'more' });
});
document.addEventListener('toggle', async event => {
  const detail = event.target;
  if (!detail.matches?.('details[data-activity-seq]') || !detail.open || detail.dataset.loading) return;
  detail.dataset.loading = 'true';
  const box = detail.querySelector('.activity-payload');
  try {
    const entry = await api('GET', `${activityPath()}/${detail.dataset.activitySeq}`);
    const meta = document.createElement('div');
    meta.textContent = [`事件 ${entry.eventId}`, entry.taskId && `任务 ${entry.taskId}`, entry.runId && `执行 ${entry.runId}`].filter(Boolean).join(' · ');
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(entry.payload, null, 2);
    box.replaceChildren(meta, pre);
  } catch (error) { box.textContent = error.message; delete detail.dataset.loading; }
}, true);
