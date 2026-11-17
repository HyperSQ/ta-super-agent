export type Config = {
  host: string; port: number; databasePath: string; adminToken: string; webhookToken: string;
  teacherQQ: string[]; concurrency: number; sendEnabled: boolean; llbotUrl: string; llbotToken: string;
  reclassifyEnabled: boolean;
  batchMs: number;
  libraryPath: string;
  pdfRenderer: string;
  headless?: { launcher: string; workspace: string; timeoutMs: number };
  embedding?: { url: string; apiKey: string; model: string; fingerprint: string; dimensions: number; queryPrefix: string };
  model: { baseUrl: string; apiKey: string; model: string; timeoutMs: number; vision?: boolean };
};
export function loadConfig(env = process.env): Config {
  const adminToken = env.ADMIN_TOKEN ?? '', webhookToken = env.QQ_WEBHOOK_TOKEN ?? '';
  if (adminToken.length < 16 || webhookToken.length < 16 || adminToken === webhookToken) throw new Error('请配置两个不同的至少16字符ADMIN_TOKEN和QQ_WEBHOOK_TOKEN');
  const integer = (name: string, fallback: number, max: number) => {
    const value = Number(env[name] ?? fallback);
    if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new Error(`${name}配置无效`);
    return value;
  };
  const teacherQQ = (env.TEACHER_QQ_IDS ?? '').split(',').map(x => x.trim()).filter(Boolean);
  if (teacherQQ.some(x => !/^\d+$/.test(x))) throw new Error('教师QQ必须为数字ID');
  const embedding = env.EMBEDDING_URL ? {
    url: env.EMBEDDING_URL, apiKey: env.EMBEDDING_API_KEY ?? '', model: env.EMBEDDING_MODEL ?? '',
    fingerprint: env.EMBEDDING_CONFIG_HASH ?? '', dimensions: integer('EMBEDDING_DIMENSIONS', 1024, 16384),
    queryPrefix: env.EMBEDDING_QUERY_PREFIX?.replace(/\\n/g, '\n') ?? '',
  } : undefined;
  if (embedding && (!embedding.model || !embedding.fingerprint || !/^https?:\/\//.test(embedding.url))) throw new Error('Embedding需配置有效URL、模型和完整编码配置指纹');
  const batchRaw = (env.TA_BATCH_MS ?? '').trim();
  const batchMs = batchRaw === '' || batchRaw === '0' ? 0 : integer('TA_BATCH_MS', 1500, 10_000);
  return {
    host: env.HOST ?? '127.0.0.1', port: integer('PORT', 8787, 65535), databasePath: env.DATABASE_PATH ?? 'var/db/ta.sqlite',
    adminToken, webhookToken, teacherQQ, concurrency: integer('WORKER_CONCURRENCY', 3, 32),
    sendEnabled: env.QQ_SEND_ENABLED === 'true', llbotUrl: env.LLBOT_HTTP_URL ?? 'http://127.0.0.1:13010', llbotToken: env.LLBOT_ACCESS_TOKEN ?? '',
    reclassifyEnabled: env.THREAD_RECLASSIFY_ENABLED === 'true',
    batchMs,
    libraryPath: env.LIBRARY_PATH ?? 'var/library', pdfRenderer: env.PDF_RENDERER ?? 'pdftoppm', embedding,
    headless: env.TA_DSH_LAUNCHER ? { launcher: env.TA_DSH_LAUNCHER, workspace: env.TA_DSH_WORKSPACE ?? 'var/dsh',
      timeoutMs: integer('TA_DSH_TIMEOUT_MS', 240000, 900000) } : undefined,
    model: { baseUrl: env.MODEL_BASE_URL ?? 'https://api.deepseek.com', apiKey: env.MODEL_API_KEY ?? '', model: env.MODEL_NAME ?? 'deepseek-chat', timeoutMs: integer('MODEL_TIMEOUT_MS', 60000, 90000),
      vision: env.MODEL_VISION_ENABLED ? env.MODEL_VISION_ENABLED === 'true' : undefined },
  };
}
