// Advances AnimatedSprite2D frames from their SpriteAnimation children.
import { Instance } from '../instance'
import { parseFrames } from '../classes2d'

interface State { anim: string; time: number; idx: number; finished: boolean }

export class Animator2D {
  private states = new Map<Instance, State>()

  /**
   * @param apply  receives the sprite-sheet frame to show
   * @param finished  called when a non-looping animation reaches its last frame
   */
  update(dt: number, sprites: Iterable<Instance>, apply: (inst: Instance, frame: number, index: number) => void, finished?: (inst: Instance, anim: string) => void) {
    for (const s of sprites) {
      if (s.className !== 'AnimatedSprite2D' || !s.get('Playing')) continue
      const anims = s.children.filter((c) => c.className === 'SpriteAnimation')
      if (!anims.length) continue
      const name = s.get<string>('Animation')
      const anim = anims.find((a) => a.name === name) ?? (name ? null : anims[0])
      if (!anim) continue
      const frames = parseFrames(anim.get<string>('Frames'))
      if (!frames.length) continue
      let st = this.states.get(s)
      if (!st || st.anim !== anim.name) {
        st = { anim: anim.name, time: 0, idx: -1, finished: false }
        this.states.set(s, st)
      }
      if (st.finished) continue
      st.time += dt * (s.get<number>('SpeedScale') ?? 1)
      const fps = Math.max(0.01, anim.get<number>('FPS') ?? 8)
      let idx = Math.floor(st.time * fps)
      if (idx >= frames.length) {
        if (anim.get('Loop')) idx %= frames.length
        else { idx = frames.length - 1; st.finished = true; finished?.(s, anim.name) }
      }
      if (idx !== st.idx) { st.idx = idx; apply(s, frames[idx], idx) }
    }
  }

  reset(inst: Instance) { this.states.delete(inst) }
}
