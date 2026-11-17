import type { ReplyAction } from '../domain/model.ts';
import { hasFormula } from '../adapters/qq/math-image.ts';

export const replyRule = `需要进一步查证时调用已提供的读工具。准备结束时只输出一个完整 JSON 对象，不要加围栏或草稿：
{"action":"send","format":"text","content":"最终回复"}；自然需要分条时 content 可以是最多三条文字的数组。
{"action":"send","format":"latex","content":"完整渲染内容"}；数学公式和正式证明使用 LaTeX，公式用 $...$ 或 $$...$$。
{"action":"silent"}；用户说不用回复时采用此动作，不回确认。
以上为程序结束决定，不能填收件人、课程号或其他字段。默认短答一条，少用 emoji；问如何起步先给下一步，不强塞完整证明。不要播报查资料过程，不重复发送文字和图片。`;

export function parseReply(content: string | null, turnId: string): ReplyAction | undefined {
  if (!content || content.length > 12000) return;
  let item: Record<string, unknown>;
  try { item = JSON.parse(content); } catch { return; }
  if (!item || typeof item !== 'object' || Array.isArray(item)) return;
  if (item.protocol !== 'ta-reply-v1' || item.turn_id !== turnId) return;
  delete item.protocol; delete item.turn_id;
  const keys = Object.keys(item).sort().join(',');
  if (keys === 'action' && item.action === 'silent') return { action: 'silent' };
  if (keys !== 'action,content,format' || item.action !== 'send') return;
  if (item.format === 'latex' && typeof item.content === 'string' && item.content.trim() && item.content.length <= 8000)
    return { action: 'send', format: 'latex', content: item.content.trim() };
  if (item.format !== 'text') return;
  const raw = Array.isArray(item.content) ? item.content : [item.content];
  if (!raw.length || raw.length > 3 || !raw.every(part => typeof part === 'string' && !!part.trim() && part.length <= 3000)) return;
  if (raw.some(hasFormula)) {
    const text = raw.join('\n\n').trim();
    return text.length <= 8000 ? { action: 'send', format: 'latex', content: text } : undefined;
  }
  const parts = raw.flatMap((part: string) => {
    const text = part.trim().replace(/\r\n?/g, '\n');
    if (/(?:^|\n)\s*(?:`{3,}|~{3,})/.test(text)) return [text];
    return text.split(/\n[ \t]*\n(?:[ \t]*\n)*/).map(p => p.trim().replace(/[ \t]*\n[ \t]*/g, ' ')).filter(Boolean);
  });
  const unique = [...new Map(parts.map(p => [p.replace(/\s+/g, ' '), p])).values()];
  const limited = unique.length > 3 ? [...unique.slice(0, 2), unique.slice(2).join(' ')] : unique;
  if (!limited.length || limited.some(part => part.length > 3000)) return;
  return { action: 'send', format: 'text', content: limited };
}
