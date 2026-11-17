import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers.ts';
import { Academics } from '../src/application/services/academics.ts';
import { CourseworkIntake } from '../src/application/services/coursework-intake.ts';
import { Router } from '../src/agents/router.ts';
import { QQAccess } from '../src/application/services/qq-access.ts';
import { askTeacher } from '../src/application/services/teacher-inquiry.ts';

const noModel = { async complete() { throw Error('不应调用模型'); } };
const signal = new AbortController().signal;
const clock = Date.parse('2026-11-16T12:00:00+08:00');
const create = (f: ReturnType<typeof fixture>) => {
  f.engine.now = () => clock;
  f.store.saveCourse({ ...f.store.course('math')!, roster: ['姓名甲'], weeklyLesson: { weekday: 6, time: '09:00', teacherQQ: '900', enabledAt: 1 } });
  const ac = new Academics(f.engine);
  const assignment = ac.saveAssignment('web:admin', { courseId: 'math', title: '实验01', instructions: '测试', studentVisible: true,
    deadline: '2026-11-15T12:00:00+08:00', gradingPolicy: '' });
  return { ac, assignment, homework: new CourseworkIntake(f.engine), qq: new QQAccess(f.engine, { async isMember() { return true; } }),
    router: new Router(f.engine, noModel) };
};
function message(id: string, text: string, user = '101', file = false) {
  return { message_type: 'private' as const, self_id: '999', user_id: user, message_id: id,
    message: [{ type: 'text', data: { text } }, ...(file ? [{ type: 'file', data: { file_id: 'f', file: 'draft.txt' } }] : [])] };
}

test('私信提交只得到邮箱提示；邮件登记后识别重交、迟交与个人延期', async t => {
  const f = fixture();
  t.after(() => f.store.close());
  const { assignment, ac, homework, qq, router } = create(f);
  // 私信不再接收作业：明确引导到课程邮箱。
  const submit = await qq.receive(message('11', '/submit ' + assignment.id + ' 姓名甲'));
  assert('event' in submit && submit.event);
  await router.route(submit.event, signal);
  assert.match(f.store.deliveries().find(d => d.replyEventId === submit.event!.id)?.text ?? '', /邮箱/);
  assert.equal(homework.list('math').requests.length, 0);

  // 邮件登记走正式提交：首封迟交。
  const first = homework.registerMail('math', { id: 'mail-1', receivedAt: clock + 3600_000 }, assignment.id, '姓名甲',
    [{ name: 'draft.txt', bytes: Buffer.from('示例内容') }]);
  assert.equal(first.attempt, 1);
  assert.equal(first.late, true);
  assert.equal(Buffer.from(homework.file('math', first.id, 1).data, 'base64').toString(), '示例内容');

  const ext = await qq.receive(message('13', '/extension ' + assignment.id + ' 2027-01-01T12:00:00+08:00\n姓名甲\n测试理由'));
  assert('event' in ext && ext.event);
  await router.route(ext.event, signal);
  const request = homework.list('math').requests.find(row => row.kind === 'extension')!;
  homework.review('math', request.id, request.revision, true, '已批准');
  assert.equal(ac.extensions('web:admin', assignment.id).students[0].effectiveDeadline, '2027-01-01T04:00:00.000Z');

  // 延期生效后再交：第二次提交且不算迟交。
  const second = homework.registerMail('math', { id: 'mail-2', receivedAt: Date.parse('2026-11-20T12:00:00+08:00') }, assignment.id, '姓名甲',
    [{ name: 'v2.txt', bytes: Buffer.from('第二版') }]);
  assert.equal(second.attempt, 2);
  assert.equal(second.late, false);
  assert.throws(() => homework.review('math', second.id, second.revision, true, ''), /已处理|不能|不是/);
});

test('引用教师答复后重排同一个任务，复用 DSH 会话；重复回复不会再次续跑', async t => {
  const f = fixture();
  t.after(() => f.store.close());
  const { qq, router } = create(f);
  const event = f.engine.receive({ sourceKey: 'dsh-run', courseId: 'math', threadId: 'dsh-run', actorId: 'web:admin',
    channel: { kind: 'management', target: '测试任务' }, text: '需要教师输入', externalId: 'dsh-run', receivedAt: clock,
    scheduled: 'custom', scheduledWorker: 'dsh' }).event;
  await router.route(event, signal);
  const task = f.store.tasks()[0];
  const run = f.engine.claim(task.id)!;
  const question = askTeacher(f.engine, 'math', '请给范围', 'one');
  f.engine.updateDSH(run, task => { task.dshSession = 'session-example'; task.teacherWait = { questionId: question.id }; });
  f.engine.finish(run, '等待教师');
  assert.equal(f.store.task(task.id)?.status, 'waiting_teacher');
  const pending = f.store.deliveries()[0];
  f.engine.claimDelivery(pending.id);
  f.engine.settleDelivery(pending.id, { externalId: '800' });
  await qq.receive({ ...message('801', '17.2 节', '900'), message: [
    { type: 'reply', data: { id: '800' } }, { type: 'text', data: { text: '17.2 节' } },
  ] });
  assert.equal(f.store.task(task.id)?.status, 'queued');
  const resumed = f.engine.claim(task.id)!;
  assert.equal(resumed.task.dshSession, 'session-example');
  assert.equal(f.store.event(resumed.task.teacherWait!.answerId!)?.text, '17.2 节');
  f.engine.finish(resumed, '续跑完成');
  assert.equal(f.store.task(task.id)?.status, 'completed');
  assert.equal(f.store.task(task.id)?.teacherWait, undefined);
});
