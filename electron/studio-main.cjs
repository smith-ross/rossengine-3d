// RossEngine Studio — the editor as a desktop app (Electron main process).
// Serves the built editor over app://, provides native file dialogs, and builds standalone games
// from the bundled RossPlayer template (no Node.js/npm needed on the user's machine).
const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, shell } = require('electron')
const { spawn } = require('node:child_process')
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')
const { exportGame, exportGameFromRuntime } = require('./export-game.cjs')

const DEV_URL = process.env.ROSS_STUDIO_URL // e.g. http://localhost:5173 while developing
const EDITOR_DIR = path.join(__dirname, 'editor')
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64'
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.wasm': 'application/wasm', '.zip': 'application/zip', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
])

/**
 * What games are built from:
 *  - packaged Studio: its own Electron runtime + the bundled player app (resources/player.asar)
 *  - development: the repo's packaged player template (player-template/)
 */
function playerSource() {
  const asar = path.join(process.resourcesPath || '', 'player.asar')
  if (app.isPackaged && fs.existsSync(asar)) return { kind: 'runtime', asar }
  const tpl = path.join(__dirname, '..', 'player-template', `RossPlayer-${process.platform}-${ARCH}`)
  if (fs.existsSync(tpl)) return { kind: 'template', dir: tpl }
  return null
}

const defaultBuildDir = () => process.env.ROSS_BUILD_DIR || path.join(app.getPath('documents'), 'RossEngine Games')

// Paths the renderer may write to / open: only ones the user picked in a native dialog
// (or that Studio produced). Scripts running inside the editor can't touch anything else.
const files = new Map() // token -> file path
const buildRoots = new Set()
const produced = new Set()
const token = (p) => {
  for (const [t, q] of files) if (q === p) return t
  const t = crypto.randomUUID()
  files.set(t, p)
  return t
}

let win = null
let dirty = false
let allowClose = false
let altClicked = false // Alt is held for a click (see before-input-event)

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 960, minHeight: 600,
    title: 'RossEngine Studio',
    backgroundColor: '#17181c',
    show: false,
    webPreferences: {
      backgroundThrottling: !process.env.ROSS_SMOKE_SCRIPT,
      preload: path.join(__dirname, 'studio-preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  // smoke tests run fully hidden (no window, no focus stealing)
  if (!process.env.ROSS_SMOKE_SCRIPT) win.once('ready-to-show', () => { win.maximize(); win.show() })
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  // On Windows, releasing Alt on its own focuses the menu bar, even if Alt was held for a click
  // (extra cursors in the code editor). Skip that one release so typing still reaches the editor;
  // tapping Alt by itself still opens the menu.
  win.webContents.on('before-input-event', (e, input) => {
    if (input.key !== 'Alt') return
    if (input.type === 'keyDown' && !input.isAutoRepeat) altClicked = false
    else if (input.type === 'keyUp' && altClicked) { altClicked = false; e.preventDefault() }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://') && !(DEV_URL && url.startsWith(DEV_URL))) e.preventDefault()
  })
  win.on('close', (e) => {
    if (!dirty || allowClose) return
    e.preventDefault()
    const choice = dialog.showMessageBoxSync(win, {
      type: 'question',
      buttons: ['Save', "Don't Save", 'Cancel'],
      defaultId: 0, cancelId: 2,
      message: 'Save changes to this place before closing?',
      detail: 'Unsaved changes are also kept in Studio\'s autosave until you open another place.',
    })
    if (choice === 0) win.webContents.send('studio:menu', 'save-and-close')
    if (choice === 1) { allowClose = true; win.close() }
  })
  win.loadURL(DEV_URL || 'app://studio/index.html')
  if (process.env.ROSS_SMOKE_SCRIPT) runSmokeTest()
}

function buildMenu() {
  const send = (id) => () => win && win.webContents.send('studio:menu', id)
  // Shortcuts are handled inside the editor, so menu accelerators are display-only.
  const item = (label, id, accelerator) => ({ label, click: send(id), accelerator, registerAccelerator: false })
  const template = [
    {
      label: 'File',
      submenu: [
        item('New Baseplate', 'new-baseplate'),
        item('New 2D Place', 'new-2d'),
        item('New Sample: Coin Collector (3D)', 'new-demo'),
        item('New Sample: Platformer (2D)', 'new-platformer'),
        { type: 'separator' },
        item('Open…', 'open', 'CmdOrCtrl+O'),
        item('Save', 'save', 'CmdOrCtrl+S'),
        item('Save As…', 'save-as', 'CmdOrCtrl+Shift+S'),
        { type: 'separator' },
        item('Build Game…', 'build'),
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        item('Undo', 'undo', 'CmdOrCtrl+Z'),
        item('Redo', 'redo', 'CmdOrCtrl+Y'),
        { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' },
      ],
    },
    {
      label: 'Test',
      submenu: [item('Play', 'play', 'F5'), item('Stop', 'stop', 'Shift+F5')],
    },
    {
      label: 'View',
      submenu: [
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { type: 'separator' },
        { role: 'togglefullscreen' }, { type: 'separator' },
        { role: 'reload' }, { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Help',
      submenu: [{
        label: 'About RossEngine Studio',
        click: () => dialog.showMessageBox(win, {
          type: 'info', title: 'RossEngine Studio',
          message: `RossEngine Studio ${app.getVersion()}`,
          detail: `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}\nScripting: Luau, TypeScript, Python`,
        }),
      }],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

const PLACE_FILTERS = [{ name: 'RossEngine place', extensions: ['rbe', 'json'] }]

function registerIpc() {
  ipcMain.handle('studio:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    template: !!playerSource(),
    buildDir: defaultBuildDir(),
  }))
  ipcMain.handle('studio:open', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Open place', filters: PLACE_FILTERS, properties: ['openFile'] })
    if (r.canceled || !r.filePaths[0]) return null
    const p = r.filePaths[0]
    return { token: token(p), name: path.basename(p), text: fs.readFileSync(p, 'utf8') }
  })
  ipcMain.handle('studio:save', (_e, t, text) => {
    const p = files.get(t)
    if (!p) throw new Error('Unknown file')
    fs.writeFileSync(p, String(text))
    return { token: t, name: path.basename(p) }
  })
  ipcMain.handle('studio:saveAs', async (_e, suggested, text) => {
    const r = await dialog.showSaveDialog(win, {
      title: 'Save place', filters: PLACE_FILTERS,
      defaultPath: path.join(app.getPath('documents'), String(suggested || 'Place') + '.rbe'),
    })
    if (r.canceled || !r.filePath) return null
    fs.writeFileSync(r.filePath, String(text))
    return { token: token(r.filePath), name: path.basename(r.filePath) }
  })
  ipcMain.handle('studio:chooseBuildDir', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Build games into…', properties: ['openDirectory', 'createDirectory'], defaultPath: defaultBuildDir() })
    if (r.canceled || !r.filePaths[0]) return null
    buildRoots.add(r.filePaths[0])
    return r.filePaths[0]
  })
  ipcMain.handle('studio:build', (_e, o) => {
    const src = playerSource()
    if (!src) return { ok: false, error: 'The RossPlayer runtime is missing from this Studio installation.' }
    const outRoot = o && o.outDir && buildRoots.has(o.outDir) ? o.outDir : defaultBuildDir()
    try {
      const r = src.kind === 'runtime'
        ? exportGameFromRuntime({
          studioDir: path.dirname(process.execPath), studioExe: process.execPath, playerAsar: src.asar,
          outRoot, name: o.name, placeJson: String(o.placeJson),
        })
        : exportGame({ templateDir: src.dir, outRoot, name: o.name, placeJson: String(o.placeJson) })
      produced.add(r.exe)
      produced.add(r.dir)
      return { ok: true, ...r }
    } catch (e) {
      return { ok: false, error: String((e && e.stack) || e) }
    }
  })
  ipcMain.handle('studio:reveal', (_e, p) => { if (produced.has(p)) shell.showItemInFolder(p) })
  ipcMain.handle('studio:runGame', (_e, p) => {
    if (!produced.has(p)) return false
    const child = spawn(p, [], { detached: true, stdio: 'ignore', cwd: path.dirname(p) })
    child.unref()
    return true
  })
  ipcMain.on('studio:alt-click', () => { altClicked = true })
  ipcMain.on('studio:dirty', (_e, d) => { dirty = !!d })
  ipcMain.on('studio:close', () => { allowClose = true; win && win.close() })
}

/** ROSS_SMOKE_SCRIPT=file.js: run a script in the editor after load, print its result, quit. */
function runSmokeTest() {
  const code = fs.readFileSync(process.env.ROSS_SMOKE_SCRIPT, 'utf8')
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') process.stdout.write(`[studio:${e.level}] ${e.message}\n`)
  })
  win.webContents.once('did-finish-load', () => {
    setTimeout(async () => {
      try {
        const result = await win.webContents.executeJavaScript(code, true)
        process.stdout.write(`[smoke] ${JSON.stringify(result, null, 1)}\n`)
        if (process.env.ROSS_SMOKE_SHOT) {
          const img = await win.webContents.capturePage()
          fs.writeFileSync(process.env.ROSS_SMOKE_SHOT, img.toPNG())
        }
      } catch (err) {
        process.stdout.write(`[smoke] failed: ${err && err.stack || err}\n`)
      }
      allowClose = true
      app.quit()
    }, 2500)
  })
}

app.whenReady().then(() => {
  protocol.handle('app', (request) => {
    const url = new URL(request.url)
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html'
    const file = path.normalize(path.join(EDITOR_DIR, rel))
    if (!file.startsWith(EDITOR_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return new Response('Not found', { status: 404 })
    }
    return new Response(fs.readFileSync(file), {
      headers: { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' },
    })
  })
  registerIpc()
  buildMenu()
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})

app.on('window-all-closed', () => app.quit())
