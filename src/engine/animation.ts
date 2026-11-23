// Keyframe animation: Animation (tracks of keyframes) played by an AnimationPlayer.
//
// An AnimationPlayer animates its parent (the "root") and anything inside it. Each track targets
// one property of one object, found by its path of names below the root. CFrames of parts are
// stored relative to the root's rest pose (its pivot the first time it plays), so a copy of an
// animated model works wherever it is placed. 2D positions are already relative to the parent.
import { CFrame, enumItem } from './datatypes'
import { Instance, decodeValue, encodeValue } from './instance'
import { BasePart, Model } from './classes'
import { ease, lerpValue } from './game/Tweens'

export const EASING_STYLES = ['Linear', 'Constant', 'Sine', 'Quad', 'Cubic', 'Back', 'Bounce', 'Elastic'] as const
export const EASING_DIRECTIONS = ['InOut', 'In', 'Out'] as const
export type EasingStyle = typeof EASING_STYLES[number]
export type EasingDirection = typeof EASING_DIRECTIONS[number]

export interface Keyframe {
  t: number
  /** encoded value (encodeValue format) */
  v: unknown
  /** how the value moves from this key to the next */
  ease: EasingStyle
  dir: EasingDirection
}
export interface Track {
  /** names from the root down ([] = the root itself) */
  path: string[]
  /** which same-named sibling at each step (0 = the first); only stored when some step isn't the first */
  idx?: number[]
  prop: string
  keys: Keyframe[]
}

/** Properties that are never animated (structure, code, data). */
// (derived properties such as a part's Position/Orientation are skipped too: they have a getter and record as CFrame)
export const NOT_ANIMATABLE = new Set(['Name', 'Parent', 'Archivable', 'Locked', 'Source', 'Recipe', 'Tracks', 'ClassName', 'Language'])

export function parseTracks(json: string | undefined | null): Track[] {
  if (!json) return []
  try {
    const t = JSON.parse(json)
    return Array.isArray(t) ? t.filter((x) => x && Array.isArray(x.path) && typeof x.prop === 'string' && Array.isArray(x.keys)) : []
  } catch { return [] }
}
const parsed = new WeakMap<Instance, { json: string; tracks: Track[] }>()
/** An Animation's tracks (cached until its Tracks property changes; treat as read-only). */
export function tracksOf(anim: Instance): Track[] {
  const json = anim.get<string>('Tracks') ?? ''
  const c = parsed.get(anim)
  if (c && c.json === json) return c.tracks
  const tracks = parseTracks(json)
  parsed.set(anim, { json, tracks })
  return tracks
}
export const writeTracks = (anim: Instance, tracks: Track[]) => anim.set('Tracks', JSON.stringify(tracks))

export const encode = (v: unknown) => encodeValue(v, () => null)
export const decode = (v: unknown) => decodeValue(v, () => null, enumItem)

export function pathOf(root: Instance, inst: Instance): string[] | null {
  return locate(root, inst)?.path ?? null
}
export interface Location { path: string[]; idx?: number[] }
/** Where an object is below root: names, plus which same-named sibling (models often have several "Part"s). */
export function locate(root: Instance, inst: Instance): Location | null {
  const path: string[] = [], idx: number[] = []
  for (let i: Instance | null = inst; i !== root; i = i.parent) {
    if (!i || !i.parent) return null
    const me: Instance = i
    path.unshift(me.name)
    idx.unshift(me.parent!.children.filter((c) => c.name === me.name).indexOf(me))
  }
  return idx.some((n) => n > 0) ? { path, idx } : { path }
}
export function resolvePath(root: Instance, path: string[], idx?: number[]): Instance | null {
  let i: Instance | null = root
  for (let k = 0; k < path.length; k++) {
    const named: Instance[] = i ? i.children.filter((c) => c.name === path[k]) : []
    i = named[idx?.[k] ?? 0] ?? null
    if (!i) return null
  }
  return i
}
/** The object a track animates. */
export const trackTarget = (root: Instance, t: Track) => resolvePath(root, t.path, t.idx)
/** Same object? (paths and sibling indices; a missing idx means all zeros) */
export function sameLocation(a: Location, b: Location) {
  if (a.path.length !== b.path.length || a.path.some((n, k) => n !== b.path[k])) return false
  return a.path.every((_n, k) => (a.idx?.[k] ?? 0) === (b.idx?.[k] ?? 0))
}
export const trackLabel = (t: Track) => `${t.path.length ? t.path.join('.') : '(root)'}.${t.prop}`

/** The value of a track at time t. */
export function evaluate(track: Track, t: number): unknown {
  const keys = track.keys
  if (!keys.length) return undefined
  if (t <= keys[0].t) return decode(keys[0].v)
  const last = keys[keys.length - 1]
  if (t >= last.t) return decode(last.v)
  let i = 0
  while (i < keys.length - 1 && keys[i + 1].t <= t) i++
  const a = keys[i], b = keys[i + 1]
  if (a.ease === 'Constant') return decode(a.v)
  const u = (t - a.t) / Math.max(1e-6, b.t - a.t)
  return lerpValue(decode(a.v), decode(b.v), a.ease === 'Linear' ? u : ease(a.ease, a.dir, u))
}

/** Insert or replace a key (keys stay sorted; keys closer than 1 ms are the same key). */
export function setKey(track: Track, t: number, value: unknown, easing?: Partial<Pick<Keyframe, 'ease' | 'dir'>>) {
  const existing = track.keys.find((k) => Math.abs(k.t - t) < 0.001)
  if (existing) { existing.v = encode(value); if (easing?.ease) existing.ease = easing.ease; if (easing?.dir) existing.dir = easing.dir; return existing }
  const k: Keyframe = { t, v: encode(value), ease: easing?.ease ?? 'Linear', dir: easing?.dir ?? 'InOut' }
  track.keys.push(k)
  track.keys.sort((x, y) => x.t - y.t)
  return k
}

/** The frame CFrame tracks are relative to: the root's pivot (identity for roots without one). */
export function restFrame(root: Instance): CFrame {
  if (root instanceof BasePart) return root.cframe
  if (root instanceof Model) return root.getPivot()
  return CFrame.identity
}

/** Is this property's value stored relative to the rest frame? */
export const isRelative = (inst: Instance, prop: string) => prop === 'CFrame' && inst instanceof BasePart

/** Apply an animation's pose at time t below `root`. */
export function applyPose(root: Instance, tracks: Track[], t: number, rest: CFrame) {
  for (const tr of tracks) {
    const target = trackTarget(root, tr)
    if (!target || !target.classInfo.props.has(tr.prop)) continue
    let v = evaluate(tr, t)
    if (v === undefined) continue
    if (isRelative(target, tr.prop) && v instanceof CFrame) v = rest.mul(v)
    try { target.set(tr.prop, v) } catch { /* wrong type (e.g. property changed): skip */ }
  }
}

/** The value to store in a key for an object's current property value. */
export function keyValue(inst: Instance, prop: string, rest: CFrame): unknown {
  const v = inst.get(prop)
  return isRelative(inst, prop) && v instanceof CFrame ? rest.inverse().mul(v) : v
}

// ------------------------------------------------------------------ runtime (used by GameSession)
interface PlayState {
  anim: Instance
  time: number
  playing: boolean
  rest: CFrame
}

/** Plays AnimationPlayers in a running game. */
export class AnimationRunner {
  private states = new Map<Instance, PlayState>()
  /** rest pose per player: captured the first time it plays, so Open then Close share it */
  private rests = new Map<Instance, CFrame>()

  constructor(private fire: (inst: Instance, event: string, ...args: unknown[]) => void) {}

  animationOf(player: Instance, name?: string | null): Instance | null {
    const anims = player.children.filter((c) => c.className === 'Animation')
    if (name) return anims.find((a) => a.name === name) ?? null
    const cur = player.get<string>('CurrentAnimation')
    return anims.find((a) => a.name === cur) ?? anims[0] ?? null
  }

  play(player: Instance, name?: string | null) {
    const anim = this.animationOf(player, name)
    if (!anim) throw new Error(`AnimationPlayer has no Animation${name ? ` named "${name}"` : ''}`)
    const root = player.parent
    if (!root) return
    if (!this.rests.has(player)) this.rests.set(player, restFrame(root))
    this.states.set(player, { anim, time: 0, playing: true, rest: this.rests.get(player)! })
    player.set('CurrentAnimation', anim.name)
    player.set('Playing', true)
    player.set('TimePosition', 0)
    applyPose(root, tracksOf(anim), 0, this.rests.get(player)!)
    this.fire(player, 'Played', anim.name)
  }

  stop(player: Instance) {
    const s = this.states.get(player)
    if (!s) return
    this.states.delete(player)
    player.set('Playing', false)
    this.fire(player, 'Stopped', s.anim.name)
  }

  pause(player: Instance) { const s = this.states.get(player); if (s) { s.playing = false; player.set('Playing', false) } }
  resume(player: Instance) { const s = this.states.get(player); if (s) { s.playing = true; player.set('Playing', true) } }

  seek(player: Instance, time: number) {
    const s = this.states.get(player)
    if (!s || !player.parent) return
    s.time = Math.max(0, Math.min(time, s.anim.get<number>('Length') ?? 0))
    player.set('TimePosition', s.time)
    applyPose(player.parent, tracksOf(s.anim), s.time, s.rest)
  }

  update(dt: number) {
    for (const [player, s] of [...this.states]) {
      const root = player.parent
      if (!root || !player.dataModel || !s.anim.parent) { this.states.delete(player); continue }
      if (!s.playing) continue
      const length = Math.max(0.001, s.anim.get<number>('Length') ?? 1)
      s.time += dt * (player.get<number>('Speed') ?? 1)
      let ended = false
      if (s.time >= length || s.time < 0) {
        if (s.anim.get<boolean>('Looped')) s.time = ((s.time % length) + length) % length
        else { s.time = Math.max(0, Math.min(s.time, length)); ended = true }
      }
      applyPose(root, tracksOf(s.anim), s.time, s.rest)
      player.set('TimePosition', s.time)
      if (ended) {
        this.states.delete(player)
        player.set('Playing', false)
        this.fire(player, 'Ended', s.anim.name)
      }
    }
  }

  /** AnimationPlayers with Autoplay set start when the game does. */
  autoplay(players: Instance[]) {
    for (const p of players) {
      const name = p.get<string>('Autoplay')
      if (name) { try { this.play(p, name) } catch { /* no such animation */ } }
    }
  }
}
