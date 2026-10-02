const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  sendControl: (action) => ipcRenderer.send('player-control', action),
  onStateUpdate: (callback) => ipcRenderer.on('state-update', (event, state) => callback(state)),
  getTranslations: (keys) => ipcRenderer.invoke('get-translations', keys),
  getTheme: () => ipcRenderer.invoke('get-mini-player-theme'),
  setTheme: (theme) => ipcRenderer.send('set-mini-player-theme', theme),
  getAlwaysOnTop: () => ipcRenderer.invoke('get-mini-player-always-on-top'),
  setAlwaysOnTop: (enabled) => ipcRenderer.send('set-mini-player-always-on-top', enabled),
  openSettings: () => ipcRenderer.send('open-mini-player-settings'),
  onThemeChanged: (callback) => ipcRenderer.on('theme-changed', (event, theme) => callback(theme)),
  closeWindow: () => ipcRenderer.send('close-mini-player-settings'),
});