// 2D constraints (see constraintClasses.ts) as Rapier 2D impulse joints. A 2D constraint is a node:
// its world position is the pivot, and its "up" (rotated with it) is a slider's direction. Body0 is
// the moving body (default: the body the constraint is inside); Body1 the base (empty: the world).
// Angles are measured from where things are at the start, clockwise like Rotation; sliders in pixels.
import RAPIER from '@dimforge/rapier2d-compat'
import { EnumItem, Vector2 } from '../datatypes'
import { Instance } from '../instance'
import { apply, worldXform, xformRotation } from '../classes2d'
import { CONSTRAINT_CLASSES_2D } from '../constraintClasses'

const rad = (deg: number) => (deg * Math.PI) / 180
const MOTOR_FACTOR = 1000
const SERVO_GAIN = 10

interface Entry {
  joint: RAPIER.ImpulseJoint; kind: string; signature: string
  mover: RAPIER.RigidBody; base: RAPIER.RigidBody
  /** anchors in each body's own space (meters) */
  aMover: { x: number; y: number }; aBase: { x: number; y: number }
  /** slider axis in the base's space; hinge rotation offset at the start */
  axis: { x: number; y: number }; ref: number
}

export const isConstraint2D = (i: Instance) => CONSTRAINT_CLASSES_2D.includes(i.className)

export class Joints2D {
  private entries = new Map<Instance, Entry>()
  /** the base-side anchor/angle each joint started with (bodies rebuilt later keep the zero point) */
  private locked = new Map<Instance, { base: Instance | null; aBase: { x: number; y: number }; ref: number; axis: { x: number; y: number } }>()
  private ground: RAPIER.RigidBody | null = null

  constructor(private world: RAPIER.World, private ppm: () => number) {}

  private groundBody() {
    if (!this.ground) this.ground = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
    return this.ground
  }

  /** Each physics sync: make, remake or drop joints so they match the constraint nodes. */
  sync(nodes: Instance[], bodyOf: (i: Instance) => RAPIER.RigidBody | undefined) {
    const seen = new Set(nodes)
    for (const c of [...this.entries.keys()]) if (!seen.has(c)) this.drop(c)
    for (const c of [...this.locked.keys()]) if (!seen.has(c)) this.locked.delete(c)
    for (const c of nodes) {
      const moverInst = c.get<Instance | null>('Body0') ?? (c.parent?.isA('PhysicsBody2D') ? c.parent : null)
      const baseInst = c.get<Instance | null>('Body1')
      const mover = moverInst ? bodyOf(moverInst) : undefined
      const base = baseInst ? bodyOf(baseInst) : this.groundBody()
      if (!c.get('Enabled') || !mover || !base || mover === base) { this.drop(c); continue }
      const sig = this.signature(c, mover, base)
      const e = this.entries.get(c)
      if (e && e.signature === sig && e.joint.isValid()) continue
      this.drop(c)
      this.create(c, sig, baseInst, mover, base)
    }
  }

  private signature(c: Instance, mover: RAPIER.RigidBody, base: RAPIER.RigidBody) {
    const keys = ['Mode', 'Speed', 'MaxTorque', 'MaxForce', 'LimitsEnabled', 'LowerAngle', 'UpperAngle', 'LowerLimit', 'UpperLimit', 'FreeLength', 'Stiffness', 'Damping', 'Length', 'End1']
    return `${mover.handle}|${base.handle}|` + keys.map((k) => (c.classInfo.props.has(k) ? String(c.get(k)) : '')).join('|')
  }

  private drop(c: Instance) {
    const e = this.entries.get(c)
    if (!e) return
    try { if (e.joint.isValid()) this.world.removeImpulseJoint(e.joint, true) } catch { /* removed with its body */ }
    this.entries.delete(c)
  }

  /** a world point (pixels) in a body's own space (meters) */
  private local(rb: RAPIER.RigidBody, x: number, y: number) {
    const t = rb.translation(), r = rb.rotation(), ppm = this.ppm()
    const dx = x / ppm - t.x, dy = y / ppm - t.y
    return { x: Math.cos(r) * dx + Math.sin(r) * dy, y: -Math.sin(r) * dx + Math.cos(r) * dy }
  }
  private world2(rb: RAPIER.RigidBody, a: { x: number; y: number }) {
    const t = rb.translation(), r = rb.rotation()
    return { x: t.x + Math.cos(r) * a.x - Math.sin(r) * a.y, y: t.y + Math.sin(r) * a.x + Math.cos(r) * a.y }
  }

  private create(c: Instance, signature: string, baseInst: Instance | null, mover: RAPIER.RigidBody, base: RAPIER.RigidBody) {
    const kind = c.className
    const ppm = this.ppm()
    const m = worldXform(c)
    const aMover = this.local(mover, m.tx, m.ty)
    let joint: RAPIER.ImpulseJoint
    let aBase: { x: number; y: number }, axis = { x: 0, y: -1 }, ref = 0
    if (kind === 'SpringConstraint2D' || kind === 'RopeConstraint2D') {
      // the second end: End1 in Body1's space (pixels), or a world point
      const e1 = c.get<Vector2>('End1') ?? new Vector2(0, 0)
      const w = baseInst ? apply(worldXform(baseInst), e1.x, e1.y) : { x: e1.x, y: e1.y }
      aBase = this.local(base, w.x, w.y)
      const data = kind === 'SpringConstraint2D'
        ? RAPIER.JointData.spring(Math.max(0, c.get<number>('FreeLength')) / ppm, Math.max(0, c.get<number>('Stiffness')), Math.max(0, c.get<number>('Damping')), aBase, aMover)
        : RAPIER.JointData.rope(Math.max(0, c.get<number>('Length')) / ppm, aBase, aMover)
      joint = this.world.createImpulseJoint(data, base, mover, true)
    } else {
      let lock = this.locked.get(c)
      if (!lock || lock.base !== baseInst) {
        const r = xformRotation(m), up = { x: Math.sin(r), y: -Math.cos(r) } // the node's up, in the world
        const br = base.rotation()
        lock = {
          base: baseInst, aBase: this.local(base, m.tx, m.ty), ref: mover.rotation() - br,
          axis: { x: Math.cos(br) * up.x + Math.sin(br) * up.y, y: -Math.sin(br) * up.x + Math.cos(br) * up.y },
        }
        this.locked.set(c, lock)
      }
      aBase = lock.aBase; axis = lock.axis; ref = lock.ref
      const hinge = kind === 'HingeConstraint2D'
      const data = hinge ? RAPIER.JointData.revolute(aBase, aMover) : RAPIER.JointData.prismatic(aBase, aMover, axis)
      joint = this.world.createImpulseJoint(data, base, mover, true)
      joint.setContactsEnabled(false)
      const unit = joint as RAPIER.UnitImpulseJoint
      if (c.get('LimitsEnabled')) {
        const lo = c.get<number>(hinge ? 'LowerAngle' : 'LowerLimit'), hi = c.get<number>(hinge ? 'UpperAngle' : 'UpperLimit')
        if (hinge) unit.setLimits(rad(Math.min(lo, hi)) + ref, rad(Math.max(lo, hi)) + ref)
        else unit.setLimits(Math.min(lo, hi) / ppm, Math.max(lo, hi) / ppm)
      }
      const mode = c.get<EnumItem>('Mode')?.name
      if (mode === 'Motor' || mode === 'Servo') {
        unit.setMotorMaxForce(Math.max(0, c.get<number>(hinge ? 'MaxTorque' : 'MaxForce')))
        if (mode === 'Motor') unit.configureMotorVelocity(hinge ? rad(c.get<number>('Speed')) : c.get<number>('Speed') / ppm, MOTOR_FACTOR)
      }
    }
    this.entries.set(c, { joint, kind, signature, mover, base, aMover, aBase, axis, ref })
    mover.wakeUp()
  }

  /** Every physics step: servos steer towards their target. */
  drive() {
    for (const [c, e] of this.entries) {
      if ((e.kind !== 'HingeConstraint2D' && e.kind !== 'SliderConstraint2D') || c.get<EnumItem>('Mode')?.name !== 'Servo') continue
      const hinge = e.kind === 'HingeConstraint2D'
      let err = hinge ? rad(c.get<number>('TargetAngle') - this.measure(e)) : (c.get<number>('TargetPosition') - this.measure(e)) / this.ppm()
      if (hinge) err = Math.atan2(Math.sin(err), Math.cos(err))
      const max = Math.abs(hinge ? rad(c.get<number>('Speed')) : c.get<number>('Speed') / this.ppm())
      const vel = Math.max(-max, Math.min(max, err * SERVO_GAIN))
      ;(e.joint as RAPIER.UnitImpulseJoint).configureMotorVelocity(vel, MOTOR_FACTOR)
      if (Math.abs(vel) > 1e-4) e.mover.wakeUp()
    }
  }

  value(c: Instance): number {
    const e = this.entries.get(c)
    return e ? this.measure(e) : 0
  }

  private measure(e: Entry): number {
    const ppm = this.ppm()
    if (e.kind === 'HingeConstraint2D') {
      const a = e.mover.rotation() - e.base.rotation() - e.ref
      return (Math.atan2(Math.sin(a), Math.cos(a)) * 180) / Math.PI
    }
    const wm = this.world2(e.mover, e.aMover), wb = this.world2(e.base, e.aBase)
    const dx = wm.x - wb.x, dy = wm.y - wb.y
    if (e.kind === 'SliderConstraint2D') {
      const r = e.base.rotation(), ax = Math.cos(r) * e.axis.x - Math.sin(r) * e.axis.y, ay = Math.sin(r) * e.axis.x + Math.cos(r) * e.axis.y
      return (dx * ax + dy * ay) * ppm
    }
    return Math.hypot(dx, dy) * ppm
  }
}

