// Physics constraints: joints between two parts (3D) or two 2D bodies.
//
// No attachments: a constraint is one object with one pivot (where it sits, and which way it faces).
// The pivot is stored relative to Part0, so it moves with that part; when the game starts each
// constraint locks in where Part1 is relative to it (like a WeldConstraint). Leave Part1 empty to
// pin Part0 to the world. A hinge turns around the pivot's up axis; a slider moves along it.
// Springs and ropes run from the pivot to a second end on Part1.
import { CFrame, Color3, Vector3, enumItem } from './datatypes'
import { Instance, PropDef, defineClass } from './instance'

/** The running game reports joint angles/positions/lengths (0 when not running). */
const current = (c: Instance) =>
  ((c.dataModel as unknown as { runtime?: { constraintValue?(c: Instance): number } } | null)?.runtime?.constraintValue?.(c)) ?? 0

const cframeOf = (p: unknown): CFrame | null =>
  p instanceof Instance && !p.destroyed && p.props.get('CFrame') instanceof CFrame ? (p.props.get('CFrame') as CFrame) : null

/** World pivot of a 3D constraint. */
export function pivotOf(c: Instance): CFrame {
  const off = (c.props.get('Offset') as CFrame | undefined) ?? CFrame.identity
  const p0 = cframeOf(c.get('Part0'))
  return p0 ? p0.mul(off) : off
}
export function setPivot(c: Instance, world: CFrame) {
  const p0 = cframeOf(c.get('Part0'))
  c.set('Offset', p0 ? p0.inverse().mul(world) : world)
}
/** World position of the second end (springs and ropes). */
export function end1Of(c: Instance): Vector3 {
  const off = (c.props.get('Offset1') as CFrame | undefined) ?? CFrame.identity
  const p1 = cframeOf(c.get('Part1'))
  return (p1 ? p1.mul(off) : off).position
}
export function setEnd1(c: Instance, world: Vector3) {
  const p1 = cframeOf(c.get('Part1'))
  c.set('Offset1', p1 ? p1.inverse().mul(CFrame.fromPosition(world)) : CFrame.fromPosition(world))
}

const P = 'Parts', L = 'Placement', B = 'Behavior', A = 'Appearance', S = 'State'

const baseProps = (visible: boolean): Record<string, PropDef> => ({
  Part0: { type: 'Instance', category: P },
  Part1: { type: 'Instance', category: P },
  Enabled: { type: 'bool', default: () => true, category: B },
  Offset: { type: 'CFrame', hidden: true },
  Pivot: { type: 'CFrame', hidden: true, get: pivotOf, set: setPivot },
  Position: {
    type: 'Vector3', category: L,
    get: (c: Instance) => pivotOf(c).position,
    set: (c: Instance, v: Vector3) => setPivot(c, pivotOf(c).withPosition(v)),
  },
  Orientation: {
    type: 'Vector3', category: L,
    get: (c: Instance) => pivotOf(c).toOrientation(),
    set: (c: Instance, v: Vector3) => setPivot(c, CFrame.fromOrientation(pivotOf(c).position, v)),
  },
  ShowInGame: { type: 'bool', default: () => visible, category: A },
  Color: { type: 'Color3', default: () => Color3.fromRGB(255, 176, 64), category: A },
  Thickness: { type: 'number', default: () => 0.2, category: A },
})

const end1Props: Record<string, PropDef> = {
  Offset1: { type: 'CFrame', hidden: true },
  End1: { type: 'Vector3', category: L, get: end1Of, set: setEnd1 },
  CurrentLength: { type: 'number', readonly: true, noSave: true, category: S, get: current },
}

const motorProps = (unit: 'angle' | 'distance'): Record<string, PropDef> => {
  const ang = unit === 'angle'
  return {
    Mode: { type: 'Enum.JointMode', default: () => enumItem('JointMode', 'Free'), category: B },
    Speed: { type: 'number', default: () => (ang ? 90 : 8), category: B }, // deg/s or studs/s
    [ang ? 'MaxTorque' : 'MaxForce']: { type: 'number', default: () => 1e6, category: B },
    [ang ? 'TargetAngle' : 'TargetPosition']: { type: 'number', category: B },
    LimitsEnabled: { type: 'bool', category: B },
    [ang ? 'LowerAngle' : 'LowerLimit']: { type: 'number', default: () => (ang ? -90 : -5), category: B },
    [ang ? 'UpperAngle' : 'UpperLimit']: { type: 'number', default: () => (ang ? 90 : 5), category: B },
    [ang ? 'CurrentAngle' : 'CurrentPosition']: { type: 'number', readonly: true, noSave: true, category: S, get: current },
  }
}

export const CONSTRAINT_CLASSES = ['HingeConstraint', 'BallSocketConstraint', 'SliderConstraint', 'SpringConstraint', 'RopeConstraint']
export const CONSTRAINT_CLASSES_2D = ['HingeConstraint2D', 'SliderConstraint2D', 'SpringConstraint2D', 'RopeConstraint2D']

export class Constraint extends Instance {}
export class Constraint2D extends Instance {}

export function registerConstraintClasses() {
  defineClass(Constraint, { name: 'Constraint', superclass: 'Instance', creatable: false, props: baseProps(false) })
  const cls = (name: string, props: Record<string, PropDef>) => {
    class C extends Constraint {}
    Object.defineProperty(C, 'name', { value: name })
    defineClass(C, { name, superclass: 'Constraint', category: 'Constraints', props })
  }
  /** Turns around the pivot's up axis (a door, a wheel, a lever). Free, or driven by a motor / servo. */
  cls('HingeConstraint', motorProps('angle'))
  /** Turns any way around the pivot (a pendulum, a ragdoll joint). */
  cls('BallSocketConstraint', {})
  /** Slides along the pivot's up axis (a lift, a piston, a drawer). */
  cls('SliderConstraint', motorProps('distance'))
  /** Pulls the two ends towards FreeLength apart (suspension, bouncy things). */
  cls('SpringConstraint', {
    ...end1Props,
    FreeLength: { type: 'number', default: () => 5, category: B },
    Stiffness: { type: 'number', default: () => 2000, category: B },
    Damping: { type: 'number', default: () => 50, category: B },
    ShowInGame: { type: 'bool', default: () => true, category: A },
  })
  /** Keeps the two ends at most Length apart (a swing, a tow rope, a chain). */
  cls('RopeConstraint', {
    ...end1Props,
    Length: { type: 'number', default: () => 10, category: B },
    ShowInGame: { type: 'bool', default: () => true, category: A },
    Color: { type: 'Color3', default: () => Color3.fromRGB(150, 120, 80), category: A },
  })
}

/** 2D constraints are 2D objects: put one inside a body and it moves with it. Its position is the pivot. */
export function register2DConstraintClasses() {
  const base: Record<string, PropDef> = {
    Body0: { type: 'Instance', category: P },
    Body1: { type: 'Instance', category: P },
    Enabled: { type: 'bool', default: () => true, category: B },
    ShowInGame: { type: 'bool', category: A },
    Color: { type: 'Color3', default: () => Color3.fromRGB(255, 176, 64), category: A },
    Thickness: { type: 'number', default: () => 2, category: A },
  }
  defineClass(Constraint2D, { name: 'Constraint2D', superclass: 'Node2D', creatable: false, props: base })
  const cls = (name: string, props: Record<string, PropDef>) => {
    class C extends Constraint2D {}
    Object.defineProperty(C, 'name', { value: name })
    defineClass(C, { name, superclass: 'Constraint2D', category: '2D', props })
  }
  const ang = motorProps('angle'), dist = motorProps('distance')
  cls('HingeConstraint2D', ang)
  cls('SliderConstraint2D', { ...dist, Speed: { type: 'number', default: () => 120, category: B }, LowerLimit: { type: 'number', default: () => -64, category: B }, UpperLimit: { type: 'number', default: () => 64, category: B } })
  const end1: Record<string, PropDef> = {
    End1: { type: 'Vector2', category: L }, // in Body1's space (or the world, without a Body1)
    CurrentLength: { type: 'number', readonly: true, noSave: true, category: S, get: current },
    ShowInGame: { type: 'bool', default: () => true, category: A },
  }
  cls('SpringConstraint2D', {
    ...end1,
    FreeLength: { type: 'number', default: () => 64, category: B },
    Stiffness: { type: 'number', default: () => 50, category: B },
    Damping: { type: 'number', default: () => 2, category: B },
  })
  cls('RopeConstraint2D', {
    ...end1,
    Length: { type: 'number', default: () => 96, category: B },
    Color: { type: 'Color3', default: () => Color3.fromRGB(150, 120, 80), category: A },
  })
}

