// Renders World2D (sprites, animated sprites, tilemaps, text) with an orthographic three.js camera.
// World coordinates are pixels, y down. Used by the 2D game session and the editor's 2D viewport.
import * as THREE from 'three'
import type { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { ShaderPass as ShaderPassImpl } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import type { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { ShaderMat, clock, installShaderErrorHandler, makeComposer, onShaderFailed, setPassMaterial, shaderMaterial, updateShaderUniforms } from './shaders'
import { Color3, EnumItem, Vector2 } from '../datatypes'
import { Instance } from '../instance'
import { DataModel } from '../classes'
import { TileMap, Xform, apply, invert, isNode2D, localXform } from '../classes2d'
import { assets } from '../assets'

const IDENTITY: Xform = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }
const mulX = (p: Xform, q: Xform): Xform => ({
  a: p.a * q.a + p.c * q.b, b: p.b * q.a + p.d * q.b, c: p.a * q.c + p.c * q.d, d: p.b * q.c + p.d * q.d,
  tx: p.a * q.tx + p.c * q.ty + p.tx, ty: p.b * q.tx + p.d * q.ty + p.ty,
})
/** 2D affine (y down) -> three.js matrix (y up) */
function toMatrix(m: Xform, target: THREE.Matrix4) {
  return target.set(m.a, -m.c, 0, m.tx, -m.b, m.d, 0, -m.ty, 0, 0, 1, 0, 0, 0, 0, 1)
}

const PLANE = new THREE.PlaneGeometry(1, 1)
const CIRCLE = new THREE.CircleGeometry(0.5, 40)

// textures: one per (url, filtering); sprites clone them to set their own frame UVs
const texCache = new Map<string, THREE.Texture>()
function texture(content: string, pixelArt: boolean, onLoad: () => void): THREE.Texture | null {
  const url = assets.url(content)
  if (!url) return null
  const key = url + (pixelArt ? '#px' : '#smooth')
  let t = texCache.get(key)
  if (!t) {
    const tex: THREE.Texture = new THREE.TextureLoader().load(url, () => { for (const cb of (tex as any).__waiters.splice(0)) cb() })
    ;(tex as any).__waiters = [onLoad]
    tex.colorSpace = THREE.SRGBColorSpace
    if (pixelArt) { tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.NearestFilter; tex.generateMipmaps = false }
    texCache.set(key, tex)
    t = tex
  } else if (!loaded(t)) {
    ;(t as any).__waiters.push(onLoad)
  }
  return t
}
const loaded = (t: THREE.Texture | null) => !!t?.image && (t.image as HTMLImageElement).width > 0

const DRAWABLE = new Set(['Sprite2D', 'AnimatedSprite2D', 'TileMap', 'Text2D'])

interface View {
  inst: Instance
  group: THREE.Group
  mesh?: THREE.Mesh
  mat?: THREE.MeshBasicMaterial
  tex?: THREE.Texture | null
  dirty: boolean
  /** bounds in the node's local space (y down): x, y, w, h */
  bounds: { x: number; y: number; w: number; h: number }
  world: Xform
  order: number
  debug?: THREE.LineLoop
  /** active custom Shader material (replaces the drawable's material) */
  shader?: ShaderMat | null
}

export interface Renderer2DOptions {
  /** editor mode: grid, collision outlines, selection, animation preview */
  editor?: boolean
}

export class Renderer2D {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1000, 1000)
  /** camera centre in world pixels and zoom (pixels per world unit) */
  view = { x: 0, y: 0, zoom: 2 }
  onBeforeRender?: (dt: number) => void
  /** editor animation preview: frame overrides that don't touch the instance */
  frameOverride = new Map<Instance, number>()
  showCollision = false
  showGrid = false
  gridSize = 16
  private views = new Map<Instance, View>()
  private overlay = new THREE.Group()
  private selection: Instance[] = []
  private hovered: Instance | null = null
  private disposeObserver: () => void
  private disposeAssets: () => void
  private resizeObserver: ResizeObserver
  private raf = 0
  private last = performance.now()
  private running = false
  private grid: THREE.LineSegments | null = null
  private screen: { composer: EffectComposer; passes: Array<{ shader: Instance; pass: ShaderPass; sm: ShaderMat }>; key: string } | null = null
  private screenDirty = true
  private emptyScreenKey = ''
  private disposeShaderFailed: () => void
  /** drawables in draw order, rebuilt each frame */
  drawList: View[] = []
  /** every Node2D seen in the last traversal with its world transform */
  nodes = new Map<Instance, Xform>()

  constructor(readonly container: HTMLElement, readonly game: DataModel, readonly opts: Renderer2DOptions = {}) {
    this.renderer = new THREE.WebGLRenderer({ antialias: false, alpha: false })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    Object.assign(this.renderer.domElement.style, { display: 'block', width: '100%', height: '100%', imageRendering: 'pixelated' })
    this.renderer.domElement.tabIndex = 0
    container.appendChild(this.renderer.domElement)
    installShaderErrorHandler(this.renderer)
    this.disposeShaderFailed = onShaderFailed((sh) => this.shaderTouched(sh))
    this.overlay.renderOrder = 1e9
    this.scene.add(this.overlay)
    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(container)
    this.resize()
    this.disposeObserver = game.observe({
      added: (inst) => this.shaderTouched(inst),
      removing: (inst) => { this.shaderTouched(inst); for (const i of [inst, ...inst.getDescendants()]) this.removeView(i) },
      reparented: (inst) => this.shaderTouched(inst),
      changed: (inst) => {
        const v = this.views.get(inst)
        if (v) v.dirty = true
        else if (inst.parent && this.views.get(inst.parent) && inst.className === 'SpriteAnimation') this.views.get(inst.parent)!.dirty = true
        this.shaderTouched(inst)
      },
    })
    this.disposeAssets = assets.subscribe(() => { for (const v of this.views.values()) v.dirty = true })
  }

  get world2d() { return this.game.getService('World2D') }

  start() {
    if (this.running) return
    this.running = true
    this.last = performance.now()
    const loop = () => {
      if (!this.running) return
      this.raf = requestAnimationFrame(loop)
      const now = performance.now()
      const dt = Math.min(0.1, (now - this.last) / 1000)
      this.last = now
      this.onBeforeRender?.(dt)
      this.render()
    }
    this.raf = requestAnimationFrame(loop)
  }
  stop() { this.running = false; cancelAnimationFrame(this.raf) }

  dispose() {
    this.stop()
    this.disposeObserver()
    this.disposeAssets()
    this.disposeShaderFailed()
    if (this.screen) { for (const p of this.screen.passes) p.pass.dispose(); this.screen.composer.dispose() }
    this.resizeObserver.disconnect()
    for (const v of this.views.values()) { v.mat?.dispose(); v.shader?.material.dispose(); v.mesh?.geometry !== PLANE && v.mesh?.geometry !== CIRCLE && v.mesh?.geometry.dispose() }
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }

  resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1
    this.renderer.setSize(w, h, false)
    this.screen?.composer.setSize(w, h)
  }

  size() { return { w: this.container.clientWidth || 1, h: this.container.clientHeight || 1 } }

  // ------------------------------------------------------------------ coordinates
  screenToWorld(clientX: number, clientY: number): Vector2 {
    const r = this.renderer.domElement.getBoundingClientRect()
    const { w, h } = this.size()
    return new Vector2(this.view.x + (clientX - r.left - w / 2) / this.view.zoom, this.view.y + (clientY - r.top - h / 2) / this.view.zoom)
  }
  /** viewport-relative pixels -> world */
  viewportToWorld(x: number, y: number): Vector2 {
    const { w, h } = this.size()
    return new Vector2(this.view.x + (x - w / 2) / this.view.zoom, this.view.y + (y - h / 2) / this.view.zoom)
  }
  worldToViewport(p: Vector2): Vector2 {
    const { w, h } = this.size()
    return new Vector2((p.x - this.view.x) * this.view.zoom + w / 2, (p.y - this.view.y) * this.view.zoom + h / 2)
  }

  // ------------------------------------------------------------------ frame
  render() {
    const w2d = this.world2d
    const bg = w2d.get<Color3>('BackgroundColor')
    this.scene.background = new THREE.Color().setRGB(bg.r, bg.g, bg.b, THREE.SRGBColorSpace)
    const { w, h } = this.size()
    const z = Math.max(0.01, this.view.zoom)
    this.camera.left = -w / 2 / z; this.camera.right = w / 2 / z
    this.camera.top = h / 2 / z; this.camera.bottom = -h / 2 / z
    this.camera.position.set(this.view.x, -this.view.y, 10)
    this.camera.updateProjectionMatrix()

    // traverse the 2D world: compose transforms, decide draw order
    this.drawList = []
    this.nodes.clear()
    let order = 0
    const walk = (inst: Instance, parent: Xform, parentZ: number, visible: boolean) => {
      for (const c of inst.children) {
        if (isNode2D(c)) {
          const m = mulX(parent, localXform(c))
          const zi = parentZ + (c.get<number>('ZIndex') ?? 0)
          const vis = visible && c.get<boolean>('Visible') !== false
          this.nodes.set(c, m)
          if (DRAWABLE.has(c.className)) {
            const v = this.viewFor(c)
            v.world = m
            v.order = zi * 100000 + order++
            v.group.visible = vis
            this.drawList.push(v)
          }
          if (this.opts.editor && c.className !== 'TileMap') this.collisionOutline(c, m, vis)
          walk(c, m, zi, vis)
        } else walk(c, parent, parentZ, visible)
      }
    }
    walk(w2d, IDENTITY, 0, true)
    for (const v of this.drawList) {
      if (v.dirty) this.rebuild(v)
      let m = v.world
      const sf = v.inst.get<Vector2>('ScrollFactor')
      if (sf && (sf.x !== 1 || sf.y !== 1)) m = { ...m, tx: m.tx + this.view.x * (1 - sf.x), ty: m.ty + this.view.y * (1 - sf.y) }
      toMatrix(m, v.group.matrix)
      v.group.matrixWorldNeedsUpdate = true
      if (v.mesh) v.mesh.renderOrder = v.order
      if (v.mesh && this.frameOverride.has(v.inst)) this.applyFrame(v, this.frameOverride.get(v.inst)!)
    }
    this.updateOverlay()
    this.updateShaders()
    const screen = this.screenPasses()
    if (screen) screen.composer.render()
    else this.renderer.render(this.scene, this.camera)
  }

  // ------------------------------------------------------------------ custom shaders
  /** A Shader/ScreenShader was added, removed, moved or edited (or failed to compile). */
  private shaderTouched(inst: Instance) {
    if (inst.className === 'Shader' && inst.parent) { const v = this.views.get(inst.parent); if (v) v.dirty = true }
    if (inst.className === 'ScreenShader') this.screenDirty = true
  }

  private updateShaders() {
    const t = clock()
    const res = this.renderer.getDrawingBufferSize(new THREE.Vector2())
    for (const v of this.drawList) {
      const sm = v.shader
      if (!sm) continue
      updateShaderUniforms(sm, t)
      const u = sm.material.uniforms
      u.RESOLUTION.value.copy(res)
      const map = u.TEXTURE.value as THREE.Texture | null
      if (map) { map.updateMatrix(); u.UV_TRANSFORM.value.copy(map.matrix) }
    }
  }

  /** Swap the drawable's material for its Shader child's (or back). Called after each rebuild. */
  private applyShader(v: View) {
    const sh = v.inst.children.find((c) => c.className === 'Shader' && c.get<boolean>('Enabled') !== false)
    const sm = sh ? shaderMaterial(sh, '2d', v.shader) : null
    if (!sm && v.shader) v.shader.material.dispose()
    v.shader = sm
    if (!v.mesh || !v.mat) return
    if (!sm) { v.mesh.material = v.mat; return }
    const m = v.mat
    const u = sm.material.uniforms
    u.COLOR.value.set(m.color.r, m.color.g, m.color.b, m.opacity)
    u.TEXTURE.value = m.map
    u.HAS_TEXTURE.value = !!m.map
    if (!m.map) u.UV_TRANSFORM.value.identity()
    v.mesh.material = sm.material
  }

  /** ScreenShaders in World2D (or Lighting) as a post-processing chain; null when there are none. */
  private screenPasses() {
    const lighting = this.game.children.find((c) => c.className === 'Lighting')
    const shaders = [...(lighting?.children ?? []), ...this.world2d.children]
      .filter((c) => c.className === 'ScreenShader' && c.get<boolean>('Enabled') !== false)
    const key = shaders.map((sh) => sh.id).join(',')
    if (this.screenDirty || (this.screen?.key ?? this.emptyScreenKey) !== key) {
      this.screenDirty = false
      const old = this.screen
      this.screen = null
      if (old) { for (const p of old.passes) p.pass.dispose(); old.composer.dispose() }
      const passes: Array<{ shader: Instance; pass: ShaderPass; sm: ShaderMat }> = []
      for (const sh of shaders) {
        const sm = shaderMaterial(sh, 'screen')
        if (sm) passes.push({ shader: sh, pass: new ShaderPassImpl(sm.material, 'TEXTURE'), sm })
      }
      if (passes.length) this.screen = { composer: makeComposer(this.renderer, this.scene, this.camera, passes.map((p) => p.pass), this.container), passes, key }
      else this.emptyScreenKey = key
    }
    if (!this.screen) return null
    const t = clock()
    const res = this.renderer.getDrawingBufferSize(new THREE.Vector2())
    for (const p of this.screen.passes) {
      const sm = shaderMaterial(p.shader, 'screen', p.sm)
      if (!sm) { this.screenDirty = true; continue }
      if (sm !== p.sm) { p.sm = sm; setPassMaterial(p.pass, sm.material) }
      updateShaderUniforms(sm, t)
      sm.material.uniforms.RESOLUTION.value.copy(res)
    }
    return this.screen
  }

  // ------------------------------------------------------------------ views
  private viewFor(inst: Instance): View {
    let v = this.views.get(inst)
    if (v) return v
    const group = new THREE.Group()
    group.matrixAutoUpdate = false
    this.scene.add(group)
    v = { inst, group, dirty: true, bounds: { x: 0, y: 0, w: 0, h: 0 }, world: IDENTITY, order: 0 }
    this.views.set(inst, v)
    return v
  }

  private removeView(inst: Instance) {
    const v = this.views.get(inst)
    if (v) {
      this.scene.remove(v.group)
      v.mat?.dispose()
      v.shader?.material.dispose()
      if (v.mesh && v.mesh.geometry !== PLANE && v.mesh.geometry !== CIRCLE) v.mesh.geometry.dispose()
      if (v.tex && (v.tex as any).__clone) v.tex.dispose()
      this.views.delete(inst)
    }
    const d = this.debugLines.get(inst)
    if (d) { this.overlay.remove(d); this.debugLines.delete(inst) }
  }

  private rebuild(v: View) {
    v.dirty = false
    const i = v.inst
    if (!v.mat) {
      v.mat = new THREE.MeshBasicMaterial({ transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide })
    }
    const mat = v.mat
    switch (i.className) {
      case 'Sprite2D': case 'AnimatedSprite2D': this.buildSprite(v, mat); break
      case 'TileMap': this.buildTileMap(v as View & { inst: TileMap }, mat); break
      case 'Text2D': this.buildText(v, mat); break
    }
    this.applyShader(v)
  }

  private setMesh(v: View, geo: THREE.BufferGeometry) {
    if (!v.mesh) {
      v.mesh = new THREE.Mesh(geo, v.mat)
      v.group.add(v.mesh)
    } else if (v.mesh.geometry !== geo) {
      if (v.mesh.geometry !== PLANE && v.mesh.geometry !== CIRCLE) v.mesh.geometry.dispose()
      v.mesh.geometry = geo
    }
  }

  private buildSprite(v: View, mat: THREE.MeshBasicMaterial) {
    const i = v.inst
    const size = i.get<Vector2>('Size'), pivot = i.get<Vector2>('Pivot')
    const color = i.get<Color3>('Color')
    const image = i.get<string>('Image')
    mat.color.setRGB(color.r, color.g, color.b, THREE.SRGBColorSpace)
    mat.opacity = 1 - (i.get<number>('Transparency') ?? 0)
    let base: THREE.Texture | null = null
    if (image) base = texture(image, i.get<boolean>('PixelArt') !== false, () => { v.dirty = true })
    if (base) {
      if (!v.tex || v.tex.source !== base.source) {
        v.tex = base.clone()
        ;(v.tex as any).__clone = true
        // clones share the image source; it uploads itself once loaded
        if (loaded(base)) v.tex.needsUpdate = true
      }
      mat.map = v.tex
      this.setMesh(v, PLANE)
      this.applyFrame(v, this.frameOverride.get(i) ?? i.get<number>('Frame') ?? 0)
    } else {
      mat.map = null
      v.tex = null
      this.setMesh(v, i.get<EnumItem>('Shape')?.name === 'Circle' ? CIRCLE : PLANE)
    }
    mat.needsUpdate = true
    const fx = i.get<boolean>('FlipX') ? -1 : 1, fy = i.get<boolean>('FlipY') ? -1 : 1
    const mesh = v.mesh!
    mesh.scale.set(size.x * fx, size.y * fy, 1)
    // pivot (0..1, y down) -> offset of the quad centre from the node origin
    const ox = (0.5 - pivot.x) * size.x, oy = (0.5 - pivot.y) * size.y
    mesh.position.set(ox, -oy, 0)
    v.bounds = { x: -pivot.x * size.x, y: -pivot.y * size.y, w: size.x, h: size.y }
  }

  private applyFrame(v: View, frame: number) {
    const t = v.tex
    if (!t) return
    const hf = Math.max(1, v.inst.get<number>('HFrames') ?? 1), vf = Math.max(1, v.inst.get<number>('VFrames') ?? 1)
    const f = Math.max(0, Math.floor(frame)) % (hf * vf)
    const col = f % hf, row = Math.floor(f / hf)
    t.repeat.set(1 / hf, 1 / vf)
    t.offset.set(col / hf, 1 - (row + 1) / vf)
  }

  private buildTileMap(v: View & { inst: TileMap }, mat: THREE.MeshBasicMaterial) {
    const tm = v.inst
    const ts = tm.get<Vector2>('TileSize')
    const color = tm.get<Color3>('Color')
    mat.color.setRGB(color.r, color.g, color.b, THREE.SRGBColorSpace)
    mat.opacity = 1
    const image = tm.get<string>('TileSet')
    const tex = image ? texture(image, true, () => { v.dirty = true }) : null
    const ready = loaded(tex)
    mat.map = ready ? tex : null
    mat.vertexColors = !ready
    mat.needsUpdate = true
    const cols = ready ? Math.max(1, Math.floor((tex!.image as HTMLImageElement).width / ts.x)) : 1
    const rows = ready ? Math.max(1, Math.floor((tex!.image as HTMLImageElement).height / ts.y)) : 1
    const pos: number[] = [], uv: number[] = [], col: number[] = [], idx: number[] = []
    let n = 0
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const [k, tile] of tm.cells) {
      const [cx, cy] = k.split(',').map(Number)
      const x0 = cx * ts.x, y0 = cy * ts.y, x1 = x0 + ts.x, y1 = y0 + ts.y
      minX = Math.min(minX, x0); minY = Math.min(minY, y0); maxX = Math.max(maxX, x1); maxY = Math.max(maxY, y1)
      pos.push(x0, -y0, 0, x1, -y0, 0, x1, -y1, 0, x0, -y1, 0)
      if (ready) {
        const tc = tile % cols, tr = Math.floor(tile / cols) % rows
        const u0 = tc / cols, u1 = (tc + 1) / cols, v0 = 1 - tr / rows, v1 = 1 - (tr + 1) / rows
        uv.push(u0, v0, u1, v0, u1, v1, u0, v1)
        col.push(1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1)
      } else {
        // no tileset yet: a distinct colour per tile index
        const c = new THREE.Color().setHSL((tile * 0.13) % 1, 0.55, 0.55)
        uv.push(0, 0, 1, 0, 1, 1, 0, 1)
        for (let q = 0; q < 4; q++) col.push(c.r, c.g, c.b)
      }
      idx.push(n, n + 2, n + 1, n, n + 3, n + 2)
      n += 4
    }
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3))
    geo.setIndex(idx)
    this.setMesh(v, geo)
    v.mesh!.position.set(0, 0, 0)
    v.mesh!.scale.set(1, 1, 1)
    v.bounds = n ? { x: minX, y: minY, w: maxX - minX, h: maxY - minY } : { x: 0, y: 0, w: 0, h: 0 }
  }

  private buildText(v: View, mat: THREE.MeshBasicMaterial) {
    const i = v.inst
    const text = String(i.get('Text') ?? '')
    const size = Math.max(4, i.get<number>('TextSize') ?? 16)
    const font = i.get<EnumItem>('Font')?.name ?? 'GothamBold'
    const family = font.startsWith('Code') ? 'Consolas, monospace' : font.startsWith('Cartoon') ? '"Comic Sans MS", cursive' : '"Segoe UI", Arial, sans-serif'
    const weight = font.endsWith('Bold') ? '700' : '400'
    const scale = 4 // render text at 4x for crisp zoom
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')!
    ctx.font = `${weight} ${size * scale}px ${family}`
    const stroke = (i.get<number>('StrokeThickness') ?? 0) * scale
    const lines = text.split('\n')
    const tw = Math.max(1, ...lines.map((l) => ctx.measureText(l).width)) + stroke * 2 + 4
    const lh = size * scale * 1.2
    canvas.width = Math.ceil(tw)
    canvas.height = Math.ceil(lh * lines.length + stroke * 2)
    ctx.font = `${weight} ${size * scale}px ${family}`
    ctx.textBaseline = 'top'
    ctx.textAlign = 'center'
    const c = i.get<Color3>('TextColor'), sc = i.get<Color3>('StrokeColor')
    lines.forEach((l, k) => {
      const y = stroke + k * lh
      if (stroke > 0) {
        ctx.lineWidth = stroke * 2
        ctx.lineJoin = 'round'
        ctx.strokeStyle = `rgb(${sc.r * 255},${sc.g * 255},${sc.b * 255})`
        ctx.strokeText(l, canvas.width / 2, y)
      }
      ctx.fillStyle = `rgb(${c.r * 255},${c.g * 255},${c.b * 255})`
      ctx.fillText(l, canvas.width / 2, y)
    })
    if (v.tex) v.tex.dispose()
    v.tex = new THREE.CanvasTexture(canvas)
    v.tex.colorSpace = THREE.SRGBColorSpace
    mat.map = v.tex
    mat.color.setRGB(1, 1, 1)
    mat.needsUpdate = true
    this.setMesh(v, PLANE)
    const w = canvas.width / scale, h = canvas.height / scale
    v.mesh!.scale.set(w, h, 1)
    v.mesh!.position.set(0, 0, 0)
    v.bounds = { x: -w / 2, y: -h / 2, w, h }
  }

  // ------------------------------------------------------------------ editor overlay
  private debugLines = new Map<Instance, THREE.LineLoop>()
  private collisionOutline(n: Instance, m: Xform, visible: boolean) {
    if (!this.showCollision || !n.isA('PhysicsBody2D')) {
      const d = this.debugLines.get(n)
      if (d) d.visible = false
      return
    }
    let d = this.debugLines.get(n)
    if (!d) {
      d = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: n.className === 'Area2D' ? 0xffc04a : 0x4adf7a, depthTest: false }))
      d.renderOrder = 1e9
      this.debugLines.set(n, d)
      this.overlay.add(d)
    }
    d.visible = visible
    const size = n.get<Vector2>('CollisionSize'), off = n.get<Vector2>('CollisionOffset')
    const pts: number[] = []
    if (n.get<EnumItem>('CollisionShape')?.name === 'Circle') {
      const r = Math.min(size.x, size.y) / 2
      for (let k = 0; k < 32; k++) {
        const a = (k / 32) * Math.PI * 2
        const p = apply(m, off.x + Math.cos(a) * r, off.y + Math.sin(a) * r)
        pts.push(p.x, -p.y, 0)
      }
    } else {
      for (const [x, y] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) {
        const p = apply(m, off.x + x * size.x, off.y + y * size.y)
        pts.push(p.x, -p.y, 0)
      }
    }
    d.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
  }

  setSelection(insts: Instance[]) { this.selection = insts }
  setHover(inst: Instance | null) { this.hovered = inst }

  private selLines: THREE.LineSegments | null = null
  private updateOverlay() {
    // grid
    if (this.opts.editor && this.showGrid) {
      const g = this.gridSize * (this.view.zoom * this.gridSize < 6 ? 4 : 1)
      const { w, h } = this.size()
      const hw = w / 2 / this.view.zoom + g, hh = h / 2 / this.view.zoom + g
      const x0 = Math.floor((this.view.x - hw) / g) * g, x1 = this.view.x + hw
      const y0 = Math.floor((this.view.y - hh) / g) * g, y1 = this.view.y + hh
      const pts: number[] = []
      for (let x = x0; x <= x1; x += g) pts.push(x, -y0, 0, x, -y1, 0)
      for (let y = y0; y <= y1; y += g) pts.push(x0, -y, 0, x1, -y, 0)
      if (!this.grid) {
        this.grid = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.08, depthTest: false }))
        this.grid.renderOrder = -1
        this.scene.add(this.grid)
      }
      this.grid.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
      this.grid.visible = true
      // world origin axes
    } else if (this.grid) this.grid.visible = false

    // selection + hover rectangles
    const pts: number[] = []
    const rect = (inst: Instance, inset = 0) => {
      const b = this.boundsOf(inst)
      if (!b) return
      const corners = b.map((p) => [p.x, -p.y])
      for (let k = 0; k < 4; k++) {
        const a = corners[k], c = corners[(k + 1) % 4]
        pts.push(a[0] - inset, a[1], 0, c[0] - inset, c[1], 0)
      }
    }
    for (const s of this.selection) rect(s)
    if (this.hovered && !this.selection.includes(this.hovered)) rect(this.hovered)
    if (!this.selLines) {
      this.selLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x4aa3ff, depthTest: false }))
      this.selLines.renderOrder = 1e9 + 1
      this.overlay.add(this.selLines)
    }
    this.selLines.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
  }

  /** World-space corners of a node's visible area (for selection/picking). */
  boundsOf(inst: Instance): Vector2[] | null {
    const m = this.nodes.get(inst)
    if (!m) return null
    const v = this.views.get(inst)
    let b = v?.bounds
    if (!b || (b.w === 0 && b.h === 0)) {
      if (inst.isA('PhysicsBody2D')) {
        const s = inst.get<Vector2>('CollisionSize'), o = inst.get<Vector2>('CollisionOffset')
        b = { x: o.x - s.x / 2, y: o.y - s.y / 2, w: s.x, h: s.y }
      } else {
        // containers: union of children
        const pts: Vector2[] = []
        for (const d of inst.getDescendants()) { const bb = this.views.has(d) ? this.boundsOf(d) : null; if (bb) pts.push(...bb) }
        if (!pts.length) b = { x: -8, y: -8, w: 16, h: 16 }
        else {
          const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y)
          const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
          return [new Vector2(x0, y0), new Vector2(x1, y0), new Vector2(x1, y1), new Vector2(x0, y1)]
        }
      }
    }
    return [[b.x, b.y], [b.x + b.w, b.y], [b.x + b.w, b.y + b.h], [b.x, b.y + b.h]].map(([x, y]) => { const p = apply(m, x, y); return new Vector2(p.x, p.y) })
  }

  /** Topmost node under a world point. */
  pick(p: Vector2, ignore?: (i: Instance) => boolean): Instance | null {
    const candidates: Array<{ inst: Instance; order: number }> = []
    for (const v of this.drawList) if (v.group.visible) candidates.push({ inst: v.inst, order: v.order })
    for (const [n] of this.nodes) if (n.isA('PhysicsBody2D') && !this.views.has(n)) candidates.push({ inst: n, order: -1 })
    candidates.sort((a, b) => b.order - a.order)
    for (const { inst } of candidates) {
      if (ignore?.(inst)) continue
      const m = this.nodes.get(inst)
      if (!m) continue
      const l = apply(invert(m), p.x, p.y)
      if (inst instanceof TileMap) {
        const ts = inst.get<Vector2>('TileSize')
        if (inst.getCell(Math.floor(l.x / ts.x), Math.floor(l.y / ts.y)) >= 0) return inst
        continue
      }
      const b = this.views.get(inst)?.bounds
      const bb = b && (b.w || b.h) ? b : (() => { const s = inst.get<Vector2>('CollisionSize'), o = inst.get<Vector2>('CollisionOffset'); return s ? { x: o.x - s.x / 2, y: o.y - s.y / 2, w: s.x, h: s.y } : null })()
      if (bb && l.x >= bb.x && l.x <= bb.x + bb.w && l.y >= bb.y && l.y <= bb.y + bb.h) return inst
    }
    return null
  }
}
