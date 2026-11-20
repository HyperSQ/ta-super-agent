const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const paths = {
  cap: '<path d="m2 8 10-5 10 5-10 5L2 8Z"/><path d="M6 10v6c3 3 9 3 12 0v-6M22 8v7"/>',
  home: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  book: '<path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Zm0 0v15"/>',
  file: '<path d="M14 2H5v20h14V7l-5-5Zm0 0v6h5M8 12h8M8 16h6"/>',
  check: '<path d="m6 12 4 4 8-9"/><rect x="3" y="3" width="18" height="18" rx="4"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  server: '<rect x="3" y="3" width="18" height="7" rx="2"/><rect x="3" y="14" width="18" height="7" rx="2"/><path d="M7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6"/>',
  shield: '<path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6l9-4Z"/><path d="m8 11 3 3 5-6"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14-5L3 9m0-6v6h6m-5 4a8 8 0 0 0 14 5l3-3m0 6v-6h-6"/>',
  people: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m2-16a3 3 0 0 1 0 6m2 10v-3a6 6 0 0 0-3-5"/>',
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.file}</svg>`;
const brand = () => `<div class="brand"><span class="brand-mark">${icon('cap')}</span><div><strong>助教工作台</strong><small>Teaching workspace</small></div></div>`;
const state = { connected: false, profile: {}, page: 'overview', courses: [], courseId: '', assignments: [], assignmentId: '', records: [], tasks: [], search: '', dirty: false, newCourse: false };
state.qq = { status: null, image: null, error: '', busy: false };
state.memories = []; state.memoryJobs = []; state.memoryDetail = null; state.memoryFilter = '';
state.assignmentDetail = null;
state.scoreDrafts = new Map();
state.inbox = { items: [], counts: { total: 0 } };
let toastTimer;
function toast(message, error = false) { const box = $('#toast'); box.textContent = message; box.className = `visible${error ? ' error' : ''}`; clearTimeout(toastTimer); toastTimer = setTimeout(() => box.className = '', 4500); }
async function unwrap(promise) { const result = await promise; if (!result.ok) { const error = new Error(result.error || '操作失败'); error.status = result.status; throw error; } return result.data; }
const api = (method, route, body) => unwrap(window.ta.request(method, route, body));
const course = () => state.courses.find(c => c.id === state.courseId);
const assignment = () => state.assignments.find(a => a.id === state.assignmentId);
const fmt = value => value ? new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '—';
function localTime(value = new Date()) { const d = new Date(value); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
const pill = (text, color = '') => `<span class="pill ${color}">${escape(text)}</span>`;
const empty = (title, detail, action = '') => `<div class="empty">${icon('book')}<h3>${escape(title)}</h3><p class="muted">${escape(detail)}</p>${action}</div>`;
function canLeave() { return !state.dirty || window.confirm('尚有未保存的修改，确定离开？'); }
async function refresh() {
  state.courses = await api('GET', '/v1/courses');
  if (!state.courses.some(c => c.id === state.courseId)) state.courseId = state.courses[0]?.id || '';
  state.assignments = state.courseId ? await api('GET', `/v1/courses/${encodeURIComponent(state.courseId)}/assignments`) : [];
  if (!state.assignments.some(a => a.id === state.assignmentId)) state.assignmentId = state.assignments.at(-1)?.id || '';
  state.records = state.assignmentId ? await api('GET', `/v1/assignments/${encodeURIComponent(state.assignmentId)}/offline`) : [];
  state.tasks = await api('GET', '/v1/tasks');
  if (state.page === 'memory') await loadMemories();
  if (state.page === 'schedules') await loadSchedules();
  if (state.page === 'coursework') await loadCoursework();
  if (state.page === 'course-mail') await loadCourseMail();
  if (state.page === 'conversation') await loadConversation();
  if (state.page === 'inbox') await loadInbox();
}
function connection(error = '') {
  const p = state.profile;
  $('#app').innerHTML = `<main class="connection-view"><section class="connection-intro">${brand()}<div class="connection-story"><div class="eyebrow">A little less busy. A lot more teaching.</div><h1>让教学更专注，<br>让事务有条理。</h1><p>课程安排、作业记录与助教任务，<br>在一个清晰的工作空间里持续推进。</p><div class="connection-features"><div class="row">${icon('book')}集中维护课程与教学进度</div><div class="row">${icon('check')}轻松登记线下作业</div><div class="row">${icon('shield')}通过 SSH 私密连接服务器</div></div></div><div class="intro-footer">TA SUPER AGENT · 教师桌面工作空间</div></section><section class="connection-form-wrap"><form id="connect-form" class="connection-form"><h2>连接你的工作台</h2><p class="muted">内核在服务器持续运行，关掉桌面端也不会中断。</p><div class="stack"><label>服务器 IP<input name="host" value="${escape(p.host)}" placeholder="例如 192.168.1.100" required autocomplete="off"></label><div class="grid2"><label>SSH 用户名<input name="username" value="${escape(p.username || 'root')}" required autocomplete="username"></label><label>SSH 端口<input name="port" type="number" min="1" max="65535" value="${escape(p.port || 22)}" required></label></div><label>SSH 密码<input name="password" type="password" placeholder="输入服务器登录密码" required autocomplete="off"></label></div><details><summary>高级连接设置</summary><div class="stack"><label>服务器内核目录<input name="remoteDir" value="${escape(p.remoteDir || '/opt/ta-super-agent')}"></label><label>内核端口<input name="apiPort" type="number" min="1" max="65535" value="${escape(p.apiPort || 8787)}"></label></div></details>${error ? `<p class="connection-error" role="alert">${escape(error)}</p>` : ''}<button class="button" type="submit">连接工作台 ${icon('arrow')}</button><p class="help">密码仅用于本次连接，不保存在本机。</p><button class="demo-link" type="button" data-action="demo">暂不连接，体验演示工作台 →</button></form></section></main>`;
  $('#connect-form details .stack').insertAdjacentHTML('beforeend', `<label>专属LLBot端口（连接后读取）<input name="llbotPort" type="number" value="${escape(p.llbotInstance === 'ta-llbot' ? p.llbotPort : 13080)}" readonly></label><label>专属LLBot数据目录（连接后读取）<input name="llbotDataDir" value="${escape(p.llbotInstance === 'ta-llbot' ? p.llbotDataDir : '/var/lib/ta-llbot/data')}" readonly></label><p class="help">内核端口与专属LLBot实例以服务器独立配置为准。</p>`);
}
const navItems = [['overview', 'home', '总览'], ['course', 'book', '课程设置'], ['assignments', 'file', '作业管理'], ['offline', 'check', '线下登记'], ['tasks', 'activity', '运行任务']];
navItems.splice(1, 0, ['inbox', 'check', '待办']);
navItems.push(['qq', 'shield', 'LLBot 登录']);
navItems.splice(5, 0, ['memory', 'people', '学习记忆']);
navItems.splice(5, 0, ['activities', 'activity', '后台活动']);
navItems.splice(4, 0, ['schedules', 'activity', '定时任务']);
navItems.splice(4, 0, ['coursework', 'check', '提交与延期']);
navItems.splice(5, 0, ['course-mail', 'check', '作业邮箱']);
navItems.splice(1, 0, ['conversation', 'people', '课程助教']);
function render() {
  if (!state.connected) return connection();
  const current = course(), pageLabel = state.page === 'extensions' ? '个别学生延期' : navItems.find(n => n[0] === state.page)?.[2];
  $('#app').innerHTML = `<div class="app-shell"><aside class="sidebar">${brand()}<div class="course-select-label">当前课程 / COURSE</div><select id="course-select" aria-label="当前课程">${state.courses.length ? state.courses.map(c => `<option value="${escape(c.id)}" ${c.id === state.courseId ? 'selected' : ''}>${escape(c.title)}</option>`).join('') : '<option>尚未创建课程</option>'}</select><nav class="nav">${navItems.map(([id, i, label]) => `<button data-action="page" data-page="${id}" class="${id === state.page ? 'active' : ''}">${icon(i)}${label}</button>`).join('')}</nav><div class="sidebar-bottom"><div class="server-caption">${icon('server')}服务器工作空间</div><div class="server-label">${escape(state.profile.host)}</div><button class="button secondary small" data-action="disconnect">断开连接</button></div></aside><main class="main"><header class="topbar"><div class="breadcrumb">工作空间 <span>/</span><span>${escape(pageLabel)}</span></div><div class="row">${state.profile.demo ? pill('演示数据 · 未连接服务器', 'orange') : '<span class="pill"><i class="dot"></i>SSH 已连接</span>'}<span class="avatar">教</span></div></header><div class="workspace">${pageContent()}</div></main></div>`;
  paintQQBadge();
}
function pageHead(title, detail, action = '') { return `<div class="page-head"><div><h1>${title}</h1><p class="muted">${detail}</p></div>${action}</div>`; }
function pageContent() {
  if (state.page === 'qq') return qqPage();
  if (state.page === 'inbox') return inboxPage();
  if (state.page === 'course') return coursePage();
  if (!course()) return pageHead('开始你的第一门课程', '先建立课程，再安排作业与登记。') + empty('还没有课程', '课程信息与学生名单会保存在服务器。', '<button class="button" data-action="new-course">创建课程</button>');
  if (state.page === 'offline') return offlinePage();
  if (state.page === 'schedules') return schedulesPage();
  if (state.page === 'coursework') return courseworkPage();
  if (state.page === 'course-mail') return courseMailPage();
  if (state.page === 'conversation') return conversationPage();
  if (state.page === 'assignments') return assignmentsPage();
  if (state.page === 'extensions') return extensionsPage();
  if (state.page === 'tasks') return tasksPage();
  if (state.page === 'activities') return activitiesPage();
  if (state.page === 'memory') return memoryPage();
  return overviewPage();
}
function overviewPage() {
  const c = course(), roster = c.roster || [], received = state.records.length;
  return pageHead('课程总览', `${escape(c.title)}${c.className ? ' · ' + escape(c.className) : ''}`, '<button class="button secondary" data-action="refresh">' + icon('refresh') + ' 刷新</button>') + `<section class="hero"><div><div class="eyebrow">Your teaching, thoughtfully organized</div><h2>把课堂事务，安排得井井有条。</h2><p>从一份清晰的课程计划，到每一次准确的作业登记。</p></div><button class="button" data-action="page" data-page="offline">登记线下作业 ${icon('arrow')}</button></section><div class="stats">${[[roster.length, '人', '课程学生', 'people', '按姓名维护课程名单'], [state.assignments.length, '次', '已建作业', 'file', '集中查看题目与截止时间'], [received, '份', '本次线下已交', 'check', assignment()?.title || '尚未选择作业'], [state.tasks.filter(t => t.courseId === c.id && ['queued', 'running'].includes(t.status)).length, '项', '进行中任务', 'activity', '内核在服务器持续运行']].map(([n, unit, label, i, help]) => `<div class="card stat"><div class="label">${label}${icon(i)}</div><div class="number">${n}<small>${unit}</small></div><div class="help">${escape(help)}</div></div>`).join('')}</div><div class="dashboard"><section class="card"><div class="card-title"><h2>教学进度</h2><button class="button ghost small" data-action="page" data-page="course">编辑课程 →</button></div><div class="progress-label">${escape(c.title)} · 当前安排</div><div class="timeline"><p class="progress-text">${escape(c.progress || '还未设置教学进度，先记录本周已讲内容和后续安排。')}</p></div><div class="quick-links"><button class="quick-link" data-action="new-assignment">${icon('plus')}创建一份新作业</button><button class="quick-link" data-action="page" data-page="course">${icon('people')}维护学生名单</button></div></section><section class="card"><div class="card-title"><h2>近期作业</h2><button class="button ghost small" data-action="page" data-page="assignments">查看全部 →</button></div>${state.assignments.slice(-3).reverse().map(a => `<div class="assignment-item"><span class="assignment-icon">${icon('file')}</span><div class="spacer"><h3>${escape(a.title)}</h3><small>截止 ${fmt(a.deadline)}</small></div><button class="button ghost small" data-action="register-assignment" data-id="${escape(a.id)}">登记 →</button></div>`).join('') || '<p class="muted">还没有作业，创建后即可登记线下提交。</p>'}</section></div>`;
}
function progressMetadata(c) {
  const last = c.progressAt ? new Date(c.progressAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '暂无更新时间';
  return `<p class="help">教学进度：${escape(last)}${c.progressSource === 'inferred' ? '（据作业和群消息推断）' : c.progressSource === 'teacher' ? '（教师更新）' : ''}</p>`;
}
function coursePage() {
  const c = state.newCourse ? {} : course() || {};
  const field = (name, label, value, extra = '') => `<label>${label}<input name="${name}" value="${escape(value)}" ${extra}></label>`;
  return pageHead(state.newCourse || !c.id ? '创建课程' : '课程设置', '让助教了解课程安排与规则，学生按姓名管理。', '<button class="button secondary" data-action="new-course">' + icon('plus') + ' 新建课程</button>') + `<form id="course-form"><div class="form-columns"><section class="card"><h2>基本信息</h2><p class="form-intro">设置课程名称、班级与沟通范围。</p><div class="grid2 section-gap">${field('title', '课程名称', c.title, 'required placeholder="例如：数学分析"')}${field('className', '授课班级', c.className, 'placeholder="例如：2026级数学一班"')}${field('groupId', '课程 QQ 群号', c.groupId, 'inputmode="numeric" pattern="[0-9]*" placeholder="可选"')}<div></div><label class="field-wide">教学进度<textarea name="progress" rows="4" placeholder="记录已经讲到的内容与接下来的安排">${escape(c.progress)}</textarea></label><label class="field-wide">助教工作说明<textarea name="instructions" rows="3" placeholder="例如：答疑先给思路，再逐步解释">${escape(c.instructions)}</textarea></label></div><div class="subsection"><h3>通用评分标准</h3><label><textarea name="gradingPolicy" rows="4" placeholder="定义步骤分、计算错误与重复扣分等统一规则">${escape(c.gradingPolicy)}</textarea></label><p class="help">新建作业可沿用此标准；实际自动批改功能将在后续接入。</p></div></section><section class="card"><h2>课程学生名单</h2><p class="form-intro">每行一个姓名，用于线下登记与缺交统计。</p><label class="section-gap"><textarea name="roster" rows="18" placeholder="张三&#10;李四&#10;王五">${escape((c.roster || []).join('\n'))}</textarea></label><p class="help">无需绑定 QQ 或邮箱。同班重名时，请在姓名后添加可区分的班级或学号备注。</p><div class="note section-gap">修改将保存到服务器。编辑课程不会向学生群自动发布消息。</div>${c.id ? progressMetadata(c) : ''}${c.id && !state.profile.demo ? `<div class="subsection"><h3>课程教材</h3><p class="help">已绑定 ${(c.textbookIds ?? []).length} 份教材。Markdown 用 ## 1.1 节标题和 ### T1 题号。</p><input type="file" id="textbook-markdown" accept=".md,.markdown"><button type="button" class="button secondary small" data-action="textbook-import">导入并绑定</button></div>` : ''}</section></div><div class="form-footer"><span class="muted spacer">${c.id ? `课程版本 ${c.revision || 1}` : '建立课程后即可创建作业'}</span><button class="button" type="submit">${c.id ? '保存更改' : '创建课程'}</button></div></form>`;
}
function imagePreviews() {
  return state.assignmentImages.map((image, index) => `<div class="assignment-image">
    <img src="${escape(image.dataUrl)}" alt="${escape(image.name)}">
    <span title="${escape(image.name)}">${escape(image.name)}</span>
    <button type="button" class="button ghost small" data-action="remove-image" data-index="${index}">移除</button>
  </div>`).join('');
}

function assignmentsPage() {
  const c = course(), a = state.assignmentDetail;
  const due = new Date(); due.setDate(due.getDate() + 7); due.setHours(22, 0, 0, 0);
  state.assignmentImages = [...(a?.images || [])];
  const list = state.assignments.slice().reverse().map(item => `<div class="assignment-item">
    <span class="assignment-icon">${icon('file')}</span>
    <div class="spacer"><h3>${escape(item.title)}</h3><small>截止 ${fmt(item.deadline)}</small></div>
    <button class="button ghost small" data-action="edit-assignment" data-id="${escape(item.id)}">编辑</button>
    <button class="button ghost small" data-action="assignment-extensions" data-id="${escape(item.id)}">延期</button>
    <button class="button secondary small" data-action="register-assignment" data-id="${escape(item.id)}">登记</button>
  </div>`).join('');
  return pageHead('作业管理', '保存题目、图片、评分要求与截止时间。') + `<div class="form-columns">
    <section class="card">
      <div class="card-title"><h2>课程作业 <small>(${state.assignments.length})</small></h2><button class="button ghost small" data-action="new-assignment">${icon('plus')}新建</button></div>
      ${list || '<p class="muted">创建第一份作业后，即可登记分数。</p>'}
    </section>
    <section class="card">
      <h2>${a ? '编辑作业' : '创建作业'}</h2>
      <form id="assignment-form" class="assignment-editor section-gap">
        <label>作业名称<input name="title" value="${escape(a?.title)}" placeholder="例如：第 04 次作业 · 全微分" required></label>
        <label>题目与提交要求<textarea name="instructions" rows="5">${escape(a?.instructions)}</textarea></label>
        <label>添加题目图片<input id="assignment-files" type="file" accept="image/png,image/jpeg,image/webp" multiple></label>
        <div class="help">最多 3 张，支持 PNG、JPEG 和 WebP。大图会压缩，请检查公式是否清晰。</div>
        <div id="assignment-images" class="assignment-images">${imagePreviews()}</div>
        <label>截止时间<input name="deadline" type="datetime-local" value="${localTime(a?.deadline || due)}" required></label>
        <label>本次评分标准<textarea name="gradingPolicy" rows="4">${escape(a?.gradingPolicy ?? c.gradingPolicy)}</textarea></label>
        <label class="row"><input style="width:auto" name="studentVisible" type="checkbox" ${a?.studentVisible === true ? 'checked' : ''}> 允许助教向本课程学生查答这份作业（不会发送群通知）</label>
        <button class="button" type="submit">保存作业</button>
      </form>
    </section>
  </div>`;
}

async function assignmentImage(file) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请选择 PNG、JPEG 或 WebP 图片');
  if (file.size > 20 * 1024 * 1024) throw new Error('单张原图不能超过 20 MB');
  let image = file;
  if (file.size > 768 * 1024) {
    const bitmap = await createImageBitmap(file);
    try {
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 2200 / Math.max(bitmap.width, bitmap.height));
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext('2d');
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of [0.88, 0.72, 0.55]) {
        image = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
        if (image && image.size <= 768 * 1024) break;
      }
    } finally { bitmap.close(); }
    if (!image || image.size > 768 * 1024) throw new Error('压缩后图片仍过大，请裁剪后再添加');
  }
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(image);
  });
  const name = image === file ? file.name : file.name.replace(/\.[^.]+$/, '') + '.jpg';
  return { name, dataUrl };
}

function offlinePage() {
  const a = assignment();
  if (!a) return pageHead('线下分数登记', '先创建一份作业。') + empty('尚无作业', '创建后可录入各学生的分数。', '<button class="button" data-action="new-assignment">创建作业</button>');
  const known = new Map(state.records.map(r => [r.studentName, r]));
  const names = [...new Set([...(course().roster || []), ...known.keys()])].filter(name => name.includes(state.search));
  const rows = names.map(name => {
    const record = known.get(name);
    const value = state.scoreDrafts.get(name)?.value ?? record?.score ?? '';
    return `<tr>
      <td><span class="name">${escape(name)}</span></td>
      <td><input type="number" class="score-input" min="0" step="any" inputmode="decimal" data-score-name="${escape(name)}" aria-label="${escape(name)}的分数" value="${escape(value)}" placeholder="未评分"></td>
      <td>${record ? `<button type="button" class="button ghost small" data-action="undo-registration" data-name="${escape(name)}">撤销</button>` : '—'}</td>
    </tr>`;
  }).join('');
  const scored = state.records.filter(r => r.score !== undefined).length;
  return pageHead('线下分数登记', '为本次作业录入分数，支持批量保存和更正。', '<button class="button secondary" data-action="refresh">' + icon('refresh') + '刷新记录</button>') + `
    <section class="card assignment-strip">
      <label>当前登记作业<select id="assignment-select" aria-label="当前作业">
        ${state.assignments.map(item => `<option value="${escape(item.id)}" ${item.id === a.id ? 'selected' : ''}>${escape(item.title)}</option>`).join('')}
      </select></label>
      ${pill(`已录入分数 ${scored} 人`)}
    </section>
    <form id="registration-form" class="card table-card">
      <div class="table-toolbar">
        <input id="student-search" class="search" value="${escape(state.search)}" placeholder="搜索学生姓名" aria-label="搜索学生姓名">
        <span class="spacer"></span>
        <button id="save-scores" class="button" type="submit" ${state.scoreDrafts.size ? '' : 'disabled'}>保存分数</button>
      </div>
      <div class="table-wrap"><table class="score-table">
        <thead><tr><th>学生姓名</th><th>分数</th><th>操作</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="3">暂无匹配学生，请在课程设置中维护名单。</td></tr>'}</tbody>
      </table></div>
      <div class="table-foot"><span>当前 ${names.length} 人</span><span id="score-draft-count">待保存 ${state.scoreDrafts.size} 人</span></div>
    </form>`;
}
async function loadInbox() {
  state.inbox = state.courseId ? await api('GET', `/v1/courses/${encodeURIComponent(state.courseId)}/inbox`) : { items: [], counts: { total: 0 } };
}
function inboxPage() {
  const data = state.inbox || { items: [], counts: { total: 0 } };
  const names = { teacher_draft: '待确认草稿', coursework: '提交与延期', roster: '名单变更', mail: '邮件待核对', grading: '批改待审核', memory_job: '系统异常', task: '等待教师', alert: '监督告警' };
  const jumps = { coursework: 'coursework', 'course-mail': 'course-mail', memory: 'memory', tasks: 'tasks', activities: 'activities' };
  const counts = data.counts || {};
  const chips = Object.entries(names).filter(([kind]) => counts[kind]).map(([kind, label]) => pill(`${label} ${counts[kind]}`, kind === 'alert' ? 'orange' : '')).join('');
  const rows = (data.items || []).map(item => {
    const page = jumps[item.entry];
    const action = item.kind === 'grading' && item.status === 'pending'
      ? `<span class="row"><button class="button small" data-action="grading-approve" data-id="${escape(item.id)}">通过</button>` +
        `<button class="button ghost small" data-action="grading-reject" data-id="${escape(item.id)}">驳回</button></span>`
      : page ? `<button class="button secondary small" data-action="page" data-page="${page}">去处理</button>` : '<span class="help">在原 QQ 会话或助教对话处理</span>';
    return `<div class="row section-gap"><div class="spacer"><strong>${escape(item.title)}</strong><p class="help">${escape(names[item.kind] || item.kind)} · ${fmt(item.createdAt || undefined)}${item.detail ? ' · ' + escape(item.detail) : ''}</p></div>${action}</div>`;
  }).join('');
  const proposals = (data.proposals || []).map(item => {
    const page = jumps[item.entry] || item.entry;
    return `<div class="row section-gap"><div class="spacer"><strong>${escape(item.title)}</strong><p class="help">${escape(item.reason)}</p></div><button class="button ghost small" data-action="page" data-page="${page}">查看</button></div>`;
  }).join('');
  return pageHead('待办', '需要你决定或核对的事项；批改批次可直接在这里通过或驳回。', '<button class="button secondary" data-action="refresh">' + icon('refresh') + ' 刷新</button>')
    + `<section class="card"><div class="row">${chips || pill('暂无待办')}</div><div class="task-list section-gap">${rows || empty('没有待处理事项', '新的提交、延期、邮件与告警会出现在这里。')}</div></section>`
    + (proposals ? `<section class="card section-gap"><h2>建议</h2><p class="help">根据当前记录给出的候选与理由，不会自动执行。</p><div class="task-list section-gap">${proposals}</div></section>` : '');
}
function tasksPage() {
  const labels = { queued: '等待执行', running: '正在执行', waiting_teacher: '等待教师回复', completed: '结果已保存', blocked: '需要处理', paused: '已暂停', cancelled: '已取消', superseded: '已替代' };
  const workers = { qa: '答疑', lesson: '教学材料', scheduled: '教学材料', 'teaching-affairs': '教学事务', coursework: '作业处理' };
  return pageHead('运行任务', '关闭工作台后，服务器仍会继续处理任务。', '<button class="button secondary" data-action="refresh">' + icon('refresh') + '刷新</button>') + `
    <form id="lesson-form" class="card assignment-editor">
      <h2>准备习题课讲义</h2>
      <label>备课要求<textarea name="goal" rows="3" maxlength="2000" required placeholder="例如：40 分钟，围绕一致收敛准备 3 道题，包含典型误区。"></textarea></label>
      <div class="row"><button type="submit" class="button">生成草稿</button><span class="muted">草稿保存到下方任务，供教师审阅。</span></div>
    </form>
    <div class="task-list section-gap">${state.tasks.filter(t => t.courseId === state.courseId).slice().reverse().map(t => `<details class="card task-row">
      <summary>${icon('activity')}<span class="spacer">${escape(workers[t.kind] ?? t.kind)} · ${escape(t.kind === 'scheduled' ? t.grant?.channel?.target || t.goal : t.goal)}</span>${pill(labels[t.status] || t.status, t.status === 'blocked' ? 'orange' : '')}</summary>
      <pre>${escape(t.result || t.error || '任务尚无输出')}</pre>
      ${(t.artifacts ?? []).map(a => `<div class="row section-gap"><button class="button secondary small" data-action="download-artifact" data-id="${escape(t.id)}" data-sha="${escape(a.sha256)}" data-name="${escape(a.name)}">下载 ${escape(a.name)}</button>${a.deliveryEventId ? `<button class="button ghost small" data-action="artifact-receipt" data-id="${escape(a.deliveryEventId)}">查看发送回执</button>` : ''}</div>`).join('')}
      ${['lesson', 'scheduled'].includes(t.kind) && t.result ? `<button class="button secondary small" data-action="copy-lesson" data-id="${escape(t.id)}">复制 Markdown 草稿</button>` : ''}
    </details>`).join('') || empty('暂时没有运行任务', '可在上方新建讲义任务。')}</div>`;
}

async function afterConnect(profile) { state.profile = profile; state.connected = true; state.page = 'overview'; state.dirty = false; state.scoreDrafts.clear(); state.assignmentDetail = null; state.qq = { status: null, image: null, error: '', busy: false }; await refresh(); render(); void refreshQQ(false); }
function paintQQBadge() {
  const row = $('.topbar .row'); if (!row) return;
  let badge = $('#qq-badge');
  if (!badge) { badge = document.createElement('span'); badge.id = 'qq-badge'; row.prepend(badge); }
  const status = state.qq.status;
  badge.className = `pill ${status?.online === false ? 'orange' : !status?.available ? 'gray' : ''}`;
  badge.textContent = status?.setupRequired === 'auth-token' ? '助教QQ待授权' : status?.available ? status.online ? '助教QQ在线' : state.profile.demo ? '助教QQ演示离线' : '助教QQ已离线' : '助教QQ状态待确认';
}
async function refreshQQ(requestQr = false, force = false) {
  if (!state.connected || state.qq.busy) return;
  const qqSession = state.qq;
  state.qq.busy = true; state.qq.error = '';
  if (force) state.qq.image = null;
  if (state.page === 'qq') render();
  try {
    const status = await unwrap(window.ta.qqStatus());
    if (!state.connected || state.qq !== qqSession) return;
    state.qq.status = status;
    if (!status.available) { state.qq.image = null; state.qq.error = status.error || '暂时无法确认LLBot状态'; }
    else if (status.online) state.qq.image = null;
    else if (!status.setupRequired && requestQr && (!state.qq.image || force)) {
      const result = await unwrap(window.ta.qqQr());
      if (!state.connected || state.qq !== qqSession) return;
      state.qq.status = result; state.qq.image = result.imageDataUrl || null; state.qq.fetchedAt = result.fetchedAt;
    }
  } catch (error) { if (state.qq === qqSession) { state.qq.error = error.message; state.qq.image = null; } }
  finally { qqSession.busy = false; if (state.qq === qqSession) { if (state.connected && state.page === 'qq') render(); else paintQQBadge(); } }
}
function qqPage() {
  const q = state.qq, status = q.status;
  if (status?.setupRequired === 'auth-token') return pageHead('助教专属 LLBot 登录', '独立实例 ta-llbot，原聊天机器人的 LLBot 保持不动。', `<button class="button secondary" data-action="qq-status">${icon('refresh')}检查状态</button>`) + `<section class="card qq-status-card"><span class="qq-status-symbol">${icon('shield')}</span><div class="spacer"><h2>等待配置官方 Auth Token</h2><p class="muted">专属 LLBot 和内部服务已部署，尚未启动它自己的 QQ 客户端。</p></div>${pill('待授权', 'orange')}</section><section class="card section-gap"><h2>下一步</h2><p class="muted section-gap">准备好供新实例使用的 LLBot 官方 Auth Token 后，完成服务器配置并重新连接工作台。随后此页会提供新账号自己的登录二维码。</p><div class="note section-gap">不会复制旧账号登录态，不会借用或重启原 LLBot。</div></section>`;
  const title = !status?.available ? '正在确认登录状态' : status.online ? 'QQ 已在线，助教服务可以继续工作' : 'QQ 已离线，请扫码恢复登录';
  const hint = status?.online ? '当前不需要登录二维码。工作台会定期检查在线状态。' : '请使用对应账号的手机 QQ 扫码，并在手机上确认登录。';
  return pageHead('助教专属 LLBot 登录', '独立实例 ta-llbot；掉线时刷新此实例自己的登录二维码。', `<button class="button secondary" data-action="qq-status" ${q.busy ? 'disabled' : ''}>${icon('refresh')}检查状态</button>`) + `<section class="card qq-status-card"><span class="qq-status-symbol ${status?.online ? 'is-online' : ''}">${icon('shield')}</span><div class="spacer"><h2>${escape(title)}</h2><p class="muted">${escape(hint)}</p><p class="help">${status?.account ? `账号 ${escape(status.account)} · ` : ''}${status?.checkedAt ? '最近检查 ' + fmt(status.checkedAt) : '尚未完成检查'}</p></div>${pill(status?.available ? status.online ? '在线' : '待登录' : '状态未知', status?.online ? '' : 'orange')}</section>${q.error ? `<div class="connection-error" role="alert">${escape(q.error)}。请核对SSH权限、LLBot端口和数据目录；工作台不会自动重启服务。</div>` : ''}${status?.available && !status.online ? `<div class="qq-layout section-gap"><section class="card qr-card"><h2>手机 QQ 扫码登录</h2><div class="qr-frame">${q.image ? `<img src="${escape(q.image)}" alt="服务器LLBot实时登录二维码">` : `<div class="qr-placeholder">${icon('shield')}<strong>${state.profile.demo ? '登录二维码演示区' : q.busy ? '正在获取二维码…' : '等待获取二维码'}</strong><span>${state.profile.demo ? '演示模式不生成真实登录码' : '点击下方按钮获取实时二维码'}</span></div>`}</div><button class="button" data-action="qq-qr" ${q.busy ? 'disabled' : ''}>${icon('refresh')}${q.busy ? '正在获取…' : '刷新二维码'}</button><p class="help section-gap">${q.fetchedAt ? '最近获取 ' + fmt(q.fetchedAt) + ' · ' : ''}二维码失效后可重新刷新。</p></section><section class="card"><h2>恢复登录</h2><ol class="qq-steps"><li><strong>打开对应账号的手机 QQ</strong><p>请使用助教专属QQ账号，不要使用原聊天机器人的QQ账号。</p></li><li><strong>扫描左侧二维码</strong><p>在手机上完成登录确认。二维码不会保存到本机文件。</p></li><li><strong>等待状态更新</strong><p>工作台每 30 秒检查一次，也可点击“检查状态”。上线后自动隐藏二维码。</p></li></ol><div class="note">此页面只管理助教专属 ta-llbot 实例；原聊天机器人使用自己的 LLBot，不受此处登录影响。</div></section></div>` : `<section class="card section-gap">${empty(status?.online ? '当前登录正常' : '等待状态确认', status?.online ? '掉线时，此页将提供可刷新的实时登录二维码。' : '只有明确检测到离线后才会获取登录二维码。')}</section>`}`;
}
document.addEventListener('submit', async event => {
  if (event.target.id === 'extension-form') return;
  event.preventDefault(); const form = event.target;
  if (!form.reportValidity()) return;
  const data = Object.fromEntries(new FormData(form));
  form.classList.add('busy');
  try {
    if (form.id === 'schedules-form') {
      const controls = [...form.elements].filter(control => !control.disabled);
      controls.forEach(control => control.disabled = true);
      try { await saveSchedules(); }
      finally { controls.forEach(control => control.disabled = false); }
      return;
    }
    if (form.id.startsWith('course-mail-')) { await submitCourseMail(form, data); return; }
    if (form.id === 'conversation-form') { await sendConversation(form, data.message); return; }
    if (form.id === 'connect-form') {
      state.profile = { ...data }; delete state.profile.password;
      const connecting = window.ta.connect(data); form.elements.password.value = ''; delete data.password;
      const result = await unwrap(connecting); await afterConnect(result); return;
    }
    if (form.id === 'lesson-form') {
      const goal = data.goal.trim();
      if (!goal) throw new Error('请填写备课要求');
      const button = form.querySelector('button');
      if (button.disabled) return;
      button.disabled = true;
      try {
        await api('POST', '/v1/tasks', { courseId: state.courseId, kind: 'lesson', goal });
        await refresh();
        render();
        toast('讲义任务已提交，可点刷新查看进度');
      } finally { button.disabled = false; }
      return;
    }
    if (form.id === 'course-form') {
      const existing = state.newCourse ? undefined : course();
      const body = { ...data, roster: data.roster.split(/\r?\n/).map(n => n.trim()).filter(Boolean), textbookIds: existing?.textbookIds || [] };
      const result = existing ? await api('PUT', `/v1/courses/${encodeURIComponent(existing.id)}`, { ...body, revision: existing.revision || 1 }) : await api('POST', '/v1/courses', { ...body, id: crypto.randomUUID() });
      state.courseId = result.id; state.newCourse = false; state.dirty = false; await refresh(); render(); toast('课程信息已保存'); return;
    }
    if (form.id === 'assignment-form') {
      const editing = state.assignmentDetail;
      if (!data.instructions.trim() && !state.assignmentImages.length) throw new Error('请输入题目或添加题目图片');
      const body = { ...data, deadline: new Date(data.deadline).toISOString(), images: state.assignmentImages, studentVisible: form.elements.studentVisible.checked };
      const saved = editing ? await api('PUT', `/v1/assignments/${encodeURIComponent(editing.id)}`, { ...body, revision: editing.revision }) : await api('POST', `/v1/courses/${encodeURIComponent(state.courseId)}/assignments`, body);
      state.assignmentId = saved.id; state.assignmentDetail = saved; state.dirty = false; await refresh(); render(); toast('作业已保存，未发送群通知'); return;
    }
    if (form.id === 'registration-form') {
      const students = [...state.scoreDrafts].map(([name, draft]) => {
        const score = Number(draft.value);
        if (!draft.value.trim() || !Number.isFinite(score) || score < 0) throw new Error(`请填写 ${name} 的有效分数；删除已录入的分数请用“撤销”`);
        return { name, revision: draft.revision, score };
      });
      if (!students.length) return;
      await api('POST', `/v1/assignments/${encodeURIComponent(state.assignmentId)}/offline`, { students });
      state.scoreDrafts.clear(); state.dirty = false; await refresh(); render(); toast(`已保存 ${students.length} 位学生的分数`); return;
    }
  } catch (error) {
    if (form.id === 'connect-form') { state.connected = false; connection(error.message); }
    else toast(error.status === 409 ? `${error.message}。请刷新后核对记录。` : error.message, true);
  } finally { form.classList.remove('busy'); }
});
document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]'); if (!button) return;
  const action = button.dataset.action;
  try {
    if (action === 'demo') { await afterConnect(await unwrap(window.ta.demo())); return; }
    if (action === 'qq-status') { await refreshQQ(state.page === 'qq'); return; }
    if (action === 'qq-qr') { await refreshQQ(true, true); return; }
    if (action === 'disconnect') { if (!canLeave()) return; await unwrap(window.ta.disconnect()); state.connected = false; state.dirty = false; connection(); return; }
    if (['page', 'new-course', 'new-assignment', 'edit-assignment', 'register-assignment', 'assignment-extensions', 'refresh'].includes(action) && !canLeave()) return;
    if (['page', 'new-course', 'new-assignment', 'edit-assignment', 'register-assignment', 'assignment-extensions', 'refresh'].includes(action)) state.scoreDrafts.clear();
    if (action === 'assignment-extensions') { await openExtensions(button); return; }
    if (['reload-schedules', 'add-schedule', 'remove-schedule', 'run-schedule'].includes(action)) { await handleScheduleAction(action, button.dataset.id); return; }
    if (action === 'download-artifact') {
      await downloadCourseFile(`/v1/tasks/${encodeURIComponent(button.dataset.id)}/artifacts/${button.dataset.sha}`, button.dataset.name);
      return;
    }
    if (action === 'artifact-receipt') {
      const receipt = await api('GET', '/v1/dsh/requests/' + encodeURIComponent(button.dataset.id));
      toast(receipt.status === 'sent' ? '群文件已发送' : '交付状态 ' + receipt.status, receipt.status === 'failed');
      return;
    }
    if (action === 'grading-approve' || action === 'grading-reject') {
      const id = button.dataset.id;
      button.disabled = true;
      try {
        const courseId = encodeURIComponent(state.courseId);
        if (action === 'grading-approve') {
          const batches = await api('GET', `/v1/courses/${courseId}/grading-batches`);
          const batch = batches.find(item => item.id === id && item.status === 'pending');
          if (!batch) throw new Error('该批次已更新，请刷新待办');
          const scores = batch.items.map(item => `${item.studentName} · ${item.assignmentTitle} · ${item.total}/${item.maximum}`);
          if (!window.confirm(`确认向以下 ${scores.length} 份作业的发件人发送批改反馈？\n\n${scores.join('\n')}`)) return;
        }
        const result = await api('POST', `/v1/courses/${courseId}/grading-batches/${encodeURIComponent(id)}/${action === 'grading-approve' ? 'approve' : 'reject'}`);
        toast(action === 'grading-approve' ? `已通过，回信 ${result.sent ?? 0} 份${result.failed ? `，${result.failed} 份需核对` : ''}` : '已驳回这批批改');
        await loadInbox(); render();
      } catch (error) { toast(error.message, true); }
      finally { button.disabled = false; }
      return;
    }
    if (['coursework-review', 'coursework-file'].includes(action)) { await courseworkAction(action, button.dataset); return; }
    if (action === 'textbook-import') {
      if (state.dirty) { toast('请先保存课程编辑'); return; }
      const input = $('#textbook-markdown'), file = input?.files?.[0], selected = course();
      if (!file || file.size > 480_000) { toast('请选择不超过 480 KB 的 UTF-8 Markdown 文件', true); return; }
      button.disabled = true;
      try {
        const markdown = await file.text();
        const book = await api('POST', `/v1/courses/${encodeURIComponent(selected.id)}/textbook-import`, { markdown, revision: selected.revision });
        await refresh(); render();
        toast(`已导入「${book.title}」，共 ${book.sections} 节、${book.exercises} 题`);
      } finally { button.disabled = false; }
      return;
    }
    if (action?.startsWith('course-mail-')) { await courseMailAction(action, button.dataset); return; }
    if (action === 'copy-lesson') {
      const task = state.tasks.find(item => item.id === button.dataset.id && item.courseId === state.courseId && ['lesson', 'scheduled'].includes(item.kind));
      if (task?.result) { await navigator.clipboard.writeText(task.result); toast('已复制 Markdown'); }
      return;
    }
    if (action === 'remove-image') {
      state.assignmentImages.splice(Number(button.dataset.index), 1);
      $('#assignment-images').innerHTML = imagePreviews();
      state.dirty = true;
      return;
    }
    if (action === 'page') { state.page = button.dataset.page; state.newCourse = false; state.dirty = false; render(); }
    if (action === 'page' && state.page === 'qq') await refreshQQ(true);
    if (action === 'page' && state.page === 'memory') { await loadMemories(); render(); }
    if (action === 'page' && state.page === 'activities') { await openActivities(); }
    if (action === 'page' && state.page === 'schedules') { await loadSchedules(); if (state.page === 'schedules') render(); }
    if (action === 'page' && state.page === 'coursework') { await loadCoursework(); if (state.page === 'coursework') render(); }
    if (action === 'page' && state.page === 'course-mail') { await loadCourseMail(); if (state.page === 'course-mail') render(); }
    if (action === 'page' && state.page === 'conversation') { await loadConversation(); if (state.page === 'conversation') render(); }
    if (action === 'page' && state.page === 'inbox') { await loadInbox(); if (state.page === 'inbox') render(); }
    if (action === 'new-course') { state.page = 'course'; state.newCourse = true; state.dirty = false; render(); }
    if (action === 'new-assignment') { state.page = 'assignments'; state.assignmentDetail = null; state.dirty = false; render(); }
    if (action === 'edit-assignment') {
      const courseId = state.courseId, profile = state.profile;
      const detail = await api('GET', `/v1/assignments/${encodeURIComponent(button.dataset.id)}`);
      if (!button.isConnected || state.courseId !== courseId || state.profile !== profile) return;
      state.page = 'assignments'; state.assignmentDetail = detail; state.dirty = false; render();
    }
    if (action === 'register-assignment') { state.page = 'offline'; state.assignmentId = button.dataset.id; state.dirty = false; await refresh(); render(); }
    if (action === 'refresh') { state.dirty = false; await refresh(); render(); toast('已同步服务器记录'); }
    if (action === 'undo-registration') {
      const name = button.dataset.name, record = state.records.find(r => r.studentName === name);
      if (!window.confirm(`撤销 ${name} 的本次线下登记？历史操作记录仍会保留。`)) return;
      await api('DELETE', `/v1/assignments/${encodeURIComponent(state.assignmentId)}/offline/${encodeURIComponent(name)}`, { revision: record.revision });
      state.scoreDrafts.delete(name); state.dirty = state.scoreDrafts.size > 0; await refresh(); render(); toast('登记已撤销');
    }
  } catch (error) { toast(error.message, true); }
});
document.addEventListener('change', async event => {
  const el = event.target;
  try {
    if (el.id === 'assignment-files' && el.files.length) {
      const form = el.form, files = [...el.files];
      el.value = '';
      if (state.assignmentImages.length + files.length > 3) throw new Error('一份作业最多添加 3 张图片');
      form.classList.add('busy');
      form.querySelector('button[type=submit]').disabled = true;
      try {
        const added = [];
        for (const file of files) added.push(await assignmentImage(file));
        if (!form.isConnected) return;
        state.assignmentImages.push(...added);
        $('#assignment-images').innerHTML = imagePreviews();
        state.dirty = true;
      } finally {
        form.classList.remove('busy');
        form.querySelector('button[type=submit]').disabled = false;
      }
      return;
    }
    if (el.id === 'course-select') {
      if (!canLeave()) { el.value = state.courseId; return; }
      if (state.page === 'extensions') state.page = 'assignments';
      state.courseId = el.value; state.assignmentId = ''; state.scoreDrafts.clear(); state.newCourse = false; state.assignmentDetail = null; state.dirty = false; await refresh(); render();
      if (state.page === 'activities') await openActivities();
    }
    if (el.id === 'assignment-select') {
      if (!canLeave()) { el.value = state.assignmentId; return; }
      state.assignmentId = el.value; state.scoreDrafts.clear(); state.dirty = false; await refresh(); render();
    }
  } catch (error) { toast(error.message, true); }
});
document.addEventListener('input', event => {
  if (event.target.closest('#course-form,#assignment-form,#memory-form,#extension-form,#schedules-form,#course-mail-settings,#course-mail-reply,#conversation-form') && !['assignment-files','textbook-markdown'].includes(event.target.id)) state.dirty = true;
  const name = event.target.dataset.scoreName;
  if (name) {
    const current = state.records.find(r => r.studentName === name);
    const value = event.target.value;
    if (!event.target.validity.badInput && value === String(current?.score ?? '')) state.scoreDrafts.delete(name);
    else state.scoreDrafts.set(name, { value, revision: state.scoreDrafts.get(name)?.revision ?? current?.revision ?? 0 });
    state.dirty = state.scoreDrafts.size > 0;
    $('#save-scores').disabled = !state.dirty;
    $('#score-draft-count').textContent = `待保存 ${state.scoreDrafts.size} 人`;
  }
  if (event.target.id === 'student-search') {
    const position = event.target.selectionStart; state.search = event.target.value; render(); const input = $('#student-search'); input.focus(); input.setSelectionRange(position, position);
  }
});
window.ta.onDisconnected(() => { if (state.connected && !state.profile.demo) { state.connected = false; state.qq = { status: null, image: null, error: '', busy: false }; connection('与服务器的SSH连接已断开，请重新连接'); } });
window.addEventListener('beforeunload', event => { if (state.dirty) { event.preventDefault(); event.returnValue = ''; } });
unwrap(window.ta.profile()).then(profile => { state.profile = profile; connection(); }).catch(error => connection(error.message));
setInterval(() => { if (state.connected) void refreshQQ(state.page === 'qq'); }, 30000);
