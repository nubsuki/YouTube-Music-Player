const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("listenAlong", {
  createParty: (hostName) =>
    ipcRenderer.invoke("la:create-party", { hostName }),

  joinParty: (partyId, guestName) =>
    ipcRenderer.invoke("la:join-party", { partyId, guestName }),

  closeParty: () => ipcRenderer.invoke("la:close-party"),

  leaveParty: () => ipcRenderer.invoke("la:leave-party"),

  getState: () => ipcRenderer.invoke("la:get-state"),

  onStateChange: (cb) => {
    ipcRenderer.on("la:state-changed", (_event, state) => cb(state));
  },

  getConfig: () => ipcRenderer.invoke("la:get-config"),

  saveConfig: (config) => ipcRenderer.send("la:save-config", config),

  openPartyPage: (partyId) =>
    ipcRenderer.send("la:open-party-page", { partyId }),

  copyText: (text) => ipcRenderer.send("la:copy-text", text),

  readClipboard: () => ipcRenderer.invoke("la:read-clipboard"),

  closeWindow: () => ipcRenderer.send("la:close-window"),
});
