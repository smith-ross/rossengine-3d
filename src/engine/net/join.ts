// Joining a host: say hello (repeated until the host answers, in case it is still starting), then
// wait for the welcome: the world as it is now, this player's id in it, and the game's assets.
import { HostMsg, NET_VERSION } from './codec'
import type { ClientLink } from './transport'

export type Welcome = Extract<HostMsg, { t: 'welcome' }>

/** Messages that arrived after the welcome but before the game was ready (NetClient picks them up). */
export const earlyMessages = new WeakMap<ClientLink, HostMsg[]>()

export function joinGame(link: ClientLink, name: string, timeoutMs = 30000): Promise<Welcome> {
  return new Promise((resolve, reject) => {
    let done = false
    let hello: ReturnType<typeof setInterval> | undefined, timer: ReturnType<typeof setTimeout> | undefined
    const finish = (fn: () => void) => { if (done) return; done = true; clearInterval(hello); clearTimeout(timer); fn() }
    const early: HostMsg[] = []
    earlyMessages.set(link, early)
    link.onMessage = (msg) => {
      if (msg.t === 'welcome') finish(() => resolve(msg))
      else if (msg.t === 'reject') finish(() => { link.close(); reject(new Error(msg.reason)) })
      else if (done) early.push(msg)
    }
    link.onClose = (reason) => finish(() => reject(new Error(reason)))
    const send = () => link.send({ t: 'hello', name, version: NET_VERSION })
    hello = setInterval(send, 1000)
    timer = setTimeout(() => finish(() => { link.close(); reject(new Error('The host did not answer.')) }), timeoutMs)
    send() // (a host on the same page may answer before this returns)
    if (done) { clearInterval(hello); clearTimeout(timer) }
  })
}
