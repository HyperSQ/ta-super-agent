// One-shot read-only verification using the same SSH adapter as the desktop.
const { SSHSession } = require('../desktop/lib/ssh-session.cjs');
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
let buffer = '', started = false;
process.stdin.on('data', async chunk => {
  if (chunk.includes('\x03')) process.exit(1);
  if (started) return;
  buffer += chunk;
  const newline = buffer.search(/[\r\n]/);
  if (newline < 0) return;
  started = true;
  let session;
  try {
    const input = JSON.parse(buffer.slice(0, newline)); buffer = '';
    session = new SSHSession({ verifyHost: (_profile, fingerprint) => fingerprint === input.fingerprint });
    const profile = await session.connect(input); input.password = undefined;
    const courses = await session.request('GET', '/v1/courses');
    const status = await session.qqStatus();
    let qrAvailable;
    if (status.available && status.online === false && !status.setupRequired) qrAvailable = Boolean((await session.qqQr()).imageDataUrl);
    console.log(JSON.stringify({ ok: true, kernelPort: profile.apiPort, courseCount: courses.length, qqInstance: profile.llbotInstance, qqPort: profile.llbotPort, qqAvailable: status.available, qqOnline: status.online, qqSetupRequired: status.setupRequired, qrAvailable, qqError: status.error }));
  } catch (error) { console.log(JSON.stringify({ ok: false, error: error.message })); process.exitCode = 1; }
  finally { session?.disconnect(); setTimeout(() => process.exit(process.exitCode || 0), 100); }
});
console.log(JSON.stringify({ ready: true, credentialsOnStdin: true }));
