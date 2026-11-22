// Rigid-body physics for the Workspace, backed by Rapier.
import RAPIER from '@dimforge/rapier3d-compat'
import { CFrame, EnumItem, Vector3 } from '../datatypes'
import { Instance } from '../instance'
import { BasePart, DataModel } from '../classes'

let initPromise: Promise<void> | null = null
export function initPhysics() {
  if (!initPromise) initPromise = RAPIER.init()
  return initPromise
}
export { RAPIER }

export type CharacterRole = 'root' | 'limb'

interface Body {
  part: BasePart
  rb: RAPIER.RigidBody
  collider: RAPIER.Collider
  role?: CharacterRole
}

const STEP = 1 / 60

export class Physics {
  readonly world: RAPIER.World
  private events = new RAPIER.EventQueue(true)
  private bodies = new Map<BasePart, Body>()
  private byCollider = new Map<number, Body>()
  private joints = new Map<Instance, RAPIER.ImpulseJoint>()
  private roles = new Map<BasePart, CharacterRole>()
  private writing = false
  private accumulator = 0
  private disposeObserver: () => void
  private dirty = new Set<BasePart>()
  private dirtyWelds = new Set<Instance>()
  /** pairs currently touching, to avoid duplicate Touched events */
  private touching = new Map<string, number>()

  constructor(readonly game: DataModel) {
    const g = game.workspace.get<number>('Gravity')
    this.world = new RAPIER.World({ x: 0, y: -g, z: 0 })
    for (const d of game.workspace.getDescendants()) this.track(d)
    this.disposeObserver = game.observe({
      added: (inst) => { for (const i of [inst, ...inst.getDescendants()]) this.track(i) },
      removing: (inst) => { for (const i of [inst, ...inst.getDescendants()]) this.untrack(i) },
      reparented: (inst) => {
        for (const i of [inst, ...inst.getDescendants()]) { this.untrack(i); this.track(i) }
      },
      changed: (inst, prop) => this.changed(inst, prop),
    })
  }

  dispose() {
    this.disposeObserver()
    this.world.free()
    this.events.free()
  }

  private inWorkspace(i: Instance) { return i.isDescendantOf(this.game.workspace) }

  private track(inst: Instance) {
    if (inst instanceof BasePart && this.inWorkspace(inst)) this.dirty.add(inst)
    else if (inst.className === 'WeldConstraint' && this.inWorkspace(inst)) this.dirtyWelds.add(inst)
  }

  private untrack(inst: Instance) {
    if (inst instanceof BasePart) { this.dirty.delete(inst); this.removeBody(inst) }
    if (inst.className === 'WeldConstraint') { this.dirtyWelds.delete(inst); this.removeJoint(inst) }
  }

  private changed(inst: Instance, prop: string) {
    if (this.writing) return
    if (inst instanceof BasePart) {
      const b = this.bodies.get(inst)
      if (!b) return
      switch (prop) {
        case 'CFrame': {
          if (b.role) return // driven by the character controller
          const cf = inst.cframe
          const q = cf.toQuaternion()
          if (b.rb.isKinematic()) {
            b.rb.setNextKinematicTranslation({ x: cf.x, y: cf.y, z: cf.z })
            b.rb.setNextKinematicRotation(q)
          } else {
            b.rb.setTranslation({ x: cf.x, y: cf.y, z: cf.z }, true)
            b.rb.setRotation(q, true)
          }
          break
        }
        case 'AssemblyLinearVelocity': {
          const v = inst.get<Vector3>('AssemblyLinearVelocity')
          b.rb.setLinvel({ x: v.x, y: v.y, z: v.z }, true)
          break
        }
        case 'AssemblyAngularVelocity': {
          const v = inst.get<Vector3>('AssemblyAngularVelocity')
          b.rb.setAngvel({ x: v.x, y: v.y, z: v.z }, true)
          break
        }
        case 'Anchored': case 'CanCollide': case 'Size': case 'Shape': case 'CanTouch': case 'Massless':
          this.dirty.add(inst)
          break
      }
    } else if (inst.className === 'WeldConstraint' && (prop === 'Part0' || prop === 'Part1' || prop === 'Enabled')) {
      this.dirtyWelds.add(inst)
    } else if (inst.className === 'Workspace' && prop === 'Gravity') {
      this.world.gravity = { x: 0, y: -inst.get<number>('Gravity'), z: 0 }
    }
  }

  /** Mark a part as driven by a character controller. */
  setRole(part: BasePart, role: CharacterRole | null) {
    if (role) this.roles.set(part, role)
    else this.roles.delete(part)
    this.dirty.add(part)
    this.flushDirty()
  }

  bodyOf(part: BasePart) { return this.bodies.get(part) }
  partOfCollider(c: RAPIER.Collider) { return this.byCollider.get(c.handle)?.part }

  private removeBody(part: BasePart) {
    const b = this.bodies.get(part)
    if (!b) return
    // joints attached to this body are removed with it
    for (const [weld, j] of this.joints) {
      if (weld.get('Part0') === part || weld.get('Part1') === part) { this.joints.delete(weld); this.dirtyWelds.add(weld); void j }
    }
    this.byCollider.delete(b.collider.handle)
    this.world.removeRigidBody(b.rb)
    this.bodies.delete(part)
  }

  private createBody(part: BasePart) {
    this.removeBody(part)
    const role = this.roles.get(part)
    const cf = part.cframe
    const q = cf.toQuaternion()
    const anchored = part.get<boolean>('Anchored')
    let desc: RAPIER.RigidBodyDesc
    if (role) desc = RAPIER.RigidBodyDesc.kinematicPositionBased()
    else if (anchored) desc = RAPIER.RigidBodyDesc.fixed()
    else desc = RAPIER.RigidBodyDesc.dynamic().setCanSleep(true)
    desc.setTranslation(cf.x, cf.y, cf.z).setRotation(q)
    if (!anchored && !role) {
      const v = part.get<Vector3>('AssemblyLinearVelocity')
      const w = part.get<Vector3>('AssemblyAngularVelocity')
      desc.setLinvel(v.x, v.y, v.z).setAngvel({ x: w.x, y: w.y, z: w.z })
    }
    const rb = this.world.createRigidBody(desc)
    const cdesc = role === 'root' ? RAPIER.ColliderDesc.capsule(1.5, 1).setTranslation(0, -0.5, 0) : shapeFor(part)
    const canCollide = part.get<boolean>('CanCollide')
    if (role === 'limb' || (!canCollide && role !== 'root')) cdesc.setSensor(true)
    cdesc.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
    cdesc.setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL)
    cdesc.setFriction(0.5).setRestitution(0)
    cdesc.setDensity(part.get<boolean>('Massless') ? 0.001 : 0.7)
    const collider = this.world.createCollider(cdesc, rb)
    const body: Body = { part, rb, collider, role }
    this.bodies.set(part, body)
    this.byCollider.set(collider.handle, body)
  }

  private removeJoint(weld: Instance) {
    const j = this.joints.get(weld)
    if (j) {
      try { this.world.removeImpulseJoint(j, true) } catch { /* body already removed */ }
      this.joints.delete(weld)
    }
  }

  private createJoint(weld: Instance) {
    this.removeJoint(weld)
    if (!weld.get('Enabled') || !this.inWorkspace(weld)) return
    const p0 = weld.get<BasePart | null>('Part0'), p1 = weld.get<BasePart | null>('Part1')
    if (!(p0 instanceof BasePart) || !(p1 instanceof BasePart)) return
    const b0 = this.bodies.get(p0), b1 = this.bodies.get(p1)
    if (!b0 || !b1 || b0.role || b1.role) return
    const rel = p1.cframe.inverse().mul(p0.cframe) // p0's frame expressed in p1 space
    const rq = rel.toQuaternion()
    const data = RAPIER.JointData.fixed({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 1 }, { x: rel.x, y: rel.y, z: rel.z }, { x: rq.x, y: rq.y, z: rq.z, w: rq.w })
    this.joints.set(weld, this.world.createImpulseJoint(data, b0.rb, b1.rb, true))
  }

  flushDirty() {
    if (this.dirty.size) {
      const list = [...this.dirty]
      this.dirty.clear()
      for (const p of list) if (!p.destroyed && this.inWorkspace(p)) {
        this.createBody(p)
        // re-create welds touching this part
        for (const d of this.game.workspace.getDescendants()) {
          if (d.className === 'WeldConstraint' && (d.get('Part0') === p || d.get('Part1') === p)) this.dirtyWelds.add(d)
        }
      }
    }
    if (this.dirtyWelds.size) {
      const list = [...this.dirtyWelds]
      this.dirtyWelds.clear()
      for (const w of list) this.createJoint(w)
    }
  }

  /** Advance the simulation; returns the number of fixed steps taken. */
  step(dt: number, onSubstep?: (dt: number) => void) {
    this.flushDirty()
    this.accumulator = Math.min(this.accumulator + dt, STEP * 4)
    let steps = 0
    while (this.accumulator >= STEP) {
      onSubstep?.(STEP)
      this.world.timestep = STEP
      this.world.step(this.events)
      this.accumulator -= STEP
      steps++
      this.drainEvents()
    }
    if (steps) this.writeBack()
    return steps
  }

  private writeBack() {
    const killY = this.game.workspace.get<number>('FallenPartsDestroyHeight')
    this.writing = true
    const fallen: BasePart[] = []
    try {
      for (const b of this.bodies.values()) {
        if (!b.rb.isDynamic() || b.rb.isSleeping()) continue
        const t = b.rb.translation(), r = b.rb.rotation()
        b.part.set('CFrame', CFrame.fromPositionQuaternion(t, r))
        const v = b.rb.linvel(), w = b.rb.angvel()
        b.part.set('AssemblyLinearVelocity', new Vector3(v.x, v.y, v.z))
        b.part.set('AssemblyAngularVelocity', new Vector3(w.x, w.y, w.z))
        if (t.y < killY) fallen.push(b.part)
      }
    } finally {
      this.writing = false
    }
    for (const p of fallen) p.destroy()
  }

  private drainEvents() {
    this.events.drainCollisionEvents((h1, h2, started) => {
      const a = this.byCollider.get(h1), b = this.byCollider.get(h2)
      if (!a || !b) return
      const pa = a.part, pb = b.part
      if (a.role && b.role && pa.parent === pb.parent) return // same character
      const key = pa.id < pb.id ? `${pa.id}:${pb.id}` : `${pb.id}:${pa.id}`
      const count = this.touching.get(key) ?? 0
      if (started) {
        this.touching.set(key, count + 1)
        if (count > 0) return
        if (pa.get('CanTouch') && pb.get('CanTouch')) {
          pa.fire('Touched', pb)
          pb.fire('Touched', pa)
          const ha = pa.parent?.findFirstChildOfClass('Humanoid'), hb = pb.parent?.findFirstChildOfClass('Humanoid')
          if (ha && a.role) ha.fire('Touched', pb, pa)
          if (hb && b.role) hb.fire('Touched', pa, pb)
        }
      } else {
        if (count <= 1) {
          this.touching.delete(key)
          pa.fire('TouchEnded', pb)
          pb.fire('TouchEnded', pa)
        } else this.touching.set(key, count - 1)
      }
    })
  }

  applyImpulse(part: BasePart, v: Vector3) {
    this.flushDirty()
    this.bodies.get(part)?.rb.applyImpulse({ x: v.x, y: v.y, z: v.z }, true)
  }

  getMass(part: BasePart) {
    this.flushDirty()
    return this.bodies.get(part)?.rb.mass() ?? 0
  }

  raycast(origin: Vector3, direction: Vector3, params: Map<string, unknown> | null): Map<string, unknown> | null {
    this.flushDirty()
    const len = direction.magnitude
    if (len === 0) return null
    const dir = direction.mul(1 / len)
    let filterList: Instance[] = []
    let include = false
    let respectCanCollide = false
    if (params) {
      const f = params.get('FilterDescendantsInstances')
      if (f instanceof Map) filterList = [...f.values()].filter((v): v is Instance => v instanceof Instance)
      const ft = params.get('FilterType') as EnumItem | undefined
      include = ft?.name === 'Include' || ft?.name === 'Whitelist'
      respectCanCollide = !!params.get('RespectCanCollide')
    }
    const matches = (part: BasePart) => filterList.some((f) => f === part || part.isDescendantOf(f))
    const ray = new RAPIER.Ray({ x: origin.x, y: origin.y, z: origin.z }, { x: dir.x, y: dir.y, z: dir.z })
    const hit = this.world.castRayAndGetNormal(ray, len, true, undefined, undefined, undefined, undefined, (c) => {
      const b = this.byCollider.get(c.handle)
      if (!b) return false
      const p = b.part
      if (b.role === 'root') return include ? matches(p) : !filterList.some((f) => p.isDescendantOf(f) || f === p) && !matchesCharacter(filterList, p)
      if (!p.get('CanQuery')) return false
      if (respectCanCollide && !p.get('CanCollide')) return false
      return include ? matches(p) : !matches(p)
    })
    if (!hit) return null
    const body = this.byCollider.get(hit.collider.handle)!
    const pos = origin.add(dir.mul(hit.timeOfImpact))
    return new Map<string, unknown>([
      ['Instance', body.part],
      ['Position', pos],
      ['Normal', new Vector3(hit.normal.x, hit.normal.y, hit.normal.z)],
      ['Distance', hit.timeOfImpact],
      ['Material', body.part.get('Material')],
    ])
  }
}

function matchesCharacter(list: Instance[], p: Instance) {
  return list.some((f) => p.parent === f)
}

function shapeFor(part: BasePart): RAPIER.ColliderDesc {
  const s = part.size
  const hx = Math.max(s.x / 2, 0.025), hy = Math.max(s.y / 2, 0.025), hz = Math.max(s.z / 2, 0.025)
  if (part.className === 'WedgePart') {
    const pts = new Float32Array([
      -hx, -hy, hz, hx, -hy, hz, hx, hy, hz, -hx, hy, hz,
      -hx, -hy, -hz, hx, -hy, -hz,
    ])
    return RAPIER.ColliderDesc.convexHull(pts) ?? RAPIER.ColliderDesc.cuboid(hx, hy, hz)
  }
  const shape = part.get<EnumItem | undefined>('Shape')?.name
  if (shape === 'Ball') return RAPIER.ColliderDesc.ball(Math.min(hx, hy, hz))
  if (shape === 'Cylinder') {
    const r = Math.min(hy, hz)
    // Rapier cylinders are along Y; Roblox cylinders run along X
    return RAPIER.ColliderDesc.cylinder(hx, r).setRotation({ x: 0, y: 0, z: Math.SQRT1_2, w: Math.SQRT1_2 })
  }
  return RAPIER.ColliderDesc.cuboid(hx, hy, hz)
}
