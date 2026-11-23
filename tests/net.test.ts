import { describe, it, expect } from 'vitest'
import '../src/engine/classes'
import { BasePart, DataModel } from '../src/engine/classes'
import { CFrame, Color3, Vector3 } from '../src/engine/datatypes'
import { Instance, addEventSink, createInstance, deserialize } from '../src/engine/instance'
import { NetClient, NetHost, TICK, replicates } from '../src/engine/net/Replicator'
import { decodeNet, encodeNet } from '../src/engine/net/codec'
import { joinGame } from '../src/engine/net/join'
import type { ClientLink, HostLink } from '../src/engine/net/transport'

const make = (cls: string, parent: Instance, props: Record<string, unknown> = {}) => {
  const i = createInstance(cls)
  for (const [k, v] of Object.entries(props)) i.set(k, v)
  i.setParent(parent)
  return i
}

/** A host game and one player joined over an in-memory link (every message goes through JSON, like the wire). */
async function session() {
  const host = new DataModel().initServices()
  const hostPlayer = make('Player', host.getService('Players'), { Name: 'Host' })
  make('Part', host.workspace, { Name: 'Floor', Anchored: true })
  make('Script', host.getService('ScriptService'), { Name: 'ServerOnly' })
  make('LocalScript', host.getService('ScriptService'), { Name: 'ForEachPlayer' })
  make('RemoteEvent', host.getService('Storage'), { Name: 'Ping' })
  make('Camera', host.workspace)

  const wire = <T>(m: T): T => JSON.parse(JSON.stringify(m))
  const hostLink: HostLink = {
    onConnect: () => {}, onMessage: () => {}, onDisconnect: () => {}, address: 'test',
    send: (_peer, msg) => clientLink.onMessage(wire(msg)), drop: () => {}, close: () => {},
  }
  const clientLink: ClientLink = {
    onMessage: () => {}, onClose: () => {},
    send: (msg) => hostLink.onMessage('p1', wire(msg)), close: () => {},
  }
  const net = new NetHost({
    game: host, placeName: 'Test',
    hostPlayer: () => hostPlayer,
    addPlayer: (name) => make('Player', host.getService('Players'), { Name: name }),
    removePlayer: (p) => p.destroy(),
    invokeHere: () => {}, ownershipChanged: () => {}, output: () => {}, assets: () => [],
  }, hostLink)
  hostLink.onConnect('p1')

  const welcome = await joinGame(clientLink, 'Guest')
  const map = new Map<number, Instance>()
  const game = new DataModel()
  deserialize(welcome.snapshot as never, game, map)
  game.initServices()
  const me = map.get(welcome.player)!
  const client = new NetClient({
    game, localPlayer: () => me, invokeHere: () => {}, ownershipChanged: () => {}, disconnected: () => {},
  }, clientLink, map)
  client.start()
  /** run both sides for a few network ticks */
  const tick = (n = 1) => { for (let i = 0; i < n; i++) { net.update(TICK); client.update(TICK) } }
  return { host, hostPlayer, net, game, me, client, tick }
}

describe('multiplayer', () => {
  it('encodes values for the wire, Instances as ids', () => {
    const part = createInstance('Part')
    const v = new Map<unknown, unknown>([['pos', new Vector3(1, 2, 3)], ['part', part], [1, [true, 'x']], ['cf', CFrame.fromPosition(new Vector3(4, 5, 6))]])
    const back = decodeNet(JSON.parse(JSON.stringify(encodeNet(v, (i) => i.id))), (id) => (id === part.id ? part : null)) as Map<unknown, unknown>
    expect((back.get('pos') as Vector3).z).toBe(3)
    expect(back.get('part')).toBe(part)
    expect(back.get(1)).toEqual([true, 'x'])
    expect((back.get('cf') as CFrame).position.y).toBe(5)
  })

  it('sends a joining player the world, without server code or the host\'s camera', async () => {
    const { host, game, me } = await session()
    expect(me.name).toBe('Guest')
    expect(game.workspace.findFirstChild('Floor')).toBeTruthy()
    expect(game.getService('Storage').findFirstChild('Ping')?.className).toBe('RemoteEvent')
    const scripts = game.getService('ScriptService').children.map((c) => c.name)
    expect(scripts).toEqual(['ForEachPlayer']) // the server Script stays on the host
    expect(game.workspace.children.some((c) => c.className === 'Camera')).toBe(false)
    expect(replicates(host.getService('SaveService'), host)).toBe(false)
    expect(game.getService('Players').children.map((p) => p.name).sort()).toEqual(['Guest', 'Host'])
  })

  it('streams new objects, changes and removals to the player', async () => {
    const { host, game, tick } = await session()
    const box = make('Part', host.workspace, { Name: 'Box', Color: new Color3(1, 0, 0) })
    make('Part', box, { Name: 'Lid' })
    tick()
    const copy = game.workspace.findFirstChild('Box') as BasePart
    expect(copy?.findFirstChild('Lid')).toBeTruthy()
    box.set('Color', new Color3(0, 0, 1))
    box.set('Transparency', 0.5)
    host.workspace.findFirstChild('Floor')!.destroy()
    tick()
    expect(copy.get<Color3>('Color').b).toBe(1)
    expect(copy.get<number>('Transparency')).toBe(0.5)
    expect(game.workspace.findFirstChild('Floor')).toBeNull()
    box.setParent(host.getService('Storage'))
    tick()
    expect(game.getService('Storage').findFirstChild('Box')).toBe(copy)
  })

  it('sends attributes key by key, so a player\'s own attributes survive the host\'s', async () => {
    const { hostPlayer, game, me, tick, host } = await session()
    const guestOnHost = host.getService('Players').children.find((p) => p.name === 'Guest')!
    me.attributes.set('Local', 1) // set on the player's machine only
    guestOnHost.attributes.set('Score', 5)
    host.notifyChanged(guestOnHost, 'Attributes')
    tick()
    expect(me.attributes.get('Score')).toBe(5)
    expect(me.attributes.get('Local')).toBe(1)
    void hostPlayer; void game
  })

  it('takes the player\'s own character from them, and glides it on the host', async () => {
    const { host, game, me, tick } = await session()
    const guestOnHost = host.getService('Players').children.find((p) => p.name === 'Guest')!
    const ch = make('Model', host.workspace, { Name: 'GuestChar' })
    const root = make('Part', ch, { Name: 'Root' }) as BasePart
    guestOnHost.set('Character', ch)
    tick()
    const myRoot = game.workspace.findFirstChild('GuestChar')!.findFirstChild('Root') as BasePart
    expect(me.get('Character')).toBe(myRoot.parent)
    // the player moves their character; the host glides to it
    myRoot.set('CFrame', CFrame.fromPosition(new Vector3(10, 0, 0)))
    tick(4)
    expect(root.cframe.position.x).toBeCloseTo(10, 3)
    // but the host's world is the host's: a player moving the floor changes nothing there
    const floor = game.workspace.findFirstChild('Floor') as BasePart
    floor.set('CFrame', CFrame.fromPosition(new Vector3(0, 50, 0)))
    tick(2)
    expect((host.workspace.findFirstChild('Floor') as BasePart).cframe.position.y).toBe(0)
  })

  it('delivers RemoteEvents in order with the changes', async () => {
    const { host, net, game, tick } = await session()
    const remote = host.getService('Storage').findFirstChild('Ping')!
    const got: unknown[][] = []
    const off = addEventSink((inst, ev, args) => { if (inst.dataModel === game && ev === 'OnClientEvent') got.push(args) })
    const made = make('Part', host.workspace, { Name: 'New' })
    net.fireClients(remote, null, ['hello', 3, made]) // refers to a part made this very tick
    tick()
    off()
    expect(got).toHaveLength(1)
    expect(got[0][0]).toBe('hello')
    expect(got[0][1]).toBe(3)
    expect(got[0][2]).toBe(game.workspace.findFirstChild('New'))
  })
})
