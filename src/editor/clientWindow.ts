// A test player window for "Test multiplayer" in the editor: joins the editor's game (a local room)
// and plays it like a built game would, with no editor around it. Opened as index.html#ross-client=<room>&name=…
import '../engine/classes'
import { GameSession } from '../engine/game/GameSession'
import { joinLocal } from '../engine/net/transport'
import { joinGame } from '../engine/net/join'
import { assets, SerializedAsset } from '../engine/assets'
import { DevConsole } from '../player/DevConsole'

export async function runClientWindow() {
  const params = new URLSearchParams(location.hash.slice(1))
  const room = params.get('ross-client') ?? ''
  const name = params.get('name') || 'Player'
  document.title = `${name} — joining…`
  Object.assign(document.body.style, { margin: '0', background: '#000', overflow: 'hidden' })
  const container = document.createElement('div')
  Object.assign(container.style, { position: 'fixed', inset: '0' })
  document.body.appendChild(container)
  const status = document.createElement('div')
  Object.assign(status.style, { position: 'fixed', inset: '0', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#cfd3da', font: '600 16px system-ui, sans-serif' })
  status.textContent = `${name}: joining the game…`
  document.body.appendChild(status)
  const consoleUi = new DevConsole(document.body)
  try {
    const link = await joinLocal(room)
    const welcome = await joinGame(link, name)
    assets.load(welcome.assets as SerializedAsset[])
    status.remove()
    const session = await GameSession.start(container, welcome.snapshot as never, {
      output: (kind, msg, source) => consoleUi.log(kind, msg, source),
      network: { role: 'client', link, player: welcome.player },
      // the editor stopped the game: this window has done its job
      onDisconnect: () => setTimeout(() => window.close(), 2500),
    })
    const me = session.game.getService('Players').get<{ name: string } | null>('LocalPlayer')
    document.title = `${me?.name ?? name} — ${welcome.name}`
    ;(window as unknown as { __session: GameSession }).__session = session
  } catch (e) {
    status.textContent = `${name}: ${(e as Error)?.message ?? e}`
  }
}
