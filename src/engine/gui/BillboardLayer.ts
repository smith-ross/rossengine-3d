// BillboardGuis: GUI drawn over a 3D part/model (or a 2D object), facing the camera. Each billboard is
// an ordinary GUI tree (built by its own GuiRenderer) inside a box that is moved every frame to where
// its adornee appears on screen. The layer sits between the game canvas and the ScreenGuis.
import { UDim2, Vector3 } from '../datatypes'
import { Instance } from '../instance'
import { GuiRenderer } from './GuiRenderer'

/** Where an adornee appears: viewport pixels, and pixels per world unit there (studs, or 2D pixels). */
export interface BillboardAnchor { x: number; y: number; unitPx: number; dist: number }

/** What a renderer (SceneRenderer or Renderer2D) provides to place billboards. */
export interface BillboardHost {
  readonly kind: '3d' | '2d'
  /** run after each rendered frame */
  afterRender: Array<() => void>
  /** null when the adornee isn't something this renderer shows, or is behind the camera */
  billboardAnchor(adornee: Instance, offset: Vector3, worldOffset: Vector3): BillboardAnchor | null
  /** 3D only: is something solid between the camera and this billboard's adornee? */
  billboardHidden?(adornee: Instance, offset: Vector3, worldOffset: Vector3): boolean
  /** the root of what this renderer draws (Workspace or World2D) */
  readonly billboardWorld: Instance
}

/** Design pixels per unit of Size scale: a 4-stud-wide 3D billboard is laid out 200px wide, then scaled. */
const DESIGN_PX = { '3d': 50, '2d': 1 }

interface Board { gui: GuiRenderer; wrap: HTMLDivElement }

/**
 * A billboard's layout size (design pixels) and how much to scale it on screen. Size in scale is in
 * world units (studs / 2D pixels) and follows the distance; a Size only in offset stays that many pixels.
 */
export function billboardBox(size: UDim2, unitPx: number, kind: '3d' | '2d') {
  const design = DESIGN_PX[kind]
  return {
    w: Math.max(0, size.xs * design + size.xo),
    h: Math.max(0, size.ys * design + size.yo),
    scale: size.xs || size.ys ? unitPx / design : 1,
  }
}

export class BillboardLayer {
  readonly root: HTMLDivElement
  private boards = new Map<Instance, Board>()
  private dirty = true
  private disposeObserver: () => void
  private readonly hook = () => this.update()
  /** GUI container whose billboards (with an Adornee) are shown too: StarterGui in the editor, PlayerGui in a game */
  private source: Instance | null = null
  /** game: buttons and text boxes in billboards can be used */
  interactive = false
  /** editor: billboards holding the selection are outlined */
  selection: Instance[] = []
  /** checked every few frames per billboard (the occlusion ray isn't free) */
  private frame = 0
  private hiddenCache = new Map<Instance, boolean>()

  constructor(container: HTMLElement, readonly game: Instance & { observe: (o: Record<string, (i: Instance) => void>) => () => void }, readonly host: BillboardHost) {
    this.root = document.createElement('div')
    Object.assign(this.root.style, { position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden', userSelect: 'none' })
    container.appendChild(this.root)
    const touch = () => { this.dirty = true }
    this.disposeObserver = game.observe({ added: touch, removing: touch, reparented: touch })
    host.afterRender.push(this.hook)
  }

  set guiSource(src: Instance | null) { this.source = src; this.dirty = true }

  /** a TextBox in a billboard has the keyboard (so typing isn't game input) */
  get focused(): HTMLElement | null {
    for (const b of this.boards.values()) if (b.gui.focused) return b.gui.focused
    return null
  }

  dispose() {
    this.disposeObserver()
    const i = this.host.afterRender.indexOf(this.hook)
    if (i >= 0) this.host.afterRender.splice(i, 1)
    for (const b of this.boards.values()) b.gui.dispose()
    this.boards.clear()
    this.root.remove()
  }

  /** The billboards this layer shows, and what each one sits on. */
  private adorneeOf(bb: Instance): Instance | null {
    const set = bb.get<Instance | null>('Adornee')
    if (set && !set.destroyed) return set
    if (!bb.isDescendantOf(this.host.billboardWorld)) return null
    // inside a part / model / 2D object: the nearest one up the tree
    for (let p = bb.parent; p && p !== this.host.billboardWorld; p = p.parent) {
      if (this.host.kind === '3d' ? p.isA('BasePart') || p.className === 'Model' : p.isA('Node2D')) return p
    }
    return null
  }

  private shown(bb: Instance) {
    return bb.isDescendantOf(this.host.billboardWorld) || (!!this.source && bb.isDescendantOf(this.source))
  }

  private sync() {
    this.dirty = false
    const want = new Set(this.game.getDescendants().filter((d) => d.className === 'BillboardGui' && this.shown(d)))
    for (const [bb, b] of this.boards) if (!want.has(bb)) { b.gui.dispose(); b.wrap.remove(); this.boards.delete(bb); this.hiddenCache.delete(bb) }
    for (const bb of want) {
      if (this.boards.has(bb)) continue
      const wrap = document.createElement('div')
      Object.assign(wrap.style, { position: 'absolute', left: '0', top: '0', pointerEvents: 'none', transformOrigin: '50% 50%' })
      this.root.appendChild(wrap)
      const gui = new GuiRenderer(wrap)
      gui.interactive = this.interactive
      gui.setSource(bb)
      this.boards.set(bb, { gui, wrap })
    }
  }

  /** Place every billboard for the frame just drawn. */
  update() {
    if (this.dirty) this.sync()
    this.frame++
    for (const [bb, { wrap }] of this.boards) {
      const s = wrap.style
      const adornee = bb.get<boolean>('Enabled') !== false ? this.adorneeOf(bb) : null
      const off = bb.get<Vector3>('StudsOffset') ?? new Vector3(0, 0, 0)
      const woff = bb.get<Vector3>('StudsOffsetWorldSpace') ?? new Vector3(0, 0, 0)
      const at = adornee ? this.host.billboardAnchor(adornee, off, woff) : null
      const max = bb.get<number>('MaxDistance') ?? 0
      const onTop = !!bb.get<boolean>('AlwaysOnTop')
      let hidden = !at || (max > 0 && at.dist > max)
      if (!hidden && !onTop && this.host.billboardHidden) {
        // behind a wall? (re-checked every 3rd frame, staggered between billboards)
        if (!this.hiddenCache.has(bb) || (this.frame + bb.id) % 3 === 0) this.hiddenCache.set(bb, this.host.billboardHidden(adornee!, off, woff))
        hidden = this.hiddenCache.get(bb)!
      }
      if (hidden || !at) { s.display = 'none'; continue }
      // laid out at a fixed design size; Size in scale (studs) then grows and shrinks with distance
      const { w, h, scale: k } = billboardBox(bb.get<UDim2>('Size') ?? new UDim2(4, 0, 1, 0), at.unitPx, this.host.kind)
      s.display = 'block'
      s.width = `${w}px`
      s.height = `${h}px`
      s.overflow = bb.get<boolean>('ClipsDescendants') ? 'hidden' : 'visible'
      s.transform = `translate(${at.x.toFixed(1)}px, ${at.y.toFixed(1)}px) translate(-50%, -50%) scale(${k.toFixed(4)})`
      // nearer billboards on top; AlwaysOnTop ones above the rest
      s.zIndex = String((onTop ? 2_000_000 : 1_000_000) - Math.round(at.dist * 10))
      const selected = this.selection.some((x) => x === bb || x.isDescendantOf(bb))
      s.outline = selected ? '1px dashed #4aa3ff' : 'none'
    }
  }
}
