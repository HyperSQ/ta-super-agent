const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { SSHSession, allowRequest } = require('./lib/ssh-session.cjs');
const { DemoSession } = require('./lib/demo.cjs');

let window, ssh, demo;
const rendererFile = path.join(__dirname, 'renderer', 'index.html');
function readSettings() { try { return JSON.parse(readFileSync(path.join(app.getPath('userData'), 'connections.json'), 'utf8')); } catch { return {}; } }
function saveSettings(settings) { mkdirSync(app.getPath('userData'), { recursive: true }); writeFileSync(path.join(app.getPath('userData'), 'connections.json'), JSON.stringify(settings, null, 2)); }
function senderAllowed(event) { return window && event.sender === window.webContents && event.senderFrame?.url === pathToFileURL(rendererFile).href; }
function handle(name, fn) { ipcMain.handle(name, async (event, ...args) => {
  if (!senderAllowed(event)) return { ok: false, error: '不允许的调用来源' };
  try { return { ok: true, data: await fn(...args) }; } catch (error) { return { ok: false, error: error.message, status: error.status }; }
}); }

app.whenReady().then(() => {
  window = new BrowserWindow({ width: 1400, height: 940, minWidth: 1060, minHeight: 740, title: '助教工作台', backgroundColor: '#f5f7f9', icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  window.setMenuBarVisibility(false);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ssh = new SSHSession({
    verifyHost: async (profile, fingerprint) => {
      const key = `${profile.host}:${profile.port}`, known = readSettings().hosts?.[key];
      if (known && known !== fingerprint) throw new Error('服务器主机指纹发生变化，请先核实服务器身份');
      if (known) return true;
      const response = await dialog.showMessageBox(window, { type: 'question', title: '首次连接此服务器', message: `${profile.host}:${profile.port}`, detail: `服务器SSH主机指纹：\n${fingerprint}\n\n请与服务器管理员提供的指纹核对。`, buttons: ['信任并连接', '取消'], defaultId: 1, cancelId: 1 });
      return response.response === 0;
    },
    onVerified: (profile, fingerprint) => { const settings = readSettings(); saveSettings({ ...settings, profile, hosts: { ...settings.hosts, [`${profile.host}:${profile.port}`]: fingerprint } }); },
  });
  ssh.on('disconnected', () => { if (!demo && !window.isDestroyed()) window.webContents.send('ta:disconnected'); });
  handle('ta:profile', () => readSettings().profile || { host: '', username: 'root', port: 22, apiPort: 8787, remoteDir: '/opt/ta-super-agent' });
  handle('ta:connect', async input => { demo = undefined; return ssh.connect(input); });
  handle('ta:disconnect', () => { demo = undefined; ssh.disconnect(); return true; });
  handle('ta:demo', () => { demo = new DemoSession(); ssh.disconnect(); return { host: '演示环境', username: '教师', demo: true }; });
  handle('ta:request', (method, route, body) => {
    if (!allowRequest(method, route)) throw new Error('不支持的工作台操作');
    return demo ? demo.request(method, route, body) : ssh.request(method, route, body);
  });
  handle('ta:qq-status', () => demo ? { available: true, online: false, demo: true, instance: 'ta-llbot', account: '', checkedAt: new Date().toISOString() } : ssh.qqStatus());
  handle('ta:qq-qr', () => demo ? { available: true, online: false, demo: true, imageDataUrl: null, fetchedAt: new Date().toISOString() } : ssh.qqQr());
  window.loadFile(rendererFile);
  window.on('closed', () => { ssh.disconnect(); window = undefined; });
});
app.on('window-all-closed', () => app.quit());
