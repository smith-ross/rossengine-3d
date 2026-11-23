// Bridge between the editor (renderer) and RossEngine Studio's main process.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('rossStudio', {
  isDesktop: true,
  info: () => ipcRenderer.invoke('studio:info'),
  open: () => ipcRenderer.invoke('studio:open'),
  save: (token, text) => ipcRenderer.invoke('studio:save', token, text),
  saveAs: (suggestedName, text) => ipcRenderer.invoke('studio:saveAs', suggestedName, text),
  chooseBuildDir: () => ipcRenderer.invoke('studio:chooseBuildDir'),
  build: (options) => ipcRenderer.invoke('studio:build', options),
  reveal: (p) => ipcRenderer.invoke('studio:reveal', p),
  runGame: (p) => ipcRenderer.invoke('studio:runGame', p),
  setDirty: (dirty) => ipcRenderer.send('studio:dirty', dirty),
  closeNow: () => ipcRenderer.send('studio:close'),
  // "Test multiplayer": another player window running this app as a test client
  openClient: (hash, index) => ipcRenderer.send('studio:open-client', hash, index),
  onMenu: (callback) => {
    const listener = (_e, id) => callback(id)
    ipcRenderer.on('studio:menu', listener)
    return () => ipcRenderer.removeListener('studio:menu', listener)
  },
})

// Alt+click (extra cursors in the code editor, picking inside bodies in the viewport): tell the main
// process, so letting go of Alt afterwards doesn't put the keyboard in the menu bar.
window.addEventListener('mousedown', (e) => { if (e.altKey) ipcRenderer.send('studio:alt-click') }, true)
