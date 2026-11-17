import { Store } from '../src/adapters/storage/sqlite.ts';
import { Policy } from '../src/security/policy.ts';
import { TaskEngine } from '../src/application/task-engine.ts';
import { receiveQQ } from '../src/adapters/qq/llbot.ts';
import type { QQMessage } from '../src/adapters/qq/llbot.ts';
import { Router } from '../src/agents/router.ts';
import { TaskRunner } from '../src/application/task-runner.ts';
import { DeliveryOutbox } from '../src/application/delivery-outbox.ts';

// Deterministic demonstration of infrastructure; no model, QQ, or network calls.
const store = new Store(':memory:');
try {
  const engine = new TaskEngine(store, new Policy(['900']));
  engine.createCourse('web:admin', { id: 'math', title: '数学分析', groupId: '100', instructions: '' });
  const router = new Router(engine, { complete: async () => { throw new Error('演示不调用模型'); } });
  const message = (id: number, user: number, text: string, quote?: number): QQMessage => ({
    message_type: 'group', self_id: 999, group_id: 100, user_id: user, message_id: id,
    message: [...(quote ? [{ type: 'reply', data: { id: quote } }] : [{ type: 'at', data: { qq: 999 } }]), { type: 'text', data: { text } }],
  });
  for (const raw of [message(101, 1, '第2题换序条件是什么？'), message(102, 2, '第3题的极限怎么求？')]) {
    const received = receiveQQ(engine, raw);
    if ('event' in received) await router.route(received.event, new AbortController().signal);
  }
  const runner = new TaskRunner(engine, async ({ run }) => `【模拟答复，非数学解答】任务仅看到：${run.history.map(i => i.event.text).join('；')}`, 2);
  let sent = 200;
  const outbox = new DeliveryOutbox(engine, { send: async (d, event) => {
    console.log(JSON.stringify({ replyTo: event.externalId, student: event.actor.id, text: d.text }));
    return { externalId: String(++sent) };
  } }, true);
  runner.tick(); await runner.idle(); await outbox.tick();
  receiveQQ(engine, message(103, 1, '为什么需要绝对可积？', 201));
  runner.tick(); await runner.idle(); await outbox.tick();
  console.log(`演示完成：${store.tasks().length} 个独立任务，${store.deliveries().filter(d => d.status === 'sent').length} 次模拟交付；未连接外部服务。`);
} finally { store.close(); }
