import type { Worker } from './qa-worker.ts';
import type { TeacherWork } from '../../application/services/teacher-work.ts';

export function teachingAffairsWorker(work: TeacherWork): Worker {
  return async ({ run, signal, complete, handoff }) => {
    const origin = run.history[0]?.event;
    if (run.task.kind !== 'teaching-affairs' || !origin || !complete) throw Error('教学事务执行上下文不完整');
    let receipt: string | undefined;
    await work.execute(origin, signal, result => {
      // The original business transaction and the QQ receipt commit together.
      complete(result);
      receipt = result;
    }, handoff);
    if (!receipt) throw Error('教学事务未提交有效回执');
    return receipt;
  };
}
