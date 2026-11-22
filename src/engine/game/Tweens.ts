// TweenService implementation: interpolates Instance properties over time.
import * as THREE from 'three'
import { CFrame, Color3, UDim, UDim2, Vector2, Vector3 } from '../datatypes'
import { Instance, createInstance } from '../instance'
import type { TweenInfoData } from '../classes'

type Ease = (t: number) => number
const styles: Record<string, Ease> = {
  Linear: (t) => t,
  Sine: (t) => 1 - Math.cos((t * Math.PI) / 2),
  Quad: (t) => t * t,
  Cubic: (t) => t * t * t,
  Quart: (t) => t ** 4,
  Quint: (t) => t ** 5,
  Exponential: (t) => (t === 0 ? 0 : 2 ** (10 * t - 10)),
  Circular: (t) => 1 - Math.sqrt(1 - t * t),
  Back: (t) => 2.70158 * t * t * t - 1.70158 * t * t,
  Elastic: (t) => (t === 0 || t === 1 ? t : -(2 ** (10 * t - 10)) * Math.sin((t * 10 - 10.75) * ((2 * Math.PI) / 3))),
  Bounce: (t) => 1 - bounceOut(1 - t),
}
function bounceOut(t: number) {
  const n = 7.5625, d = 2.75
  if (t < 1 / d) return n * t * t
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375
  return n * (t -= 2.625 / d) * t + 0.984375
}
function ease(style: string, dir: string, t: number) {
  const f = styles[style] ?? styles.Quad
  if (dir === 'In') return f(t)
  if (dir === 'Out') return 1 - f(1 - t)
  return t < 0.5 ? f(t * 2) / 2 : 1 - f((1 - t) * 2) / 2
}

export function lerpValue(a: unknown, b: unknown, t: number): unknown {
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * t
  if (a instanceof Vector3 && b instanceof Vector3) return a.add(b.sub(a).mul(t))
  if (a instanceof Vector2 && b instanceof Vector2) return new Vector2(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t)
  if (a instanceof Color3 && b instanceof Color3) return new Color3(a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t)
  if (a instanceof UDim2 && b instanceof UDim2)
    return new UDim2(a.xs + (b.xs - a.xs) * t, a.xo + (b.xo - a.xo) * t, a.ys + (b.ys - a.ys) * t, a.yo + (b.yo - a.yo) * t)
  if (a instanceof UDim && b instanceof UDim) return new UDim(a.scale + (b.scale - a.scale) * t, a.offset + (b.offset - a.offset) * t)
  if (a instanceof CFrame && b instanceof CFrame) {
    const q = a.toQuaternion().slerp(b.toQuaternion(), t)
    const p = new THREE.Vector3(a.x, a.y, a.z).lerp(new THREE.Vector3(b.x, b.y, b.z), t)
    return CFrame.fromPositionQuaternion(p, q)
  }
  return t < 1 ? a : b
}

interface ActiveTween {
  tween: Instance
  target: Instance
  info: TweenInfoData
  goals: Map<string, unknown>
  from: Map<string, unknown>
  elapsed: number
  playing: boolean
  iteration: number
}

export class TweenManager {
  private tweens = new Map<Instance, ActiveTween>()

  create(target: Instance, info: TweenInfoData, goals: Map<string, unknown>) {
    for (const k of goals.keys()) {
      const def = target.classInfo.props.get(String(k))
      if (!def) throw new Error(`TweenService:Create property named '${k}' cannot be tweened due to type mismatch (property is not a valid member)`)
    }
    const tween = createInstance('Tween')
    tween.rawSet('Instance', target)
    this.tweens.set(tween, { tween, target, info, goals, from: new Map(), elapsed: 0, playing: false, iteration: 0 })
    return tween
  }

  control(tween: Instance, action: 'Play' | 'Pause' | 'Cancel') {
    const t = this.tweens.get(tween)
    if (!t) return
    if (action === 'Play') {
      if (!t.playing) {
        if (t.tween.get('PlaybackState') !== 'Paused') {
          t.elapsed = 0
          t.iteration = 0
          t.from.clear()
        }
        // cancel other tweens on the same properties
        for (const other of this.tweens.values()) {
          if (other !== t && other.playing && other.target === t.target && [...other.goals.keys()].some((k) => t.goals.has(k))) {
            other.playing = false
            this.setState(other, 'Cancelled')
            other.tween.fire('Completed', stateEnum('Cancelled'))
          }
        }
        for (const k of t.goals.keys()) if (!t.from.has(k)) t.from.set(k, t.target.get(String(k)))
        t.playing = true
        this.setState(t, 'Playing')
      }
    } else if (action === 'Pause') {
      if (t.playing) { t.playing = false; this.setState(t, 'Paused') }
    } else {
      if (t.playing || t.tween.get('PlaybackState') === 'Paused') {
        t.playing = false
        this.setState(t, 'Cancelled')
        t.from.clear()
        t.tween.fire('Completed', stateEnum('Cancelled'))
      }
    }
  }

  private setState(t: ActiveTween, s: string) {
    t.tween.rawSet('PlaybackState', s)
    t.tween.changed('PlaybackState')
  }

  update(dt: number) {
    for (const t of this.tweens.values()) {
      if (!t.playing) continue
      if (t.target.destroyed) { t.playing = false; continue }
      t.elapsed += dt
      const { info } = t
      const local = t.elapsed - info.delay
      if (local < 0) continue
      const dur = Math.max(info.time, 1e-6)
      const cycle = info.reverses ? dur * 2 : dur
      let phase = Math.min(local, cycle)
      let alpha = phase <= dur ? phase / dur : 1 - (phase - dur) / dur
      const eased = ease(info.style, info.direction, Math.min(Math.max(alpha, 0), 1))
      for (const [k, goal] of t.goals) {
        try { t.target.set(String(k), lerpValue(t.from.get(k), goal, eased)) } catch { /* ignore */ }
      }
      if (local >= cycle) {
        if (info.repeatCount < 0 || t.iteration < info.repeatCount) {
          t.iteration++
          t.elapsed = info.delay
        } else {
          t.playing = false
          this.setState(t, 'Completed')
          t.tween.fire('Completed', stateEnum('Completed'))
        }
      }
      void phase
    }
  }
}

function stateEnum(s: string) { return s }
