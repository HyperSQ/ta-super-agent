import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.ts';
import { Router } from '../src/agents/router.ts';
import { Academics } from '../src/application/services/academics.ts';
import { CourseworkIntake } from '../src/application/services/coursework-intake.ts';
import { weeklyReport } from '../src/application/services/weekly-report.ts';
import { TeacherConversation } from '../src/application/teacher-conversation.ts';

test('教师周报按课程和近七天统计已登记尝试，工作台读取不触发模型', async () => {
  const f = fixture();
  try {
    f.store.saveCourse({ ...f.store.course('math')!, roster: ['合成学生'] });
    f.engine.createCourse('web:admin', { id: 'other', title: '另一门课', groupId: '101', instructions: '' });
    const at = f.engine.now();
    const assignment = new Academics(f.engine).saveAssignment('web:admin', {
      courseId: 'math', title: '第一次作业', instructions: '提交证明', gradingPolicy: '', studentVisible: true,
      deadline: new Date(at - 1000).toISOString(),
    });
    const intake = new CourseworkIntake(f.engine);
    const file = [{ name: 'proof.txt', bytes: Buffer.from('测试作答') }];
    intake.registerMail('math', { id: 'recent-first', receivedAt: at - 2000 }, assignment.id, '合成学生', file);
    intake.registerMail('math', { id: 'recent-late', receivedAt: at - 500 }, assignment.id, '合成学生', file);
    intake.registerMail('math', { id: 'outside', receivedAt: at - 8 * 86_400_000 }, assignment.id, '合成学生', file);
    const [row] = weeklyReport(f.engine, 'math', at).assignments;
    assert.deepEqual([row.accepted, row.students, row.late], [2, 1, 1]);
    assert.deepEqual(weeklyReport(f.engine, 'other', at).assignments, []);

    const conversation = new TeacherConversation(f.engine);
    const request = conversation.send('math', 'workbench', '生成本周周报草稿', 'teacher-weekly-00001');
    const router = new Router(f.engine, { async complete() { throw Error('不得调用模型'); } });
    await router.route(f.store.event(request.eventId)!, new AbortController().signal);
    const reply = conversation.turn('math', request.eventId).reply ?? '';
    assert.match(reply, /已登记 2 次/);
    assert.doesNotMatch(reply, /合成学生|测试作答/);
    assert.equal(f.store.deliveries().length, 0);
  } finally { f.store.close(); }
});
