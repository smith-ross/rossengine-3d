// Multiplayer over TCP for a game window: host (listen for players) or join (connect to a host).
// Messages are lines of JSON. The game page talks to this through its preload (window.rossNet).
const net = require('node:net')
const os = require('node:os')

/** LAN addresses (IPv4, not internal) players on other machines can type. */
function localAddresses() {
  const out = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address)
  }
  return out.length ? out : ['127.0.0.1']
}

/**
 * One bridge per window. `webContents` receives 'ross-net:event' messages:
 * { type: 'connect' | 'data' | 'close', peer, data? } (peer is 'host' on a player's side).
 */
function createNetBridge(webContents) {
  let server = null
  let client = null
  const sockets = new Map()
  let nextId = 1
  const emit = (ev) => { if (!webContents.isDestroyed()) webContents.send('ross-net:event', ev) }
  const readLines = (sock, onLine) => {
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('data', (chunk) => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (line) onLine(line)
      }
      if (buf.length > 256 * 1024 * 1024) sock.destroy() // nobody sends a message this big
    })
  }
  const close = () => {
    for (const s of sockets.values()) s.destroy()
    sockets.clear()
    if (server) { server.close(); server = null }
    if (client) { client.destroy(); client = null }
  }
  return {
    host(port) {
      close()
      return new Promise((resolve) => {
        const srv = net.createServer((sock) => {
          const id = `p${nextId++}`
          sockets.set(id, sock)
          sock.setNoDelay(true)
          sock.on('error', () => {})
          sock.on('close', () => { if (sockets.delete(id)) emit({ type: 'close', peer: id }) })
          emit({ type: 'connect', peer: id })
          readLines(sock, (line) => emit({ type: 'data', peer: id, data: line }))
        })
        srv.once('error', (err) => resolve({ ok: false, error: err.code === 'EADDRINUSE' ? `Port ${port} is already in use (is another game hosting?)` : String(err.message || err) }))
        srv.listen(port, () => { server = srv; resolve({ ok: true, port, addresses: localAddresses() }) })
      })
    },
    join(hostName, port) {
      close()
      return new Promise((resolve) => {
        const sock = net.connect({ host: hostName, port })
        let settled = false
        const timer = setTimeout(() => { if (!settled) { settled = true; sock.destroy(); resolve({ ok: false, error: `No answer from ${hostName}:${port}` }) } }, 10000)
        sock.once('connect', () => {
          settled = true
          clearTimeout(timer)
          client = sock
          sock.setNoDelay(true)
          readLines(sock, (line) => emit({ type: 'data', peer: 'host', data: line }))
          sock.on('close', () => { if (client === sock) { client = null; emit({ type: 'close', peer: 'host' }) } })
          resolve({ ok: true })
        })
        sock.on('error', (err) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          resolve({ ok: false, error: err.code === 'ECONNREFUSED' ? `Nobody is hosting at ${hostName}:${port}` : String(err.message || err) })
        })
      })
    },
    send(peer, line) {
      const s = peer === 'host' ? client : sockets.get(peer)
      if (s && !s.destroyed && typeof line === 'string') s.write(line + '\n')
    },
    drop(peer) { const s = sockets.get(peer); if (s) s.destroy() },
    close,
  }
}

/** Wire the bridge's IPC (once per app); each window gets its own bridge. */
function registerNetIpc(ipcMain) {
  const bridges = new Map()
  const of = (e) => {
    let b = bridges.get(e.sender.id)
    if (!b) {
      b = createNetBridge(e.sender)
      bridges.set(e.sender.id, b)
      e.sender.once('destroyed', () => { b.close(); bridges.delete(e.sender.id) })
    }
    return b
  }
  ipcMain.handle('ross-net:host', (e, port) => of(e).host(Number(port) || 47800))
  ipcMain.handle('ross-net:join', (e, hostName, port) => of(e).join(String(hostName), Number(port) || 47800))
  ipcMain.on('ross-net:send', (e, peer, line) => of(e).send(peer, line))
  ipcMain.on('ross-net:drop', (e, peer) => of(e).drop(peer))
  ipcMain.handle('ross-net:close', (e) => of(e).close())
}

module.exports = { registerNetIpc, createNetBridge, localAddresses }
