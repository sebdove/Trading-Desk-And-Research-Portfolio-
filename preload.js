// The only bridge between the dashboard page and the app. The page gets these functions and nothing else.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('botApp', {
  status: () => ipcRenderer.invoke('bots:status'),
  start: market => ipcRenderer.invoke('bots:start', market),
  stop: market => ipcRenderer.invoke('bots:stop', market),
  log: market => ipcRenderer.invoke('bots:log', market),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: patch => ipcRenderer.invoke('settings:save', patch),
  resetPaper: market => ipcRenderer.invoke('bots:resetPaper', market),
  openFolder: () => ipcRenderer.invoke('app:openFolder'),
  onStatus: fn => ipcRenderer.on('bots:status', (_e, s) => fn(s)),
  onLog: fn => ipcRenderer.on('bots:log', (_e, l) => fn(l)),
  bubbleUpdate: () => ipcRenderer.invoke('bubble:update'),
  bubbleCheck: (text, month) => ipcRenderer.invoke('bubble:check', text, month),
  bubbleWindow: () => ipcRenderer.invoke('bubble:window'),
  onBubble: fn => ipcRenderer.on('bubble:event', (_e, m) => fn(m)),
});
