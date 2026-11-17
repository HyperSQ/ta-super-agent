import { randomUUID } from 'node:crypto';
import { readFileSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { Marked } from 'marked';
import { renderToString } from 'katex';
import puppeteer from 'puppeteer-core';

// Port of AI-chat's markdownToMathHtml / reply_with_latex pipeline.
const require = createRequire(import.meta.url);
const cssPath = require.resolve('katex/dist/katex.min.css');
const css = readFileSync(cssPath, 'utf8').replace(/url\(fonts\/([^)]*)\)/g, (_, name) => {
  const ext = name.split('.').at(-1);
  return 'url(data:font/' + ext + ';base64,' + readFileSync(join(dirname(cssPath), 'fonts', name)).toString('base64') + ')';
});
const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const markdown = new Marked({
  async: false,
  renderer: {
    html: ({ text }) => escape(text),
    image: ({ text }) => escape(text),
    link: ({ tokens }) => tokens.map(token => escape(token.raw)).join(''),
  },
});

function html(text: string): string {
  const prefix = 'TAMATH' + randomUUID().replaceAll('-', '');
  const expressions: { token: string; tex: string; displayMode: boolean }[] = [];
  const protectedText = text.split(/(\x60\x60\x60[\s\S]*?\x60\x60\x60|~~~[\s\S]*?~~~|\x60[^\x60\n]*\x60)/g)
    .map((part, i) => i % 2 ? part : part.replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(?<!\\)\$([^$\n]+?)(?<!\\)\$/g,
      (_, block, bracket, paren, inline) => {
        const token = prefix + expressions.length + 'END';
        expressions.push({ token, tex: (block ?? bracket ?? paren ?? inline).trim(), displayMode: block !== undefined || bracket !== undefined });
        return token;
      })).join('');
  let body = markdown.parse(protectedText, { async: false });
  for (const { token, tex, displayMode } of expressions) {
    body = body.replaceAll(token, () => renderToString(tex, { displayMode, trust: false, throwOnError: false, maxExpand: 300, maxSize: 15 }));
  }
  return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; font-src data:"><style>'
    + css + 'body{margin:0;padding:24px;background:#edf4f1;color:#173128;font:22px/1.65 "Noto Sans CJK SC",sans-serif} main{padding:26px;border-radius:12px;background:white;overflow-wrap:anywhere;overflow:hidden}p{margin:0 0 .7em}p:last-child{margin-bottom:0}.katex-display{overflow:hidden;margin:.8em 0}pre{white-space:pre-wrap}</style><main>' + body + '</main></html>';
}

async function render(text: string) {
  const browser = await puppeteer.launch({
    executablePath: process.env.TA_MATH_CHROMIUM, pipe: true, headless: 'shell', timeout: 8000,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-background-networking'],
  });
  try {
    const page = await browser.newPage();
    await page.setJavaScriptEnabled(false);
    await page.setViewport({ width: 840, height: 400, deviceScaleFactor: 1.35 });
    await page.setContent(html(text), { waitUntil: 'load', timeout: 6000 });
    const panel = await page.$('main');
    const box = await panel?.boundingBox();
    if (!panel || !box || box.height > 2200) throw new Error('版面超过单张图片');
    return await panel.screenshot({ type: 'png' });
  } finally { await browser.close(); }
}

const socket = process.env.TA_MATH_SOCKET || '/run/ta-math/render.sock';
try { unlinkSync(socket); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
let busy = false;
const server = createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/render') { res.writeHead(404).end(); return; }
  if (busy) { res.writeHead(503).end(); return; }
  busy = true;
  try {
    const chunks: Buffer[] = [];
    let length = 0;
    for await (const chunk of req) {
      length += chunk.length;
      if (length > 18000) throw new Error('公式输入过长');
      chunks.push(chunk);
    }
    const png = await render(Buffer.concat(chunks).toString('utf8'));
    res.writeHead(200, { 'content-type': 'image/png' }).end(png);
  } catch (error) {
    console.error('公式渲染失败:', error instanceof Error ? error.message.split('\n')[0] : 'unknown');
    res.writeHead(422).end();
  } finally { busy = false; }
});
server.requestTimeout = 20000;
server.listen(socket);
