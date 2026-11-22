// Turns a packaged RossPlayer template into a standalone game: copy it, add resources/game.json,
// rename the executable. Shared by the CLI/dev build server and RossEngine Studio (Electron).
const fs = require('node:fs')
const path = require('node:path')

const PLAYER_NAME = 'RossPlayer'

function safeName(name) {
  return String(name || '').replace(/[^\w\- ]+/g, '').trim() || 'Game'
}

/**
 * @param {{ templateDir: string, outRoot: string, name: string, placeJson: string, platform?: string, arch?: string }} o
 * @returns {{ dir: string, exe: string }}
 */
function exportGame(o) {
  const platform = o.platform || process.platform
  const arch = o.arch || (process.arch === 'arm64' ? 'arm64' : 'x64')
  const safe = safeName(o.name)
  const dir = path.join(o.outRoot, `${safe}-${platform}-${arch}`)
  // Inside Electron, fs treats .asar files as directories; copy them as plain files.
  const prevNoAsar = process.noAsar
  process.noAsar = true
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(o.outRoot, { recursive: true })
    fs.cpSync(o.templateDir, dir, { recursive: true })
    fs.rmSync(path.join(dir, '.ross-built'), { force: true })
    const resources = platform === 'darwin'
      ? path.join(dir, `${PLAYER_NAME}.app`, 'Contents', 'Resources')
      : path.join(dir, 'resources')
    fs.writeFileSync(path.join(resources, 'game.json'), o.placeJson)
    let exe
    if (platform === 'win32') {
      exe = path.join(dir, `${safe}.exe`)
      fs.renameSync(path.join(dir, `${PLAYER_NAME}.exe`), exe)
    } else if (platform === 'darwin') {
      exe = path.join(dir, `${safe}.app`)
      fs.renameSync(path.join(dir, `${PLAYER_NAME}.app`), exe)
    } else {
      exe = path.join(dir, safe.replace(/ /g, '_'))
      fs.renameSync(path.join(dir, PLAYER_NAME), exe)
    }
    fs.writeFileSync(path.join(dir, 'README.txt'), `${safe}\n\nMade with RossEngine. Run ${path.basename(exe)} to play.\nF11 toggles fullscreen, F9 opens the developer console.\n`)
    return { dir, exe }
  } finally {
    process.noAsar = prevNoAsar
  }
}

/**
 * Build a game from RossEngine Studio's own Electron runtime (same Electron version as the player):
 * copy Studio's install minus its resources, swap in the player app (player.asar) and game.json.
 * This avoids shipping a second copy of Electron inside Studio.
 * @param {{ studioDir: string, studioExe: string, playerAsar: string, outRoot: string, name: string, placeJson: string }} o
 */
function exportGameFromRuntime(o) {
  const platform = process.platform
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const safe = safeName(o.name)
  const dir = path.join(o.outRoot, `${safe}-${platform}-${arch}`)
  const prevNoAsar = process.noAsar
  process.noAsar = true
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    for (const entry of fs.readdirSync(o.studioDir)) {
      if (entry === 'resources' || entry === path.basename(o.studioExe)) continue
      fs.cpSync(path.join(o.studioDir, entry), path.join(dir, entry), { recursive: true })
    }
    const resources = path.join(dir, 'resources')
    fs.mkdirSync(resources)
    fs.copyFileSync(o.playerAsar, path.join(resources, 'app.asar'))
    fs.writeFileSync(path.join(resources, 'game.json'), o.placeJson)
    const ext = platform === 'win32' ? '.exe' : ''
    const exe = path.join(dir, (platform === 'win32' ? safe : safe.replace(/ /g, '_')) + ext)
    fs.copyFileSync(o.studioExe, exe)
    if (platform !== 'win32') fs.chmodSync(exe, 0o755)
    fs.writeFileSync(path.join(dir, 'README.txt'), `${safe}\n\nMade with RossEngine. Run ${path.basename(exe)} to play.\nF11 toggles fullscreen, F9 opens the developer console.\n`)
    return { dir, exe }
  } finally {
    process.noAsar = prevNoAsar
  }
}

module.exports = { exportGame, exportGameFromRuntime, safeName, PLAYER_NAME }
