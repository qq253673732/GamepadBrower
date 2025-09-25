const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  log: (message) => ipcRenderer.send('log', message),
  loadURLInView: (url) => ipcRenderer.invoke('view-load-url', url),
  scanAndLabel: () => ipcRenderer.invoke('view-scan-labels'),
  activateCode: (code) => ipcRenderer.invoke('view-activate-code', code),
  openDevToolsView: () => ipcRenderer.send('open-devtools-view')
});
