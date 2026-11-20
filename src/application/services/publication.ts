import type { Delivery, Task } from '../../domain/model.ts';

export function publishedDeliveries(deliveries: Delivery[], groupId?: string): Delivery[] {
  if (!groupId) return [];
  return deliveries.filter(delivery => delivery.status === 'sent' &&
    delivery.channel.kind === 'qq-group' && delivery.channel.target === groupId);
}

export function resultPublished(task: Task, deliveries: Delivery[]): boolean {
  const parts = deliveries.filter(delivery => delivery.taskId === task.id &&
    delivery.revision === task.revision && delivery.inputEpoch === task.inputEpoch && !delivery.fileId && !delivery.imageId);
  return !!task.result && parts.map(delivery => delivery.text).join('\n') === task.result;
}

export function artifactPublished(artifact: NonNullable<Task['artifacts']>[number], deliveries: Delivery[]): boolean {
  return !!artifact.deliveryEventId && deliveries.some(delivery => delivery.replyEventId === artifact.deliveryEventId && !!delivery.fileId);
}
