// Rigid-body physics for the Workspace, backed by Rapier.
import RAPIER from '@dimforge/rapier3d-compat'
import { CFrame, EnumItem, Vector3 } from '../datatypes'
import { Instance } from '../instance'
import { BasePart, DataModel } from '../classes'
import { loadMesh, loadedMesh } from '../render/meshes'
import { Joints3D, isConstraint } from './Joints3D'

let initPromise: Promise<void> | null = null
export function initPhysics() {
  if (!initPromise) initPromise = RAPIER.init()
  return initPromise
}
export { RAPIER }

/** root: walks (character controller); limb: follows it; rider: a root sitting on something (moves with it, pushes nothing) */
export type CharacterRole = 'root' | 'limb' | 'rider'

interface Body {
  part: BasePart
  rb: RAPIER.RigidBody
  collider: RAPIER.Collider
  role?: CharacterRole
}

const STEP = 1 / 60

export interface CharacterContact { floor: boolean; wall: boolean; ceiling: boolean; floorNormal: Vector3 }
const NO_CONTACT = (): CharacterContact => ({ floor: false, wall: false, ceiling: false, floorNormal: new Vector3(0, 1, 0) })

/** A CharacterBody3D: its controller, and the parts that ride along with it. */
interface CharBody {
  controller: RAPIER.KinematicCharacterController
  /** parts inside the body or welded to it -> their offset from the body */
  followers: Map<BasePart, CFrame>
  state: CharacterContact
}
const isCharacterBody = (p: Instance) => p.className === 'CharacterBody3D'

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
  /** what each character controller (CharacterBody3D, Humanoid root) bumped into on its last move */
  private bumped = new Map<BasePart, Set<BasePart>>()
  private chars = new Map<BasePart, CharBody>()
  /** CharacterBody3Ds sitting on something (their SeatPart) */
  private seated = new Map<BasePart, BasePart>()
  /** CharacterBody3Ds whose SeatPart changed: applied at the next flush (it can change inside a Touched handler, mid-step) */
  private seatsDirty = new Set<BasePart>()
  /** the set of parts riding on character bodies may have changed */
  private followersDirty = false
  /**
   * Multiplayer: parts another machine controls (the host's world on a player's machine, another
   * player's character on the host). They follow the network instead of being simulated here.
   */
  isRemote: ((part: BasePart) => boolean) | null = null
  private remote = new Set<BasePart>()
  /** hinges, sliders, springs, ropes... */
  readonly constraints: Joints3D

  constructor(readonly game: DataModel) {
    const g = game.workspace.get<number>('Gravity')
    this.world = new RAPIER.World({ x: 0, y: -g, z: 0 })
    this.constraints = new Joints3D(this.world, (p) => (p instanceof BasePart ? this.bodies.get(p) : undefined))
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
    if (inst instanceof BasePart && this.inWorkspace(inst)) { this.dirty.add(inst); this.followersDirty = true }
    else if (inst.className === 'WeldConstraint' && this.inWorkspace(inst)) { this.dirtyWelds.add(inst); this.followersDirty = true }
    else if (isConstraint(inst) && this.inWorkspace(inst)) this.constraints.track(inst)
  }

  private untrack(inst: Instance) {
    if (inst instanceof BasePart) { this.dirty.delete(inst); this.removeBody(inst); this.followersDirty = true }
    if (inst.className === 'WeldConstraint') { this.dirtyWelds.delete(inst); this.removeJoint(inst); this.followersDirty = true }
    if (isConstraint(inst)) this.constraints.untrack(inst)
  }

  private changed(inst: Instance, prop: string) {
    if (this.writing) return
    if (inst instanceof BasePart) {
      const b = this.bodies.get(inst)
      if (!b) return
      switch (prop) {
        case 'CFrame': {
          if (b.role) return // driven by the character controller
          if (this.remote.has(inst)) {
            const cf = inst.cframe
            b.rb.setNextKinematicTranslation({ x: cf.x, y: cf.y, z: cf.z })
            b.rb.setNextKinematicRotation(cf.toQuaternion())
            return
          }
          if (this.chars.has(inst)) {
            // a script turned or teleported a CharacterBody3D: its riders come along
            const cf = inst.cframe
            b.rb.setTranslation({ x: cf.x, y: cf.y, z: cf.z }, true)
            b.rb.setRotation(cf.toQuaternion(), true)
            this.moveFollowers(inst)
            return
          }
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
        case 'Anchored': case 'CanCollide': case 'Size': case 'Shape': case 'CanTouch': case 'Massless': case 'MeshId': case 'CollisionFidelity':
        case 'MaxSlopeAngle': case 'MaxStepHeight':
          this.dirty.add(inst)
          break
        case 'SeatPart':
          if (isCharacterBody(inst)) this.seatsDirty.add(inst)
          break
      }
    } else if (isConstraint(inst)) {
      if (this.inWorkspace(inst)) this.constraints.changed(inst, prop)
    } else if (inst.className === 'WeldConstraint' && (prop === 'Part0' || prop === 'Part1' || prop === 'Enabled')) {
      this.dirtyWelds.add(inst)
      this.followersDirty = true
    } else if (inst.className === 'Workspace' && prop === 'Gravity') {
      this.world.gravity = { x: 0, y: -inst.get<number>('Gravity'), z: 0 }
    }
  }

  /** Who controls which parts changed (a character was handed to a player, or respawned): rebuild bodies. */
  refreshRemote() {
    for (const p of this.bodies.keys()) this.dirty.add(p)
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

  private removeBody(part: BasePart, rebuilding = false) {
    const b = this.bodies.get(part)
    if (!b) return
    // joints attached to this body are removed with it
    for (const [weld, j] of this.joints) {
      if (weld.get('Part0') === part || weld.get('Part1') === part) { this.joints.delete(weld); this.dirtyWelds.add(weld); void j }
    }
    this.byCollider.delete(b.collider.handle)
    if (!rebuilding) this.endBumps(part, true)
    // its collider goes (and Rapier reports no end to its contacts): forget what it was touching, so
    // touches after it's rebuilt fire Touched again
    this.forgetTouches(part)
    this.world.removeRigidBody(b.rb)
    this.bodies.delete(part)
    this.remote.delete(part)
    this.constraints.partChanged(part) // (Rapier removed its joints with it)
    const c = this.chars.get(part)
    if (c && !rebuilding) {
      // the body itself is gone (not just being rebuilt): its riders go back to normal physics
      try { this.world.removeCharacterController(c.controller) } catch { /* world freed */ }
      for (const f of c.followers.keys()) if (this.roles.get(f) === 'limb') { this.roles.delete(f); if (!f.destroyed) this.dirty.add(f) }
      this.chars.delete(part)
    }
  }

  private createBody(part: BasePart) {
    this.removeBody(part, true)
    const role = this.roles.get(part)
    const cf = part.cframe
    const q = cf.toQuaternion()
    const anchored = part.get<boolean>('Anchored')
    let desc: RAPIER.RigidBodyDesc
    const character = isCharacterBody(part)
    const remote = !role && !anchored && !!this.isRemote?.(part)
    if (remote) this.remote.add(part)
    else this.remote.delete(part)
    if (role || character || remote) desc = RAPIER.RigidBodyDesc.kinematicPositionBased()
    else if (anchored) desc = RAPIER.RigidBodyDesc.fixed()
    else desc = RAPIER.RigidBodyDesc.dynamic().setCanSleep(true)
    desc.setTranslation(cf.x, cf.y, cf.z).setRotation(q)
    if (!anchored && !role && !character && !remote) {
      const v = part.get<Vector3>('AssemblyLinearVelocity')
      const w = part.get<Vector3>('AssemblyAngularVelocity')
      desc.setLinvel(v.x, v.y, v.z).setAngvel({ x: w.x, y: w.y, z: w.z })
    }
    const rb = this.world.createRigidBody(desc)
    const cdesc = role === 'root' || role === 'rider' ? RAPIER.ColliderDesc.capsule(1.5, 1).setTranslation(0, -0.5, 0)
      : character ? characterCapsule(part) : this.shapeFor(part)
    const canCollide = part.get<boolean>('CanCollide')
    // (a CharacterBody3D in a seat pushes nothing, so it doesn't shove what it sits on)
    if (role === 'limb' || role === 'rider' || (!canCollide && role !== 'root') || (character && this.seated.has(part))) cdesc.setSensor(true)
    cdesc.setActiveEvents(RAPIER.ActiveEvents.COLLISION_EVENTS)
    cdesc.setActiveCollisionTypes(RAPIER.ActiveCollisionTypes.ALL)
    cdesc.setFriction(0.5).setRestitution(0)
    cdesc.setDensity(part.get<boolean>('Massless') ? 0.001 : 0.7)
    const collider = this.world.createCollider(cdesc, rb)
    const body: Body = { part, rb, collider, role }
    this.bodies.set(part, body)
    this.byCollider.set(collider.handle, body)
    if (character) this.setupCharacter(part)
  }

  // ------------------------------------------------------------------ CharacterBody3D
  private setupCharacter(part: BasePart) {
    let c = this.chars.get(part)
    if (!c) {
      c = { controller: this.world.createCharacterController(0.05), followers: new Map(), state: NO_CONTACT() }
      this.chars.set(part, c)
    }
    const k = c.controller
    const slope = Math.min(89, Math.max(0, part.get<number>('MaxSlopeAngle') ?? 50))
    k.setUp({ x: 0, y: 1, z: 0 })
    k.setSlideEnabled(true)
    k.setMaxSlopeClimbAngle((slope * Math.PI) / 180)
    k.setMinSlopeSlideAngle(((slope + 5) * Math.PI) / 180)
    const step = part.get<number>('MaxStepHeight') ?? 1
    if (step > 0) k.enableAutostep(step, 0.3, false)
    else k.disableAutostep()
    k.enableSnapToGround(0.5)
    k.setApplyImpulsesToDynamicBodies(true)
    k.setCharacterMass(20)
    this.followersDirty = true
  }

  /** Parts inside a CharacterBody3D, or welded to it, ride along rigidly (no physics of their own). */
  private refreshFollowers() {
    this.followersDirty = false
    if (!this.chars.size) return
    const welds = this.game.workspace.getDescendants().filter((d) => d.className === 'WeldConstraint' && d.get('Enabled'))
    for (const [body, c] of this.chars) {
      const want = new Set<BasePart>()
      for (const d of body.getDescendants()) if (d instanceof BasePart && !isCharacterBody(d)) want.add(d)
      for (const w of welds) {
        const p0 = w.get<Instance | null>('Part0'), p1 = w.get<Instance | null>('Part1')
        if (p0 === body && p1 instanceof BasePart && !isCharacterBody(p1)) want.add(p1)
        if (p1 === body && p0 instanceof BasePart && !isCharacterBody(p0)) want.add(p0)
      }
      for (const f of [...c.followers.keys()]) {
        if (want.has(f)) continue
        c.followers.delete(f)
        if (this.roles.get(f) === 'limb') { this.roles.delete(f); if (!f.destroyed) this.dirty.add(f) }
      }
      const inv = body.cframe.inverse()
      for (const f of want) {
        if (c.followers.has(f)) continue
        c.followers.set(f, inv.mul(f.cframe))
        if (this.roles.get(f) !== 'limb') { this.roles.set(f, 'limb'); this.dirty.add(f) }
      }
    }
  }

  private moveFollowers(body: BasePart) {
    const c = this.chars.get(body)
    if (!c) return
    const cf = body.cframe
    for (const [f, offset] of c.followers) {
      if (f.destroyed) continue
      const fcf = cf.mul(offset)
      f.set('CFrame', fcf)
      const fb = this.bodies.get(f)
      if (fb) { fb.rb.setNextKinematicTranslation({ x: fcf.x, y: fcf.y, z: fcf.z }); fb.rb.setNextKinematicRotation(fcf.toQuaternion()) }
    }
  }

  /** A CharacterBody3D's SeatPart changed: sit down, or stand up beside the seat it was on. */
  private seatChanged(body: BasePart) {
    const want = body.get<Instance | null>('SeatPart')
    const old = this.seated.get(body)
    const seat = want instanceof BasePart && !want.destroyed && this.inWorkspace(want) && want !== body ? want : null
    if (seat === (old ?? null)) return
    if (seat) this.seated.set(body, seat)
    else this.seated.delete(body)
    if (!seat && old && !old.destroyed) {
      // stand up on the seat's left (or where its ExitOffset attribute says): the bottom of the body there
      const exit = old.attributes.get('ExitOffset')
      const at = old.cframe.mul(exit instanceof Vector3 ? CFrame.fromPosition(exit) : new CFrame(-(old.size.x / 2 + body.size.x / 2 + 1), 1, 0)).position
      const look = old.cframe.lookVector
      const flat = new Vector3(look.x, 0, look.z)
      const pos = at.add(new Vector3(0, body.size.y / 2, 0))
      const cf = flat.magnitude > 1e-3 ? CFrame.lookAt(pos, pos.add(flat)) : CFrame.fromPosition(pos)
      this.writing = true
      try { body.set('CFrame', cf); body.set('Velocity', Vector3.zero) } finally { this.writing = false }
    }
    this.dirty.add(body) // its collider: a sensor while seated (rebuilt by the flush this runs in)
    if (!seat) this.moveFollowers(body)
  }

  /**
   * Seated CharacterBody3Ds move with their seats (sitting on top, facing the same way). Run after each
   * physics step, and again after scripts' Heartbeat so a script turning or moving the body can't knock it off.
   */
  rideSeats() {
    if (this.seatsDirty.size) this.flushDirty()
    if (!this.seated.size) return
    for (const [body, seat] of this.seated) {
      if (body.destroyed || seat.destroyed || !this.inWorkspace(seat) || body.get('SeatPart') !== seat) {
        this.seated.delete(body)
        if (!body.destroyed && body.get('SeatPart') === seat) body.set('SeatPart', null)
        continue
      }
      const cf = seat.cframe.mul(new CFrame(0, seat.size.y / 2 + body.size.y / 2, 0))
      this.writing = true
      try { body.set('CFrame', cf); if (!body.get<Vector3>('Velocity').equals(Vector3.zero)) body.set('Velocity', Vector3.zero) } finally { this.writing = false }
      const b = this.bodies.get(body)
      if (b) { b.rb.setTranslation({ x: cf.x, y: cf.y, z: cf.z }, true); b.rb.setRotation(cf.toQuaternion(), true) }
      this.moveFollowers(body)
    }
  }

  /** CharacterBody3D:MoveAndSlide(): move by Velocity * dt, sliding along what it hits. */
  moveAndSlide(part: BasePart, dt: number): Vector3 {
    this.flushDirty()
    if (this.seated.has(part)) {
      // sitting: the seat carries it
      const c = this.chars.get(part)
      this.endBumps(part) // (it bumps nothing while seated)
      if (c) c.state = { floor: true, wall: false, ceiling: false, floorNormal: new Vector3(0, 1, 0) }
      return Vector3.zero
    }
    let v = part.get<Vector3>('Velocity')
    const b = this.bodies.get(part), c = this.chars.get(part)
    if (!b || !c || !(dt > 0)) return v
    if (part.get<boolean>('UseGravity')) v = new Vector3(v.x, Math.max(-500, v.y - this.game.workspace.get<number>('Gravity') * dt), v.z)
    const cf = part.cframe
    // query from where the body is now (its collider only moves on its own during world.step)
    b.rb.setTranslation({ x: cf.x, y: cf.y, z: cf.z }, true)
    b.rb.setRotation(cf.toQuaternion(), true)
    this.world.propagateModifiedBodyPositionsToColliders()
    const desired = { x: v.x * dt, y: v.y * dt, z: v.z * dt }
    c.controller.computeColliderMovement(b.collider, desired, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, (col) => {
      const o = this.byCollider.get(col.handle)
      return !o || (o.part !== part && !c.followers.has(o.part))
    })
    const m = c.controller.computedMovement()
    this.characterBumped(part, c.controller)
    const st: CharacterContact = { floor: c.controller.computedGrounded(), wall: false, ceiling: false, floorNormal: new Vector3(0, 1, 0) }
    for (let i = 0; i < c.controller.numComputedCollisions(); i++) {
      const hit = c.controller.computedCollision(i)
      if (!hit) continue
      const n = hit.normal1
      if (n.y > 0.6) { st.floor = true; st.floorNormal = new Vector3(n.x, n.y, n.z) }
      else if (n.y < -0.6) st.ceiling = true
      else st.wall = true
    }
    if (st.floor && v.y < 0) v = new Vector3(v.x, 0, v.z)
    if (st.ceiling && v.y > 0) v = new Vector3(v.x, 0, v.z)
    // against a wall: keep only the sideways part of the speed it actually managed
    if (st.wall) v = new Vector3(m.x / dt, v.y, m.z / dt)
    c.state = st
    const pos = new Vector3(cf.x + m.x, cf.y + m.y, cf.z + m.z)
    this.writing = true
    try {
      part.set('CFrame', cf.withPosition(pos))
      part.set('Velocity', v)
    } finally { this.writing = false }
    b.rb.setTranslation({ x: pos.x, y: pos.y, z: pos.z }, true)
    b.rb.setNextKinematicTranslation({ x: pos.x, y: pos.y, z: pos.z })
    this.moveFollowers(part)
    if (pos.y < this.game.workspace.get<number>('FallenPartsDestroyHeight')) part.destroy()
    return v
  }

  characterState(part: BasePart): CharacterContact { return this.chars.get(part)?.state ?? NO_CONTACT() }

  /** Collider shape; MeshParts with Hull fidelity get rebuilt once their mesh has loaded. */
  private shapeFor(part: BasePart) {
    if (part.className === 'MeshPart' && part.get<EnumItem>('CollisionFidelity')?.name === 'Hull') {
      const meshId = part.get<string>('MeshId')
      if (meshId && loadedMesh(meshId) === undefined) {
        void loadMesh(meshId).then(() => { if (!part.destroyed && this.bodies.has(part)) this.dirty.add(part) })
      }
    }
    return shapeFor(part)
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
    if (this.seatsDirty.size) {
      const list = [...this.seatsDirty]
      this.seatsDirty.clear()
      for (const b of list) if (!b.destroyed) this.seatChanged(b)
    }
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
    this.constraints.flush()
    // character bodies' riders (may rebuild some bodies as kinematic, so flush once more)
    if (this.followersDirty) {
      this.refreshFollowers()
      if (this.dirty.size || this.dirtyWelds.size) {
        this.followersDirty = false
        this.flushDirty()
        this.followersDirty = false
      }
    }
  }

  /** Advance the simulation; returns the number of fixed steps taken. */
  step(dt: number, onSubstep?: (dt: number) => void) {
    this.flushDirty()
    this.accumulator = Math.min(this.accumulator + dt, STEP * 4)
    let steps = 0
    while (this.accumulator >= STEP) {
      onSubstep?.(STEP)
      this.constraints.drive()
      // chains of joints (a car's wheel, hub and strut) need more solver passes to stay firm
      this.world.numSolverIterations = this.constraints.count ? 8 : 4
      this.world.timestep = STEP
      this.world.step(this.events)
      this.accumulator -= STEP
      steps++
      this.drainEvents()
    }
    if (steps) this.writeBack()
    if (steps && this.seated.size) this.rideSeats()
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
      if (a.role && b.role && a.part.parent === b.part.parent) return // same character
      if (started) this.touchStart(a, b)
      else this.touchEnd(a.part, b.part)
    })
  }

  private forgetTouches(part: BasePart) {
    if (!this.touching.size) return
    const id = String(part.id)
    for (const key of [...this.touching.keys()]) {
      const i = key.indexOf(':')
      if (key.slice(0, i) === id || key.slice(i + 1) === id) this.touching.delete(key)
    }
    for (const [ch, set] of this.bumped) if (ch !== part) set.delete(part)
  }

  private touchKey(pa: BasePart, pb: BasePart) { return pa.id < pb.id ? `${pa.id}:${pb.id}` : `${pb.id}:${pa.id}` }

  /** Two parts started touching (counted, so several contacts between them fire Touched once). */
  private touchStart(a: Body, b: Body) {
    const pa = a.part, pb = b.part
    const key = this.touchKey(pa, pb)
    const count = this.touching.get(key) ?? 0
    this.touching.set(key, count + 1)
    if (count > 0) return
    if (pa.get('CanTouch') && pb.get('CanTouch')) {
      pa.fire('Touched', pb)
      pb.fire('Touched', pa)
      const ha = pa.parent?.findFirstChildOfClass('Humanoid'), hb = pb.parent?.findFirstChildOfClass('Humanoid')
      if (ha && a.role) ha.fire('Touched', pb, pa)
      if (hb && b.role) hb.fire('Touched', pa, pb)
    }
  }

  private touchEnd(pa: BasePart, pb: BasePart) {
    const key = this.touchKey(pa, pb)
    const count = this.touching.get(key) ?? 0
    if (count <= 0) return
    if (count <= 1) {
      this.touching.delete(key)
      pa.fire('TouchEnded', pb)
      pb.fire('TouchEnded', pa)
    } else this.touching.set(key, count - 1)
  }

  /** A character stopped moving by itself (seated, removed): what it was bumping into stops touching it. */
  endBumps(part: BasePart, quiet = false) {
    const was = this.bumped.get(part)
    if (!was) return
    this.bumped.delete(part)
    for (const p of was) {
      if (!quiet) { this.touchEnd(part, p); continue }
      // (gone: forget the touch without TouchEnded events)
      const key = this.touchKey(part, p), n = this.touching.get(key) ?? 0
      if (n <= 1) this.touching.delete(key)
      else this.touching.set(key, n - 1)
    }
  }

  /**
   * A character controller moved and bumped into these colliders. It stops just short of what it
   * walks into, so the physics never reports a contact: these count as touches instead (Touched when
   * it first bumps something, TouchEnded once it no longer does).
   */
  characterBumped(part: BasePart, controller: RAPIER.KinematicCharacterController) {
    const me = this.bodies.get(part)
    const was = this.bumped.get(part)
    const now = new Set<BasePart>()
    if (me) {
      for (let i = 0; i < controller.numComputedCollisions(); i++) {
        const hit = controller.computedCollision(i)
        const other = hit?.collider ? this.byCollider.get(hit.collider.handle) : undefined
        if (!other || other.part === part || now.has(other.part)) continue
        now.add(other.part)
        if (!was?.has(other.part)) this.touchStart(me, other)
      }
    }
    if (was) for (const p of was) if (!now.has(p)) this.touchEnd(part, p)
    if (now.size) this.bumped.set(part, now)
    else this.bumped.delete(part)
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
      if (b.role === 'root' || b.role === 'rider') return include ? matches(p) : !filterList.some((f) => p.isDescendantOf(f) || f === p) && !matchesCharacter(filterList, p)
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
  if (part.className === 'MeshPart') {
    const meshId = part.get<string>('MeshId')
    if (meshId && part.get<EnumItem>('CollisionFidelity')?.name === 'Hull') {
      const m = loadedMesh(meshId)
      if (m && m.hullPoints.length >= 12) {
        const pts = new Float32Array(m.hullPoints.length)
        for (let i = 0; i < pts.length; i += 3) { pts[i] = m.hullPoints[i] * s.x; pts[i + 1] = m.hullPoints[i + 1] * s.y; pts[i + 2] = m.hullPoints[i + 2] * s.z }
        const hull = RAPIER.ColliderDesc.convexHull(pts)
        if (hull) return hull
      }
    }
    return RAPIER.ColliderDesc.cuboid(hx, hy, hz)
  }
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

/** The capsule of a CharacterBody3D: as wide as the smaller of Size X/Z, as tall as Size Y. */
function characterCapsule(part: BasePart) {
  const s = part.size
  const radius = Math.max(0.1, Math.min(s.x, s.z) / 2)
  const half = Math.max(0.01, s.y / 2 - radius)
  return RAPIER.ColliderDesc.capsule(half, radius)
}
