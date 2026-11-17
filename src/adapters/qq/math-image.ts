import { request } from 'node:http';

const formula = /(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|(?<!\\)\$[^$\n]+?(?<!\\)\$)/;
const code = /(\x60\x60\x60[\s\S]*?\x60\x60\x60|~~~[\s\S]*?~~~|\x60[^\x60\n]*\x60)/g;
export const hasFormula = (text: string) => text.split(code).some((part, i) => i % 2 === 0 && formula.test(part));

export function mathImage(socketPath: string, text: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path: '/render', method: 'POST' }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('公式渲染服务未完成'));
        return;
      }
      const parts: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 3 * 1024 * 1024) res.destroy(new Error('公式图片过大'));
        else parts.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => {
        const image = Buffer.concat(parts);
        if (image.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') reject(new Error('公式图片格式无效'));
        else resolve(image);
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('公式渲染超时')), 18000);
    req.once('close', () => clearTimeout(timer));
    req.on('error', reject);
    req.end(text);
  });
}
