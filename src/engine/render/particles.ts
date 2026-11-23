// Particles for ParticleEmitter (3D) and ParticleEmitter2D: a small CPU simulation per emitter,
// drawn as one THREE.Points object with a soft round dot (or the emitter's Texture).
// Positions live in "sim space": the world, or the emitter's own space when LockedToEmitter is on.
import * as THREE from 'three'
import { Color3, Vector2, Vector3 } from '../datatypes'
import { Instance } from '../instance'

export interface ParticleSettings {
  enabled: boolean
  rate: number
  lifetime: number
  lifetimeVariation: number
  max: number
  speed: number
  speedVariation: number
  spread: number // degrees
  drag: number
  spin: number // degrees per second (each particle spins one way or the other)
  randomRotation: boolean
  locked: boolean
  color0: THREE.Color
  color1: THREE.Color
  size0: number
  size1: number
  alpha0: number
  alpha1: number
  glow: boolean
  texture: string
}

/** Read an emitter's properties (shared by both emitter classes). */
export function readSettings(inst: Instance): ParticleSettings {
  const num = (k: string, d: number) => { const v = Number(inst.get(k)); return Number.isFinite(v) ? v : d }
  const col = (k: string) => { const c = inst.get<Color3>(k) ?? new Color3(1, 1, 1); return new THREE.Color().setRGB(c.r, c.g, c.b, THREE.SRGBColorSpace) }
  return {
    enabled: inst.get<boolean>('Enabled') !== false,
    rate: Math.max(0, num('Rate', 20)),
    lifetime: Math.max(0.01, num('Lifetime', 2)),
    lifetimeVariation: Math.max(0, num('LifetimeVariation', 0)),
    max: Math.max(1, Math.min(5000, Math.floor(num('MaxParticles', 500)))),
    speed: num('Speed', 5),
    speedVariation: Math.max(0, num('SpeedVariation', 0)),
    spread: Math.max(0, Math.min(180, num('SpreadAngle', 0))),
    drag: Math.max(0, num('Drag', 0)),
    spin: num('Spin', 0),
    randomRotation: inst.get<boolean>('RandomRotation') !== false,
    locked: !!inst.get<boolean>('LockedToEmitter'),
    color0: col('Color'),
    color1: col('ColorEnd'),
    size0: Math.max(0, num('Size', 1)),
    size1: Math.max(0, num('SizeEnd', 1)),
    alpha0: 1 - Math.min(1, Math.max(0, num('Transparency', 0))),
    alpha1: 1 - Math.min(1, Math.max(0, num('TransparencyEnd', 1))),
    glow: !!inst.get<boolean>('Glow'),
    texture: inst.get<string>('Texture') ?? '',
  }
}

export { requestsOf } from '../particleClasses'

/** A unit vector within `spread` degrees of `dir` (uniform over the cone). */
export function coneDirection(dir: THREE.Vector3, spreadDeg: number, out = new THREE.Vector3()): THREE.Vector3 {
  const d = dir.lengthSq() > 1e-9 ? dir.clone().normalize() : new THREE.Vector3(0, 1, 0)
  if (spreadDeg <= 0) return out.copy(d)
  const cosMax = Math.cos((spreadDeg * Math.PI) / 180)
  const z = cosMax + Math.random() * (1 - cosMax)
  const r = Math.sqrt(Math.max(0, 1 - z * z)), phi = Math.random() * Math.PI * 2
  // a basis around d
  const a = Math.abs(d.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0)
  const u = new THREE.Vector3().crossVectors(a, d).normalize(), w = new THREE.Vector3().crossVectors(d, u)
  return out.copy(d).multiplyScalar(z).addScaledVector(u, r * Math.cos(phi)).addScaledVector(w, r * Math.sin(phi))
}

/** A direction in the plane, within `spread` degrees either side of `dir`. */
export function arcDirection(dir: Vector2, spreadDeg: number): THREE.Vector3 {
  const base = dir.x || dir.y ? Math.atan2(dir.y, dir.x) : -Math.PI / 2
  const a = base + ((Math.random() * 2 - 1) * spreadDeg * Math.PI) / 180
  return new THREE.Vector3(Math.cos(a), Math.sin(a), 0)
}

export type Spawner = (pos: THREE.Vector3, vel: THREE.Vector3) => void

const VERTEX = `
attribute vec4 pColor;
attribute float pSize;
attribute float pAngle;
uniform float pointScale;
uniform bool perspective;
varying vec4 vColor;
varying float vAngle;
void main() {
	vColor = pColor;
	vAngle = pAngle;
	vec4 mv = modelViewMatrix * vec4(position, 1.0);
	gl_Position = projectionMatrix * mv;
	// x1.4142: room for the image to turn without its corners being cut off
	gl_PointSize = 1.4142 * pSize * (perspective ? pointScale / max(-mv.z, 0.001) : pointScale);
}`

const FRAGMENT = `
uniform sampler2D map;
uniform bool hasMap;
uniform float occlusion;
varying vec4 vColor;
varying float vAngle;
void main() {
	vec2 c = gl_PointCoord - 0.5;
	float s = sin(vAngle), k = cos(vAngle);
	c = vec2(k * c.x - s * c.y, s * c.x + k * c.y) * 1.4142 + 0.5;
	if (c.x < 0.0 || c.x > 1.0 || c.y < 0.0 || c.y > 1.0) discard;
	vec4 t = hasMap ? texture2D(map, vec2(c.x, 1.0 - c.y)) : vec4(1.0, 1.0, 1.0, smoothstep(0.5, 0.12, length(c - 0.5)));
	vec4 col = vColor * t;
	if (col.a < 0.004) discard;
	gl_FragColor = vec4(col.rgb, 1.0);
	#include <tonemapping_fragment>
	#include <colorspace_fragment>
	// premultiplied: normal particles cover what is behind them; glowing ones mostly add light
	// (they still dim the background a little so their colour shows against a bright sky)
	gl_FragColor = vec4(gl_FragColor.rgb * col.a, col.a * occlusion);
}`

export class ParticleSystem {
  readonly points: THREE.Points
  readonly material: THREE.ShaderMaterial
  private geometry = new THREE.BufferGeometry()
  private cap = 0
  count = 0
  // per particle state (struct of arrays)
  private pos = new Float32Array(0)
  private vel = new Float32Array(0)
  private age = new Float32Array(0)
  private life = new Float32Array(0)
  private angle = new Float32Array(0)
  private spinDir = new Float32Array(0)
  private carry = 0
  private wasLocked: boolean | null = null
  private textureKey = ''

  constructor(readonly perspective: boolean) {
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX, fragmentShader: FRAGMENT,
      uniforms: { map: { value: null }, hasMap: { value: false }, pointScale: { value: 1 }, perspective: { value: perspective }, occlusion: { value: 1 } },
      transparent: true, depthWrite: false, depthTest: perspective,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    })
    this.points = new THREE.Points(this.geometry, this.material)
    this.points.frustumCulled = false
    this.points.matrixAutoUpdate = false
    this.points.raycast = () => {}
    this.ensure(64)
  }

  private ensure(n: number) {
    if (n <= this.cap) return
    const cap = Math.max(n, this.cap * 2)
    const grow = (a: Float32Array, k: number) => { const b = new Float32Array(cap * k); b.set(a.subarray(0, this.count * k)); return b }
    this.pos = grow(this.pos, 3); this.vel = grow(this.vel, 3)
    this.age = grow(this.age, 1); this.life = grow(this.life, 1); this.angle = grow(this.angle, 1); this.spinDir = grow(this.spinDir, 1)
    this.cap = cap
    this.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage))
    this.geometry.setAttribute('pColor', new THREE.BufferAttribute(new Float32Array(cap * 4), 4).setUsage(THREE.DynamicDrawUsage))
    this.geometry.setAttribute('pSize', new THREE.BufferAttribute(new Float32Array(cap), 1).setUsage(THREE.DynamicDrawUsage))
    this.geometry.setAttribute('pAngle', new THREE.BufferAttribute(new Float32Array(cap), 1).setUsage(THREE.DynamicDrawUsage))
  }

  clear() { this.count = 0; this.carry = 0 }

  /** Use an image (or null for the soft dot). `key` identifies it so it is only swapped on change. */
  setTexture(key: string, tex: THREE.Texture | null) {
    const k = tex ? key : ''
    if (k === this.textureKey && (this.material.uniforms.map.value === tex || !tex)) return
    this.textureKey = k
    this.material.uniforms.map.value = tex
    this.material.uniforms.hasMap.value = !!tex
  }

  private spawnOne(s: ParticleSettings, spawn: Spawner) {
    if (this.count >= Math.min(s.max, 20000)) return
    this.ensure(this.count + 1)
    const i = this.count++
    const p = new THREE.Vector3(), v = new THREE.Vector3()
    spawn(p, v)
    const speed = Math.max(0, s.speed + (Math.random() * 2 - 1) * s.speedVariation)
    v.multiplyScalar(speed)
    this.pos[i * 3] = p.x; this.pos[i * 3 + 1] = p.y; this.pos[i * 3 + 2] = p.z
    this.vel[i * 3] = v.x; this.vel[i * 3 + 1] = v.y; this.vel[i * 3 + 2] = v.z
    this.age[i] = 0
    this.life[i] = Math.max(0.01, s.lifetime + (Math.random() * 2 - 1) * s.lifetimeVariation)
    this.angle[i] = s.randomRotation ? Math.random() * Math.PI * 2 : 0
    this.spinDir[i] = s.randomRotation && Math.random() < 0.5 ? -1 : 1
  }

  /**
   * Advance by dt: spawn (rate, plus any burst), age, move, and remove dead particles.
   * `accel` is in sim space. `spawn` gives a new particle's position and direction (unit) in sim space.
   */
  step(dt: number, s: ParticleSettings, accel: THREE.Vector3, spawn: Spawner, burst = 0) {
    if (this.wasLocked !== null && this.wasLocked !== s.locked) this.clear() // switching spaces: start over
    this.wasLocked = s.locked
    // age and move
    const drag = s.drag > 0 ? Math.exp(-s.drag * dt) : 1
    const spin = (s.spin * Math.PI) / 180
    for (let i = 0; i < this.count; ) {
      this.age[i] += dt
      if (this.age[i] >= this.life[i]) { this.remove(i); continue }
      const j = i * 3
      this.vel[j] = (this.vel[j] + accel.x * dt) * drag
      this.vel[j + 1] = (this.vel[j + 1] + accel.y * dt) * drag
      this.vel[j + 2] = (this.vel[j + 2] + accel.z * dt) * drag
      this.pos[j] += this.vel[j] * dt; this.pos[j + 1] += this.vel[j + 1] * dt; this.pos[j + 2] += this.vel[j + 2] * dt
      this.angle[i] += spin * this.spinDir[i] * dt
      i++
    }
    // new ones
    for (let b = 0; b < burst; b++) this.spawnOne(s, spawn)
    if (s.enabled && s.rate > 0) {
      this.carry += s.rate * dt
      const whole = Math.floor(this.carry + 1e-6) // (so 30 frames of 10/60 make 5, not 4.9999)
      const n = Math.min(whole, 1000)
      this.carry = Math.max(0, this.carry - whole)
      for (let k = 0; k < n; k++) this.spawnOne(s, spawn)
    } else this.carry = 0
  }

  private remove(i: number) {
    const last = --this.count
    if (i === last) return
    this.pos.copyWithin(i * 3, last * 3, last * 3 + 3)
    this.vel.copyWithin(i * 3, last * 3, last * 3 + 3)
    this.age[i] = this.age[last]; this.life[i] = this.life[last]; this.angle[i] = this.angle[last]; this.spinDir[i] = this.spinDir[last]
  }

  /**
   * Fill the GPU buffers. `pointScale` turns Size into pixels (see the vertex shader). With `sortFrom`
   * (a point in sim space, i.e. the camera), particles are drawn far to near so see-through ones blend right.
   */
  write(s: ParticleSettings, pointScale: number, sortFrom?: THREE.Vector3) {
    this.material.uniforms.pointScale.value = pointScale
    this.material.uniforms.occlusion.value = s.glow ? 0.4 : 1
    let order: number[] | null = null
    if (sortFrom && !s.glow && this.count > 1) {
      const d = new Float32Array(this.count)
      for (let i = 0; i < this.count; i++) {
        const dx = this.pos[i * 3] - sortFrom.x, dy = this.pos[i * 3 + 1] - sortFrom.y, dz = this.pos[i * 3 + 2] - sortFrom.z
        d[i] = dx * dx + dy * dy + dz * dz
      }
      order = Array.from({ length: this.count }, (_, i) => i).sort((a, b) => d[b] - d[a])
    }
    const pos = this.geometry.getAttribute('position') as THREE.BufferAttribute
    const col = this.geometry.getAttribute('pColor') as THREE.BufferAttribute
    const size = this.geometry.getAttribute('pSize') as THREE.BufferAttribute
    const ang = this.geometry.getAttribute('pAngle') as THREE.BufferAttribute
    const P = pos.array as Float32Array, C = col.array as Float32Array, S = size.array as Float32Array, A = ang.array as Float32Array
    const c0 = s.color0, c1 = s.color1
    for (let k = 0; k < this.count; k++) {
      const i = order ? order[k] : k
      const t = Math.min(1, this.age[i] / this.life[i])
      P[k * 3] = this.pos[i * 3]; P[k * 3 + 1] = this.pos[i * 3 + 1]; P[k * 3 + 2] = this.pos[i * 3 + 2]
      C[k * 4] = c0.r + (c1.r - c0.r) * t
      C[k * 4 + 1] = c0.g + (c1.g - c0.g) * t
      C[k * 4 + 2] = c0.b + (c1.b - c0.b) * t
      // a quick fade in over the first few percent of its life, so particles don't pop in
      C[k * 4 + 3] = (s.alpha0 + (s.alpha1 - s.alpha0) * t) * Math.min(1, t * 25)
      S[k] = s.size0 + (s.size1 - s.size0) * t
      A[k] = this.angle[i]
    }
    for (const a of [pos, col, size, ang]) { a.needsUpdate = true; a.clearUpdateRanges(); a.addUpdateRange(0, this.count * a.itemSize) }
    this.geometry.setDrawRange(0, this.count)
  }

  /** Read a particle (tests). */
  particle(i: number) {
    return { pos: new Vector3(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]), vel: new Vector3(this.vel[i * 3], this.vel[i * 3 + 1], this.vel[i * 3 + 2]), age: this.age[i], life: this.life[i] }
  }

  dispose() {
    this.geometry.dispose()
    this.material.dispose()
  }
}
