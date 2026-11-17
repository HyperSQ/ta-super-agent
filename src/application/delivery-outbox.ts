import type { Delivery, Event } from '../domain/model.ts';
import { DomainError } from '../domain/model.ts';
import { TaskEngine } from './task-engine.ts';
import { activity } from './activities.ts';
export type SendReceipt = { externalId: string; png?: Buffer } | { fileUploaded: true; externalFileId?: string };
export interface Sender { send(delivery: Delivery, event: Event): Promise<SendReceipt> }

export class DeliveryOutbox {
  engine: TaskEngine; sender: Sender; enabled: boolean;
  private busy = false;
  constructor(engine: TaskEngine, sender: Sender, enabled = false) { this.engine = engine; this.sender = sender; this.enabled = enabled; }
  async tick(): Promise<void> {
    if (this.busy || !this.enabled) return;
    this.busy = true;
    try {
      for (const candidate of this.engine.store.deliveries()) {
        if (candidate.status !== 'pending') continue;
        const d = this.engine.claimDelivery(candidate.id);
        if (!d) continue;
        const scope = { node: 'outbox' as const, courseId: this.engine.store.event(d.replyEventId)!.courseId, eventId: d.replyEventId, taskId: d.taskId };
        activity(this.engine.store, scope, 'delivery.start', '尝试交付', d);
        try { this.engine.settleDelivery(d.id, await this.sender.send(d, this.engine.store.event(d.replyEventId)!)); }
        catch (error) {
          if (error instanceof DomainError && ['forbidden', 'stale', 'not_found', 'unavailable', 'render_failed'].includes(error.code)) {
            this.engine.rejectDelivery(d.id, error.message, error.code === 'unavailable');
          } else this.engine.settleDelivery(d.id, { error: error instanceof Error ? error.message : '发送结果不明' });
        }
        const result = this.engine.store.delivery(d.id);
        activity(this.engine.store, scope, `delivery.${result?.status ?? 'unknown'}`, '交付回执', result);
      }
    } finally { this.busy = false; }
  }
}
