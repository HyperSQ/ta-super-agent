import { Store } from '../src/adapters/storage/sqlite.ts';
import { Policy } from '../src/security/policy.ts';
import { TaskEngine } from '../src/application/task-engine.ts';
import type { Event } from '../src/domain/model.ts';
import { randomUUID } from 'node:crypto';

export function fixture(path = ':memory:') {
  const store = new Store(path), policy = new Policy(['900']);
  const engine = new TaskEngine(store, policy);
  if (!store.course('math')) engine.createCourse('web:admin', { id: 'math', title: '数学分析', groupId: '100', instructions: '注重推导过程' });
  const receive = (text: string, options: { actorId?: string; threadId?: string; sourceKey?: string; courseId?: string } = {}): Event => engine.receive({
    sourceKey: options.sourceKey ?? randomUUID(), courseId: options.courseId ?? 'math', threadId: options.threadId ?? randomUUID(),
    actorId: options.actorId ?? 'qq:1', text, receivedAt: Date.now(),
    channel: { kind: 'qq-group', target: store.course(options.courseId ?? 'math')?.groupId ?? '100' }, externalId: randomUUID(),
  }).event;
  return { store, policy, engine, receive };
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
