// 2D physics (Rapier 2D) for World2D: static/rigid/character/area bodies and tilemap collision.
// The physics world works in meters (pixels / PixelsPerMeter); y points down like the 2D world.
import RAPIER from '@dimforge/rapier2d-compat'
import { EnumItem, Vector2 } from '../datatypes'
import { Instance } from '../instance'
import { DataModel } from '../classes'
import { TileMap, apply, invert, isNode2D, parentXform, setWorldPosition, worldXform, xformRotation, xformScale } from '../classes2d'

let ready: Promise<void> | null = null
export function initPhysics2D() {
  if (!ready) ready = RAPIER.init()
  return ready
}

type Kind = 'static' | 'rigid' | 'character' | 'area' | 'tilemap'
interface Body {
  inst: Instance
  kind: Kind
  rb: RAPIER.RigidBody
  colliders: RAPIER.Collider[]
  controller?: RAPIER.KinematicCharacterController
  state: { floor: boolean; wall: boolean; ceiling: boolean; floorNormal: Vector2 }
  signature: string
}

const STEP = 1 / 60

export class Physics2D {
  readonly world: RAPIER.World
  private events = new RAPIER.EventQueue(true)
  private bodies = new Map<Instance, Body>()
  private byCollider = new Map<number, Body>()
  private teleport = new Set<Instance>()
  private writing = false
  private accumulator = 0
  private touching = new Map<string, number>()
  private disposeObserver: () => void
  frameDt = 1 / 60

  constructor(readonly game: DataModel) {
    this.world = new RAPIER.World(this.gravity())
    this.disposeObserver = game.observe({
      changed: (inst, prop) => {
        if (this.writing) return
        const b = this.bodies.get(inst)
        if (b && b.kind === 'rigid') {
          if (prop === 'Position' || prop === 'Rotation') this.teleport.add(inst)
          if (prop === 'Velocity') { const v = inst.get<Vector2>('Velocity'); b.rb.setLinvel(this.toM(v), true) }
          if (prop === 'AngularVelocity') b.rb.setAngvel(((inst.get<number>('AngularVelocity') ?? 0) * Math.PI) / 180, true)
        }
        if (inst.className === 'World2D' && prop === 'Gravity') this.world.gravity = this.gravity()
      },
    })
  }

  dispose() {
    this.disposeObserver()
    this.world.free()
    this.events.free()
  }

  private get w2d() { return this.game.getService('World2D') }
  get ppm() { return Math.max(1, this.w2d.get<number>('PixelsPerMeter') ?? 32) }
  private toM = (v: { x: number; y: number }) => ({ x: v.x / this.ppm, y: v.y / this.ppm })
  private gravity() { const g = this.w2d.get<Vector2>('Gravity'); return { x: g.x / this.ppm, y: g.y / this.ppm } }

  // ------------------------------------------------------------------ body management
  private kindOf(i: Instance): Kind | null {
    switch (i.className) {
      case 'StaticBody2D': return 'static'
      case 'RigidBody2D': return 'rigid'
      case 'CharacterBody2D': return 'character'
      case 'Area2D': return 'area'
      case 'TileMap': return i.get('Collision') ? 'tilemap' : null
    }
    return null
  }

  /** Properties that require rebuilding the body when they change. */
  private signature(i: Instance): string {
    const keys = ['CollisionShape', 'CollisionSize', 'CollisionOffset', 'CanCollide', 'Friction', 'Restitution', 'Density', 'FixedRotation', 'GravityScale', 'LinearDamping', 'TileSize', 'SolidTiles', 'Collision', 'Scale']
    const parts = keys.map((k) => (i.classInfo.props.has(k) ? String(i.get(k)) : ''))
    if (i instanceof TileMap) parts.push(i.encodeCells())
    return parts.join('|')
  }

  private sync() {
    const seen = new Set<Instance>()
    const visit = (inst: Instance) => {
      for (const c of inst.children) {
        if (isNode2D(c)) {
          const kind = this.kindOf(c)
          if (kind) {
            seen.add(c)
            const sig = this.signature(c)
            let b = this.bodies.get(c)
            if (!b || b.kind !== kind || b.signature !== sig) { this.removeBody(c); b = this.createBody(c, kind, sig) }
            if (b.kind !== 'rigid') this.placeKinematic(b)
            else if (this.teleport.has(c)) {
              const m = worldXform(c)
              b.rb.setTranslation(this.toM({ x: m.tx, y: m.ty }), true)
              b.rb.setRotation(xformRotation(m), true)
            }
          }
        }
        visit(c)
      }
    }
    visit(this.w2d)
    this.teleport.clear()
    for (const inst of [...this.bodies.keys()]) if (!seen.has(inst)) this.removeBody(inst)
  }

  private placeKinematic(b: Body) {
    const m = worldXform(b.inst)
    const t = this.toM({ x: m.tx, y: m.ty })
    if (b.kind === 'static' || b.kind === 'tilemap') { b.rb.setTranslation(t, false); b.rb.setRotation(xformRotation(m), false) }
    else { b.rb.setNextKinematicTranslation(t); b.rb.setNextKinematicRotation(xformRotation(m)) }
  }

  private createBody(i: Instance, kind: Kind, signature: string): Body {
    const m = worldXform(i)
    let desc: RAPIER.RigidBodyDesc
    if (kind === 'rigid') {
      desc = RAPIER.RigidBodyDesc.dynamic()
        .setGravityScale(i.get<number>('GravityScale') ?? 1)
        .setLinearDamping(i.get<number>('LinearDamping') ?? 0)
      const v = i.get<Vector2>('Velocity')
      desc.setLinvel(v.x / this.ppm, v.y / this.ppm)
      if (i.get('FixedRotation')) desc.lockRotations()
    } else if (kind === 'static' || kind === 'tilemap') desc = RAPIER.RigidBodyDesc.fixed()
    else desc = RAPIER.RigidBodyDesc.kinematicPositionBased()
    desc.setTranslation(m.tx / this.ppm, m.ty / this.ppm).setRotation(xformRotation(m))
    const rb = this.world.createRigidBody(desc)
    const colliders: RAPIER.Collider[] = []
    const s = xformScale(m)
    const add = (cd: RAPIER.ColliderDesc) => {
      cd.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS).setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL)
      colliders.push(this.world.createCollider(cd, rb))
    }
    if (kind === 'tilemap') {
      const tm = i as TileMap
      const ts = tm.get<Vector2>('TileSize')
      const solid = tm.solidSet()
      const isSolid = (x: number, y: number) => { const t = tm.getCell(x, y); return t >= 0 && (solid === 'all' || solid.has(t)) }
      // merge horizontal runs of solid tiles into one box each
      const rows = new Map<number, number[]>()
      for (const k of tm.cells.keys()) { const [x, y] = k.split(',').map(Number); if (isSolid(x, y)) (rows.get(y) ?? rows.set(y, []).get(y)!).push(x) }
      for (const [y, xs] of rows) {
        xs.sort((a, b) => a - b)
        let start = xs[0], prev = xs[0]
        const flush = (a: number, b: number) => {
          const w = (b - a + 1) * ts.x * s.x, h = ts.y * s.y
          const cx = (a * ts.x + (b - a + 1) * ts.x / 2) * s.x, cy = (y * ts.y + ts.y / 2) * s.y
          add(RAPIER.ColliderDesc.cuboid(w / 2 / this.ppm, h / 2 / this.ppm).setTranslation(cx / this.ppm, cy / this.ppm).setFriction(0.4))
        }
        for (let k = 1; k <= xs.length; k++) {
          if (k < xs.length && xs[k] === prev + 1) { prev = xs[k]; continue }
          flush(start, prev)
          start = xs[k]; prev = xs[k]
        }
      }
    } else {
      const size = i.get<Vector2>('CollisionSize'), off = i.get<Vector2>('CollisionOffset')
      const w = Math.max(1, size.x * s.x), h = Math.max(1, size.y * s.y)
      const cd = i.get<EnumItem>('CollisionShape')?.name === 'Circle'
        ? RAPIER.ColliderDesc.ball(Math.min(w, h) / 2 / this.ppm)
        : RAPIER.ColliderDesc.cuboid(w / 2 / this.ppm, h / 2 / this.ppm)
      cd.setTranslation(off.x * s.x / this.ppm, off.y * s.y / this.ppm)
        .setFriction(i.get<number>('Friction') ?? 0.2)
        .setRestitution(i.get<number>('Restitution') ?? 0)
        .setDensity(i.get<number>('Density') ?? 1)
      if (kind === 'area' || i.get('CanCollide') === false) cd.setSensor(true)
      add(cd)
    }
    const body: Body = { inst: i, kind, rb, colliders, signature, state: { floor: false, wall: false, ceiling: false, floorNormal: new Vector2(0, -1) } }
    if (kind === 'character') {
      const c = this.world.createCharacterController(0.01)
      c.setUp({ x: 0, y: -1 })
      c.setSlideEnabled(true)
      c.enableSnapToGround(4 / this.ppm)
      c.setMaxSlopeClimbAngle((50 * Math.PI) / 180)
      c.setMinSlopeSlideAngle((60 * Math.PI) / 180)
      const step = i.get<number>('MaxStepHeight') ?? 4
      if (step > 0) c.enableAutostep(step / this.ppm, 1 / this.ppm, false)
      c.setApplyImpulsesToDynamicBodies(true)
      body.controller = c
    }
    this.bodies.set(i, body)
    for (const c of colliders) this.byCollider.set(c.handle, body)
    return body
  }

  private removeBody(i: Instance) {
    const b = this.bodies.get(i)
    if (!b) return
    for (const c of b.colliders) this.byCollider.delete(c.handle)
    if (b.controller) this.world.removeCharacterController(b.controller)
    this.world.removeRigidBody(b.rb)
    this.bodies.delete(i)
  }

  // ------------------------------------------------------------------ simulation
  step(dt: number) {
    this.frameDt = dt
    this.sync()
    this.accumulator = Math.min(this.accumulator + dt, STEP * 4)
    let steps = 0
    while (this.accumulator >= STEP) {
      this.world.timestep = STEP
      this.world.step(this.events)
      this.accumulator -= STEP
      steps++
      this.drainEvents()
    }
    if (steps) this.writeBack()
  }

  private writeBack() {
    this.writing = true
    try {
      for (const b of this.bodies.values()) {
        if (b.kind !== 'rigid' || b.rb.isSleeping()) continue
        const t = b.rb.translation()
        const i = b.inst
        setWorldPosition(i, new Vector2(t.x * this.ppm, t.y * this.ppm))
        const parentRot = xformRotation(parentXform(i))
        i.set('Rotation', ((b.rb.rotation() - parentRot) * 180) / Math.PI)
        const v = b.rb.linvel()
        i.set('Velocity', new Vector2(v.x * this.ppm, v.y * this.ppm))
      }
    } finally {
      this.writing = false
    }
  }

  private drainEvents() {
    this.events.drainCollisionEvents((h1, h2, started) => {
      const a = this.byCollider.get(h1), b = this.byCollider.get(h2)
      if (!a || !b || a === b) return
      const key = a.inst.id < b.inst.id ? `${a.inst.id}:${b.inst.id}` : `${b.inst.id}:${a.inst.id}`
      const n = this.touching.get(key) ?? 0
      if (started) {
        this.touching.set(key, n + 1)
        if (n > 0) return
        this.contact(a, b, true)
        this.contact(b, a, true)
      } else {
        if (n > 1) { this.touching.set(key, n - 1); return }
        this.touching.delete(key)
        this.contact(a, b, false)
        this.contact(b, a, false)
      }
    })
  }

  private contact(self: Body, other: Body, started: boolean) {
    if (self.kind === 'tilemap') return
    if (self.kind === 'area') { if (other.kind !== 'area') self.inst.fire(started ? 'BodyEntered' : 'BodyExited', other.inst) }
    else self.inst.fire(started ? 'Touched' : 'TouchEnded', other.inst)
  }

  // ------------------------------------------------------------------ API
  moveAndSlide(inst: Instance): Vector2 {
    const b = this.bodies.get(inst)
    let v = inst.get<Vector2>('Velocity')
    if (!b || !b.controller) return v
    const dt = this.frameDt
    if (inst.get('UseGravity')) {
      const g = this.w2d.get<Vector2>('Gravity')
      v = new Vector2(v.x + g.x * dt, v.y + g.y * dt)
    }
    const m = worldXform(inst)
    b.rb.setTranslation(this.toM({ x: m.tx, y: m.ty }), true)
    const desired = { x: (v.x * dt) / this.ppm, y: (v.y * dt) / this.ppm }
    const collider = b.colliders[0]
    b.controller.computeColliderMovement(collider, desired, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, (c) => this.byCollider.get(c.handle) !== b)
    const mv = b.controller.computedMovement()
    const st = { floor: b.controller.computedGrounded(), wall: false, ceiling: false, floorNormal: new Vector2(0, -1) }
    for (let k = 0; k < b.controller.numComputedCollisions(); k++) {
      const c = b.controller.computedCollision(k)
      if (!c) continue
      const n = c.normal1 // outward normal of the obstacle; "up" is -y
      if (n.y < -0.65) { st.floor = true; st.floorNormal = new Vector2(n.x, n.y) }
      else if (n.y > 0.65) st.ceiling = true
      else if (Math.abs(n.x) > 0.65) st.wall = true
    }
    if (st.floor && v.y > 0) v = new Vector2(v.x, 0)
    if (st.ceiling && v.y < 0) v = new Vector2(v.x, 0)
    if (st.wall && Math.abs(mv.x) < Math.abs(desired.x) * 0.5) v = new Vector2(0, v.y)
    b.state = st
    const np = { x: m.tx + mv.x * this.ppm, y: m.ty + mv.y * this.ppm }
    b.rb.setTranslation(this.toM(np), true)
    b.rb.setNextKinematicTranslation(this.toM(np))
    setWorldPosition(inst, new Vector2(np.x, np.y))
    inst.set('Velocity', v)
    return v
  }

  bodyState(inst: Instance) {
    return this.bodies.get(inst)?.state ?? { floor: false, wall: false, ceiling: false, floorNormal: new Vector2(0, -1) }
  }

  applyImpulse(inst: Instance, v: Vector2) {
    const b = this.bodies.get(inst)
    if (b?.kind === 'rigid') b.rb.applyImpulse({ x: v.x / this.ppm, y: v.y / this.ppm }, true)
  }

  raycast(origin: Vector2, dir: Vector2, exclude: Instance[]): Map<string, unknown> | null {
    const len = Math.hypot(dir.x, dir.y)
    if (!len) return null
    const ray = new RAPIER.Ray(this.toM(origin), { x: dir.x / len, y: dir.y / len })
    const hit = this.world.castRayAndGetNormal(ray, len / this.ppm, true, undefined, undefined, undefined, undefined, (c) => {
      const b = this.byCollider.get(c.handle)
      return !!b && b.kind !== 'area' && !c.isSensor() && !exclude.some((e) => e === b.inst || b.inst.isDescendantOf(e))
    })
    if (!hit) return null
    const b = this.byCollider.get(hit.collider.handle)!
    const d = hit.timeOfImpact * this.ppm
    return new Map<string, unknown>([
      ['Instance', b.inst],
      ['Position', new Vector2(origin.x + (dir.x / len) * d, origin.y + (dir.y / len) * d)],
      ['Normal', new Vector2(hit.normal.x, hit.normal.y)],
      ['Distance', d],
    ])
  }
}

export { apply, invert }
