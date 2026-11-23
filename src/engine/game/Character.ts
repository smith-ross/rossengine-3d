// Humanoid character controller (players and NPCs) built on Rapier's kinematic character controller.
import { CFrame, Color3, Vector3, enumItem } from '../datatypes'
import { Instance, createInstance } from '../instance'
import { BasePart, Humanoid, Model } from '../classes'
import { Physics, RAPIER } from '../physics/Physics'

export function buildDefaultCharacter(name: string): Model {
  const model = createInstance('Model') as Model
  model.name = name
  const mk = (n: string, size: Vector3, color: Color3, offset: Vector3) => {
    const p = createInstance('Part') as BasePart
    p.name = n
    p.set('Size', size)
    p.set('Color', color)
    p.set('Material', enumItem('Material', 'SmoothPlastic'))
    p.set('CFrame', CFrame.fromPosition(offset))
    p.setParent(model)
    return p
  }
  const skin = Color3.fromRGB(245, 205, 48)
  const root = mk('HumanoidRootPart', new Vector3(2, 2, 1), Color3.fromRGB(163, 162, 165), new Vector3(0, 0, 0))
  root.set('Transparency', 1)
  mk('Torso', new Vector3(2, 2, 1), Color3.fromRGB(13, 105, 172), new Vector3(0, 0, 0))
  mk('Head', new Vector3(2, 1, 1), skin, new Vector3(0, 1.5, 0))
  mk('Left Arm', new Vector3(1, 2, 1), skin, new Vector3(-1.5, 0, 0))
  mk('Right Arm', new Vector3(1, 2, 1), skin, new Vector3(1.5, 0, 0))
  mk('Left Leg', new Vector3(1, 2, 1), Color3.fromRGB(39, 70, 45), new Vector3(-0.5, -2, 0))
  mk('Right Leg', new Vector3(1, 2, 1), Color3.fromRGB(39, 70, 45), new Vector3(0.5, -2, 0))
  const h = createInstance('Humanoid')
  h.setParent(model)
  model.set('PrimaryPart', root)
  return model
}

const LIMB_PIVOTS: Record<string, { pivot: number; sign: number; arm: boolean }> = {
  'Left Arm': { pivot: 1, sign: 1, arm: true },
  'Right Arm': { pivot: 1, sign: -1, arm: true },
  'Left Leg': { pivot: 1, sign: -1, arm: false },
  'Right Leg': { pivot: 1, sign: 1, arm: false },
}

export class CharacterController {
  readonly root: BasePart
  private offsets = new Map<BasePart, CFrame>()
  private controller: RAPIER.KinematicCharacterController
  private vy = 0
  grounded = false
  private jumpRequested = false
  /** desired move direction (world space, horizontal) from input */
  inputMove = Vector3.zero
  private scriptMove: Vector3 | null = null
  private moveTarget: { pos: Vector3; started: number } | null = null
  private animTime = 0
  private yaw: number
  private disposed = false
  private lastState = ''
  /** the part this character is sitting on (Humanoid.SeatPart), while seated */
  private seat: BasePart | null = null
  dead = false

  constructor(readonly model: Model, readonly humanoid: Humanoid, readonly physics: Physics, readonly time: () => number) {
    this.root = model.findFirstChild('HumanoidRootPart') as BasePart
    const rootInv = this.root.cframe.inverse()
    for (const d of model.getDescendants()) {
      if (d instanceof BasePart && d !== this.root) this.offsets.set(d, rootInv.mul(d.cframe))
    }
    const look = this.root.cframe.lookVector
    this.yaw = Math.atan2(-look.x, -look.z)
    physics.setRole(this.root, 'root')
    for (const p of this.offsets.keys()) physics.setRole(p, 'limb')
    const c = physics.world.createCharacterController(0.05)
    c.setUp({ x: 0, y: 1, z: 0 })
    c.enableAutostep(1.1, 0.2, false)
    c.enableSnapToGround(0.6)
    c.setMaxSlopeClimbAngle((55 * Math.PI) / 180)
    c.setMinSlopeSlideAngle((60 * Math.PI) / 180)
    c.setApplyImpulsesToDynamicBodies(true)
    c.setCharacterMass(20)
    this.controller = c
  }

  dispose() {
    if (this.disposed) return
    this.disposed = true
    try { this.physics.world.removeCharacterController(this.controller) } catch { /* world freed */ }
    if (!this.root.destroyed) this.physics.setRole(this.root, null)
    for (const p of this.offsets.keys()) if (!p.destroyed) this.physics.setRole(p, null)
  }

  jump() { this.jumpRequested = true }
  move(dir: Vector3) { this.scriptMove = dir.magnitude > 0 ? dir : null }
  moveTo(pos: Vector3) { this.moveTarget = { pos, started: this.time() } }

  /** Physics substep */
  update(dt: number) {
    if (this.dead || this.disposed || this.root.destroyed) return
    const h = this.humanoid
    if (h.get<number>('Health') <= 0) { this.die(); return }
    if (this.updateSeat()) return
    const body = this.physics.bodyOf(this.root)
    if (!body) return
    const rootCF = this.root.cframe

    // movement direction: MoveTo > script Move > player input
    let dir = this.inputMove
    if (this.scriptMove) dir = this.scriptMove
    if (this.moveTarget) {
      const d = this.moveTarget.pos.sub(rootCF.position)
      const flat = new Vector3(d.x, 0, d.z)
      if (flat.magnitude < 1.2) {
        this.moveTarget = null
        h.fire('MoveToFinished', true)
      } else if (this.time() - this.moveTarget.started > 8) {
        this.moveTarget = null
        h.fire('MoveToFinished', false)
      } else dir = flat.unit
    }
    dir = new Vector3(dir.x, 0, dir.z)
    if (dir.magnitude > 1) dir = dir.unit
    const old = h.get<Vector3>('MoveDirection')
    if (!old.equals(dir)) { h.rawSet('MoveDirection', dir); h.changed('MoveDirection') }

    if (h.get<boolean>('Jump')) { this.jumpRequested = true; h.rawSet('Jump', false) }
    const g = this.physics.game.workspace.get<number>('Gravity')
    const speed = h.get<number>('WalkSpeed')
    if (this.grounded && this.jumpRequested) {
      this.vy = h.get<number>('JumpPower')
      this.grounded = false
      h.fire('Jumping', true)
    }
    this.jumpRequested = false
    this.vy -= g * dt
    if (this.vy < -300) this.vy = -300
    const desired = { x: dir.x * speed * dt, y: this.vy * dt, z: dir.z * speed * dt }

    body.rb.setTranslation({ x: rootCF.x, y: rootCF.y, z: rootCF.z }, true)
    this.controller.computeColliderMovement(body.collider, desired, RAPIER.QueryFilterFlags.EXCLUDE_SENSORS, undefined, (c) => {
      const p = this.physics.partOfCollider(c)
      return !p || p.parent !== this.model
    })
    const m = this.controller.computedMovement()
    const wasGrounded = this.grounded
    this.grounded = this.controller.computedGrounded()
    if (this.grounded && this.vy < 0) this.vy = 0
    if (this.vy > 0 && m.y < desired.y * 0.5) this.vy = 0 // bumped head

    if (h.get<boolean>('AutoRotate') && dir.magnitude > 0.01) {
      const target = Math.atan2(-dir.x, -dir.z)
      let delta = target - this.yaw
      while (delta > Math.PI) delta -= Math.PI * 2
      while (delta < -Math.PI) delta += Math.PI * 2
      this.yaw += delta * Math.min(1, dt * 14)
    }
    const pos = new Vector3(rootCF.x + m.x, rootCF.y + m.y, rootCF.z + m.z)
    const newCF = CFrame.fromOrientation(pos, new Vector3(0, (this.yaw * 180) / Math.PI, 0))
    this.root.set('CFrame', newCF)
    body.rb.setNextKinematicTranslation({ x: pos.x, y: pos.y, z: pos.z })

    // state events
    const state = !this.grounded ? 'Freefall' : dir.magnitude > 0.01 ? 'Running' : 'Idle'
    if (state !== this.lastState) {
      if (state === 'Freefall') h.fire('FreeFalling', true)
      if (state === 'Running' || state === 'Idle') h.fire('Running', state === 'Running' ? speed : 0)
      if (!wasGrounded && this.grounded) h.fire('StateChanged', enumItem('HumanoidStateType', 'Freefall'), enumItem('HumanoidStateType', 'Landed'))
      this.lastState = state
    }
    if (pos.y < this.physics.game.workspace.get<number>('FallenPartsDestroyHeight')) h.set('Health', 0)
    this.animTime += dt * (dir.magnitude > 0.01 && this.grounded ? speed / 16 : 0)
    this.poseLimbs(newCF, dir.magnitude > 0.01)
  }

  /**
   * Humanoid.SeatPart: sit on it (riding along as it moves), stand up on Jump or when it's cleared.
   * Returns true while seated (no walking this step).
   */
  private updateSeat(): boolean {
    const h = this.humanoid
    const want = h.get<Instance | null>('SeatPart')
    const seat = want instanceof BasePart && !want.destroyed && want.isDescendantOf(this.physics.game.workspace) ? want : null
    if (want && !seat) h.set('SeatPart', null) // the seat is gone
    if (seat !== this.seat) {
      const old = this.seat
      this.seat = seat
      if (seat) {
        this.physics.setRole(this.root, 'rider') // pushes nothing, so it doesn't shove what it sits on
        this.vy = 0
        this.jumpRequested = false
      } else {
        this.physics.setRole(this.root, 'root')
        if (old && !old.destroyed) {
          // stand up beside the seat (on its left, or where its ExitOffset attribute says), facing the same way
          const exit = old.attributes.get('ExitOffset')
          const out = old.cframe.mul(exit instanceof Vector3 ? CFrame.fromPosition(exit) : new CFrame(-(old.size.x / 2 + 2.5), 2, 0))
          const look = old.cframe.lookVector
          this.yaw = Math.atan2(-look.x, -look.z)
          this.root.set('CFrame', CFrame.fromOrientation(out.position, new Vector3(0, (this.yaw * 180) / Math.PI, 0)))
        }
        this.vy = 0
      }
    }
    if (!seat) return false
    if (h.get<boolean>('Jump')) { this.jumpRequested = true; h.rawSet('Jump', false) }
    if (this.jumpRequested) {
      this.jumpRequested = false
      h.set('SeatPart', null) // stands up next step
    }
    if (!h.get<Vector3>('MoveDirection').equals(Vector3.zero)) { h.rawSet('MoveDirection', Vector3.zero); h.changed('MoveDirection') }
    // sitting on top of the seat: the legs (sticking out in front) resting on its top face
    const cf = seat.cframe.mul(new CFrame(0, seat.size.y / 2 + 1.5, 0))
    const look = cf.lookVector
    this.yaw = Math.atan2(-look.x, -look.z)
    this.root.set('CFrame', cf)
    const body = this.physics.bodyOf(this.root)
    if (body) {
      body.rb.setNextKinematicTranslation({ x: cf.x, y: cf.y, z: cf.z })
      body.rb.setNextKinematicRotation(cf.toQuaternion())
    }
    this.grounded = true
    if (this.lastState !== 'Seated') { this.lastState = 'Seated'; h.fire('StateChanged', enumItem('HumanoidStateType', 'Running'), enumItem('HumanoidStateType', 'Seated')) }
    this.poseLimbs(cf, false, true)
    return true
  }

  private poseLimbs(rootCF: CFrame, walking: boolean, sitting = false) {
    const swing = walking && this.grounded ? Math.sin(this.animTime * 9) * 0.9 : 0
    for (const [part, offset] of this.offsets) {
      if (part.destroyed) continue
      let local = offset
      const limb = LIMB_PIVOTS[part.name]
      if (limb) {
        let angle = swing * limb.sign
        if (!this.grounded) angle = limb.arm ? Math.PI * 0.9 : 0.15 * limb.sign
        if (sitting) angle = limb.arm ? 1.2 : Math.PI / 2 // legs out in front, hands forward
        const piv = limb.pivot
        local = offset
          .mul(new CFrame(0, piv, 0))
          .mul(rotX(angle))
          .mul(new CFrame(0, -piv, 0))
      }
      const cf = rootCF.mul(local)
      part.set('CFrame', cf)
      const b = this.physics.bodyOf(part)
      if (b) {
        b.rb.setNextKinematicTranslation({ x: cf.x, y: cf.y, z: cf.z })
        b.rb.setNextKinematicRotation(cf.toQuaternion())
      }
    }
  }

  die() {
    if (this.dead) return
    this.dead = true
    this.humanoid.dead = true
    if (this.humanoid.get<number>('Health') > 0) this.humanoid.set('Health', 0)
    if (this.humanoid.get('SeatPart')) this.humanoid.set('SeatPart', null)
    this.seat = null
    this.dispose()
    // fall apart
    for (const p of [this.root, ...this.offsets.keys()]) {
      if (p.destroyed) continue
      p.set('Anchored', false)
      if (p !== this.root) {
        const r = () => (Math.random() - 0.5) * 20
        p.set('AssemblyLinearVelocity', new Vector3(r(), Math.random() * 15, r()))
      }
    }
    this.root.set('CanCollide', false)
  }
}

function rotX(a: number) {
  const c = Math.cos(a), s = Math.sin(a)
  return new CFrame(0, 0, 0, 1, 0, 0, 0, c, -s, 0, s, c)
}

export function findHumanoidModel(inst: Instance): { model: Model; humanoid: Humanoid } | null {
  if (!(inst instanceof Model)) return null
  const humanoid = inst.findFirstChildOfClass('Humanoid') as Humanoid | null
  const root = inst.findFirstChild('HumanoidRootPart')
  if (!humanoid || !(root instanceof BasePart)) return null
  return { model: inst, humanoid }
}
