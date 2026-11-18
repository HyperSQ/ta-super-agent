import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fixture } from './helpers.ts';
import { Router } from '../src/agents/router.ts';
import { RouterSessions } from '../src/application/router-sessions.ts';
import type { Event } from '../src/domain/model.ts';

const signal = new AbortController().signal;

function event(f: ReturnType<typeof fixture>): Event {
  return f.engine.receive({ sourceKey: randomUUID(), externalId: randomUUID(), threadId: 'thread-router', courseId: 'math',
    actorId: 'qq:1', channel: { kind: 'qq-private', target: '1' }, receivedAt: f.engine.now(), text: '我作业交了吗' }).event;
}

test('Router 保留常驻会话：消息、决策与 Worker 报告进入同一线程', async () => {
  const f = fixture();
  try {
    const router = new Router(f.engine, { async complete(): Promise<string> { throw new Error('不应调用模型'); } });
    const first = event(f);
    await router.route(first, signal);
    const sessions = new RouterSessions(f.engine);
    const session = sessions.ensure('math', 'thread-router');
    let turns = sessions.recent(session);
    assert.equal(turns[0].role, 'user');
    assert.equal(turns[0].content, '我作业交了吗');
    assert.equal(sessions.decisions('math').length, 1);
    assert.equal((sessions.decisions('math')[0] as { action: string }).action, 'create');

    const task = f.store.tasks().find(item => item.courseId === 'math')!;
    const run = f.engine.claim(task.id)!;
    f.engine.finish(run, '还没交，第 3 次作业截止到 12 月 20 日。', { source: 'worker' });
    turns = sessions.recent(sessions.ensure('math', 'thread-router'));
    assert.ok(turns.some(turn => turn.role === 'assistant' && turn.content.includes('[completed]')));
  } finally { f.store.close(); }
});
