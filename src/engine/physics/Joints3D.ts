// 3D constraints (see constraintClasses.ts) as Rapier impulse joints.
//
// Hinge and slider joints get explicit frames on both bodies: X along the pivot's up axis, and the
// two frames together where the pivot is when the game starts. So the hinge angle / slider position
// is 0 at the start, and limits and targets are in those terms. Part1's frame is locked in the first
// time the joint is made (a body rebuilt later doesn't move the zero point).
import RAPIER from '@dimforge/rapier3d-compat'
import { CFrame, EnumItem, Vector3 } from '../datatypes'
import { Instance } from '../instance'
import { CONSTRAINT_CLASSES, end1Of, pivotOf } from '../constraintClasses'

/** turns the joint's X axis onto the pivot's up axis */
const UP = CFrame.fromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2)
const V = (p: Vector3) => ({ x: p.x, y: p.y, z: p.z })
const Q = (cf: CFrame) => { const q = cf.toQuaternion(); return { x: q.x, y: q.y, z: q.z, w: q.w } }
const rad = (deg: number) => (deg * Math.PI) / 180
/** how strongly motors chase their speed: high enough to hold it against gravity (MaxForce/MaxTorque still caps the push) */
const MOTOR_FACTOR = 1000
/** servos: speed per unit of error (1/s), capped at Speed */
const SERVO_GAIN = 10

/** props that only change how a joint is drawn */
const DRAWING = new Set(['Color', 'Thickness', 'ShowInGame', 'Name'])
/** props applied to a joint in place (no rebuild) */
const LIVE = new Set(['Speed', 'MaxTorque', 'MaxForce', 'TargetAngle', 'TargetPosition'])

interface BodyRef { rb: RAPIER.RigidBody; role?: string }
interface Entry { joint: RAPIER.ImpulseJoint; kind: string; p0: Instance; p1: Instance | null; b0: RAPIER.RigidBody; b1: RAPIER.RigidBody; f0: CFrame; f1: CFrame }

export const isConstraint = (i: Instance) => CONSTRAINT_CLASSES.includes(i.className)

export class Joints3D {
  private all = new Set<Instance>()
  private entries = new Map<Instance, Entry>()
  private dirty = new Set<Instance>()
  private locked = new Map<Instance, { p1: Instance | null; f1: CFrame }>()
  private ground: RAPIER.RigidBody | null = null

  constructor(private world: RAPIER.World, private bodyOf: (p: Instance) => BodyRef | undefined) {}

  track(c: Instance) { this.all.add(c); this.dirty.add(c) }
  untrack(c: Instance) { this.drop(c); this.all.delete(c); this.dirty.delete(c); this.locked.delete(c) }
  changed(c: Instance, prop: string) {
    if (prop.startsWith('Current') || DRAWING.has(prop)) return
    // motor settings a driving script changes every frame: applied to the joint as it is
    const e = this.entries.get(c)
    if (e && LIVE.has(prop) && !this.dirty.has(c)) { this.applyMotor(c, e); return }
    this.dirty.add(c)
  }
  get pending() { return this.dirty.size > 0 }
  /** how many joints are in the world */
  get count() { return this.entries.size }

  /** A part's body was rebuilt (or is gone): joints on it are remade. */
  partChanged(part: Instance) {
    for (const [c, e] of this.entries) if (e.p0 === part || e.p1 === part) { this.entries.delete(c); this.dirty.add(c) }
    for (const c of this.all) if (c.get('Part0') === part || c.get('Part1') === part) this.dirty.add(c)
  }

  flush() {
    if (!this.dirty.size) return
    const list = [...this.dirty]
    this.dirty.clear()
    for (const c of list) this.create(c)
  }

  private drop(c: Instance) {
    const e = this.entries.get(c)
    if (!e) return
    try { if (e.joint.isValid()) this.world.removeImpulseJoint(e.joint, true) } catch { /* removed with its body */ }
    this.entries.delete(c)
  }

  private groundBody() {
    if (!this.ground) this.ground = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed())
    return this.ground
  }

  private create(c: Instance) {
    this.drop(c)
    if (c.destroyed || !c.get('Enabled')) return
    const p0 = c.get<Instance | null>('Part0'), p1 = c.get<Instance | null>('Part1')
    if (!p0 || p0 === p1) return
    const b0 = this.bodyOf(p0)
    if (!b0 || b0.role) return // (character parts are driven by their controller)
    let rb1: RAPIER.RigidBody
    if (p1) {
      const b1 = this.bodyOf(p1)
      if (!b1 || b1.role) return
      rb1 = b1.rb
    } else rb1 = this.groundBody()
    const cf0 = p0.get<CFrame>('CFrame'), cf1 = p1 ? p1.get<CFrame>('CFrame') : CFrame.identity
    const kind = c.className
    const offset = (c.props.get('Offset') as CFrame | undefined) ?? CFrame.identity
    let joint: RAPIER.ImpulseJoint
    let f0: CFrame, f1: CFrame
    if (kind === 'SpringConstraint' || kind === 'RopeConstraint') {
      f0 = CFrame.fromPosition(offset.position)
      f1 = cf1.inverse().mul(CFrame.fromPosition(end1Of(c)))
      const data = kind === 'SpringConstraint'
        ? RAPIER.JointData.spring(Math.max(0, c.get<number>('FreeLength')), Math.max(0, c.get<number>('Stiffness')), Math.max(0, c.get<number>('Damping')), V(f0.position), V(f1.position))
        : RAPIER.JointData.rope(Math.max(0, c.get<number>('Length')), V(f0.position), V(f1.position))
      joint = this.world.createImpulseJoint(data, b0.rb, rb1, true)
    } else {
      f0 = offset.mul(UP)
      let lock = this.locked.get(c)
      if (!lock || lock.p1 !== p1) { lock = { p1, f1: cf1.inverse().mul(pivotOf(c)).mul(UP) }; this.locked.set(c, lock) }
      f1 = lock.f1
      // Rapier measures its second body against its first: the base (Part1, or the world) goes first,
      // so angles, positions and motor speeds say how Part0 moves (+ along / anticlockwise round the axis)
      const data = kind === 'BallSocketConstraint' ? RAPIER.JointData.spherical(V(f1.position), V(f0.position))
        : kind === 'HingeConstraint' ? RAPIER.JointData.revolute(V(f1.position), V(f0.position), { x: 1, y: 0, z: 0 })
          : RAPIER.JointData.prismatic(V(f1.position), V(f0.position), { x: 1, y: 0, z: 0 })
      joint = this.world.createImpulseJoint(data, rb1, b0.rb, true)
      joint.setContactsEnabled(false) // the two parts usually touch at the joint
      if (kind !== 'BallSocketConstraint') {
        joint.setFrameX1(Q(f1))
        joint.setFrameX2(Q(f0))
        const unit = joint as RAPIER.UnitImpulseJoint
        const hinge = kind === 'HingeConstraint'
        if (c.get('LimitsEnabled')) {
          const lo = c.get<number>(hinge ? 'LowerAngle' : 'LowerLimit'), hi = c.get<number>(hinge ? 'UpperAngle' : 'UpperLimit')
          unit.setLimits(hinge ? rad(Math.min(lo, hi)) : Math.min(lo, hi), hinge ? rad(Math.max(lo, hi)) : Math.max(lo, hi))
        }
      }
    }
    const e: Entry = { joint, kind, p0, p1, b0: b0.rb, b1: rb1, f0, f1 }
    this.entries.set(c, e)
    this.applyMotor(c, e)
    b0.rb.wakeUp()
    if (rb1.isDynamic()) rb1.wakeUp()
  }

  /** Motor / Servo: how hard it pushes, and (Motor) how fast it turns. */
  private applyMotor(c: Instance, e: Entry) {
    if (e.kind !== 'HingeConstraint' && e.kind !== 'SliderConstraint') return
    const mode = c.get<EnumItem>('Mode')?.name
    if (mode !== 'Motor' && mode !== 'Servo') return
    const hinge = e.kind === 'HingeConstraint'
    const unit = e.joint as RAPIER.UnitImpulseJoint
    unit.setMotorMaxForce(Math.max(0, c.get<number>(hinge ? 'MaxTorque' : 'MaxForce')))
    if (mode === 'Motor') unit.configureMotorVelocity(hinge ? rad(c.get<number>('Speed')) : c.get<number>('Speed'), MOTOR_FACTOR)
    e.b0.wakeUp()
    if (e.b1.isDynamic()) e.b1.wakeUp()
  }

  /** Every physics step: servos steer towards their target. */
  drive() {
    for (const [c, e] of this.entries) {
      if (e.kind !== 'HingeConstraint' && e.kind !== 'SliderConstraint') continue
      if (c.get<EnumItem>('Mode')?.name !== 'Servo') continue
      const hinge = e.kind === 'HingeConstraint'
      const now = this.measure(e)
      let err = (hinge ? rad(c.get<number>('TargetAngle')) : c.get<number>('TargetPosition')) - (hinge ? rad(now) : now)
      if (hinge) err = Math.atan2(Math.sin(err), Math.cos(err)) // the short way round
      const max = Math.abs(hinge ? rad(c.get<number>('Speed')) : c.get<number>('Speed'))
      const vel = Math.max(-max, Math.min(max, err * SERVO_GAIN))
      ;(e.joint as RAPIER.UnitImpulseJoint).configureMotorVelocity(vel, MOTOR_FACTOR)
      if (Math.abs(vel) > 1e-4) { e.b0.wakeUp(); if (e.b1.isDynamic()) e.b1.wakeUp() }
    }
  }

  /** CurrentAngle (degrees) / CurrentPosition / CurrentLength (studs) right now. */
  value(c: Instance): number {
    const e = this.entries.get(c)
    return e ? this.measure(e) : 0
  }

  private measure(e: Entry): number {
    const pose = (rb: RAPIER.RigidBody) => CFrame.fromPositionQuaternion(rb.translation(), rb.rotation())
    const w0 = pose(e.b0).mul(e.f0), w1 = pose(e.b1).mul(e.f1)
    if (e.kind === 'SpringConstraint' || e.kind === 'RopeConstraint' || e.kind === 'BallSocketConstraint') return w0.position.sub(w1.position).magnitude
    const rel = w1.inverse().mul(w0) // Part0 as seen from the base
    if (e.kind === 'HingeConstraint') return (Math.atan2(rel.r21, rel.r22) * 180) / Math.PI
    return rel.x
  }
}
