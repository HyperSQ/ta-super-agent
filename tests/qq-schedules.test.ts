import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { Router } from '../src/agents/router.ts';
import { WeeklyLesson, weeklyTasks } from '../src/application/weekly-lesson.ts';
import type { AgentCompletion } from '../src/ports/model.ts';
import { fixture } from './helpers.ts';

const invoke = (name: string, params: object = {}): AgentCompletion => ({
  finishReason: 'tool_calls', content: null, toolCalls: [{
    id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(params) },
  }],
});
const decide = (decision: object): AgentCompletion => ({
  finishReason: 'stop', content: JSON.stringify(decision), toolCalls: [],
});

test('教师用自然语言登记、首跑、更新与暂停任意周任务；学生无法写入', async t => {
  const f = fixture();
  t.after(() => f.store.close());
  let now = Date.parse('2026-11-19T12:00:00+08:00');
  f.engine.now = () => now;
  f.store.saveCourse({ ...f.store.course('math')!, progress: '学到 1.2 节', progressAt: now });
  let action: (id: string | undefined) => AgentCompletion;
  let calls = 0;
  const router = new Router(f.engine, {
    async complete() { throw Error('教师规划应提供工具'); },
    async completeTurn(messages, tools) {
      calls++;
      assert.ok(tools.some(tool => tool.function.name === 'save_schedule'));
      const last = messages.at(-1)!;
      if (last.role !== 'tool') return invoke('list_schedules');
      const data = JSON.parse(String(last.content));
      if (data.error) return decide({ action: 'reply', text: data.error });
      return action(data.tasks?.[0]?.id);
    },
  }, undefined, undefined, undefined, { dshAvailable: true, groupSending: true });
  const signal = new AbortController().signal;
  async function send(text: string, teacher = true) {
    const id = randomUUID(), qq = teacher ? '900' : '1';
    const { event } = f.engine.receive({ courseId: 'math', threadId: 'chat-' + qq, actorId: 'qq:' + qq,
      sourceKey: id, externalId: id, text, receivedAt: now, channel: { kind: 'qq-private', target: qq } });
    await router.route(event, signal);
    return f.store.deliveries().find(item => item.replyEventId === event.id)?.text ?? '';
  }
  const command = '以后礼拜五晚上八点，弄份好玩的互评练习，Notebook 要跑通，打包扔咱们课程群里';
  await send(command, false);
  assert.equal(calls, 0);
  assert.deepEqual(weeklyTasks(f.store.course('math')!), []);
  f.store.saveCourse({ ...f.store.course('math')!, groupId: undefined });
  action = () => invoke('save_schedule', { title: 'Notebook 互评', prompt: '验证 Notebook，再打包 ZIP 发往课程群。',
    weekday: 5, time: '20:00', worker: 'dsh', tools: ['class_context', 'send_group_file'] });
  assert.match(await send(command), /已登记.*每周五 20:00/);
  const [saved] = weeklyTasks(f.store.course('math')!);
  assert.equal(saved.worker, 'dsh');
  assert.match(saved.prompt, /Notebook/);
  assert.ok(saved.tools.includes('send_group_file'));

  action = id => invoke('run_schedule', { scheduleId: id, mode: 'first' });
  assert.match(await send('那先给他们试一版吧'), /未绑定 QQ 群/);
  f.store.saveCourse({ ...f.store.course('math')!, groupId: '100' });
  assert.match(await send('那先给他们试一版吧'), /已进入执行队列/);
  assert.match(await send('第一次那个，试着走一遍'), /已登记过/);
  const triggered = f.store.pendingEvents().filter(event => event.scheduled === 'custom');
  assert.equal(triggered.length, 1);
  assert.deepEqual(triggered[0].scheduledTools, saved.tools);
  assert.equal(triggered[0].scheduledWorker, 'dsh');
  await router.route(triggered[0], signal);
  assert.ok(f.store.tasks().some(task => task.kind === 'scheduled' && task.grant.originEventId === triggered[0].id));

  action = id => invoke('save_schedule', { scheduleId: id, weekday: 4, time: '21:00' });
  assert.match(await send('以后的换礼拜四九点，做法照旧'), /已更新.*每周四 21:00/);
  const [updated] = weeklyTasks(f.store.course('math')!);
  assert.equal(updated.id, saved.id);
  assert.equal(updated.prompt, saved.prompt);
  assert.deepEqual(updated.tools, saved.tools);

  now = Date.parse('2026-11-19T21:00:01+08:00');
  const weekly = new WeeklyLesson(f.engine);
  weekly.tick();
  await weekly.idle();
  const recurring = f.store.eventByKey(JSON.stringify(['weekly-task', 'math', saved.id, '2026-11-19']));
  assert.equal(recurring?.scheduled, 'custom');
  assert.notEqual(recurring?.id, triggered[0].id);
  action = id => invoke('save_schedule', { scheduleId: id, enabled: false });
  assert.match(await send('互评先停一停'), /已暂停/);
  assert.equal(weeklyTasks(f.store.course('math')!)[0].enabled, false);
});

test('同一句话可新建并触发首跑；课程版本过期时整次操作保留原状态', async t => {
  const f = fixture();
  t.after(() => f.store.close());
  let concurrentlyEdit = true;
  const router = new Router(f.engine, {
    async complete() { throw Error('教师规划应提供工具'); },
    async completeTurn(messages) {
      const last = messages.at(-1)!;
      if (last.role !== 'tool') return invoke('list_schedules');
      const data = JSON.parse(String(last.content));
      if (data.error) return decide({ action: 'reply', text: data.error });
      if (concurrentlyEdit) {
        const course = f.store.course('math')!;
        f.engine.updateCourse('web:admin', { ...course, instructions: '工作台刚更新' }, course.revision ?? 1);
      }
      return invoke('save_schedule', { title: '周日复盘', prompt: '根据课程记录生成一份助教复盘。',
        weekday: 0, time: '20:00', tools: ['class_context'], run: 'first' });
    },
  });
  const event = (source: string) => f.engine.receive({ courseId: 'math', threadId: 'teacher-schedules', actorId: 'qq:900',
    sourceKey: source, externalId: source, channel: { kind: 'qq-private', target: '900' }, receivedAt: f.engine.now(),
    text: '每个礼拜天晚上八点把这一周的情况理一遍，先做一份看看' }).event;
  const signal = new AbortController().signal;
  await router.route(event('stale'), signal);
  assert.deepEqual(weeklyTasks(f.store.course('math')!), []);
  assert.equal(f.store.pendingEvents().filter(item => item.scheduled === 'custom').length, 0);
  concurrentlyEdit = false;
  const request = event('fresh');
  await router.route(request, signal);
  await router.route(request, signal);
  assert.equal(weeklyTasks(f.store.course('math')!).length, 1);
  assert.equal(f.store.pendingEvents().filter(item => item.scheduled === 'custom').length, 1);
});
