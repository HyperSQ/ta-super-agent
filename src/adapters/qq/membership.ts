import { DomainError } from '../../domain/model.ts';
import type { GroupMembership } from '../../ports/qq-access.ts';

/** Fetches group membership from the dedicated LLBot, never from names or chat claims. */
export class LLBotMembership implements GroupMembership {
  url: string; token: string;
  constructor(url: string, token: string) { this.url = url.replace(/\/$/, ''); this.token = token; }
  async isMember(groupId: string, userId: string, signal?: AbortSignal): Promise<boolean> {
    if (!/^\d+$/.test(groupId) || !/^\d+$/.test(userId)) throw new DomainError('forbidden', '群号或QQ号无效');
    try {
      const response = await fetch(this.url + '/get_group_member_list', {
        method: 'POST', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
        headers: { 'content-type': 'application/json', ...(this.token ? { authorization: 'Bearer ' + this.token } : {}) },
        body: JSON.stringify({ group_id: groupId, no_cache: true }),
      });
      if (!response.ok) throw new Error();
      const result = await response.json() as { status?: string; retcode?: number; data?: unknown };
      if (result.status !== 'ok' || result.retcode !== 0 || !Array.isArray(result.data)
        || result.data.some(row => !row || typeof row !== 'object' || !/^\d+$/.test(String(row.user_id))
          || (row.group_id !== undefined && String(row.group_id) !== groupId))) throw new Error();
      return result.data.some(row => String(row.user_id) === userId);
    } catch {
      signal?.throwIfAborted();
      throw new DomainError('unavailable', '暂时无法核实课程群成员资格，稍后重试');
    }
  }
}
