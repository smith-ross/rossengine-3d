// State for the Animation editor: which AnimationPlayer/Animation is open, the playhead, preview
// playback, and recording. While an animation is open the scene shows its pose at the playhead;
// changing anything inside the animated object records a keyframe there. The rest pose (the
// objects' real values) is what gets saved, undone and played: see editor.poseGuard.
import { Instance } from '../../engine/instance'
import { CFrame } from '../../engine/datatypes'
import {
  Location, NOT_ANIMATABLE, Track, applyPose, isRelative, locate, resolvePath, restFrame, sameLocation, setKey, trackTarget, tracksOf, writeTracks,
} from '../../engine/animation'
import { editor } from '../store'

type Listener = () => void

class AnimEditor {
  /** the open AnimationPlayer; its location is kept too, so it's found again after undo rebuilds the tree */
  private playerInst: Instance | null = null
  private playerPath: Location | null = null
  animName: string | null = null
  time = 0
  previewing = false
  recording = true
  /** keys selected in the timeline: `${trackIndex}:${keyTime}` */
  selected = new Set<string>()
  snap = 0.1

  private rest = new Map<Instance, Map<string, unknown>>()
  private restCF: CFrame = CFrame.identity
  private paths = new Map<Instance, Location>()
  private applying = false
  private active = false
  private unobserve: (() => void) | null = null
  private game: unknown = null
  private raf = 0
  private listeners = new Set<Listener>()

  subscribe(fn: Listener) { this.listeners.add(fn); return () => this.listeners.delete(fn) }
  private emit() { for (const fn of this.listeners) fn() }

  // ------------------------------------------------------------------ what's open
  get player(): Instance | null {
    if (this.playerInst && this.playerInst.dataModel === editor.game) return this.playerInst
    if (!this.playerPath) return null
    const i = resolvePath(editor.game, this.playerPath.path, this.playerPath.idx)
    this.playerInst = i?.className === 'AnimationPlayer' ? i : null
    return this.playerInst
  }
  get anim(): Instance | null {
    const p = this.player
    if (!p) return null
    const anims = p.children.filter((c) => c.className === 'Animation')
    return anims.find((a) => a.name === this.animName) ?? anims[0] ?? null
  }
  get root(): Instance | null { return this.player?.parent ?? null }
  tracks(): Track[] { const a = this.anim; return a ? tracksOf(a) : [] }

  open(player: Instance | null, animName?: string | null) {
    this.deactivate()
    this.playerInst = player
    this.playerPath = player ? locate(editor.game, player) : null
    this.animName = animName ?? player?.children.find((c) => c.className === 'Animation')?.name ?? null
    this.time = 0
    this.selected.clear()
    this.activate()
    this.emit()
  }
  selectAnimation(name: string) {
    this.deactivate()
    this.animName = name
    this.time = Math.min(this.time, this.length())
    this.selected.clear()
    this.activate()
    this.emit()
  }
  length() { return Math.max(0.1, this.anim?.get<number>('Length') ?? 2) }

  // ------------------------------------------------------------------ pose
  /** Show the pose at the playhead (called whenever the animation, playhead or tree changes). */
  activate() {
    if (this.active) return
    const root = this.root, anim = this.anim
    if (!root || !anim || editor.playing || editor.bottomTab !== 'animation') return
    this.active = true
    this.game = editor.game
    this.captureRest(root)
    this.restCF = restFrame(root)
    editor.poseGuard = { restore: () => this.restoreRest(), reapply: () => this.pose() }
    this.unobserve = editor.game.observe({
      changed: (inst, prop) => this.onChanged(inst, prop),
      added: (inst) => { if (this.root && (inst === this.root || inst.isDescendantOf(this.root))) this.captureRest(inst) },
    })
    this.pose()
  }

  /** Put every animated property back to its real value and stop showing the pose. */
  deactivate() {
    this.stopPreview()
    if (!this.active) return
    this.active = false
    if (this.game === editor.game) this.restoreRest()
    this.unobserve?.()
    this.unobserve = null
    editor.poseGuard = null
    this.rest.clear()
    this.paths.clear()
  }

  /** The tree was replaced (undo/redo/open): drop the old pose and show it on the new tree. */
  refresh() {
    if (this.game !== editor.game || !this.root || !this.anim) {
      this.active = false
      this.unobserve?.()
      this.unobserve = null
      editor.poseGuard = null
      this.rest.clear()
      this.paths.clear()
    }
    if (editor.playing) { this.deactivate(); return }
    this.activate()
    this.pose()
  }

  private captureRest(root: Instance, deep = true) {
    const player = this.player
    for (const inst of deep ? [root, ...root.getDescendants()] : [root]) {
      if (player && (inst === player || inst.isDescendantOf(player))) continue
      const values = new Map<string, unknown>()
      for (const [name, def] of inst.classInfo.props) {
        if (def.readonly || def.noSave || NOT_ANIMATABLE.has(name) || def.get) continue
        values.set(name, inst.get(name))
      }
      this.rest.set(inst, values)
      const p = this.root ? locate(this.root, inst) : null
      if (p) this.paths.set(inst, p)
    }
  }

  private restoreRest() { this.restoreTracks(this.tracks()) }

  pose() {
    const root = this.root, anim = this.anim
    if (!this.active || !root || !anim) return
    this.applying = true
    try { applyPose(root, tracksOf(anim), this.time, this.restCF) } finally { this.applying = false }
  }

  seek(t: number) {
    this.time = Math.max(0, Math.min(this.length(), t))
    this.pose()
    this.emit()
  }

  // ------------------------------------------------------------------ recording
  private onChanged(inst: Instance, prop: string) {
    if (this.applying || !this.active) return
    const root = this.root, player = this.player, anim = this.anim
    if (!root || !anim || !player) return
    if (inst !== root && !inst.isDescendantOf(root)) return
    if (inst === player || inst.isDescendantOf(player)) return
    if (prop === 'Name') { this.renamed(inst); return }
    const def = inst.classInfo.props.get(prop)
    if (!def || def.readonly || def.noSave || def.get || NOT_ANIMATABLE.has(prop)) return
    if (!this.recording) {
      // editing the rest pose itself
      this.rest.get(inst)?.set(prop, inst.get(prop))
      return
    }
    const loc = locate(root, inst)
    if (!loc) return
    const tracks = structuredClone(tracksOf(anim))
    let tr = tracks.find((t) => t.prop === prop && sameLocation(t, loc))
    if (!tr) {
      tr = { ...loc, prop, keys: [] }
      tracks.push(tr)
      // a new track starts from the object's real value at 0 seconds
      const restValue = this.rest.get(inst)?.get(prop)
      if (this.time > 0.0005 && restValue !== undefined) setKey(tr, 0, isRelative(inst, prop) ? this.restCF.inverse().mul(restValue as CFrame) : restValue)
    }
    const v = inst.get(prop)
    setKey(tr, this.time, isRelative(inst, prop) && v instanceof CFrame ? this.restCF.inverse().mul(v) : v)
    // part of the same edit as the property change (which already made the undo point)
    this.applying = true
    try { writeTracks(anim, tracks) } finally { this.applying = false }
    this.emit()
  }

  /** Keep tracks pointing at an object (and its children) after it's renamed. */
  private renamed(inst: Instance) {
    const old = this.paths.get(inst), root = this.root, anim = this.anim
    if (!old || !root || !anim) return
    const now = locate(root, inst)
    if (!now) return
    const tracks = structuredClone(tracksOf(anim))
    let changed = false
    const n = old.path.length
    for (const t of tracks) {
      if (t.path.length < n || !sameLocation({ path: t.path.slice(0, n), idx: t.idx?.slice(0, n) }, old)) continue
      const idx = [...(now.idx ?? now.path.map(() => 0)), ...(t.idx?.slice(n) ?? t.path.slice(n).map(() => 0))]
      t.path = [...now.path, ...t.path.slice(n)]
      if (idx.some((x) => x > 0)) t.idx = idx; else delete t.idx
      changed = true
    }
    for (const d of [inst, ...inst.getDescendants()]) { const p = locate(root, d); if (p) this.paths.set(d, p) }
    if (changed) { this.applying = true; try { writeTracks(anim, tracks) } finally { this.applying = false } }
    this.emit()
  }

  /** Edit the tracks (undoable). */
  editTracks(fn: (tracks: Track[]) => void, checkpoint = true) {
    const anim = this.anim
    if (!anim) return
    const before = structuredClone(tracksOf(anim))
    const tracks = structuredClone(before)
    fn(tracks)
    const apply = () => { this.applying = true; try { writeTracks(anim, tracks.filter((t) => t.keys.length)) } finally { this.applying = false } }
    if (checkpoint) editor.mutate(apply)
    else { apply(); editor.emit() }
    // removed tracks: show the real value again
    const kept = new Set(this.tracks().map(trackKey))
    this.restoreTracks(before.filter((t) => !kept.has(trackKey(t))))
    this.pose()
    this.emit()
  }

  private restoreTracks(tracks: Track[]) {
    const root = this.root
    if (!root) return
    this.applying = true
    try {
      for (const tr of tracks) {
        const inst = trackTarget(root, tr)
        const v = inst ? this.rest.get(inst)?.get(tr.prop) : undefined
        if (inst && v !== undefined) inst.set(tr.prop, v)
      }
    } finally { this.applying = false }
  }

  /** Follow the editor: show the pose only while the Animation tab is open and the game isn't running. */
  sync() {
    const want = editor.bottomTab === 'animation' && !editor.playing && !!this.root && !!this.anim
    if (!want) { if (this.active) this.deactivate(); return }
    if (this.active && this.game !== editor.game) this.refresh()
    else if (!this.active) this.activate()
  }

  /** Key one track at the playhead with what it currently shows. */
  keyTrack(index: number) {
    const root = this.root
    if (!root) return
    this.editTracks((tracks) => {
      const t = tracks[index]
      const inst = t && trackTarget(root, t)
      if (!inst) return
      const v = inst.get(t.prop)
      setKey(t, this.time, isRelative(inst, t.prop) && v instanceof CFrame ? this.restCF.inverse().mul(v) : v)
    })
  }

  /** Key every track at the playhead with what it currently shows. */
  keyAll() {
    const root = this.root
    if (!root) return
    this.editTracks((tracks) => {
      for (const t of tracks) {
        const inst = trackTarget(root, t)
        if (!inst) continue
        const v = inst.get(t.prop)
        setKey(t, this.time, isRelative(inst, t.prop) && v instanceof CFrame ? this.restCF.inverse().mul(v) : v)
      }
    })
  }

  // ------------------------------------------------------------------ preview playback
  togglePreview() { if (this.previewing) this.stopPreview(); else this.startPreview() }
  startPreview() {
    if (this.previewing || !this.anim) return
    this.previewing = true
    if (this.time >= this.length() - 0.001) this.time = 0
    let last = performance.now()
    const tick = () => {
      if (!this.previewing) return
      const now = performance.now()
      const dt = (now - last) / 1000
      last = now
      let t = this.time + dt * (this.player?.get<number>('Speed') ?? 1)
      if (t >= this.length()) {
        if (this.anim?.get<boolean>('Looped')) t %= this.length()
        else { t = this.length(); this.previewing = false }
      }
      this.seek(t)
      if (this.previewing) this.raf = requestAnimationFrame(tick)
      else this.emit()
    }
    this.raf = requestAnimationFrame(tick)
    this.emit()
  }
  stopPreview() {
    if (!this.previewing) return
    this.previewing = false
    cancelAnimationFrame(this.raf)
    this.emit()
  }
}

const trackKey = (t: Track) => t.path.join('/') + '|' + (t.idx ?? []).join(',') + '|' + t.prop

export const animEditor = new AnimEditor()
editor.subscribe(() => animEditor.sync())
;(window as unknown as { __animEditor: AnimEditor }).__animEditor = animEditor // for debugging, like window.__editor
