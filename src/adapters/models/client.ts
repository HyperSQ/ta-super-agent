import type { AgentCompletion, AgentMessage, AgentModel, Message, Model, ToolCall, ToolDefinition } from '../../ports/model.ts';
import { randomUUID } from 'node:crypto';
import { currentActivity } from '../../application/activities.ts';

export class ChatModel implements Model, AgentModel {
  options: { baseUrl: string; apiKey: string; model: string; timeoutMs: number; vision?: boolean };
  constructor(options: ChatModel['options']) { this.options = options; }
  get vision(): boolean {
    return this.options.vision ?? (this.officialDeepSeek && this.options.model === 'deepseek-flash');
  }
  private get officialDeepSeek(): boolean {
    const url = new URL(this.options.baseUrl);
    return url.protocol === 'https:' && url.hostname === 'api.deepseek.com';
  }
  async complete(messages: Message[], signal: AbortSignal, json = false): Promise<string> {
    const choice = await this.request(messages, signal, 4096, json);
    if (choice.finish_reason === 'length') throw new Error('模型输出达到长度限制，未生成完整答复');
    if (choice.finish_reason === 'content_filter') throw new Error('模型未生成可用内容');
    const text = choice.message?.content;
    if (typeof text !== 'string' || !text.trim()) throw new Error('模型未返回可用内容');
    return text;
  }
  async completeTurn(messages: AgentMessage[], tools: ToolDefinition[], signal: AbortSignal, maxTokens: number): Promise<AgentCompletion> {
    const choice = await this.request(messages, signal, maxTokens, true, tools);
    const calls = choice.message?.tool_calls;
    if (choice.finish_reason === 'tool_calls' && (!Array.isArray(calls) || calls.length === 0 || calls.length > 4 || !calls.every(validCall)
      || new Set(calls.map(call => call.id)).size !== calls.length)) throw new Error('模型工具调用不完整或数量超限');
    return {
      finishReason: typeof choice.finish_reason === 'string' ? choice.finish_reason : '',
      content: typeof choice.message?.content === 'string' ? choice.message.content : null,
      toolCalls: choice.finish_reason === 'tool_calls' ? calls as ToolCall[] : [],
      reasoning: typeof choice.message?.reasoning_content === 'string' ? choice.message.reasoning_content : undefined,
    };
  }
  private async request(messages: AgentMessage[], signal: AbortSignal, maxTokens: number, json: boolean, tools?: ToolDefinition[]) {
    const requestId = randomUUID(), started = Date.now();
    const input = {
      model: this.options.model, messages, max_tokens: maxTokens,
      ...(this.officialDeepSeek ? { thinking: { type: 'disabled' } } : {}),
      ...(json ? { response_format: { type: 'json_object' } } : {}),
      ...(tools?.length ? { tools, tool_choice: 'auto' } : {}),
    };
    currentActivity('model.request', '模型请求', { requestId, input });
    try {
      const response = await this.fetchChoice(input, signal);
      const { content, tool_calls } = response.choice.message!;
      currentActivity('model.response', '模型返回', {
        requestId, durationMs: Date.now() - started, finishReason: response.choice.finish_reason, content, toolCalls: tool_calls, usage: response.usage,
      });
      return response.choice;
    } catch (error) {
      currentActivity('model.error', '模型请求失败', { requestId, durationMs: Date.now() - started, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
  private async fetchChoice(input: object, signal: AbortSignal) {
    if (!this.options.apiKey) throw new Error('未配置模型，任务保留为blocked；配置后可通过教师操作恢复');
    const baseUrl = this.options.baseUrl.replace(/\/$/, '');
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST', headers: { authorization: `Bearer ${this.options.apiKey}`, 'content-type': 'application/json' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.options.timeoutMs)]),
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`模型请求失败：HTTP ${response.status}`);
    const data = await response.json() as { usage?: unknown; choices?: { finish_reason?: string; message?: { content?: unknown; tool_calls?: unknown; reasoning_content?: unknown } }[] };
    const choice = data.choices?.[0];
    if (!choice?.message) throw new Error('模型未返回有效的消息');
    return { choice, usage: data.usage };
  }
}

function validCall(value: unknown): value is ToolCall {
  const call = value as ToolCall | undefined;
  return call?.type === 'function' && typeof call.id === 'string' && !!call.id
    && typeof call.function?.name === 'string' && typeof call.function.arguments === 'string';
}
