// Mirrors the Workspace of a DataModel into a three.js scene.
import * as THREE from 'three'
import { CFrame, Color3, EnumItem, Vector3 } from '../datatypes'
import { Instance } from '../instance'
import { BasePart, DataModel } from '../classes'
import { materialTexture } from './textures'

const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1)
const UNIT_SPHERE = new THREE.SphereGeometry(0.5, 32, 16)
const UNIT_CYLINDER = new THREE.CylinderGeometry(0.5, 0.5, 1, 32).rotateZ(Math.PI / 2) // Roblox cylinders run along X
const UNIT_WEDGE = (() => {
  // Vertical face at the back (+Z), slope facing the front (-Z)
  const g = new THREE.BufferGeometry()
  const p = [
    [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5], // back
    [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], // front bottom edge
  ]
  const tris = [
    [0, 1, 2], [0, 2, 3], // back
    [4, 2, 5], [4, 3, 2], // slope
    [4, 5, 1], [4, 1, 0], // bottom
    [4, 0, 3], // left
    [5, 2, 1], // right
  ]
  const pos: number[] = []
  for (const t of tris) for (const i of t) pos.push(...p[i])
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.computeVertexNormals()
  return g
})()

interface PartView {
  mesh: THREE.Mesh
  material: THREE.MeshStandardMaterial
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
  private selectionBoxes = new Map<Instance, THREE.Box3Helper>()
  private selection: Instance[] = []
  private disposeObserver: () => void
  private sky: THREE.Mesh
  private resizeObserver: ResizeObserver
  /** Called every frame before rendering */
  onBeforeRender?: (dt: number) => void
  private raf = 0
  private last = performance.now()
  private running = false
  hidden = new Set<Instance>()
  private localTransparency = new Map<Instance, number>()

  constructor(readonly container: HTMLElement, readonly game: DataModel) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFShadowMap
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.0
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.domElement.style.display = 'block'
    this.renderer.domElement.style.width = '100%'
    this.renderer.domElement.style.height = '100%'
    this.renderer.domElement.tabIndex = 0
    container.appendChild(this.renderer.domElement)

    this.sun.castShadow = true
    this.sun.shadow.mapSize.set(2048, 2048)
    const sc = this.sun.shadow.camera
    sc.left = -120; sc.right = 120; sc.top = 120; sc.bottom = -120; sc.near = 1; sc.far = 800
    this.sun.shadow.bias = -0.0005
    this.sun.shadow.normalBias = 0.05
    this.scene.add(this.sun, this.sun.target, this.hemi, this.ambient)

    this.sky = makeSky()
    this.scene.add(this.sky)

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(container)
    this.resize()

    for (const d of game.getDescendants()) this.add(d)
    this.disposeObserver = game.observe({
      added: (inst) => { this.add(inst); for (const d of inst.getDescendants()) this.add(d) },
      removing: (inst) => { this.remove(inst); for (const d of inst.getDescendants()) this.remove(d) },
      reparented: (inst) => {
        // moving in/out of Workspace
        for (const i of [inst, ...inst.getDescendants()]) { this.remove(i); this.add(i) }
      },
      changed: (inst, prop) => this.changed(inst, prop),
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
    // keep sun shadows centred on the camera
    const target = new THREE.Vector3()
    this.camera.getWorldDirection(target)
    const focus = this.camera.position.clone().add(target.multiplyScalar(40))
    this.sun.target.position.copy(focus)
    this.sun.position.copy(focus).add(this.sunDir.clone().multiplyScalar(300))
    this.sky.position.copy(this.camera.position)
    for (const [inst, box] of this.selectionBoxes) {
      const v = this.views.get(inst)
      if (v) box.box.setFromObject(v.mesh)
      else if (inst instanceof Instance) box.box.copy(this.boundsOf(inst))
    }
    this.renderer.render(this.scene, this.camera)
  }

  resize() {
    const w = this.container.clientWidth || 1
    const h = this.container.clientHeight || 1
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
  }

  dispose() {
    this.stop()
    this.disposeObserver()
    this.resizeObserver.disconnect()
    for (const v of this.views.values()) v.material.dispose()
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
    const ws = this.game.workspace
    return inst.isDescendantOf(ws)
  }

  private add(inst: Instance) {
    if (this.views.has(inst) || this.lights.has(inst)) return
    if (inst instanceof BasePart) {
      if (!this.inWorkspace(inst)) return
      const material = new THREE.MeshStandardMaterial()
      const mesh = new THREE.Mesh(UNIT_BOX, material)
      mesh.matrixAutoUpdate = false
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.userData.instance = inst
      const view = { mesh, material }
      this.views.set(inst, view)
      this.scene.add(mesh)
      this.updateGeometry(inst, view)
      this.updateTransform(inst, view)
      this.updateMaterial(inst, view)
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
  }

  private remove(inst: Instance) {
    const v = this.views.get(inst)
    if (v) {
      this.scene.remove(v.mesh)
      v.material.dispose()
      this.views.delete(inst)
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
  }

  private changed(inst: Instance, prop: string) {
    const v = this.views.get(inst)
    if (v) {
      switch (prop) {
        case 'CFrame': this.updateTransform(inst as BasePart, v); this.updateChildLights(inst); break
        case 'Size': this.updateTransform(inst as BasePart, v); this.updateGeometry(inst as BasePart, v); break
        case 'Shape': this.updateGeometry(inst as BasePart, v); this.updateTransform(inst as BasePart, v); break
        case 'Color': case 'Material': case 'Transparency': case 'Reflectance': case 'CastShadow':
          this.updateMaterial(inst as BasePart, v); break
      }
      return
    }
    if (this.lights.has(inst)) { this.updateLight(inst); return }
    if (inst.className === 'Lighting') this.applyLighting()
  }

  private updateChildLights(part: Instance) {
    for (const c of part.children) if (this.lights.has(c)) this.updateLight(c)
  }

  private updateGeometry(part: BasePart, v: PartView) {
    const shape = part.className === 'WedgePart' ? 'Wedge' : (part.get<EnumItem | undefined>('Shape')?.name ?? 'Block')
    v.mesh.geometry = shape === 'Ball' ? UNIT_SPHERE : shape === 'Cylinder' ? UNIT_CYLINDER : shape === 'Wedge' ? UNIT_WEDGE : UNIT_BOX
    this.updateMaterial(part, v)
  }

  private updateTransform(part: BasePart, v: PartView) {
    const s = part.size
    const shape = part.get<EnumItem | undefined>('Shape')?.name
    let sx = s.x, sy = s.y, sz = s.z
    if (shape === 'Ball') { const d = Math.min(sx, sy, sz); sx = sy = sz = d }
    else if (shape === 'Cylinder') { const d = Math.min(sy, sz); sy = sz = d }
    part.cframe.toMatrix4(v.mesh.matrix)
    v.mesh.matrix.scale(new THREE.Vector3(sx, sy, sz))
    v.mesh.matrixWorldNeedsUpdate = true
    const tex = v.material.map
    if (tex) {
      // keep texture density roughly constant (1 tile = 4 studs)
      tex.repeat.set(Math.max(sx, sz) / 4, Math.max(sy, sz) / 4)
    }
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
    const texture = materialTexture(mat)
    if (texture && !(v.mesh.geometry === UNIT_SPHERE)) {
      const t = texture.clone()
      t.needsUpdate = true
      m.map = t
    }
    let opacity = 1 - transparency
    if (mat === 'Glass') opacity = Math.min(opacity, 0.6)
    m.transparent = opacity < 1
    m.opacity = opacity
    m.depthWrite = opacity >= 1
    v.mesh.visible = opacity > 0.001 && !this.hidden.has(part)
    v.mesh.castShadow = (part.get<boolean>('CastShadow') ?? true) && opacity > 0.5
    m.needsUpdate = true
    this.updateTransform(part, v)
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
    // sun travels east->west; noon overhead
    const a = ((clock - 6) / 12) * Math.PI
    this.sunDir.set(Math.cos(a) * 0.8, Math.sin(a), 0.35).normalize()
    const daylight = THREE.MathUtils.clamp(this.sunDir.y * 3 + 0.3, 0, 1)
    this.sun.intensity = brightness * 1.1 * daylight
    const amb = lighting.get<Color3>('Ambient')
    const out = lighting.get<Color3>('OutdoorAmbient')
    this.ambient.color.setRGB(amb.r, amb.g, amb.b, THREE.SRGBColorSpace)
    this.ambient.intensity = 1.0
    this.hemi.color.setRGB(out.r, out.g, out.b, THREE.SRGBColorSpace).lerp(new THREE.Color(0xbfd8ff), 0.5)
    this.hemi.intensity = 0.4 + daylight * 0.8
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
  pick(clientX: number, clientY: number, ignore?: (inst: Instance) => boolean): { inst: BasePart; point: THREE.Vector3; normal: THREE.Vector3 } | null {
    const rect = this.renderer.domElement.getBoundingClientRect()
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    const ray = new THREE.Raycaster()
    ray.setFromCamera(ndc, this.camera)
    const meshes = [...this.views.values()].map((v) => v.mesh).filter((m) => m.visible)
    for (const hit of ray.intersectObjects(meshes, false)) {
      const inst = hit.object.userData.instance as BasePart
      if (ignore?.(inst)) continue
      const normal = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new THREE.Vector3(0, 1, 0)
      return { inst, point: hit.point, normal }
    }
    return null
  }

  meshOf(inst: Instance) { return this.views.get(inst)?.mesh }

  boundsOf(inst: Instance): THREE.Box3 {
    const box = new THREE.Box3()
    for (const i of [inst, ...inst.getDescendants()]) {
      const v = this.views.get(i)
      if (v) box.expandByObject(v.mesh)
    }
    return box
  }

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
