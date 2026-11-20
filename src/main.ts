import { loadConfig } from './config.ts';
import { Store } from './adapters/storage/sqlite.ts';
import { Policy } from './security/policy.ts';
import { TaskEngine } from './application/task-engine.ts';
import { ChatModel } from './adapters/models/client.ts';
import { Router } from './agents/router.ts';
import { ThreadClassifier } from './agents/thread-classifier.ts';
import { qaWorker } from './agents/workers/qa-worker.ts';
import { lessonWorker } from './agents/workers/lesson-worker.ts';
import { scheduledWorker } from './agents/workers/scheduled-worker.ts';
import { TaskRunner } from './application/task-runner.ts';
import { DeliveryOutbox } from './application/delivery-outbox.ts';
import { LLBotSender } from './adapters/qq/llbot.ts';
import { Runtime } from './application/runtime.ts';
import { createApi } from './http/server.ts';
import { MemoryService } from './application/services/memory.ts';
import { MemoryUpdater } from './application/memory-updater.ts';
import { ContextBuilder } from './agents/context-builder.ts';
import { TextbookLibrary } from './adapters/knowledge/library.ts';
import { HttpEmbedding } from './adapters/models/embedding.ts';
import { QQAccess } from './application/services/qq-access.ts';
import { LLBotMembership } from './adapters/qq/membership.ts';
import { qqRosterFile } from './adapters/qq/roster-file.ts';
import { qqAttachmentReader } from './adapters/qq/attachments.ts';
import { TextbookReferences } from './adapters/knowledge/references.ts';
import { textbookPageReader } from './adapters/knowledge/pdf-page.ts';
import { pdfImageReader } from './adapters/documents/pdf-image.ts';
import { QATools } from './agents/qa-tools.ts';
import { dshWorker } from './agents/workers/dsh-worker.ts';
import { DSH } from './application/services/dsh.ts';
import { CourseMail, mailKey } from './application/services/course-mail.ts';
import { PythonMailTransport } from './adapters/mail/transport.ts';
import { teachingAffairsWorker } from './agents/workers/teaching-affairs-worker.ts';
import { courseworkWorker } from './agents/workers/coursework-worker.ts';
import { Watchdog } from './application/watchdog.ts';
import { GradingBatches } from './application/grading-batches.ts';
import { CourseFiles } from './application/services/course-files.ts';
import { GroupFiles } from './application/services/group-files.ts';
import { CourseworkIntake } from './application/services/coursework-intake.ts';
import { SubmissionFiles } from './application/services/submission-files.ts';
import { dirname, join } from 'node:path';

const config = loadConfig();
const store = new Store(config.databasePath);
const engine = new TaskEngine(store, new Policy(config.teacherQQ));
engine.reviewFeedback = config.reclassifyEnabled;
const model = new ChatModel(config.model);
const embedding = config.embedding ? new HttpEmbedding(config.embedding) : undefined;
const memory = new MemoryService(engine, embedding);
const references = new TextbookReferences(config.libraryPath);
const knowledge = new TextbookLibrary(config.libraryPath, embedding);
const attachments = qqAttachmentReader(config.llbotUrl, config.llbotToken);
const contextBuilder = new ContextBuilder(memory, knowledge, references, model);
const filesRoot = join(dirname(config.databasePath), 'files');
const courseFiles = new CourseFiles(engine, { artifacts: config.headless?.workspace ?? 'var/dsh', group: filesRoot });
const groupFiles = new GroupFiles(courseFiles, filesRoot, qqAttachmentReader(config.llbotUrl, config.llbotToken, fetch, 50 * 1024 * 1024));
const qaTools = new QATools(engine, knowledge, references, textbookPageReader(config.libraryPath, config.pdfRenderer), attachments,
  pdfImageReader(config.pdfRenderer), courseFiles);
const qqAccess = new QQAccess(engine, new LLBotMembership(config.llbotUrl, config.llbotToken), qqRosterFile(config.llbotUrl, config.llbotToken));
const answer = qaWorker(model, qaTools, contextBuilder);
const prepareLesson = lessonWorker(engine, model, knowledge, references);
const nativeScheduled = scheduledWorker(engine, model, qaTools, prepareLesson);
const headless = config.headless && dshWorker(engine, qaTools, new DSH(engine, config.adminToken, attachments), prepareLesson, config.headless, config.model);
const runScheduled: typeof nativeScheduled = context => {
  if (context.run.history[0]?.event.scheduledWorker !== 'dsh') return nativeScheduled(context);
  if (!headless) throw Error('此服务器尚未启用隔离 DSH Worker');
  return headless(context);
};
const submissionFiles = new SubmissionFiles(engine, join(filesRoot, 'submission'));
const coursework = new CourseworkIntake(engine, submissionFiles);
const mail = new CourseMail(engine, new PythonMailTransport(), mailKey(config.databasePath), submissionFiles);
const batches = new GradingBatches(engine, mail);
const router = new Router(engine, model, references, batches, coursework,
  { dshAvailable: !!headless, groupSending: config.sendEnabled });
const workers = {
  qa: answer, lesson: prepareLesson, scheduled: runScheduled,
  'teaching-affairs': teachingAffairsWorker(router.teacherWork), coursework: courseworkWorker(engine, mail, model),
};
const runner = new TaskRunner(engine, input => workers[input.run.task.kind](input), config.concurrency, qqAccess);
const sender = new LLBotSender(config.llbotUrl, config.llbotToken, qqAccess, process.env.TA_MATH_SOCKET, (course, id) => store.teachingImage(course, id));
sender.loadFile = (course, id) => store.teachingFile(course, id);
const outbox = new DeliveryOutbox(engine, sender, config.sendEnabled);
const runtime = new Runtime(engine, router, runner, outbox, new ThreadClassifier(engine, model), new MemoryUpdater(engine, model, memory),
  { batchMs: config.batchMs, watchdog: new Watchdog(engine), batches: { tick: now => batches.scan(now) } });
const server = createApi(engine, config, qqAccess, qaTools, attachments, mail, batches, groupFiles, coursework, config.libraryPath);
server.listen(config.port, config.host, () => {
  mail.start();
  batches.recover();
  runtime.start();
  console.log(`助教服务 http://${config.host}:${config.port}，QQ外发${config.sendEnabled ? '已开启' : '关闭（结果留在交付队列）'}`);
});
server.on('error', error => { console.error('服务启动失败：', error.message); store.close(); process.exitCode = 1; });
let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return; closing = true;
  await new Promise<void>(resolve => server.close(() => resolve()));
  await Promise.all([runtime.stop(), mail.stop()]); store.close();
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
