// Mirrors the Workspace of a DataModel into a three.js scene.
import * as THREE from 'three'
import { CFrame, Color3, EnumItem, Vector3 } from '../datatypes'
import { Instance } from '../instance'
import { BasePart, DataModel } from '../classes'
import { materialTexture } from './textures'
import { cloneMesh, loadMesh, loadTexture } from './meshes'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { assets } from '../assets'
import type { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { ShaderMat, clock, installShaderErrorHandler, makeComposer, onShaderFailed, setPassMaterial, shaderMaterial, updateShaderUniforms } from './shaders'

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1)
const UNIT_SPHERE = new THREE.SphereGeometry(0.5, 32, 16)
const UNIT_CYLINDER = new THREE.CylinderGeometry(0.5, 0.5, 1, 32).rotateZ(Math.PI / 2) // Roblox cylinders run along X
const UNIT_PLANE = new THREE.PlaneGeometry(1, 1)
const UNIT_WEDGE = (() => {
  // Vertical face at the back (+Z), slope facing the front (-Z)
  const g = new THREE.BufferGeometry()
  const p = [
    [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5],
    [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5],
  ]
  const tris = [[0, 1, 2], [0, 2, 3], [4, 2, 5], [4, 3, 2], [4, 5, 1], [4, 1, 0], [4, 0, 3], [5, 2, 1]]
  const pos: number[] = []
  for (const t of tris) for (const i of t) pos.push(...p[i])
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.computeVertexNormals()
  return g
})()

interface PartView {
  /** root object; its matrix is CFrame * scale(Size) */
  obj: THREE.Object3D
  /** primitive mesh, or the placeholder box of a MeshPart while its mesh loads */
  mesh: THREE.Mesh
  material: THREE.MeshStandardMaterial
  /** loaded mesh (MeshPart) */
  loaded?: THREE.Object3D
  loadedKey?: string
  ownMaterials?: boolean
  /** active custom Shader material (replaces the part's material) */
  shader?: ShaderMat | null
  /** Bone instances -> bones of the loaded (cloned) skeleton */
  bones?: Map<Instance, THREE.Bone>
  boneHelper?: THREE.SkeletonHelper
}

/** The part a Bone/Skeleton belongs to. */
function rigPart(inst: Instance): BasePart | null {
  for (let i: Instance | null = inst.parent; i; i = i.parent) if (i instanceof BasePart) return i
  return null
}

/** Local transform (in part space, before scaling) for a decal on each face. */
function faceMatrix(face: string, s: Vector3): THREE.Matrix4 {
  const e = 0.012
  const m = new THREE.Matrix4()
  const r = new THREE.Matrix4()
  switch (face) {
    case 'Front': m.makeTranslation(0, 0, -s.z / 2 - e); r.makeRotationY(Math.PI); return m.multiply(r).scale(new THREE.Vector3(s.x, s.y, 1))
    case 'Back': m.makeTranslation(0, 0, s.z / 2 + e); return m.scale(new THREE.Vector3(s.x, s.y, 1))
    case 'Top': m.makeTranslation(0, s.y / 2 + e, 0); r.makeRotationX(-Math.PI / 2); return m.multiply(r).scale(new THREE.Vector3(s.x, s.z, 1))
    case 'Bottom': m.makeTranslation(0, -s.y / 2 - e, 0); r.makeRotationX(Math.PI / 2); return m.multiply(r).scale(new THREE.Vector3(s.x, s.z, 1))
    case 'Right': m.makeTranslation(s.x / 2 + e, 0, 0); r.makeRotationY(Math.PI / 2); return m.multiply(r).scale(new THREE.Vector3(s.z, s.y, 1))
    default: m.makeTranslation(-s.x / 2 - e, 0, 0); r.makeRotationY(-Math.PI / 2); return m.multiply(r).scale(new THREE.Vector3(s.z, s.y, 1))
  }
}

export class SceneRenderer {
  readonly renderer: THREE.WebGLRenderer
  readonly scene = new THREE.Scene()
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.1, 5000)
  private sun = new THREE.DirectionalLight(0xffffff, 2.2)
  private hemi = new THREE.HemisphereLight(0xbfd8ff, 0x5b5040, 0.6)
  private ambient = new THREE.AmbientLight(0xffffff, 0.3)
  private views = new Map<Instance, PartView>()
  private lights = new Map<Instance, THREE.Light>()
  private decals = new Map<Instance, THREE.Mesh>()
  private selectionBoxes = new Map<Instance, THREE.Box3Helper>()
  private hoverBox: THREE.Box3Helper
  private hovered: Instance | null = null
  private selection: Instance[] = []
  private disposeObserver: () => void
  private disposeAssets: () => void
  private sky: THREE.Mesh
  private resizeObserver: ResizeObserver
  /** Called every frame before rendering */
  onBeforeRender?: (dt: number) => void
  private raf = 0
  private last = performance.now()
  private running = false
  hidden = new Set<Instance>()
  private localTransparency = new Map<Instance, number>()
  /** parts whose Shader child changed: re-applied before the next frame */
  private shaderDirty = new Set<Instance>()
  /** parts whose Skeleton/Bones were added or removed: re-bound before the next frame */
  private rigDirty = new Set<Instance>()
  private boneMarker: THREE.Mesh
  private screen: { composer: EffectComposer; passes: Array<{ shader: Instance; pass: ShaderPass; sm: ShaderMat }>; key: string } | null = null
  private screenDirty = true
  private disposeShaderFailed: () => void

  constructor(readonly container: HTMLElement, readonly game: DataModel) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.0
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    Object.assign(this.renderer.domElement.style, { display: 'block', width: '100%', height: '100%' })
    this.renderer.domElement.tabIndex = 0
    container.appendChild(this.renderer.domElement)
    installShaderErrorHandler(this.renderer)
    this.disposeShaderFailed = onShaderFailed((sh) => {
      if (sh.className === 'ScreenShader') this.screenDirty = true
      else if (sh.parent) this.shaderDirty.add(sh.parent)
    })

    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048)
    const sc = this.sun.shadow.camera
    sc.left = -120; sc.right = 120; sc.top = 120; sc.bottom = -120; sc.near = 1; sc.far = 800
    this.sun.shadow.bias = -0.0005
    this.sun.shadow.normalBias = 0.05
    this.scene.add(this.sun, this.sun.target, this.hemi, this.ambient)

    this.sky = makeSky()
    this.scene.add(this.sky)

    // image-based lighting, so PBR/metallic materials from imported models aren't black
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    this.scene.environmentIntensity = 0.45
    pmrem.dispose()

    this.hoverBox = new THREE.Box3Helper(new THREE.Box3(), new THREE.Color(0x9fd0ff))
    ;(this.hoverBox.material as THREE.LineBasicMaterial).depthTest = false
    ;(this.hoverBox.material as THREE.LineBasicMaterial).transparent = true
    ;(this.hoverBox.material as THREE.LineBasicMaterial).opacity = 0.6
    this.hoverBox.renderOrder = 998
    this.hoverBox.visible = false
    this.scene.add(this.hoverBox)

    // the selected bone (drawn on top)
    this.boneMarker = new THREE.Mesh(new THREE.SphereGeometry(1, 12, 8), new THREE.MeshBasicMaterial({ color: 0x4aa3ff, depthTest: false, transparent: true, opacity: 0.9 }))
    this.boneMarker.renderOrder = 999
    this.boneMarker.visible = false
    this.scene.add(this.boneMarker)

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(container)
    this.resize()

    for (const d of game.getDescendants()) this.add(d)
    this.disposeObserver = game.observe({
      added: (inst) => { this.add(inst); for (const d of inst.getDescendants()) this.add(d) },
      removing: (inst) => { this.remove(inst); for (const d of inst.getDescendants()) this.remove(d) },
      reparented: (inst) => {
        for (const i of [inst, ...inst.getDescendants()]) { this.remove(i); this.add(i) }
      },
      changed: (inst, prop) => this.changed(inst, prop),
    })
    // re-resolve content when assets are imported/removed
    this.disposeAssets = assets.subscribe(() => {
      for (const [inst, v] of this.views) if (inst.className === 'MeshPart') { v.loadedKey = undefined; this.updateGeometry(inst as BasePart, v) } else this.updateMaterial(inst as BasePart, v)
      for (const d of this.decals.keys()) this.updateDecal(d)
    })
    this.applyLighting()
  }

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

  stop() {
    this.running = false
    cancelAnimationFrame(this.raf)
  }

  render() {
    const target = new THREE.Vector3()
    this.camera.getWorldDirection(target)
    const focus = this.camera.position.clone().add(target.multiplyScalar(40))
    this.sun.target.position.copy(focus)
    this.sun.position.copy(focus).add(this.sunDir.clone().multiplyScalar(300))
    this.sky.position.copy(this.camera.position)
    for (const [inst, box] of this.selectionBoxes) box.box.copy(this.boundsOf(inst))
    if (this.hovered && !this.selection.includes(this.hovered)) {
      this.hoverBox.box.copy(this.boundsOf(this.hovered))
      this.hoverBox.visible = !this.hoverBox.box.isEmpty()
    } else this.hoverBox.visible = false
    this.updateRigs()
    this.updateShaders()
    const screen = this.screenPasses()
    if (screen) screen.composer.render()
    else this.renderer.render(this.scene, this.camera)
  }

  // ------------------------------------------------------------------ rigs
  /** Match the part's Bone instances to the bones of its loaded skeleton (by name, in order). */
  private bindRig(part: BasePart, v: PartView) {
    v.bones = new Map()
    if (v.boneHelper) { this.scene.remove(v.boneHelper); v.boneHelper.dispose(); v.boneHelper = undefined }
    const skel = part.children.find((c) => c.className === 'Skeleton')
    if (!v.loaded || !skel) return
    const roots: THREE.Bone[] = []
    v.loaded.traverse((o) => { if ((o as THREE.Bone).isBone && !(o.parent as THREE.Bone | null)?.isBone) roots.push(o as THREE.Bone) })
    const match = (insts: Instance[], bones: THREE.Object3D[]) => {
      const pool = new Map<string, THREE.Bone[]>()
      for (const b of bones) if ((b as THREE.Bone).isBone) (pool.get(b.name) ?? pool.set(b.name, []).get(b.name)!).push(b as THREE.Bone)
      for (const bi of insts) {
        if (bi.className !== 'Bone') continue
        const bone = pool.get(bi.name)?.shift()
        if (!bone) continue
        v.bones!.set(bi, bone)
        this.applyBone(bi, bone)
        match(bi.children, bone.children)
      }
    }
    match(skel.children, roots)
    v.boneHelper = new THREE.SkeletonHelper(v.loaded)
    ;(v.boneHelper.material as THREE.LineBasicMaterial).depthTest = false
    v.boneHelper.renderOrder = 998
    v.boneHelper.visible = false
    this.scene.add(v.boneHelper)
  }

  /** bone pose = rest (CFrame) * animated offset (Transform) */
  private applyBone(inst: Instance, bone: THREE.Bone) {
    const cf = inst.get<CFrame>('CFrame').mul(inst.get<CFrame>('Transform'))
    bone.position.set(cf.x, cf.y, cf.z)
    bone.quaternion.copy(cf.toQuaternion() as unknown as THREE.Quaternion)
  }

  private rigTouched(inst: Instance) {
    if (inst.className !== 'Bone' && inst.className !== 'Skeleton') return
    const part = rigPart(inst)
    if (part) this.rigDirty.add(part)
  }

  private updateRigs() {
    for (const p of this.rigDirty) { const v = this.views.get(p); if (v) this.bindRig(p as BasePart, v) }
    this.rigDirty.clear()
    // skeleton lines while working with a rig; a marker on the selected bone
    let marker: THREE.Vector3 | null = null
    for (const [part, v] of this.views) {
      if (!v.boneHelper) continue
      const skel = part.children.find((c) => c.className === 'Skeleton')
      const selected = this.selection.some((s) => (s.className === 'Bone' || s.className === 'Skeleton') && s.isDescendantOf(part))
      v.boneHelper.visible = v.obj.visible && (selected || !!skel?.get<boolean>('ShowBones'))
      for (const s of this.selection) {
        const b = s.className === 'Bone' ? v.bones?.get(s) : undefined
        if (b) marker = b.getWorldPosition(new THREE.Vector3())
      }
    }
    this.boneMarker.visible = !!marker
    if (marker) {
      this.boneMarker.position.copy(marker)
      this.boneMarker.scale.setScalar(Math.max(0.05, this.camera.position.distanceTo(marker) * 0.008))
    }
  }

  /** The three.js bone driven by a Bone instance (editor gizmo), if its model is loaded. */
  boneObject(inst: Instance): THREE.Bone | null {
    const part = rigPart(inst)
    const v = part ? this.views.get(part) : undefined
    const b = v?.bones?.get(inst) ?? null
    if (b) b.updateWorldMatrix(true, false)
    return b
  }

  // ------------------------------------------------------------------ custom shaders
  private updateShaders() {
    for (const p of this.shaderDirty) { const v = this.views.get(p); if (v) this.updateMaterial(p as BasePart, v) }
    this.shaderDirty.clear()
    const t = clock()
    const res = this.renderer.getDrawingBufferSize(new THREE.Vector2())
    const sunColor = new THREE.Vector3(this.sun.color.r, this.sun.color.g, this.sun.color.b).multiplyScalar(this.sun.intensity / Math.PI)
    const ambient = new THREE.Vector3(
      this.ambient.color.r * this.ambient.intensity + this.hemi.color.r * this.hemi.intensity,
      this.ambient.color.g * this.ambient.intensity + this.hemi.color.g * this.hemi.intensity,
      this.ambient.color.b * this.ambient.intensity + this.hemi.color.b * this.hemi.intensity,
    ).multiplyScalar(1 / Math.PI).addScalar(0.08)
    for (const v of this.views.values()) {
      const sm = v.shader
      if (!sm) continue
      updateShaderUniforms(sm, t)
      const u = sm.material.uniforms
      u.RESOLUTION.value.copy(res)
      u.SUN_DIRECTION.value.copy(this.sunDir)
      u.SUN_COLOR.value.copy(sunColor)
      u.AMBIENT.value.copy(ambient)
      const map = u.TEXTURE.value as THREE.Texture | null
      if (map) { map.updateMatrix(); u.UV_TRANSFORM.value.copy(map.matrix) }
    }
  }

  /** Swap the part's material for its Shader child's (or back). Called at the end of updateMaterial. */
  private applyShader(part: BasePart, v: PartView) {
    const sh = part.children.find((c) => c.className === 'Shader' && c.get<boolean>('Enabled') !== false)
    const sm = sh ? shaderMaterial(sh, '3d', v.shader) : null
    if (!sm && v.shader) v.shader.material.dispose()
    v.shader = sm
    if (!sm) { v.mesh.material = v.material; return }
    const m = v.material
    const u = sm.material.uniforms
    u.COLOR.value.set(m.color.r, m.color.g, m.color.b, m.opacity)
    u.TEXTURE.value = m.map
    u.HAS_TEXTURE.value = !!m.map
    if (!m.map) u.UV_TRANSFORM.value.identity()
    sm.material.transparent = m.transparent || !!sh!.get<boolean>('Transparent')
    sm.material.depthWrite = !sm.material.transparent
    sm.material.side = m.side
    v.mesh.material = sm.material
    v.loaded?.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = sm.material })
  }

  /** The post-processing chain for ScreenShaders in Lighting (null when there are none). */
  private screenPasses() {
    const lighting = this.game.children.find((c) => c.className === 'Lighting')
    const shaders = lighting ? lighting.children.filter((c) => c.className === 'ScreenShader' && c.get<boolean>('Enabled') !== false) : []
    if (this.screenDirty || (this.screen?.key ?? this.emptyScreenKey) !== shaders.map((sh) => sh.id).join(',')) {
      this.screenDirty = false
      this.rebuildScreen(shaders)
    }
    if (!this.screen) return null
    const t = clock()
    const res = this.renderer.getDrawingBufferSize(new THREE.Vector2())
    for (const p of this.screen.passes) {
      // a source/attribute edit rebuilds just this pass's material
      const sm = shaderMaterial(p.shader, 'screen', p.sm)
      if (!sm) { this.screenDirty = true; continue }
      if (sm !== p.sm) { p.sm = sm; setPassMaterial(p.pass, sm.material) }
      updateShaderUniforms(sm, t)
      sm.material.uniforms.RESOLUTION.value.copy(res)
    }
    return this.screen
  }

  private rebuildScreen(shaders: Instance[]) {
    const old = this.screen
    this.screen = null
    if (old) { for (const p of old.passes) p.pass.dispose(); old.composer.dispose() }
    const passes: Array<{ shader: Instance; pass: ShaderPass; sm: ShaderMat }> = []
    for (const sh of shaders) {
      const sm = shaderMaterial(sh, 'screen')
      if (sm) passes.push({ shader: sh, pass: new ShaderPass(sm.material, 'TEXTURE'), sm })
    }
    // a failed shader is left out, but keep the key so we don't rebuild every frame
    const key = shaders.map((sh) => sh.id).join(',')
    if (!passes.length) { this.screen = null; this.emptyScreenKey = key; return }
    this.screen = { composer: makeComposer(this.renderer, this.scene, this.camera, passes.map((p) => p.pass), this.container), passes, key }
  }
  private emptyScreenKey = ''

  resize() {
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    this.renderer.setSize(w, h, false)
    this.screen?.composer.setSize(w, h)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  dispose() {
    this.stop()
    this.disposeObserver()
    this.disposeAssets()
    this.disposeShaderFailed()
    this.resizeObserver.disconnect()
    for (const v of this.views.values()) { v.material.dispose(); v.shader?.material.dispose() }
    if (this.screen) { for (const p of this.screen.passes) p.pass.dispose(); this.screen.composer.dispose() }
    this.renderer.dispose()
    this.renderer.domElement.remove()
  }

  setCameraCFrame(cf: CFrame, fov?: number) {
    cf.toMatrix4(this.camera.matrix)
    this.camera.matrix.decompose(this.camera.position, this.camera.quaternion, this.camera.scale)
    if (fov && fov !== this.camera.fov) { this.camera.fov = fov; this.camera.updateProjectionMatrix() }
  }

  // ------------------------------------------------------------------ instances
  private inWorkspace(inst: Instance) {
    return inst.isDescendantOf(this.game.workspace)
  }

  private add(inst: Instance) {
    if (this.views.has(inst) || this.lights.has(inst) || this.decals.has(inst)) return
    if (inst instanceof BasePart) {
      if (!this.inWorkspace(inst)) return
      const material = new THREE.MeshStandardMaterial()
      const mesh = new THREE.Mesh(UNIT_BOX, material)
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.userData.instance = inst
      let obj: THREE.Object3D = mesh
      if (inst.className === 'MeshPart') {
        material.side = THREE.DoubleSide // imported files often have inconsistent winding
        obj = new THREE.Group()
        obj.userData.instance = inst
        obj.add(mesh)
      }
      obj.matrixAutoUpdate = false
      const view: PartView = { obj, mesh, material }
      this.views.set(inst, view)
      this.scene.add(obj)
      this.updateGeometry(inst, view)
      this.updateTransform(inst, view)
      this.updateMaterial(inst, view)
      for (const c of inst.children) if (c.className === 'Decal') this.add(c)
      return
    }
    if (inst.className === 'Decal') {
      if (!(inst.parent instanceof BasePart) || !this.inWorkspace(inst)) return
      const mat = new THREE.MeshStandardMaterial({ transparent: true, polygonOffset: true, polygonOffsetFactor: -2, depthWrite: false })
      const m = new THREE.Mesh(UNIT_PLANE, mat)
      m.matrixAutoUpdate = false
      m.receiveShadow = true
      this.decals.set(inst, m)
      this.scene.add(m)
      this.updateDecal(inst)
      return
    }
    if (inst.isA('Light') && inst.parent instanceof BasePart && this.inWorkspace(inst)) {
      const light = inst.className === 'SpotLight' ? new THREE.SpotLight() : new THREE.PointLight()
      this.lights.set(inst, light)
      this.scene.add(light)
      if (light instanceof THREE.SpotLight) this.scene.add(light.target)
      this.updateLight(inst)
      return
    }
    if (inst.className === 'Lighting') this.applyLighting()
    this.shaderTouched(inst)
    this.rigTouched(inst)
  }

  /** A Shader/ScreenShader was added, removed, moved or edited. */
  private shaderTouched(inst: Instance) {
    if (inst.className === 'Shader' && inst.parent) this.shaderDirty.add(inst.parent)
    if (inst.className === 'ScreenShader') this.screenDirty = true
  }

  private remove(inst: Instance) {
    this.shaderTouched(inst)
    this.rigTouched(inst)
    const v = this.views.get(inst)
    if (v) {
      this.scene.remove(v.obj)
      v.material.dispose()
      v.shader?.material.dispose()
      if (v.boneHelper) { this.scene.remove(v.boneHelper); v.boneHelper.dispose() }
      this.views.delete(inst)
    }
    const d = this.decals.get(inst)
    if (d) {
      this.scene.remove(d)
      ;(d.material as THREE.Material).dispose()
      this.decals.delete(inst)
    }
    const l = this.lights.get(inst)
    if (l) {
      this.scene.remove(l)
      if (l instanceof THREE.SpotLight) this.scene.remove(l.target)
      l.dispose()
      this.lights.delete(inst)
    }
    const b = this.selectionBoxes.get(inst)
    if (b) { this.scene.remove(b); this.selectionBoxes.delete(inst) }
    if (this.hovered === inst) this.hovered = null
  }

  private changed(inst: Instance, prop: string) {
    const v = this.views.get(inst)
    if (v) {
      const p = inst as BasePart
      switch (prop) {
        case 'CFrame': this.updateTransform(p, v); this.updateAttachments(inst); break
        case 'Size': this.updateTransform(p, v); this.updateGeometry(p, v); this.updateAttachments(inst); break
        case 'Shape': case 'MeshId': this.updateGeometry(p, v); this.updateTransform(p, v); break
        case 'Color': case 'Material': case 'Transparency': case 'Reflectance': case 'CastShadow': case 'TextureID':
          this.updateMaterial(p, v); break
      }
      return
    }
    if (this.decals.has(inst)) { this.updateDecal(inst); return }
    if (this.lights.has(inst)) { this.updateLight(inst); return }
    if (inst.className === 'Lighting') this.applyLighting()
    if (inst.className === 'Bone' && (prop === 'CFrame' || prop === 'Transform')) {
      const part = rigPart(inst)
      const bone = part ? this.views.get(part)?.bones?.get(inst) : undefined
      if (bone) this.applyBone(inst, bone)
      return
    }
    if (inst.className === 'Bone' && prop === 'Name') this.rigTouched(inst)
    // Shader edits; shaderMaterial reuses the compiled material unless the source or attribute types changed
    this.shaderTouched(inst)
  }

  /** lights and decals follow their parent part */
  private updateAttachments(part: Instance) {
    for (const c of part.children) {
      if (this.lights.has(c)) this.updateLight(c)
      if (this.decals.has(c)) this.updateDecal(c)
    }
  }

  private shapeOf(part: BasePart) {
    if (part.className === 'WedgePart') return 'Wedge'
    if (part.className === 'MeshPart') return 'Mesh'
    return part.get<EnumItem | undefined>('Shape')?.name ?? 'Block'
  }

  private updateGeometry(part: BasePart, v: PartView) {
    const shape = this.shapeOf(part)
    if (shape === 'Mesh') {
      const meshId = part.get<string>('MeshId')
      if (v.loadedKey === meshId) return
      v.loadedKey = meshId
      if (v.loaded) { v.obj.remove(v.loaded); v.loaded = undefined }
      v.mesh.visible = true
      v.mesh.geometry = UNIT_BOX
      if (!meshId) return
      void loadMesh(meshId).then((m) => {
        if (!m || v.loadedKey !== meshId || !this.views.has(part)) return
        const clone = cloneMesh(m)
        clone.traverse((o) => { o.userData.instance = part; const mm = o as THREE.Mesh; if (mm.isMesh) { mm.castShadow = true; mm.receiveShadow = true } })
        v.loaded = clone
        v.ownMaterials = m.hasTextures
        v.obj.add(clone)
        v.mesh.visible = false
        this.updateMaterial(part, v)
        this.bindRig(part, v)
      })
      return
    }
    v.mesh.geometry = shape === 'Ball' ? UNIT_SPHERE : shape === 'Cylinder' ? UNIT_CYLINDER : shape === 'Wedge' ? UNIT_WEDGE : UNIT_BOX
    this.updateMaterial(part, v)
  }

  private updateTransform(part: BasePart, v: PartView) {
    const s = part.size
    const shape = this.shapeOf(part)
    let sx = s.x, sy = s.y, sz = s.z
    if (shape === 'Ball') { const d = Math.min(sx, sy, sz); sx = sy = sz = d }
    else if (shape === 'Cylinder') { const d = Math.min(sy, sz); sy = sz = d }
    part.cframe.toMatrix4(v.obj.matrix)
    v.obj.matrix.scale(new THREE.Vector3(sx, sy, sz))
    v.obj.matrixWorldNeedsUpdate = true
    const tex = v.material.map
    if (tex && !part.get<string>('TextureID')) tex.repeat.set(Math.max(sx, sz) / 4, Math.max(sy, sz) / 4)
  }

  setLocalTransparency(inst: Instance, t: number | null) {
    if (t === null) this.localTransparency.delete(inst)
    else this.localTransparency.set(inst, t)
    const v = this.views.get(inst)
    if (v) this.updateMaterial(inst as BasePart, v)
  }

  private updateMaterial(part: BasePart, v: PartView) {
    const color = part.get<Color3>('Color')
    const mat = part.get<EnumItem>('Material')?.name ?? 'Plastic'
    const local = this.localTransparency.get(part)
    const transparency = Math.max(part.get<number>('Transparency') ?? 0, local ?? 0)
    const m = v.material
    m.color.setRGB(color.r, color.g, color.b, THREE.SRGBColorSpace)
    m.emissive.setRGB(0, 0, 0)
    m.emissiveIntensity = 1
    m.roughness = 0.75
    m.metalness = 0
    m.map = null
    switch (mat) {
      case 'SmoothPlastic': m.roughness = 0.45; break
      case 'Neon': m.emissive.setRGB(color.r, color.g, color.b, THREE.SRGBColorSpace); m.emissiveIntensity = 1.6; break
      case 'Metal': m.metalness = 0.85; m.roughness = 0.35; break
      case 'Glass': m.roughness = 0.05; m.metalness = 0.1; break
      case 'Ice': m.roughness = 0.1; break
      case 'Marble': m.roughness = 0.3; break
    }
    const textureId = part.get<string>('TextureID')
    if (textureId) {
      m.map = loadTexture(textureId)
    } else if (part.className !== 'MeshPart') {
      const texture = materialTexture(mat)
      if (texture && v.mesh.geometry !== UNIT_SPHERE) {
        const t = texture.clone()
        t.needsUpdate = true
        m.map = t
      }
    }
    let opacity = 1 - transparency
    if (mat === 'Glass') opacity = Math.min(opacity, 0.6)
    m.transparent = opacity < 1
    m.opacity = opacity
    m.depthWrite = opacity >= 1
    const visible = opacity > 0.001 && !this.hidden.has(part)
    v.obj.visible = visible
    const castShadow = (part.get<boolean>('CastShadow') ?? true) && opacity > 0.5
    v.mesh.castShadow = castShadow
    m.needsUpdate = true
    // loaded meshes: either keep the file's own (textured) materials or use the part's material
    if (v.loaded) {
      const useOwn = v.ownMaterials && !textureId
      v.loaded.traverse((o) => {
        const mm = o as THREE.Mesh
        if (!mm.isMesh) return
        mm.castShadow = castShadow
        if (useOwn) {
          if (!mm.userData.ownMaterial) mm.userData.ownMaterial = Array.isArray(mm.material) ? mm.material.map((x) => x.clone()) : (mm.material as THREE.Material).clone()
          mm.material = mm.userData.ownMaterial
          for (const x of Array.isArray(mm.material) ? mm.material : [mm.material]) {
            x.transparent = opacity < 1
            x.opacity = opacity
          }
        } else mm.material = m
      })
    }
    this.updateTransform(part, v)
    this.applyShader(part, v)
  }

  private updateDecal(inst: Instance) {
    const mesh = this.decals.get(inst)
    const part = inst.parent
    if (!mesh || !(part instanceof BasePart)) return
    const mat = mesh.material as THREE.MeshStandardMaterial
    const c = inst.get<Color3>('Color3')
    mat.color.setRGB(c.r, c.g, c.b, THREE.SRGBColorSpace)
    mat.map = loadTexture(inst.get<string>('Texture'))
    mat.opacity = 1 - (inst.get<number>('Transparency') ?? 0)
    mat.needsUpdate = true
    mesh.visible = !!mat.map && mat.opacity > 0
    const face = inst.get<EnumItem>('Face')?.name ?? 'Front'
    part.cframe.toMatrix4(mesh.matrix).multiply(faceMatrix(face, part.size))
    mesh.matrixWorldNeedsUpdate = true
  }

  private updateLight(inst: Instance) {
    const light = this.lights.get(inst)!
    const part = inst.parent as BasePart | null
    const enabled = inst.get<boolean>('Enabled')
    const c = inst.get<Color3>('Color')
    light.color.setRGB(c.r, c.g, c.b, THREE.SRGBColorSpace)
    light.visible = enabled
    const range = inst.get<number>('Range')
    const brightness = inst.get<number>('Brightness')
    if (light instanceof THREE.PointLight || light instanceof THREE.SpotLight) {
      light.distance = range
      light.intensity = brightness * range * 2
      light.decay = 1.2
    }
    if (part) {
      const p = part.cframe.position
      light.position.set(p.x, p.y, p.z)
      if (light instanceof THREE.SpotLight) {
        light.angle = Math.min(Math.PI / 2, ((inst.get<number>('Angle') ?? 90) * Math.PI) / 360)
        light.penumbra = 0.3
        const face = inst.get<EnumItem>('Face')?.name ?? 'Front'
        const dirs: Record<string, Vector3> = {
          Front: new Vector3(0, 0, -1), Back: new Vector3(0, 0, 1), Top: new Vector3(0, 1, 0),
          Bottom: new Vector3(0, -1, 0), Left: new Vector3(-1, 0, 0), Right: new Vector3(1, 0, 0),
        }
        const d = part.cframe.vectorToWorld(dirs[face])
        light.target.position.set(p.x + d.x, p.y + d.y, p.z + d.z)
      }
    }
  }

  private sunDir = new THREE.Vector3(0.4, 1, 0.3).normalize()
  private applyLighting() {
    const lighting = this.game.children.find((c) => c.className === 'Lighting')
    if (!lighting) return
    const clock = lighting.get<number>('ClockTime') ?? 14
    const brightness = lighting.get<number>('Brightness') ?? 2
    const a = ((clock - 6) / 12) * Math.PI
    this.sunDir.set(Math.cos(a) * 0.8, Math.sin(a), 0.35).normalize()
    const daylight = THREE.MathUtils.clamp(this.sunDir.y * 3 + 0.3, 0, 1)
    this.sun.intensity = brightness * 1.1 * daylight
    const amb = lighting.get<Color3>('Ambient')
    const out = lighting.get<Color3>('OutdoorAmbient')
    this.ambient.color.setRGB(amb.r, amb.g, amb.b, THREE.SRGBColorSpace)
    this.ambient.intensity = 1.5
    this.hemi.color.setRGB(out.r, out.g, out.b, THREE.SRGBColorSpace).lerp(new THREE.Color(0xbfd8ff), 0.5)
    this.hemi.intensity = 0.8 + daylight * 1.0
    this.sun.color.setHSL(0.1, 0.6 * (1 - daylight) + 0.1, 0.9)
    const skyMat = this.sky.material as THREE.ShaderMaterial
    skyMat.uniforms.daylight.value = daylight
    skyMat.uniforms.sunDir.value.copy(this.sunDir)
    const fogEnd = lighting.get<number>('FogEnd') ?? 100000
    if (fogEnd < 10000) {
      const fc = lighting.get<Color3>('FogColor')
      this.scene.fog = new THREE.Fog(new THREE.Color().setRGB(fc.r, fc.g, fc.b, THREE.SRGBColorSpace), lighting.get<number>('FogStart') ?? 0, fogEnd)
    } else this.scene.fog = null
    this.renderer.shadowMap.enabled = lighting.get<boolean>('GlobalShadows') ?? true
  }

  // ------------------------------------------------------------------ picking & selection
  ray(clientX: number, clientY: number) {
    const rect = this.renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    const ray = new THREE.Raycaster()
    ray.setFromCamera(ndc, this.camera)
    return ray
  }

  pick(clientX: number, clientY: number, ignore?: (inst: Instance) => boolean): { inst: BasePart; point: THREE.Vector3; normal: THREE.Vector3 } | null {
    const ray = this.ray(clientX, clientY)
    const objs = [...this.views.values()].filter((v) => v.obj.visible).map((v) => v.obj)
    for (const hit of ray.intersectObjects(objs, true)) {
      if (!hit.object.visible) continue
      const inst = hit.object.userData.instance as BasePart | undefined
      if (!inst || ignore?.(inst)) continue
      const normal = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new THREE.Vector3(0, 1, 0)
      return { inst, point: hit.point, normal }
    }
    return null
  }

  boundsOf(inst: Instance): THREE.Box3 {
    const box = new THREE.Box3()
    for (const i of [inst, ...inst.getDescendants()]) {
      const v = this.views.get(i)
      if (v) {
        // oriented box corners of the part (cheaper and tighter than traversing meshes)
        const p = i as BasePart
        const s = p.size
        for (const x of [-0.5, 0.5]) for (const y of [-0.5, 0.5]) for (const z of [-0.5, 0.5]) {
          const w = p.cframe.pointToWorld(new Vector3(s.x * x, s.y * y, s.z * z))
          box.expandByPoint(new THREE.Vector3(w.x, w.y, w.z))
        }
      }
    }
    return box
  }

  setHover(inst: Instance | null) { this.hovered = inst }

  setSelection(insts: Instance[]) {
    this.selection = insts
    for (const [inst, box] of this.selectionBoxes) if (!insts.includes(inst)) { this.scene.remove(box); this.selectionBoxes.delete(inst) }
    for (const inst of insts) {
      if (this.selectionBoxes.has(inst)) continue
      if (!(inst instanceof BasePart) && !inst.isA('Model')) continue
      const helper = new THREE.Box3Helper(this.boundsOf(inst), new THREE.Color(0x3aa0ff))
      ;(helper.material as THREE.LineBasicMaterial).depthTest = false
      helper.renderOrder = 999
      this.selectionBoxes.set(inst, helper)
      this.scene.add(helper)
    }
  }
  getSelection() { return this.selection }
}

function makeSky() {
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: { daylight: { value: 1 }, sunDir: { value: new THREE.Vector3(0, 1, 0) } },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      uniform float daylight; uniform vec3 sunDir; varying vec3 vDir;
      void main(){
        float h = clamp(vDir.y, -1.0, 1.0);
        vec3 dayTop = vec3(0.25, 0.52, 0.95), dayHorizon = vec3(0.72, 0.85, 1.0);
        vec3 nightTop = vec3(0.01, 0.02, 0.06), nightHorizon = vec3(0.06, 0.08, 0.16);
        vec3 top = mix(nightTop, dayTop, daylight), hor = mix(nightHorizon, dayHorizon, daylight);
        vec3 col = mix(hor, top, pow(max(h, 0.0), 0.6));
        if (h < 0.0) col = mix(hor, hor * 0.6, min(-h * 4.0, 1.0));
        float s = max(dot(normalize(vDir), normalize(sunDir)), 0.0);
        col += vec3(1.0, 0.9, 0.7) * (pow(s, 800.0) * 4.0 + pow(s, 12.0) * 0.25) * max(daylight, 0.15);
        gl_FragColor = vec4(col, 1.0);
      }`,
  })
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(2000, 32, 16), mat)
  mesh.frustumCulled = false
  mesh.renderOrder = -1
  return mesh
}

