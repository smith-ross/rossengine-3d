// Renders ScreenGui trees as DOM elements layered over the 3D viewport.
import { Color3, EnumItem, UDim, UDim2, Vector2 } from '../datatypes'
import { Instance } from '../instance'

const FONTS: Record<string, string> = {
  SourceSans: '"Source Sans 3", "Segoe UI", Arial, sans-serif',
  SourceSansBold: '"Source Sans 3", "Segoe UI", Arial, sans-serif',
  Gotham: '"Montserrat", "Segoe UI", Arial, sans-serif',
  GothamBold: '"Montserrat", "Segoe UI", Arial, sans-serif',
  Arial: 'Arial, sans-serif',
  ArialBold: 'Arial, sans-serif',
  Code: 'Consolas, "Courier New", monospace',
  Cartoon: '"Comic Sans MS", "Comic Neue", cursive',
}

const rgba = (c: Color3, transparency = 0) =>
  `rgba(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)},${1 - transparency})`

export class GuiRenderer {
  readonly root: HTMLDivElement
  private els = new Map<Instance, HTMLElement>()
  private source: Instance | null = null
  private disposeObserver: (() => void) | null = null
  /** set while a TextBox has focus, so keyboard input isn't treated as game input */
  focused: HTMLElement | null = null
  interactive = true

  constructor(container: HTMLElement) {
    this.root = document.createElement('div')
    Object.assign(this.root.style, {
      position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden', userSelect: 'none',
    })
    container.appendChild(this.root)
  }

  /** Render all ScreenGuis under `source` (PlayerGui while playing, StarterGui while editing). */
  setSource(source: Instance | null) {
    this.disposeObserver?.()
    this.disposeObserver = null
    for (const el of this.els.values()) el.remove()
    this.els.clear()
    this.source = source
    if (!source || !source.dataModel) return
    const dm = source.dataModel as any
    this.disposeObserver = dm.observe({
      added: (i: Instance) => this.rebuildIfRelevant(i),
      removing: (i: Instance) => { if (this.els.has(i) || i === this.source || this.isUnder(i)) this.removeTree(i) ; this.refreshParent(i) },
      reparented: (i: Instance) => { this.removeTree(i); this.rebuildIfRelevant(i) },
      changed: (i: Instance, prop: string) => {
        if (this.els.has(i)) this.update(i)
        else if (i.parent && this.els.has(i.parent) && ['UICorner', 'UIStroke', 'UIListLayout'].includes(i.className)) this.update(i.parent)
        void prop
      },
    })
    for (const c of source.children) this.build(c, this.root)
  }

  dispose() {
    this.setSource(null)
    this.root.remove()
  }

  private isUnder(i: Instance) { return !!this.source && i.isDescendantOf(this.source) }

  private refreshParent(i: Instance) {
    if (i.parent && this.els.has(i.parent)) setTimeout(() => i.parent && this.els.has(i.parent) && this.update(i.parent), 0)
  }

  private rebuildIfRelevant(i: Instance) {
    if (!this.source || !(i === this.source || i.isDescendantOf(this.source))) return
    if (i === this.source) { this.setSource(this.source); return }
    const parent = i.parent!
    const parentEl = parent === this.source ? this.root : this.els.get(parent)
    if (['UICorner', 'UIStroke', 'UIListLayout'].includes(i.className)) { if (this.els.has(parent)) this.update(parent); return }
    if (parentEl) this.build(i, parentEl)
  }

  private removeTree(i: Instance) {
    for (const d of [i, ...i.getDescendants()]) {
      const el = this.els.get(d)
      if (el) { el.remove(); this.els.delete(d) }
    }
  }

  private build(inst: Instance, parentEl: HTMLElement) {
    if (this.els.has(inst)) return
    let el: HTMLElement | null = null
    if (inst.className === 'ScreenGui') {
      el = document.createElement('div')
      Object.assign(el.style, { position: 'absolute', inset: '0', pointerEvents: 'none' })
    } else if (inst.isA('GuiObject')) {
      if (inst.className === 'TextBox') {
        const input = document.createElement('input')
        input.type = 'text'
        input.addEventListener('focus', () => {
          this.focused = input
          if (inst.get('ClearTextOnFocus')) { input.value = ''; inst.set('Text', '') }
          inst.fire('Focused')
        })
        input.addEventListener('input', () => inst.set('Text', input.value))
        input.addEventListener('keydown', (e) => {
          e.stopPropagation()
          if (e.key === 'Enter') { (input as any).__enter = true; input.blur() }
        })
        input.addEventListener('blur', () => {
          this.focused = null
          inst.fire('FocusLost', !!(input as any).__enter)
          ;(input as any).__enter = false
        })
        el = input
      } else {
        el = document.createElement(inst.isA('GuiButton') ? 'button' : 'div')
        if (inst.isA('GuiButton')) {
          el.addEventListener('click', (e) => { e.stopPropagation(); inst.fire('MouseButton1Click'); inst.fire('Activated') })
          el.addEventListener('mousedown', (e) => { e.stopPropagation(); if (e.button === 0) inst.fire('MouseButton1Down') })
          el.addEventListener('mouseup', (e) => { if (e.button === 0) inst.fire('MouseButton1Up') })
          el.addEventListener('contextmenu', (e) => { e.preventDefault(); inst.fire('MouseButton2Click') })
        }
        el.addEventListener('mouseenter', () => inst.fire('MouseEnter'))
        el.addEventListener('mouseleave', () => inst.fire('MouseLeave'))
      }
      el.style.position = 'absolute'
      el.style.boxSizing = 'border-box'
      el.style.margin = '0'
      el.style.padding = '0'
      el.style.font = 'inherit'
      el.dataset.instance = String(inst.id)
    }
    if (!el) return
    this.els.set(inst, el)
    parentEl.appendChild(el)
    this.update(inst)
    for (const c of inst.children) this.build(c, el)
  }

  private update(inst: Instance) {
    const el = this.els.get(inst)
    if (!el) return
    const s = el.style
    if (inst.className === 'ScreenGui') {
      s.display = inst.get('Enabled') ? 'block' : 'none'
      s.zIndex = String(inst.get<number>('DisplayOrder') ?? 0)
      return
    }
    const pos = inst.get<UDim2>('Position'), size = inst.get<UDim2>('Size'), anchor = inst.get<Vector2>('AnchorPoint')
    const layout = inst.parent?.children.find((c) => c.className === 'UIListLayout')
    if (layout) {
      s.position = 'relative'
      s.left = s.top = ''
      s.flex = '0 0 auto'
      s.order = String(inst.get<number>('LayoutOrder') ?? 0)
    } else {
      s.position = 'absolute'
      s.left = `calc(${pos.xs * 100}% + ${pos.xo}px)`
      s.top = `calc(${pos.ys * 100}% + ${pos.yo}px)`
    }
    s.width = `calc(${size.xs * 100}% + ${size.xo}px)`
    s.height = `calc(${size.ys * 100}% + ${size.yo}px)`
    const rot = inst.get<number>('Rotation') ?? 0
    s.transform = `${layout ? '' : `translate(${-anchor.x * 100}%, ${-anchor.y * 100}%)`} rotate(${rot}deg)`
    s.zIndex = String(inst.get<number>('ZIndex') ?? 1)
    s.display = inst.get('Visible') ? (inst.children.some((c) => c.className === 'UIListLayout') ? 'flex' : 'block') : 'none'
    const bgT = inst.get<number>('BackgroundTransparency') ?? 0
    s.background = rgba(inst.get<Color3>('BackgroundColor3'), bgT)
    const border = inst.get<number>('BorderSizePixel') ?? 0
    s.border = border > 0 ? `${border}px solid ${rgba(inst.get<Color3>('BorderColor3'))}` : 'none'
    s.overflow = inst.get('ClipsDescendants') ? 'hidden' : 'visible'
    const interactive = this.interactive && (inst.isA('GuiButton') || inst.className === 'TextBox' || bgT < 1)
    s.pointerEvents = interactive ? 'auto' : 'none'
    s.cursor = inst.isA('GuiButton') ? 'pointer' : 'default'
    s.outline = 'none'

    // decorations
    const corner = inst.children.find((c) => c.className === 'UICorner')
    if (corner) {
      const r = corner.get<UDim>('CornerRadius')
      s.borderRadius = r.scale ? `calc(${r.scale * 100}% + ${r.offset}px)` : `${r.offset}px`
    } else s.borderRadius = '0'
    const stroke = inst.children.find((c) => c.className === 'UIStroke')
    if (stroke && !inst.get('Text')) {
      s.boxShadow = `inset 0 0 0 ${stroke.get<number>('Thickness')}px ${rgba(stroke.get<Color3>('Color'), stroke.get<number>('Transparency'))}`
    } else s.boxShadow = 'none'
    const list = inst.children.find((c) => c.className === 'UIListLayout')
    if (list) {
      const vertical = list.get<EnumItem>('FillDirection')?.name !== 'Horizontal'
      s.flexDirection = vertical ? 'column' : 'row'
      s.gap = `${list.get<UDim>('Padding').offset}px`
      s.alignItems = 'flex-start'
    }

    if (inst.classInfo.props.has('Text')) {
      const text = inst.get<string>('Text') ?? ''
      if (el instanceof HTMLInputElement) {
        if (el.value !== text) el.value = text
        el.placeholder = inst.get<string>('PlaceholderText') ?? ''
      } else el.textContent = text
      const font = inst.get<EnumItem>('Font')?.name ?? 'SourceSans'
      s.fontFamily = FONTS[font] ?? FONTS.SourceSans
      s.fontWeight = font.endsWith('Bold') ? '700' : '400'
      s.color = rgba(inst.get<Color3>('TextColor3'), inst.get<number>('TextTransparency') ?? 0)
      s.whiteSpace = inst.get('TextWrapped') ? 'normal' : 'nowrap'
      s.display = s.display === 'none' ? 'none' : 'flex'
      s.flexDirection = 'row'
      const xa = inst.get<EnumItem>('TextXAlignment')?.name ?? 'Center'
      const ya = inst.get<EnumItem>('TextYAlignment')?.name ?? 'Center'
      s.justifyContent = xa === 'Left' ? 'flex-start' : xa === 'Right' ? 'flex-end' : 'center'
      s.alignItems = ya === 'Top' ? 'flex-start' : ya === 'Bottom' ? 'flex-end' : 'center'
      s.textAlign = xa.toLowerCase()
      const strokeT = inst.get<number>('TextStrokeTransparency') ?? 1
      s.textShadow = strokeT < 1 ? `0 0 2px ${rgba(inst.get<Color3>('TextStrokeColor3'), strokeT)}, 0 0 1px ${rgba(inst.get<Color3>('TextStrokeColor3'), strokeT)}` : 'none'
      if (inst.get('TextScaled')) {
        requestAnimationFrame(() => {
          const h = el.clientHeight, w = el.clientWidth
          const len = Math.max(1, text.length)
          s.fontSize = `${Math.max(6, Math.min(h * 0.8, (w / len) * 1.8, 100))}px`
        })
      } else s.fontSize = `${inst.get<number>('TextSize')}px`
      s.lineHeight = '1.1'
    }
    if (inst.classInfo.props.has('Image')) {
      const img = inst.get<string>('Image')
      if (img && /^(https?:|data:)/.test(img)) {
        s.backgroundImage = `url("${img.replace(/"/g, '%22')}")`
        s.backgroundSize = 'contain'
        s.backgroundRepeat = 'no-repeat'
        s.backgroundPosition = 'center'
      } else s.backgroundImage = 'none'
    }
  }

  elementOf(inst: Instance) { return this.els.get(inst) }
}
