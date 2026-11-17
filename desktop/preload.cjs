const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('ta', {
  profile: () => ipcRenderer.invoke('ta:profile'),
  connect: input => ipcRenderer.invoke('ta:connect', input),
  disconnect: () => ipcRenderer.invoke('ta:disconnect'),
  demo: () => ipcRenderer.invoke('ta:demo'),
  qqStatus: () => ipcRenderer.invoke('ta:qq-status'),
  qqQr: () => ipcRenderer.invoke('ta:qq-qr'),
  request: (method, route, body) => ipcRenderer.invoke('ta:request', method, route, body),
  onDisconnected: fn => { const listener = () => fn(); ipcRenderer.on('ta:disconnected', listener); return () => ipcRenderer.removeListener('ta:disconnected', listener); },
});
