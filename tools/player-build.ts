// Builds the RossEngine Player: the game runtime bundled into an Electron app.
// The packaged "template" contains no game; each exported game is a copy of it with
// resources/game.json added and the executable renamed.
import { build } from 'vite'
import { packager } from '@electron/packager'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '..')
const APP_DIR = path.join(ROOT, 'player-build', 'app')
const TEMPLATE_DIR = path.join(ROOT, 'player-template')
export const BUILDS_DIR = path.join(ROOT, 'builds')
const require = createRequire(import.meta.url)

export const PLAYER_NAME = 'RossPlayer'
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64'

export function templatePath(platform: string = process.platform) {
  return path.join(TEMPLATE_DIR, `${PLAYER_NAME}-${platform}-${ARCH}`)
}

/** Newest modification time of the runtime's sources (to know when the template is stale). */
function newestSourceTime(): number {
  let newest = 0
  const walk = (p: string) => {
    if (!fs.existsSync(p)) return
    const st = fs.statSync(p)
    if (st.isDirectory()) for (const f of fs.readdirSync(p)) walk(path.join(p, f))
    else newest = Math.max(newest, st.mtimeMs)
  }
  for (const p of ['src/engine', 'src/player', 'electron', 'player.html', 'vite.player.config.ts', 'tools/pyodide-plugin.ts']) walk(path.join(ROOT, p))
  return newest
}

export function templateUpToDate(platform: string = process.platform) {
  const marker = path.join(templatePath(platform), '.ross-built')
  if (!fs.existsSync(marker)) return false
  return Number(fs.readFileSync(marker, 'utf8')) >= newestSourceTime()
}

export async function buildRuntime(log: (m: string) => void = console.log) {
  log('Bundling game runtime…')
  await build({ configFile: path.join(ROOT, 'vite.player.config.ts'), logLevel: 'warn' })
  for (const f of ['main.cjs', 'preload.cjs', 'net-bridge.cjs']) fs.copyFileSync(path.join(ROOT, 'electron', f), path.join(APP_DIR, f))
  const electronVersion = require('electron/package.json').version
  fs.writeFileSync(path.join(APP_DIR, 'package.json'), JSON.stringify({
    name: 'rossplayer', productName: PLAYER_NAME, version: '0.1.0', main: 'main.cjs', description: 'RossEngine game player',
    electronVersion,
  }, null, 2))
  return electronVersion as string
}

let building: Promise<string> | null = null

/** Build (or reuse) the packaged player template for a platform. */
export function ensureTemplate(platform: string = process.platform, log: (m: string) => void = console.log, force = false): Promise<string> {
  if (!force && templateUpToDate(platform)) return Promise.resolve(templatePath(platform))
  if (building) return building
  building = (async () => {
    const started = newestSourceTime()
    const electronVersion = await buildRuntime(log)
    log(`Packaging Electron ${electronVersion} player for ${platform}-${ARCH}…`)
    await packager({
      dir: APP_DIR,
      out: TEMPLATE_DIR,
      name: PLAYER_NAME,
      platform: platform as any,
      arch: ARCH as any,
      electronVersion,
      overwrite: true,
      asar: true,
      prune: false,
      quiet: true,
    })
    const dir = templatePath(platform)
    fs.writeFileSync(path.join(dir, '.ross-built'), String(started))
    log(`Player template ready: ${dir}`)
    return dir
  })().finally(() => { building = null })
  return building
}

export interface ExportResult { dir: string; exe: string }

/** Copy the template into builds/<name>, add game.json and rename the executable. */
export async function exportGame(name: string, placeJson: string, platform: string = process.platform, log: (m: string) => void = console.log): Promise<ExportResult> {
  const template = await ensureTemplate(platform, log)
  const { exportGame: doExport } = require('../electron/export-game.cjs') as typeof import('../electron/export-game.cjs')
  log(`Exporting "${name}" to ${BUILDS_DIR}`)
  return doExport({ templateDir: template, outRoot: BUILDS_DIR, name, placeJson, platform, arch: ARCH })
}
