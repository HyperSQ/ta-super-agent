import type { Delivery, Event, Run } from '../domain/model.ts';

export interface GroupMembership {
  isMember(groupId: string, userId: string, signal?: AbortSignal): Promise<boolean>;
}
export interface QQSendGuard {
  authorizeDelivery(delivery: Delivery, event: Event): Promise<void>;
  assertDeliveryTarget(delivery: Delivery, event: Event): void;
}
export interface RunGuard {
  authorizeRun(run: Run, signal: AbortSignal): Promise<void>;
}
