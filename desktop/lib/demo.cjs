const { randomUUID } = require('node:crypto');
class DemoSession {
  constructor() {
    this.courses = [{ id: 'math-demo', revision: 1, title: '数学分析', className: '2026级 · 数学一班', groupId: '123456789', progress: '第三章 · 多元函数微分学\n本周讲至全微分与链式法则，下周进入隐函数定理。', instructions: '答疑时先引导学生梳理已知条件，再逐步给出思路。', gradingPolicy: '按步骤给分；方法正确但计算错误保留步骤分；同一错误不重复扣分。', roster: ['张予安', '陈思远', '李知夏', '王书宁', '林一诺', '周明澈', '许星禾', '赵可欣', '吴嘉言', '郑亦辰', '刘沐晴', '沈以恒'], textbookIds: [] }];
    const due = new Date(); due.setDate(due.getDate() + 2); due.setHours(22, 0, 0, 0);
    this.assignments = [{ id: 'assignment-demo', courseId: 'math-demo', title: '第 04 次作业 · 全微分', instructions: '教材第85页第2、4、6题，第6题选做。请保留完整推导过程。', deadline: due.toISOString(), revision: 1, gradingPolicy: this.courses[0].gradingPolicy, createdAt: new Date().toISOString() }];
    this.records = this.courses[0].roster.slice(0, 5).map((name, i) => ({ assignmentId: 'assignment-demo', studentName: name, revision: 1, score: 85 + i, registeredAt: new Date().toISOString() }));
    this.extensions = new Map();
    this.tasks = [];
    this.memories = [{ id: 'memory-demo', courseId: 'math-demo', subjectId: 'qq:demo', revision: 1, status: 'active', kind: 'episode', observation: '学生询问全微分与偏导数的区别。', teaching: '通过二元函数的局部线性近似说明。', outcome: '尚未验证能否独立应用。', topics: ['全微分'], anchors: [], evidenceType: 'student-report', channel: { kind: 'qq-group', target: '123456789' }, sources: [{ eventId: 'event-demo', threadRevision: 1, quote: '全微分和偏导数有什么区别？' }], occurredAt: Date.now(), updatedAt: Date.now() }];
  }
  request(method, route, body) {
    const parts = route.split('/').map(decodeURIComponent);
    if (method === 'GET' && route === '/v1/courses') return structuredClone(this.courses);
    if (method === 'GET' && route === '/v1/tasks') return structuredClone(this.tasks);
    if (method === 'POST' && route === '/v1/tasks' && body.kind === 'lesson') {
      const task = { id: randomUUID(), courseId: body.courseId, goal: body.goal, kind: 'lesson', status: 'completed',
        result: '# 全微分习题课（演示）\n\n## 学生版\n\n用全微分近似计算根式。\n\n## 教师版\n\n先建立线性近似，再讨论误差。' };
      this.tasks.push(task);
      return task;
    }
    if (method === 'GET' && route === '/v1/deliveries') return [];
    if (method === 'GET' && parts[2] === 'courses' && parts[4] === 'memories') return structuredClone(this.memories.filter(m => m.courseId === parts[3]));
    if (method === 'GET' && parts[2] === 'courses' && parts[4] === 'memory-jobs') return [];
    if (parts[2] === 'memories') {
      const card = this.memories.find(m => m.id === parts[3]);
      if (!card) throw new Error('记忆不存在');
      if (method === 'GET') return structuredClone({ card, valid: card.status === 'active', sources: card.sources.map(s => ({ ...s, event: { text: s.quote, actor: { id: card.subjectId }, receivedAt: card.occurredAt } })) });
      if (body.revision !== card.revision) throw new Error('记忆已修改，请刷新');
      if (method === 'PUT') Object.assign(card, body, { revision: card.revision + 1, evidenceType: 'teacher-confirmed' });
      if (method === 'POST' && parts[4] === 'retire') Object.assign(card, { status: 'retired', revision: card.revision + 1 });
      return structuredClone(card);
    }
    if (method === 'POST' && route === '/v1/courses') { const c = { ...body, revision: 1 }; this.courses.push(c); return c; }
    if (parts[2] === 'courses' && parts[4] === 'schedules') {
      const course = this.courses.find(c => c.id === parts[3]);
      if (!course) throw new Error('课程不存在');
      if (method === 'POST' && parts[6] === 'run') {
        const task = course.weeklyTasks?.find(item => item.id === parts[5]);
        if (!task) throw new Error('找不到课内定时任务');
        const id = randomUUID();
        this.tasks.push({ id, courseId: course.id, kind: 'scheduled', status: 'completed', goal: task.title, result: '定时任务演示结果' });
        return { eventId: id };
      }
      if (method === 'PUT') {
        if (body.revision !== course.revision) throw new Error('课程已更新，请刷新');
        course.weeklyTasks = structuredClone(body.tasks);
        course.revision++;
      }
      return { revision: course.revision, tasks: structuredClone(course.weeklyTasks ?? []), availableTools: ['class_context',
        'list_assignments', 'read_assignment', 'lookup_textbook', 'search_textbook', 'textbook_section', 'view_textbook_page', 'prepare_lesson'] };
    }
    if (method === 'GET' && parts[2] === 'courses' && parts[4] === 'inbox')
      return {
        items: [
          { kind: 'teacher_draft', id: 'demo-draft', createdAt: Date.now() - 60_000, title: '待确认：新建作业「第 05 次作业」', status: 'pending', entry: 'qq', detail: '在原 QQ 会话或助教对话回复确认；确认码不在此页显示。' },
          { kind: 'coursework', id: 'demo-submission', createdAt: Date.now() - 120_000, title: '作业提交待核对 · 张予安', status: 'pending', entry: 'coursework' },
          { kind: 'mail', id: 'demo-mail', createdAt: Date.now() - 300_000, title: '作业邮件待核对：第 04 次作业', status: 'pending', entry: 'course-mail' },
        ],
        counts: { total: 3, teacher_draft: 1, coursework: 1, roster: 0, mail: 1, memory_job: 0, task: 0, alert: 0 },
        proposals: [
          { id: 'proposal-demo-1', rule: 'mail_backlog', title: '有 1 封作业邮件等待核对', reason: '邮件在核对前不会进入正式提交记录，也不会自动回信', count: 1, entry: 'course-mail', at: Date.now() },
        ],
      };
    if (method === 'GET' && parts[2] === 'courses' && parts[4] === 'coursework')
      return { requests: [], offline: structuredClone(this.records.filter(r => this.assignments.some(a => a.id === r.assignmentId && a.courseId === parts[3]))) };
    if (method === 'PUT' && parts[2] === 'courses') { const i = this.courses.findIndex(c => c.id === parts[3]); const c = { ...this.courses[i], ...body, id: parts[3], revision: this.courses[i].revision + 1 }; this.courses[i] = c; return c; }
    if (parts[2] === 'courses' && parts[4] === 'assignments') {
      if (method === 'GET') return structuredClone(this.assignments.filter(a => a.courseId === parts[3]));
      const a = { ...body, id: randomUUID(), courseId: parts[3], revision: 1, createdAt: new Date().toISOString() }; this.assignments.push(a); return a;
    }
    if (parts[2] === 'assignments' && parts[4] === 'extensions') {
      const assignment = this.assignments.find(a => a.id === parts[3]);
      if (!assignment) throw new Error('作业不存在');
      const roster = this.courses.find(c => c.id === assignment.courseId).roster;
      const saved = this.extensions.get(assignment.id) || new Map();
      const names = [...new Set([...roster, ...[...saved.keys()].filter(name => saved.get(name).deadline)])];
      if (method === 'PUT') {
        const name = parts[5], old = saved.get(name);
        if (!names.includes(name)) throw new Error('该学生不在名单中');
        if (body.assignmentRevision !== assignment.revision || (old?.revision ?? 0) !== body.revision) throw new Error('作业或延期记录已修改，请刷新');
        if (body.deadline !== null && !(Date.parse(body.deadline) > Date.parse(assignment.deadline))) throw new Error('个人截止时间须晚于全班截止时间');
        if (body.deadline === null && !old?.deadline) throw new Error('没有待撤销的延期');
        saved.set(name, { deadline: body.deadline, reason: body.deadline ? body.reason.trim() : '', revision: body.revision + 1 });
        this.extensions.set(assignment.id, saved);
      }
      return { deadline: assignment.deadline, assignmentRevision: assignment.revision,
        students: names.filter(name => roster.includes(name) || saved.get(name)?.deadline).map(studentName => {
          const record = saved.get(studentName) || { deadline: null, reason: '', revision: 0 };
          return { studentName, ...record, effectiveDeadline: Date.parse(record.deadline) > Date.parse(assignment.deadline) ? record.deadline : assignment.deadline };
        }) };
    }
    if (parts[2] === 'assignments' && parts[4] === 'offline') {
      if (method === 'GET') return structuredClone(this.records.filter(r => r.assignmentId === parts[3]));
      if (method === 'DELETE') { this.records = this.records.filter(r => !(r.assignmentId === parts[3] && r.studentName === parts[5])); return { removed: true }; }
      const current = this.records.filter(r => r.assignmentId === parts[3]);
      if (body.students.some(s => !Number.isFinite(s.score) || s.score < 0 || (current.find(r => r.studentName === s.name)?.revision ?? 0) !== s.revision)) throw new Error('分数或登记版本无效');
      for (const student of body.students) {
        this.records = this.records.filter(r => !(r.assignmentId === parts[3] && r.studentName === student.name));
        this.records.push({ assignmentId: parts[3], studentName: student.name, score: student.score, registeredAt: new Date().toISOString(), revision: student.revision + 1 });
      }
      return this.records.filter(r => r.assignmentId === parts[3]);
    }
    if (method === 'GET' && parts[2] === 'assignments') return structuredClone(this.assignments.find(a => a.id === parts[3]));
    if (method === 'PUT' && parts[2] === 'assignments') { const i = this.assignments.findIndex(a => a.id === parts[3]); this.assignments[i] = { ...this.assignments[i], ...body, revision: this.assignments[i].revision + 1 }; return this.assignments[i]; }
    throw new Error('演示环境暂不支持该操作');
  }
}
module.exports = { DemoSession };
