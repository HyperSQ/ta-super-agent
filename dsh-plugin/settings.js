import { harnessPackage } from './harness.js';
const { default: z } = await harnessPackage('@deepseek-ai/schemastery');

export const name = 'ta-super-agent-connection';
export const Config = z.object({
  host: z.string().default('').description('助教服务器 IP 或主机名').volatile(),
  port: z.number().step(1).min(1).max(65535).default(22).description('SSH 端口').volatile(),
  username: z.string().default('root').description('SSH 用户名').volatile(),
  password: z.string().default('').description('SSH 密码').role('secret').volatile(),
  fingerprint: z.string().default('').description('服务器 SSH 主机指纹 SHA256:…').volatile(),
  remoteDir: z.string().default('/opt/ta-super-agent').description('独立助教服务目录').volatile(),
  apiPort: z.number().step(1).min(1).max(65535).default(18787).description('助教 API 内网端口').volatile(),
  courseId: z.string().default('').description('可选，自动加载近况的课程 ID').volatile(),
});

export function apply(ctx, config) {
  ctx.provide('taSuperAgentConnection', () =>
    Object.fromEntries(Object.entries(config).map(([name, value]) => [name, value.get()])));
}
