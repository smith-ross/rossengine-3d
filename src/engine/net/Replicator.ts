// Multiplayer replication. The host runs the game; each player's machine gets a copy of the world
// (a snapshot when joining, then a stream of changes ~30 times a second) and sends back what its own
// player controls: their character (moves, animation, anything inside it). RemoteEvents/Functions
// travel in the same streams, in order with the changes.
import { CFrame, Vector2 } from '../datatypes'
import { Instance, SerializedInstance, deserialize, encodeValue } from '../instance'
import type { DataModel } from '../classes'
import { ClientMsg, HostMsg, NET_VERSION, Op, decodeNet, encodeNet } from './codec'
import type { ClientLink, HostLink } from './transport'
import { earlyMessages } from './join'

export const TICK = 1 / 30

/** Services the players get a copy of (not SaveService: save data stays with whoever saves). */
const REPLICATED = new Set(['Workspace', 'World2D', 'Players', 'Lighting', 'ScriptService', 'Storage', 'StarterGui', 'StarterPlayer', 'SoundService', 'NetworkService'])
/** Busy physics values nobody needs over the wire (positions are enough). */
const SKIP_PROPS = new Set(['Parent', 'AssemblyLinearVelocity', 'AssemblyAngularVelocity'])

/** Does this instance exist on the players' machines? */
export function replicates(inst: Instance, game: Instance): boolean {
  if (inst === game) return true
  let service: Instance | null = null
  for (let p: Instance | null = inst; p; p = p.parent) {
    if (p.parent === game) { service = p; break }
    // each machine has its own GUI, mouse and camera
    if (p.className === 'PlayerGui' || p.className === 'Mouse') return false
  }
  if (!service || !REPLICATED.has(service.className)) return false
  if (inst.className === 'Script') return false // server code stays on the host
  if (inst.className === 'Camera' && inst.parent === service && service.className === 'Workspace') return false
  return true
}

/** Properties every machine keeps for itself once an object exists. */
function localOnly(inst: Instance, prop: string) {
  return (inst.className === 'Camera2D' && prop !== 'Name') || (inst.className === 'Players' && prop === 'LocalPlayer')
}

/** Serialize what replicates: every stored property (noSave ones too, like Player.Character), ids = host ids. */
export function netSerialize(inst: Instance, game: Instance): SerializedInstance {
  const refOf = (i: Instance) => i.id
  const ser = (n: Instance): SerializedInstance => {
    const props: Record<string, unknown> = {}
    for (const [name, def] of n.classInfo.props) {
      if ((def.get && !def.persist) || name === 'Parent' || (n.className === 'Players' && name === 'LocalPlayer')) continue
      if (name === 'NetworkOwner' && !n.props.get(name)) continue // (almost nothing has one: keep snapshots small)
      props[name] = encodeValue(def.get ? def.get(n) : n.props.get(name), refOf)
    }
    props.Name = n.name
    const out: SerializedInstance = { className: n.className, ref: n.id, props, children: [] }
    if (n.attributes.size) out.attributes = Object.fromEntries([...n.attributes].map(([k, v]) => [k, encodeValue(v, refOf)]))
    for (const c of n.children) if (replicates(c, game)) out.children.push(ser(c))
    return out
  }
  return ser(inst)
}

/** The player whose character an instance is part of (null: the host's world). */
export function ownerOf(inst: Instance, game: DataModel): Instance | null {
  const players = game.getService('Players').children.filter((p) => p.className === 'Player')
  if (!players.length) return null
  // the nearest owner up the tree: one set with SetNetworkOwner, or a player's character
  for (let a: Instance | null = inst; a && a !== game; a = a.parent) {
    const set = a.props.get('NetworkOwner') as Instance | null | undefined
    if (set && players.includes(set)) return set
    for (const p of players) if (p.get('Character') === a) return p
  }
  return null
}

/** Did this change move control of something between machines? */
const ownershipProp = (i: Instance, prop: string) => prop === 'NetworkOwner' || (prop === 'Character' && i.className === 'Player')

/**
 * Attributes travel key by key: only the ones that changed since the last send (so one machine
 * setting "Score" doesn't wipe an attribute another machine set). `sent` remembers what went out.
 */
type SentAttrs = WeakMap<Instance, Map<string, unknown>>
function attributeDelta(inst: Instance, sent: SentAttrs, refOf: (i: Instance) => number | null) {
  const before = sent.get(inst) ?? new Map<string, unknown>()
  const set = new Map<string, unknown>(), del: string[] = []
  for (const [k, v] of inst.attributes) if (before.get(k) !== v) set.set(k, v)
  for (const k of before.keys()) if (!inst.attributes.has(k)) del.push(k)
  sent.set(inst, new Map(inst.attributes))
  return { set: encodeNet(set, refOf), del }
}

function propValue(inst: Instance, prop: string, refOf: (i: Instance) => number | null, sent: SentAttrs): unknown {
  if (prop === 'Attributes') return attributeDelta(inst, sent, refOf)
  return encodeValue(inst.get(prop), refOf)
}

function applyProp(inst: Instance, prop: string, raw: unknown, resolve: (id: number) => Instance | null, sent?: SentAttrs) {
  if (prop === 'Attributes') {
    const d = raw as { set?: unknown; del?: string[] } | null
    const set = d ? decodeNet(d.set, resolve) : null
    const changes: Array<[string, unknown]> = [...(set instanceof Map ? set : new Map())].map(([k, v]) => [String(k), v])
    for (const k of d?.del ?? []) changes.push([k, null])
    for (const [k, v] of changes) {
      if (inst.attributes.get(k) === v || (v == null && !inst.attributes.has(k))) continue
      if (v == null) inst.attributes.delete(k)
      else inst.attributes.set(k, v)
      inst.fire('AttributeChanged', k)
      inst.fire('AttributeChanged:' + k)
    }
    // what we just received is already known to the other side: don't send it back as a change
    if (sent) sent.set(inst, new Map(inst.attributes))
    inst.dataModel?.notifyChanged(inst, 'Attributes')
    return
  }
  const def = inst.classInfo.props.get(prop)
  if (!def || (def.get && !def.set)) return
  inst.set(prop, decodeNet(raw, resolve))
}

// ---- smoothing ---------------------------------------------------------------------------------
/** Positions from the network arrive ~30 times a second: glide between them instead of jumping. */
class Smoother {
  private moves = new Map<Instance, Map<string, { from: unknown; to: unknown; t: number }>>()
  /** returns false when the value should just be set (not something we smooth, or too far: a teleport) */
  target(inst: Instance, prop: string, to: unknown): boolean {
    const from = inst.get(prop)
    if (prop === 'CFrame' && from instanceof CFrame && to instanceof CFrame) {
      if (from.position.sub(to.position).magnitude > 30) return false
    } else if (prop === 'Position' && from instanceof Vector2 && to instanceof Vector2) {
      if (from.sub(to).magnitude > 300) return false
    } else if (!(prop === 'Rotation' && typeof from === 'number' && typeof to === 'number' && inst.isA('Node2D'))) return false
    let m = this.moves.get(inst)
    if (!m) { m = new Map(); this.moves.set(inst, m) }
    m.set(prop, { from, to, t: 0 })
    return true
  }
  cancel(inst: Instance, prop?: string) { if (prop) this.moves.get(inst)?.delete(prop); else this.moves.delete(inst) }
  /** stop gliding whatever this machine controls now (it just changed hands) */
  cancelWhere(mine: (inst: Instance) => boolean) { for (const inst of [...this.moves.keys()]) if (mine(inst)) this.moves.delete(inst) }
  step(dt: number, set: (inst: Instance, prop: string, v: unknown) => void) {
    for (const [inst, m] of this.moves) {
      if (inst.destroyed) { this.moves.delete(inst); continue }
      for (const [prop, mv] of m) {
        mv.t = Math.min(1, mv.t + dt / (TICK * 1.5))
        const a = mv.from, b = mv.to, k = mv.t
        const v = a instanceof CFrame ? a.Lerp(b as CFrame, k) : a instanceof Vector2 ? a.Lerp(b as Vector2, k) : (a as number) + ((b as number) - (a as number)) * k
        set(inst, prop, v)
        if (mv.t >= 1) m.delete(prop)
      }
      if (!m.size) this.moves.delete(inst)
    }
  }
}

// ---- host --------------------------------------------------------------------------------------
export interface HostHooks {
  game: DataModel
  hostPlayer(): Instance
  /** a player joined: make their Player (and character); null to refuse with a reason */
  addPlayer(name: string): Instance | string
  removePlayer(player: Instance): void
  /** run a RemoteFunction callback here; `answer` is called with its result */
  invokeHere(remote: Instance, event: '__ServerInvoke', args: unknown[], answer: (ok: boolean, value: unknown) => void): void
  ownershipChanged(): void
  output(kind: 'info' | 'warn' | 'error', msg: string): void
  assets(): unknown[]
  placeName: string
}

interface Peer { id: string; player: Instance | null; events: Op[] }

export class NetHost {
  private peers = new Map<string, Peer>()
  private known = new Set<Instance>()
  private byId = new Map<number, Instance>()
  private struct: Array<['add' | 'remove' | 'move', Instance]> = []
  private dirty = new Map<Instance, Map<string, string>>() // prop -> who changed it ('host' or a peer id)
  private origin = 'host'
  private smoothing = false
  private smoother = new Smoother()
  private sentAttrs: SentAttrs = new WeakMap()
  private acc = 0
  private disposeObserver: () => void
  private pendingAnswers = new Map<number, { peer: string; answer: (ok: boolean, value: unknown) => void }>()
  private nextReq = 1

  constructor(readonly hooks: HostHooks, readonly link: HostLink) {
    const game = hooks.game
    this.markKnown(game)
    this.disposeObserver = game.observe({
      added: (i) => this.struct.push(['add', i]),
      removing: (i) => this.struct.push(['remove', i]),
      reparented: (i) => this.struct.push(['move', i]),
      changed: (i, prop) => {
        if (ownershipProp(i, prop)) {
          hooks.ownershipChanged()
          // back with the host: stop gliding towards the last thing the player sent
          const me = hooks.hostPlayer()
          this.smoother.cancelWhere((x) => { const o = ownerOf(x, game); return !o || o === me })
        }
        if (this.smoothing || SKIP_PROPS.has(prop) || !this.known.has(i) || localOnly(i, prop)) return
        let m = this.dirty.get(i)
        if (!m) { m = new Map(); this.dirty.set(i, m) }
        m.set(prop, this.origin)
        // a change made here (not a glide towards a player's update) wins over any glide in progress
        if (this.origin === 'host') this.smoother.cancel(i, prop)
      },
    })
    link.onConnect = (peer) => this.peers.set(peer, { id: peer, player: null, events: [] })
    link.onDisconnect = (peer) => this.leave(peer)
    link.onMessage = (peer, msg) => { try { this.receive(peer, msg) } catch (e) { hooks.output('warn', `Multiplayer: bad message from a player (${(e as Error)?.message ?? e})`) } }
  }

  get address() { return this.link.address }
  get playerCount() { return [...this.peers.values()].filter((p) => p.player).length }

  dispose() {
    this.disposeObserver()
    this.link.close()
  }

  private markKnown(inst: Instance) {
    if (!replicates(inst, this.hooks.game)) return
    this.known.add(inst)
    this.byId.set(inst.id, inst)
    for (const c of inst.children) this.markKnown(c)
  }
  private forget(inst: Instance) {
    this.known.delete(inst)
    this.byId.delete(inst.id)
    this.smoother.cancel(inst)
    for (const c of inst.children) this.forget(c)
  }

  private peerOf(player: Instance) { return [...this.peers.values()].find((p) => p.player === player) }
  private resolve = (id: number) => this.byId.get(id) ?? null
  private refOf = (i: Instance) => i.id

  // ---- incoming -----------------------------------------------------------------------------
  private receive(peerId: string, msg: ClientMsg) {
    let peer = this.peers.get(peerId)
    if (!peer && msg.t === 'hello') this.peers.set(peerId, (peer = { id: peerId, player: null, events: [] })) // connected while the game was starting
    if (!peer) return
    if (msg.t === 'hello') {
      if (peer.player) return
      if (msg.version !== NET_VERSION) { this.link.send(peerId, { t: 'reject', reason: 'This game is a different version from the host\'s.' }); return }
      const name = String(msg.name || 'Player').replace(/[^\w\- ]/g, '').slice(0, 20) || 'Player'
      const made = this.hooks.addPlayer(name)
      if (typeof made === 'string') { this.link.send(peerId, { t: 'reject', reason: made }); this.link.drop(peerId); return }
      peer.player = made
      // everything before this moment goes to the others first; the newcomer gets today's world as a snapshot
      this.flush()
      this.link.send(peerId, {
        t: 'welcome', player: made.id, name: this.hooks.placeName,
        snapshot: netSerialize(this.hooks.game, this.hooks.game), assets: this.hooks.assets(),
      })
      this.hooks.output('info', `${made.name} joined the game.`)
      return
    }
    const player = peer.player
    if (!player) return
    switch (msg.t) {
      case 'up':
        // the player's own character: accept only what is theirs
        for (const [id, props] of msg.props) {
          const inst = this.byId.get(id)
          if (!inst || ownerOf(inst, this.hooks.game) !== player) continue
          this.origin = peerId
          try {
            for (const [prop, raw] of Object.entries(props)) {
              const v = prop === 'Attributes' ? null : decodeNet(raw, this.resolve)
              if (v !== null && this.smoother.target(inst, prop, v)) {
                // glide there; the others get the target value straight away
                let m = this.dirty.get(inst)
                if (!m) { m = new Map(); this.dirty.set(inst, m) }
                m.set(prop, peerId)
              } else applyProp(inst, prop, raw, this.resolve)
            }
          } finally { this.origin = 'host' }
        }
        break
      case 'ev': {
        const remote = this.byId.get(msg.remote)
        if (remote?.className === 'RemoteEvent') remote.fire('OnServerEvent', player, ...msg.args.map((a) => decodeNet(a, this.resolve)))
        break
      }
      case 'inv': {
        const remote = this.byId.get(msg.remote)
        if (remote?.className !== 'RemoteFunction') { this.link.send(peerId, { t: 'res', req: msg.req, ok: false, value: 'No such RemoteFunction on the host' }); break }
        this.hooks.invokeHere(remote, '__ServerInvoke', [player, ...msg.args.map((a) => decodeNet(a, this.resolve))],
          (ok, value) => this.link.send(peerId, { t: 'res', req: msg.req, ok, value: encodeNet(value, this.refOf) }))
        break
      }
      case 'res': {
        const p = this.pendingAnswers.get(msg.req)
        if (p) { this.pendingAnswers.delete(msg.req); p.answer(msg.ok, decodeNet(msg.value, this.resolve)) }
        break
      }
    }
  }

  private leave(peerId: string) {
    const peer = this.peers.get(peerId)
    this.peers.delete(peerId)
    for (const [req, p] of this.pendingAnswers) if (p.peer === peerId) { this.pendingAnswers.delete(req); p.answer(false, 'The player left the game') }
    if (peer?.player && !peer.player.destroyed) {
      this.hooks.output('info', `${peer.player.name} left the game.`)
      this.hooks.removePlayer(peer.player)
    }
  }

  // ---- remotes (from the host's scripts) --------------------------------------------------------
  /** RemoteEvent:FireClient / FireAllClients (player null) */
  fireClients(remote: Instance, player: Instance | null, args: unknown[]) {
    const op: Op = ['e', remote.id, 'OnClientEvent', args.map((a) => encodeNet(a, this.refOf))]
    for (const p of this.peers.values()) if (p.player && (!player || p.player === player)) p.events.push(op)
  }

  invokeClient(remote: Instance, player: Instance, args: unknown[], answer: (ok: boolean, value: unknown) => void) {
    const peer = this.peerOf(player)
    if (!peer) { answer(false, `${player.name} is not in the game`); return }
    const req = this.nextReq++
    this.pendingAnswers.set(req, { peer: peer.id, answer })
    this.link.send(peer.id, { t: 'inv', req, remote: remote.id, args: args.map((a) => encodeNet(a, this.refOf)) })
  }

  kick(player: Instance, reason: string) {
    const peer = this.peerOf(player)
    if (!peer) return false
    this.link.send(peer.id, { t: 'kick', reason })
    setTimeout(() => this.link.drop(peer.id), 200)
    return true
  }

  // ---- outgoing -----------------------------------------------------------------------------
  /** Each frame: glide players' characters, and send changes every TICK. */
  update(dt: number) {
    this.smoothing = true
    try { this.smoother.step(dt, (i, p, v) => i.set(p, v)) } finally { this.smoothing = false }
    this.acc += dt
    if (this.acc < TICK) return
    this.acc = 0
    this.flush()
  }

  private flush() {
    const game = this.hooks.game
    const ops: Op[] = []
    for (const [kind, inst] of this.struct) {
      if (kind === 'remove') {
        if (this.known.has(inst)) { ops.push(['d', inst.id]); this.forget(inst) }
        continue
      }
      const here = !inst.destroyed && inst.dataModel === game && replicates(inst, game) && !!inst.parent && this.known.has(inst.parent)
      if (kind === 'move' && this.known.has(inst)) {
        if (here) ops.push(['r', inst.id, inst.parent!.id])
        else { ops.push(['d', inst.id]); this.forget(inst) }
        continue
      }
      if (here && !this.known.has(inst)) {
        ops.push(['c', inst.parent!.id, netSerialize(inst, game)])
        this.markKnown(inst)
      }
    }
    this.struct = []
    // property values, per player: never echo a player's own change back to them
    const props = new Map<string, Array<[number, Record<string, unknown>]>>()
    for (const p of this.peers.values()) props.set(p.id, [])
    for (const [inst, m] of this.dirty) {
      if (!this.known.has(inst)) continue
      const vals: Record<string, unknown> = {}
      for (const prop of m.keys()) vals[prop] = propValue(inst, prop, this.refOf, this.sentAttrs)
      for (const p of this.peers.values()) {
        const mine = [...m].filter(([, who]) => who !== p.id).map(([prop]) => prop)
        if (!mine.length) continue
        props.get(p.id)!.push([inst.id, mine.length === m.size ? vals : Object.fromEntries(mine.map((k) => [k, vals[k]]))])
      }
    }
    this.dirty.clear()
    for (const p of this.peers.values()) {
      if (!p.player) continue
      const all = p.events.length ? ops.concat(p.events) : ops
      p.events = []
      const pp = props.get(p.id)!
      if (all.length || pp.length) this.link.send(p.id, { t: 'ops', ops: all, props: pp })
    }
  }
}

// ---- client ------------------------------------------------------------------------------------
export interface ClientHooks {
  game: DataModel
  localPlayer(): Instance | null
  invokeHere(remote: Instance, event: '__ClientInvoke', args: unknown[], answer: (ok: boolean, value: unknown) => void): void
  ownershipChanged(): void
  disconnected(reason: string): void
}

export class NetClient {
  private byNet = new Map<number, Instance>()
  private netOf = new WeakMap<Instance, number>()
  private applying = false
  private dirty = new Map<Instance, Set<string>>()
  private smoother = new Smoother()
  private sentAttrs: SentAttrs = new WeakMap()
  private acc = 0
  private disposeObserver: () => void
  private pending = new Map<number, (ok: boolean, value: unknown) => void>()
  private nextReq = 1
  private queue: HostMsg[] = []
  private ready = false

  /** `known`: the snapshot's netId -> instance map (filled by deserialize) */
  constructor(readonly hooks: ClientHooks, readonly link: ClientLink, known: Map<number, Instance>) {
    for (const [id, inst] of known) this.bind(id, inst)
    this.disposeObserver = hooks.game.observe({
      removing: (i) => this.unbind(i),
      changed: (i, prop) => {
        if (ownershipProp(i, prop)) {
          hooks.ownershipChanged()
          const me = hooks.localPlayer()
          if (me) this.smoother.cancelWhere((x) => ownerOf(x, hooks.game) === me) // ours now: no more gliding
        }
        if (this.applying || SKIP_PROPS.has(prop) || !this.netOf.has(i)) return
        // what this player controls goes to the host
        const me = hooks.localPlayer()
        if (!me || ownerOf(i, hooks.game) !== me) return
        let s = this.dirty.get(i)
        if (!s) { s = new Set(); this.dirty.set(i, s) }
        s.add(prop)
      },
    })
    this.queue.push(...(earlyMessages.get(link) ?? []))
    earlyMessages.delete(link)
    link.onMessage = (msg) => { if (this.ready) this.receive(msg); else this.queue.push(msg) }
    link.onClose = (reason) => hooks.disconnected(reason)
  }

  /** The session is set up: handle what arrived meanwhile. */
  start() {
    this.ready = true
    for (const m of this.queue.splice(0)) this.receive(m)
  }

  dispose() {
    this.disposeObserver()
    this.link.close()
  }

  private bind(id: number, inst: Instance) { this.byNet.set(id, inst); this.netOf.set(inst, id) }
  private unbind(inst: Instance) {
    const id = this.netOf.get(inst)
    if (id !== undefined) { this.byNet.delete(id); this.netOf.delete(inst) }
    this.smoother.cancel(inst)
    for (const c of inst.children) this.unbind(c)
  }
  private resolve = (id: number) => this.byNet.get(id) ?? null
  private refOf = (i: Instance) => this.netOf.get(i) ?? null

  private receive(msg: HostMsg) {
    switch (msg.t) {
      case 'ops': this.applyOps(msg.ops, msg.props); break
      case 'inv': {
        const remote = this.byNet.get(msg.remote)
        if (remote?.className !== 'RemoteFunction') { this.link.send({ t: 'res', req: msg.req, ok: false, value: 'No such RemoteFunction here' }); break }
        this.hooks.invokeHere(remote, '__ClientInvoke', msg.args.map((a) => decodeNet(a, this.resolve)),
          (ok, value) => this.link.send({ t: 'res', req: msg.req, ok, value: encodeNet(value, this.refOf) }))
        break
      }
      case 'res': {
        const answer = this.pending.get(msg.req)
        if (answer) { this.pending.delete(msg.req); answer(msg.ok, decodeNet(msg.value, this.resolve)) }
        break
      }
      case 'kick': this.link.close(); this.hooks.disconnected(msg.reason || 'You were removed from the game.'); break
    }
  }

  private applyOps(ops: Op[], props: Array<[number, Record<string, unknown>]>) {
    const me = this.hooks.localPlayer()
    this.applying = true
    try {
      for (const op of ops) {
        try {
          switch (op[0]) {
            case 'c': {
              const parent = this.byNet.get(op[1])
              const data = op[2] as SerializedInstance
              if (!parent || this.byNet.has(data.ref)) break
              // refs to existing objects resolve through the shared map; the new ones are added to it
              const inst = deserialize(data, undefined, this.byNet)
              const bindAll = (d: SerializedInstance) => { const i = this.byNet.get(d.ref); if (i) this.netOf.set(i, d.ref); for (const c of d.children) bindAll(c) }
              bindAll(data)
              inst.setParent(parent)
              break
            }
            case 'd': { const inst = this.byNet.get(op[1]); if (inst && !inst.parentLocked) inst.destroy(); break }
            case 'r': {
              const inst = this.byNet.get(op[1]), parent = this.byNet.get(op[2])
              if (inst && parent && !inst.parentLocked) inst.setParent(parent)
              break
            }
            case 'e': {
              const remote = this.byNet.get(op[1])
              if (remote) remote.fire(op[2], ...op[3].map((a) => decodeNet(a, this.resolve)))
              break
            }
          }
        } catch (e) { console.warn('multiplayer: could not apply', op[0], e) }
      }
      for (const [id, vals] of props) {
        const inst = this.byNet.get(id)
        if (!inst) continue
        // what this player controls is theirs (the host only sends changes made by the host's scripts)
        const mine = me && ownerOf(inst, this.hooks.game) === me
        for (const [prop, raw] of Object.entries(vals)) {
          if (localOnly(inst, prop)) continue
          if (!mine && prop !== 'Attributes') {
            const v = decodeNet(raw, this.resolve)
            if (this.smoother.target(inst, prop, v)) continue
          }
          this.smoother.cancel(inst, prop)
          applyProp(inst, prop, raw, this.resolve, this.sentAttrs)
        }
      }
    } finally { this.applying = false }
  }

  // ---- remotes (from this player's LocalScripts) -------------------------------------------------
  fireServer(remote: Instance, args: unknown[]) {
    const id = this.netOf.get(remote)
    if (id === undefined) throw new Error(`${remote.getFullName()} doesn't exist on the host (make RemoteEvents in the editor, or from a Script)`)
    this.link.send({ t: 'ev', remote: id, args: args.map((a) => encodeNet(a, this.refOf)) })
  }

  invokeServer(remote: Instance, args: unknown[], answer: (ok: boolean, value: unknown) => void) {
    const id = this.netOf.get(remote)
    if (id === undefined) { answer(false, `${remote.getFullName()} doesn't exist on the host`); return }
    const req = this.nextReq++
    this.pending.set(req, answer)
    this.link.send({ t: 'inv', req, remote: id, args: args.map((a) => encodeNet(a, this.refOf)) })
  }

  // ---- outgoing -----------------------------------------------------------------------------
  update(dt: number) {
    this.applying = true
    try { this.smoother.step(dt, (i, p, v) => i.set(p, v)) } finally { this.applying = false }
    this.acc += dt
    if (this.acc < TICK || !this.dirty.size) return
    this.acc = 0
    const props: Array<[number, Record<string, unknown>]> = []
    for (const [inst, set] of this.dirty) {
      const id = this.netOf.get(inst)
      if (id === undefined || inst.destroyed) continue
      props.push([id, Object.fromEntries([...set].map((p) => [p, propValue(inst, p, this.refOf, this.sentAttrs)]))])
    }
    this.dirty.clear()
    if (props.length) this.link.send({ t: 'up', props })
  }
}
