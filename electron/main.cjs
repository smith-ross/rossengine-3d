// RossEngine Player — Electron main process.
// Loads the bundled runtime (runtime/player.html) and the game data (game.json) and runs it.
const { app, BrowserWindow, Menu, ipcMain, protocol, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const RUNTIME_DIR = path.join(__dirname, 'runtime')
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.zip': 'application/zip', '.data': 'application/octet-stream',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
])

function findGameFile() {
  const argGame = process.argv.find((a) => a.startsWith('--game='))
  const candidates = [
    argGame && argGame.slice(7),
    process.env.ROSS_GAME,
    path.join(process.resourcesPath || '', 'game.json'),
    path.join(path.dirname(process.execPath), 'game.json'),
    path.join(__dirname, 'game.json'),
  ].filter(Boolean)
  return candidates.find((p) => fs.existsSync(p)) || null
}

function readGame() {
  const file = findGameFile()
  if (!file) return null
  try { return { file, text: fs.readFileSync(file, 'utf8') } } catch { return null }
}

function createWindow() {
  const game = readGame()
  let settings = {}
  let title = 'RossEngine Player'
  if (game) {
    try {
      const data = JSON.parse(game.text)
      settings = data.settings || {}
      title = data.name || title
    } catch { /* invalid json: the runtime reports it */ }
  }
  const win = new BrowserWindow({
    width: settings.width || 1280,
    height: settings.height || 720,
    fullscreen: !!settings.fullscreen,
    title,
    backgroundColor: '#000000',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.once('ready-to-show', () => win.show())
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return
    if (input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); event.preventDefault() }
    if (input.key === 'F12' && process.env.ROSS_DEVTOOLS) win.webContents.toggleDevTools()
  })
  // games can't navigate away or open windows
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('app://')) e.preventDefault() })
  win.loadURL('app://runtime/player.html')

  // Automated smoke test: ROSS_SMOKE_TEST=out.png runs the game briefly, saves a screenshot,
  // prints the game's console output and exits.
  const smoke = process.env.ROSS_SMOKE_TEST
  if (smoke) {
    win.webContents.on('console-message', (e) => {
      const level = e.level ?? 'info'
      process.stdout.write(`[game:${level}] ${e.message}\n`)
    })
    setTimeout(async () => {
      try {
        const img = await win.webContents.capturePage()
        fs.writeFileSync(smoke, img.toPNG())
        process.stdout.write(`[smoke] screenshot saved to ${smoke}\n`)
      } catch (err) {
        process.stdout.write(`[smoke] screenshot failed: ${err}\n`)
      }
      app.quit()
    }, Number(process.env.ROSS_SMOKE_DELAY || 6000))
  }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  protocol.handle('app', (request) => {
    const url = new URL(request.url)
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')
    const file = path.normalize(path.join(RUNTIME_DIR, rel))
    if (!file.startsWith(RUNTIME_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return new Response('Not found', { status: 404 })
    }
    return new Response(fs.readFileSync(file), {
      headers: { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' },
    })
  })
  ipcMain.handle('ross:load-game', () => {
    const g = readGame()
    return g ? g.text : null
  })
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => app.quit())
