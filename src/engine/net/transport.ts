// Connections between the host and the players. Two kinds:
//  - local: windows of the same app on one machine (BroadcastChannel), for testing multiplayer in the editor
//  - network: TCP over a LAN or the internet, through the desktop app's main process (window.rossNet)
import type { ClientMsg, HostMsg } from './codec'

/** The host's side: many players. */
export interface HostLink {
  onConnect: (peer: string) => void
  onMessage: (peer: string, msg: ClientMsg) => void
  onDisconnect: (peer: string) => void
  send(peer: string, msg: HostMsg): void
  drop(peer: string): void
  close(): void
  /** what other players type to join ('' for local test rooms) */
  readonly address: string
}

/** A player's side: one host. */
export interface ClientLink {
  onMessage: (msg: HostMsg) => void
  onClose: (reason: string) => void
  send(msg: ClientMsg): void
  close(): void
}

const noop = () => {}

// ---- local (BroadcastChannel) -------------------------------------------------------------------
interface Packet { room: string; from: string; to: string; kind: 'open' | 'accept' | 'msg' | 'close' | 'ping'; data?: unknown }
const channelName = (room: string) => `ross-net:${room}`

/** Host a local test room. Players join with joinLocal(room). */
export function hostLocal(room: string): HostLink {
  const ch = new BroadcastChannel(channelName(room))
  const seen = new Map<string, number>() // peer -> last time heard
  const post = (to: string, kind: Packet['kind'], data?: unknown) => ch.postMessage({ room, from: 'host', to, kind, data } satisfies Packet)
  const link: HostLink = {
    onConnect: noop, onMessage: noop, onDisconnect: noop,
    address: '',
    send: (peer, msg) => post(peer, 'msg', msg),
    drop: (peer) => { post(peer, 'close'); if (seen.delete(peer)) link.onDisconnect(peer) },
    close: () => { post('*', 'close'); clearInterval(timer); ch.close(); removeEventListener('pagehide', bye) },
  }
  ch.onmessage = (e) => {
    const p = e.data as Packet
    if (!p || p.room !== room || p.to !== 'host') return
    if (p.kind === 'open') {
      const fresh = !seen.has(p.from)
      seen.set(p.from, performance.now())
      post(p.from, 'accept')
      if (fresh) link.onConnect(p.from)
      return
    }
    if (!seen.has(p.from)) return
    seen.set(p.from, performance.now())
    if (p.kind === 'msg') link.onMessage(p.from, p.data as ClientMsg)
    else if (p.kind === 'close') { seen.delete(p.from); link.onDisconnect(p.from) }
  }
  // keep-alive both ways; a window that stops answering (closed, crashed) is dropped
  const timer = setInterval(() => {
    post('*', 'ping')
    const now = performance.now()
    for (const [peer, t] of seen) if (now - t > 6000) { seen.delete(peer); link.onDisconnect(peer) }
  }, 1000)
  const bye = () => link.close()
  addEventListener('pagehide', bye)
  return link
}

/** Join a local test room (waits for its host for up to `timeoutMs`). */
export function joinLocal(room: string, timeoutMs = 30000): Promise<ClientLink> {
  const me = `p${Math.random().toString(36).slice(2, 10)}`
  const ch = new BroadcastChannel(channelName(room))
  const post = (kind: Packet['kind'], data?: unknown) => ch.postMessage({ room, from: me, to: 'host', kind, data } satisfies Packet)
  return new Promise((resolve, reject) => {
    let accepted = false, closed = false
    let lastHeard = performance.now()
    const link: ClientLink = {
      onMessage: noop, onClose: noop,
      send: (msg) => post('msg', msg),
      close: () => { if (closed) return; closed = true; post('close'); clearInterval(timer); clearInterval(knock); ch.close(); removeEventListener('pagehide', link.close) },
    }
    const lost = (reason: string) => { if (closed) return; link.close(); link.onClose(reason) }
    ch.onmessage = (e) => {
      const p = e.data as Packet
      if (!p || p.room !== room || p.from !== 'host' || (p.to !== me && p.to !== '*')) return
      lastHeard = performance.now()
      if (p.kind === 'accept' && !accepted) { accepted = true; clearInterval(knock); resolve(link) }
      else if (p.kind === 'msg' && accepted) link.onMessage(p.data as HostMsg)
      else if (p.kind === 'close' && accepted) lost('The host closed the game.')
    }
    const started = performance.now()
    const knock = setInterval(() => {
      if (accepted) return
      if (performance.now() - started > timeoutMs) { clearInterval(knock); clearInterval(timer); ch.close(); reject(new Error('No host answered.')) }
      else post('open')
    }, 400)
    post('open')
    const timer = setInterval(() => {
      if (!accepted) return
      post('ping')
      if (performance.now() - lastHeard > 6000) lost('Lost the connection to the host.')
    }, 1000)
    addEventListener('pagehide', link.close)
  })
}

// ---- network (TCP via the desktop app) ----------------------------------------------------------
export interface RossNetBridge {
  host(port: number): Promise<{ ok: boolean; error?: string; addresses?: string[]; port?: number }>
  join(host: string, port: number): Promise<{ ok: boolean; error?: string }>
  send(peer: string, line: string): void
  drop(peer: string): void
  close(): Promise<void>
  onEvent(cb: (e: { type: 'connect' | 'data' | 'close'; peer: string; data?: string }) => void): () => void
}
declare global { interface Window { rossNet?: RossNetBridge } }

export const canUseNetwork = () => typeof window !== 'undefined' && !!window.rossNet

/** Host over TCP on `port`. Resolves with the link and the addresses players can use. */
export async function hostNetwork(port: number): Promise<{ link: HostLink; addresses: string[] }> {
  const net = window.rossNet
  if (!net) throw new Error('Hosting needs the desktop app.')
  const r = await net.host(port)
  if (!r.ok) throw new Error(r.error || `Could not host on port ${port}.`)
  const addresses = (r.addresses ?? []).map((a) => `${a}:${r.port ?? port}`)
  const link: HostLink = {
    onConnect: noop, onMessage: noop, onDisconnect: noop,
    address: addresses[0] ?? `localhost:${port}`,
    send: (peer, msg) => net.send(peer, JSON.stringify(msg)),
    drop: (peer) => net.drop(peer),
    close: () => { off(); void net.close() },
  }
  const off = net.onEvent((e) => {
    if (e.type === 'connect') link.onConnect(e.peer)
    else if (e.type === 'close') link.onDisconnect(e.peer)
    else if (e.type === 'data' && e.data) { try { link.onMessage(e.peer, JSON.parse(e.data)) } catch { /* bad message: ignore */ } }
  })
  return { link, addresses }
}

/** Connect to a host at "address:port" (or just "address", using `defaultPort`). */
export async function joinNetwork(address: string, defaultPort: number): Promise<ClientLink> {
  const net = window.rossNet
  if (!net) throw new Error('Joining needs the desktop app.')
  const m = /^\s*\[?([^\]\s]+?)\]?(?::(\d+))?\s*$/.exec(address)
  if (!m) throw new Error(`"${address}" isn't an address (try something like 192.168.1.20:${defaultPort}).`)
  const r = await net.join(m[1], m[2] ? Number(m[2]) : defaultPort)
  if (!r.ok) throw new Error(r.error || `Could not reach ${address}.`)
  let closed = false
  const link: ClientLink = {
    onMessage: noop, onClose: noop,
    send: (msg) => net.send('host', JSON.stringify(msg)),
    close: () => { if (closed) return; closed = true; off(); void net.close() },
  }
  const off = net.onEvent((e) => {
    if (e.peer !== 'host') return
    if (e.type === 'close') { if (!closed) { link.close(); link.onClose('Lost the connection to the host.') } }
    else if (e.type === 'data' && e.data) { try { link.onMessage(JSON.parse(e.data)) } catch { /* bad message: ignore */ } }
  })
  return link
}
