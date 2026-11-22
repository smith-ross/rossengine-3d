// Exposes a minimal, read-only bridge to the game runtime. Games never get Node.js access.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('rossPlayer', {
  loadGame: () => ipcRenderer.invoke('ross:load-game'),
})
