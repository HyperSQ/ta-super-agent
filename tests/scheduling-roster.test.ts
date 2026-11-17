import test from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { fixture } from './helpers.ts';
import { WeeklyLesson } from '../src/application/weekly-lesson.ts';
import { scheduledWorker } from '../src/agents/workers/scheduled-worker.ts';
import { QATools } from '../src/agents/qa-tools.ts';
import { Router } from '../src/agents/router.ts';
import { parseRosterFile, Roster } from '../src/application/services/roster.ts';
import { QQAccess } from '../src/application/services/qq-access.ts';
import { createApi } from '../src/http/server.ts';
import type { AgentModel } from '../src/ports/model.ts';
import type { WeeklyTask } from '../src/domain/model.ts';

const noModel = { async complete() { throw Error('不应调用路由模型'); } };
const slot = Date.parse('2026-11-13T19:00:00+08:00');
const base: WeeklyTask = { id: 'lab', title: '实验步骤', prompt: '写本周实验步骤', enabled: true,
  enabledAt: slot - 40_000, weekday: 5, time: '19:00', tools: ['list_assignments', 'class_context'] };

test('两个任务独立触发，两个工具轮次按配置执行，重启不重复，不外发草稿', async t => {
  const f = fixture();
  t.after(() => f.store.close());
  f.engine.now = () => slot + 10_000;
  f.store.saveCourse({ ...f.store.course('math')!, weeklyTasks: [base, { ...base, id: 'review', title: '教学总结', tools: [] }] });
  const first = new WeeklyLesson(f.engine);
  first.tick();
  await first.idle();
  const restart = new WeeklyLesson(f.engine);
  restart.tick();
  await restart.idle();
  const events = f.store.pendingEvents().filter(event => event.scheduled === 'custom');
  assert.equal(events.length, 2);
  const router = new Router(f.engine, noModel);
  const signal = new AbortController().signal;
  for (const event of events) await router.route(event, signal);
  assert.equal(f.store.tasks().filter(task => task.kind === 'scheduled').length, 2);
  const task = f.store.tasks().find(item => item.grant.channel?.target === base.title)!;
  const run = f.engine.claim(task.id)!;
  let step = 0;
  const model: AgentModel = { vision: false, async completeTurn(messages, tools) {
    assert.deepEqual(tools.map(tool => tool.function.name), ['list_assignments', 'class_context']);
    step++;
    if (step === 1) assert.match(String(messages.at(-1)?.content), /写本周实验步骤/);
    if (step === 2) assert.match(String(messages.at(-1)?.content), /assignments/);
    if (step === 3) assert.match(String(messages.at(-1)?.content), /没有启用/);
    if (step === 3) return { finishReason: 'stop', content: '{"markdown":"实验草稿"}', toolCalls: [] };
    return { finishReason: 'tool_calls', content: null, toolCalls: [{ type: 'function', id: String(step),
      function: { name: step === 1 ? 'list_assignments' : 'prepare_lesson', arguments: '{}' } }] };
  } };
  const result = await scheduledWorker(f.engine, model, new QATools(f.engine), async () => { throw Error('工具未授权'); })({ run, signal, checkpoint() {} });
  f.engine.finish(run, result);
  assert.equal(f.store.task(task.id)?.result, '实验草稿');
  assert.equal(f.store.deliveries().length, 0);
});

test('同一课程同一时段的两个任务共享一次教师进度询问', async t => {
  const f = fixture();
  t.after(() => f.store.close());
  f.engine.now = () => slot + 10_000;
  f.store.saveCourse({ ...f.store.course('math')!, weeklyTasks: [
    { ...base, teacherQQ: '900' }, { ...base, id: 'other', teacherQQ: '900' },
  ] });
  const weekly = new WeeklyLesson(f.engine);
  weekly.tick(); await weekly.idle();
  assert.equal(f.store.deliveries().length, 1);
});

test('QQ 教师文件追加只取姓名，重投不重复，删除须同一教师确认', async t => {
  const f = fixture();
  t.after(() => f.store.close());
  const csv = Buffer.from('学号,姓名,邮箱\r\n1,张三,a@example.test\r\n2,李四,b@example.test\r\n');
  assert.deepEqual(parseRosterFile('名单.csv', csv), ['张三', '李四']);
  assert.throws(() => parseRosterFile('其他.csv', Buffer.from('标题\n内容'), false), /姓名/);
  let downloaded = 0;
  const access = new QQAccess(f.engine, { async isMember() { return true; } }, async () => { downloaded++; return csv; });
  const send = (id: number, text: string, actor = '900', attach = false) => access.receive({ message_type: 'private',
    user_id: actor, self_id: '999', message_id: id, message: [{ type: 'text', data: { text } },
      ...(attach ? [{ type: 'file', data: { file_id: 'file-id', file_name: '名单.csv', file_size: csv.length } }] : [])] });
  await send(1, '', '1', true);
  await send(2, '', '900', true);
  await send(2, '', '900', true);
  assert.equal(downloaded, 1);
  const roster = new Roster(f.engine);
  assert.deepEqual(roster.list('qq:900', 'math').names, ['张三', '李四']);
  assert.throws(() => roster.add('qq:1', 'math', ['王五']), /仅教师/);
  const request = await send(3, '请把张三从名单中删除。');
  assert.ok('event' in request && request.event);
  const router = new Router(f.engine, noModel);
  const signal = new AbortController().signal;
  await router.route(request.event, signal);
  const code = f.store.deliveries().find(item => item.text.includes('/roster confirm'))!.text.split(' ').at(-1)!;
  assert.deepEqual(roster.list('qq:900', 'math').names, ['张三', '李四']);
  assert.throws(() => roster.confirm('web:admin', 'math', code), /不属于/);
  const confirm = await send(4, '/roster confirm ' + code);
  assert.ok('event' in confirm && confirm.event);
  await router.route(confirm.event, signal);
  assert.deepEqual(roster.list('qq:900', 'math').names, ['李四']);
  assert.throws(() => roster.confirm('qq:900', 'math', code), /已使用/);
});

test('工作台定时任务支持旧计划、增删改、课程版本冲突与工具校验', async t => {
  const f = fixture();
  f.store.saveCourse({ ...f.store.course('math')!, weeklyLesson: { weekday: 5, time: '19:00', teacherQQ: '900', enabledAt: 1 } });
  const token = 'local-schedule-test-token';
  const server = createApi(f.engine, { adminToken: token, webhookToken: 'test-webhook' }).listen(0, '127.0.0.1');
  t.after(() => { server.close(); f.store.close(); });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const url = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/v1/courses/math/schedules';
  const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
  const get = () => fetch(url, { headers }).then(r => r.json());
  const put = (revision: number, tasks: unknown[]) => fetch(url, { method: 'PUT', headers, body: JSON.stringify({ revision, tasks }) });
  const prior = await get();
  assert.equal(prior.tasks[0].id, 'legacy-lesson');
  assert.equal((await put(prior.revision, [{ ...base, tools: ['send_group'] }])).status, 400);
  assert.equal((await put(prior.revision, [base])).status, 200);
  assert.equal((await get()).tasks[0].title, base.title);
  assert.equal((await put(prior.revision, [])).status, 409);
  const current = await get();
  assert.equal((await put(current.revision, [])).status, 200);
  assert.deepEqual((await get()).tasks, []);
});
