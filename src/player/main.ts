// Standalone runtime entry: loads game.json and runs it. This is what the Electron player shows.
import '../engine/classes'
import { GameSession, SessionOptions } from '../engine/game/GameSession'
import { serialize, SerializedInstance } from '../engine/instance'
import { demoPlace } from '../engine/templates'
import { DevConsole } from './DevConsole'
import { assets, SerializedAsset } from '../engine/assets'
import { SaveBackend, localStorageBackend } from '../engine/save'
import { canUseNetwork, hostNetwork, joinNetwork } from '../engine/net/transport'
import { joinGame } from '../engine/net/join'
import { banner, createLobby } from './lobby'

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

/** NetworkService's settings in the saved place (multiplayer is off unless Enabled). */
function networkSettings(root: SerializedInstance) {
  const svc = root.children.find((c) => c.className === 'NetworkService')
  return { enabled: !!svc?.props.Enabled, port: Number(svc?.props.Port) || 47800 }
}

async function main() {
  const container = document.getElementById('game')!
  const consoleUi = new DevConsole(document.body)
  const place = await loadPlace()
  document.title = place.name || 'RossEngine'
  assets.load(place.assets)
  const base: SessionOptions = {
    output: (kind, msg, source) => consoleUi.log(kind, msg, source),
    // exported game: files in its app-data folder; in a browser: localStorage, per game
    saveBackend: window.rossPlayer?.save ?? localStorageBackend(`ross-save:${place.name || 'game'}:`),
  }
  const net = networkSettings(place.root)
  if (!net.enabled) {
    ;(window as any).__session = await GameSession.start(container, place.root, base)
    return
  }

  // a multiplayer game: host, join, or play alone
  const lobby = createLobby(place.name || 'RossEngine', net.port, canUseNetwork())
  for (;;) {
    const choice = await lobby.choose()
    try {
      if (choice.mode === 'solo') {
        lobby.close()
        ;(window as any).__session = await GameSession.start(container, place.root, { ...base, playerName: choice.name })
        return
      }
      if (choice.mode === 'host') {
        lobby.busy('Starting the game…')
        const { link, addresses } = await hostNetwork(net.port)
        lobby.close()
        ;(window as any).__session = await GameSession.start(container, place.root, {
          ...base, playerName: choice.name, network: { role: 'host', link, placeName: place.name },
        })
        banner(`You're hosting. Others join at ${addresses.join(' or ')}`, 20000)
        return
      }
      lobby.busy(`Joining ${choice.address}…`)
      const link = await joinNetwork(choice.address, net.port)
      const welcome = await joinGame(link, choice.name)
      lobby.close()
      assets.load(welcome.assets as SerializedAsset[])
      ;(window as any).__session = await GameSession.start(container, welcome.snapshot as SerializedInstance, {
        ...base,
        saveBackend: null, // save data belongs to the host's game
        network: { role: 'client', link, player: welcome.player },
        onDisconnect: () => setTimeout(() => location.reload(), 4000), // back to the menu
      })
      return
    } catch (e) {
      lobby.error((e as Error)?.message ?? String(e))
    }
  }
}

main().catch((e) => {
  console.error(e)
  document.body.innerHTML = `<pre style="color:#f66;padding:20px">Failed to start game:\n${String(e?.stack ?? e)}</pre>`
})
