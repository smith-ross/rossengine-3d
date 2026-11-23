// `npm run build:studio` packages RossEngine Studio (the editor) as a desktop app:
//   studio-dist/RossEngine Studio-<platform>-<arch>/
// The player app is bundled inside it, so Studio can build games on machines without Node.
import { build, createServer } from 'vite'
import { packager } from '@electron/packager'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '..')
const APP = path.join(ROOT, 'studio-build', 'app')
const require = createRequire(import.meta.url)
const platform = process.platform
const arch = process.arch === 'arm64' ? 'arm64' : 'x64'

// 1. the player runtime that Studio exports games from
const vite = await createServer({
  configFile: false, appType: 'custom', logLevel: 'error',
  server: { middlewareMode: true, watch: null }, optimizeDeps: { noDiscovery: true, entries: [] },
})
let template
try {
  const pb = await vite.ssrLoadModule('/tools/player-build.ts')
  template = await pb.ensureTemplate(platform, console.log)
} finally {
  await vite.close()
}

// 2. the editor
console.log('Building the editor…')
await build({ configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'warn' })

// 3. the Studio app folder
console.log('Assembling RossEngine Studio…')
fs.rmSync(APP, { recursive: true, force: true })
fs.mkdirSync(APP, { recursive: true })
for (const f of ['studio-main.cjs', 'studio-preload.cjs', 'export-game.cjs', 'net-bridge.cjs']) fs.copyFileSync(path.join(ROOT, 'electron', f), path.join(APP, f))
fs.cpSync(path.join(ROOT, 'dist'), path.join(APP, 'editor'), { recursive: true })
const electronVersion = require('electron/package.json').version
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
fs.writeFileSync(path.join(APP, 'package.json'), JSON.stringify({
  name: 'rossengine-studio', productName: 'RossEngine Studio', version, main: 'studio-main.cjs',
  description: 'RossEngine Studio - build 3D games scripted in Luau, TypeScript and Python',
}, null, 2))

const playerAsar = path.join(ROOT, 'studio-build', 'player.asar')
fs.copyFileSync(path.join(template, 'resources', 'app.asar'), playerAsar)

// 4. package
console.log(`Packaging Electron ${electronVersion} for ${platform}-${arch}…`)
const [out] = await packager({
  dir: APP,
  out: path.join(ROOT, 'studio-dist'),
  name: 'RossEngine Studio',
  executableName: 'RossEngine Studio',
  platform, arch, electronVersion,
  appVersion: version,
  overwrite: true, asar: true, prune: false, quiet: true,
  // Studio builds games from its own Electron runtime, so only the player app itself is bundled
  extraResource: [playerAsar],
  win32metadata: { CompanyName: 'RossEngine', FileDescription: 'RossEngine Studio', ProductName: 'RossEngine Studio' },
})
console.log(`RossEngine Studio ready: ${out}`)
