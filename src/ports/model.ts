export type Message = { role: 'system' | 'user' | 'assistant'; content: string };
export interface Model {
  complete(messages: Message[], signal: AbortSignal, json?: boolean): Promise<string>;
}

export type VisualContent = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type AgentMessage = Message
  | { role: 'assistant'; content: string | null; tool_calls: ToolCall[]; reasoning_content?: string }
  | { role: 'tool'; tool_call_id: string; content: string | VisualContent[] };
export type ToolDefinition = { type: 'function'; function: { name: string; description: string; parameters: object } };
export type AgentCompletion = { finishReason: string; content: string | null; toolCalls: ToolCall[]; reasoning?: string };
export interface AgentModel {
  readonly vision: boolean;
  completeTurn(messages: AgentMessage[], tools: ToolDefinition[], signal: AbortSignal, maxTokens: number): Promise<AgentCompletion>;
}
