// Standalone runtime entry: loads game.json and runs it. This is what the Electron player shows.
import '../engine/classes'
import { GameSession } from '../engine/game/GameSession'
import { serialize, SerializedInstance } from '../engine/instance'
import { demoPlace } from '../engine/templates'
import { DevConsole } from './DevConsole'
import { assets, SerializedAsset } from '../engine/assets'
import { SaveBackend, localStorageBackend } from '../engine/save'

declare global {
  interface Window { rossPlayer?: { loadGame(): Promise<string | null>; title?: string; save?: SaveBackend } }
}

async function loadPlace(): Promise<{ name: string; root: SerializedInstance; assets?: SerializedAsset[] }> {
  // 1. Electron player: game data provided by the preload bridge
  if (window.rossPlayer) {
    const text = await window.rossPlayer.loadGame()
    if (text) return JSON.parse(text)
  }
  // 2. ?demo or a game.json next to this page
  const params = new URLSearchParams(location.search)
  if (!params.has('demo')) {
    try {
      const res = await fetch('./game.json', { cache: 'no-store' })
      if (res.ok) return await res.json()
    } catch { /* no game.json */ }
  }
  const demo = demoPlace()
  return { name: demo.name, root: serialize(demo) }
}

async function main() {
  const container = document.getElementById('game')!
  const consoleUi = new DevConsole(document.body)
  const place = await loadPlace()
  document.title = place.name || 'RossEngine'
  assets.load(place.assets)
  ;(window as any).__session = await GameSession.start(container, place.root, {
    output: (kind, msg, source) => consoleUi.log(kind, msg, source),
    // exported game: files in its app-data folder; in a browser: localStorage, per game
    saveBackend: window.rossPlayer?.save ?? localStorageBackend(`ross-save:${place.name || 'game'}:`),
  })
}

main().catch((e) => {
  console.error(e)
  document.body.innerHTML = `<pre style="color:#f66;padding:20px">Failed to start game:\n${String(e?.stack ?? e)}</pre>`
})
