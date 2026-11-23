// Exposes a minimal, read-only bridge to the game runtime. Games never get Node.js access.
const { contextBridge, ipcRenderer } = require('electron')

const call = (channel, ...args) => {
  const r = ipcRenderer.sendSync(channel, ...args)
  if (!r || !r.ok) throw new Error(r?.error ?? 'save storage unavailable')
  return r.value
}

contextBridge.exposeInMainWorld('rossPlayer', {
  loadGame: () => ipcRenderer.invoke('ross:load-game'),
  // SaveService slots (small JSON files in the game's own app-data folder)
  save: {
    read: (slot) => call('ross:save-read', slot),
    write: (slot, json) => { call('ross:save-write', slot, json) },
    list: () => call('ross:save-list'),
    remove: (slot) => { call('ross:save-delete', slot) },
  },
})

// Multiplayer over the network (TCP, in the main process): host a game or join one by address.
contextBridge.exposeInMainWorld('rossNet', {
  host: (port) => ipcRenderer.invoke('ross-net:host', port),
  join: (host, port) => ipcRenderer.invoke('ross-net:join', host, port),
  send: (peer, line) => ipcRenderer.send('ross-net:send', peer, line),
  drop: (peer) => ipcRenderer.send('ross-net:drop', peer),
  close: () => ipcRenderer.invoke('ross-net:close'),
  onEvent: (callback) => {
    const listener = (_e, ev) => callback(ev)
    ipcRenderer.on('ross-net:event', listener)
    return () => ipcRenderer.removeListener('ross-net:event', listener)
  },
})
