// CLI: `npm run build:player` packages the RossEngine Player template (and optionally exports a game).
//   node tools/build-player.mjs                 -> build/refresh player-template/
//   node tools/build-player.mjs game.rbe "Name" -> also export a game into builds/
import { createServer } from 'vite'
import fs from 'node:fs'

// Load the TypeScript build module through Vite so it can be shared with the dev-server plugin.
const vite = await createServer({
  configFile: false, appType: 'custom', logLevel: 'error',
  server: { middlewareMode: true, watch: null },
  optimizeDeps: { noDiscovery: true, entries: [] },
})
try {
  const pb = await vite.ssrLoadModule('/tools/player-build.ts')
  const [placeFile, name] = process.argv.slice(2)
  await pb.ensureTemplate(process.platform, console.log, !placeFile)
  if (placeFile) {
    const text = fs.readFileSync(placeFile, 'utf8')
    const r = await pb.exportGame(name || JSON.parse(text).name || 'Game', text)
    console.log(`Game exported: ${r.exe}`)
  }
} finally {
  await vite.close()
}
