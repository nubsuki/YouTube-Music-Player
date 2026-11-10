const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('topbarAPI', {
  toggleOptions: () => ipcRenderer.send('topbar:toggle-options'),
  refreshPage: () => ipcRenderer.send('topbar:refresh'),
  onOptionsToggled: (cb) => ipcRenderer.on('options:view-state', (_e, isOpen) => cb(isOpen)),
});
