const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('optionsAPI', {
  // Filters
  getFilters: () => ipcRenderer.invoke('get-filters'),
  saveFilters: (filters) => ipcRenderer.send('save-filters', filters),
  resetFilters: () => ipcRenderer.send('reset-filters'),

  // Ad skipper
  getAdSkipperSettings: () => ipcRenderer.invoke('get-ad-skipper-settings'),
  saveAdSkipperSettings: (s) => ipcRenderer.send('save-ad-skipper-settings', s),

  // Adblock stats
  getAdblockStats: () => ipcRenderer.invoke('get-adblock-stats'),
  resetAdblockStats: () => ipcRenderer.send('reset-adblock-stats'),

  // App settings
  getAppSettings: () => ipcRenderer.invoke('options:get-app-settings'),
  saveAppSettings: (s) => ipcRenderer.send('options:save-app-settings', s),

  // Mini player
  getMiniPlayerTheme: () => ipcRenderer.invoke('get-mini-player-theme'),
  setMiniPlayerTheme: (t) => ipcRenderer.send('set-mini-player-theme', t),
  getMiniPlayerAlwaysOnTop: () => ipcRenderer.invoke('get-mini-player-always-on-top'),
  setMiniPlayerAlwaysOnTop: (v) => ipcRenderer.send('set-mini-player-always-on-top', v),

  // Listen along
  laCreateParty: (hostName) => ipcRenderer.invoke('la:create-party', { hostName }),
  laJoinParty: (partyId, guestName) => ipcRenderer.invoke('la:join-party', { partyId, guestName }),
  laCloseParty: () => ipcRenderer.invoke('la:close-party'),
  laLeaveParty: () => ipcRenderer.invoke('la:leave-party'),
  laGetState: () => ipcRenderer.invoke('la:get-state'),
  laGetConfig: () => ipcRenderer.invoke('la:get-config'),
  laSaveConfig: (cfg) => ipcRenderer.send('la:save-config', cfg),
  laOpenPartyPage: (partyId) => ipcRenderer.send('la:open-party-page', { partyId }),
  laCopyText: (t) => ipcRenderer.send('la:copy-text', t),
  laReadClipboard: () => ipcRenderer.invoke('la:read-clipboard'),
  onLaStateChange: (cb) => ipcRenderer.on('la:state-changed', (_e, s) => cb(s)),

  // About
  getAboutInfo: () => ipcRenderer.invoke('get-about-info'),

  // Update
  checkForUpdates: () => ipcRenderer.invoke('options:check-for-updates'),

  // Misc
  openExternal: (url) => ipcRenderer.send('open-external-link', url),
  closeOptions: () => ipcRenderer.send('options:close'),
  getTranslations: (keys) => ipcRenderer.invoke('get-translations', keys),
});

