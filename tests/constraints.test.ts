import { describe, it, expect, beforeAll } from 'vitest'
import '../src/engine/classes'
import { BasePart, DataModel } from '../src/engine/classes'
import { CFrame, Vector3, enumItem } from '../src/engine/datatypes'
import { Instance, createInstance } from '../src/engine/instance'
import { Physics, initPhysics } from '../src/engine/physics/Physics'
import { pivotOf, setEnd1, setPivot } from '../src/engine/constraintClasses'

beforeAll(() => initPhysics())

const make = (cls: string, props: Record<string, unknown>, parent: Instance) => {
  const i = createInstance(cls)
  for (const [k, v] of Object.entries(props)) i.set(k, v)
  i.setParent(parent)
  return i
}
const at = (x: number, y: number, z: number) => CFrame.fromPosition(new Vector3(x, y, z))

function world() {
  const game = new DataModel().initServices()
  const ws = game.workspace
  const part = (props: Record<string, unknown>) => make('Part', props, ws) as BasePart
  const joint = (cls: string, p0: BasePart, p1: BasePart | null, pivot: CFrame, props: Record<string, unknown> = {}) => {
    const c = make(cls, { Part0: p0, Part1: p1 }, p0)
    setPivot(c, pivot)
    for (const [k, v] of Object.entries(props)) c.set(k, v)
    return c
  }
  let physics: Physics | null = null
  const run = (seconds: number) => { physics ??= new Physics(game); for (let t = 0; t < seconds; t += 1 / 60) physics.step(1 / 60) }
  const value = (c: Instance) => physics!.constraints.value(c)
  return { game, part, joint, run, value, get physics() { return physics! } }
}

describe('constraints (3D)', () => {
  it('keeps the pivot where it was put, moving with Part0', () => {
    const { part, joint } = world()
    const door = part({ Size: new Vector3(4, 8, 0.5), CFrame: at(2, 4, 0) })
    const h = joint('HingeConstraint', door, null, at(0, 4, 0))
    expect(pivotOf(h).position.x).toBeCloseTo(0)
    door.set('CFrame', at(12, 4, 0))
    expect(pivotOf(h).position.x).toBeCloseTo(10) // stored relative to the door
    expect(h.get<Vector3>('Position').x).toBeCloseTo(10)
  })

  it('a free hinge swings a door around the pivot\'s up axis and keeps it attached', () => {
    const { part, joint, run, value } = world()
    const post = part({ Anchored: true, Size: new Vector3(1, 8, 1), CFrame: at(-0.5, 4, 0) })
    const door = part({ Size: new Vector3(4, 8, 0.5), CFrame: at(2, 4, 0), AssemblyAngularVelocity: new Vector3(0, 2, 0) })
    const h = joint('HingeConstraint', door, post, at(0, 4, 0)) // hinged to the post (they don't rub)
    run(1)
    const p = door.cframe.position
    expect(Math.hypot(p.x, p.z)).toBeCloseTo(2, 1) // still 2 studs from the hinge line
    expect(p.y).toBeCloseTo(4, 1) // and not fallen
    expect(Math.abs(value(h))).toBeGreaterThan(20) // it turned
  })

  it('a motor spins at Speed, and a servo turns to TargetAngle', () => {
    const { part, joint, run, value } = world()
    const wheel = part({ Size: new Vector3(1, 1, 4), CFrame: at(0, 10, 0) })
    // axis along X: turn the pivot so its up points along X
    const m = joint('HingeConstraint', wheel, null, CFrame.fromOrientation(new Vector3(0, 10, 0), new Vector3(0, 0, -90)), { Mode: enumItem('JointMode', 'Motor'), Speed: 90 })
    run(0.5)
    const a0 = value(m)
    run(0.5)
    const turned = value(m) - a0
    expect(turned).toBeGreaterThan(35) // ~45 degrees in half a second, the positive way
    expect(turned).toBeLessThan(55)

    const arm = part({ Size: new Vector3(4, 0.5, 0.5), CFrame: at(2, 20, 0) })
    const s = joint('HingeConstraint', arm, null, at(0, 20, 0), { Mode: enumItem('JointMode', 'Servo'), Speed: 180, TargetAngle: 60 })
    run(2)
    expect(value(s)).toBeCloseTo(60, -0.7) // within a few degrees
    s.set('TargetAngle', -30)
    run(2)
    expect(value(s)).toBeCloseTo(-30, -0.7)
  })

  it('limits stop a hinge', () => {
    const { part, joint, run, value } = world()
    // a lever sticking out sideways on a horizontal axis: gravity swings it down until the limit
    const lever = part({ Size: new Vector3(4, 0.5, 0.5), CFrame: at(2, 10, 0) })
    const h = joint('HingeConstraint', lever, null, CFrame.fromOrientation(new Vector3(0, 10, 0), new Vector3(90, 0, 0)), { LimitsEnabled: true, LowerAngle: -30, UpperAngle: 30 })
    run(2)
    expect(Math.abs(value(h))).toBeGreaterThan(25)
    expect(Math.abs(value(h))).toBeLessThan(33)
  })

  it('a ball socket makes a pendulum', () => {
    const { part, joint, run } = world()
    const bob = part({ Size: new Vector3(1, 1, 1), CFrame: at(5, 10, 0) })
    joint('BallSocketConstraint', bob, null, at(0, 10, 0))
    run(3)
    const p = bob.cframe.position
    expect(Math.hypot(p.x, p.y - 10, p.z)).toBeCloseTo(5, 0) // swinging on a 5-stud arm
    expect(p.y).toBeLessThan(9.5)
  })

  it('a slider moves along the pivot\'s up axis, driven and limited', () => {
    const { part, joint, run, value } = world()
    const lift = part({ Size: new Vector3(4, 0.5, 4), CFrame: at(0, 2, 0) })
    const sl = joint('SliderConstraint', lift, null, at(0, 2, 0), { Mode: enumItem('JointMode', 'Motor'), Speed: 6, LimitsEnabled: true, LowerLimit: 0, UpperLimit: 10 })
    run(1)
    expect(lift.cframe.position.y).toBeGreaterThan(6)
    expect(Math.abs(lift.cframe.position.x)).toBeLessThan(0.05)
    run(3)
    expect(value(sl)).toBeCloseTo(10, 0) // stopped at the top
    expect(lift.cframe.position.y).toBeCloseTo(12, 0)
  })

  it('a spring holds a weight near its free length; a rope only stops it going further', () => {
    const { part, joint, run, value } = world()
    const weight = part({ Size: new Vector3(1, 1, 1), CFrame: at(0, 15, 0) })
    const sp = joint('SpringConstraint', weight, null, at(0, 15, 0), { FreeLength: 5, Damping: 200 })
    setEnd1(sp, new Vector3(0, 20, 0))
    run(4)
    const len = value(sp)
    expect(len).toBeGreaterThan(5) // stretched by the weight
    expect(len).toBeLessThan(9)
    expect(weight.cframe.position.y).toBeCloseTo(20 - len, 0)

    const ball = part({ Shape: enumItem('PartType', 'Ball'), Size: new Vector3(1, 1, 1), CFrame: at(10, 18, 0) })
    const rope = joint('RopeConstraint', ball, null, at(10, 18, 0), { Length: 6 })
    setEnd1(rope, new Vector3(10, 20, 0))
    run(2)
    expect(value(rope)).toBeLessThan(6.1)
    expect(ball.cframe.position.y).toBeCloseTo(14, 0) // hanging at the end of the rope
  })

  it('links two moving parts, and can be turned off', () => {
    const { part, joint, run } = world()
    const a = part({ Size: new Vector3(2, 2, 2), CFrame: at(0, 30, 0) })
    const b = part({ Size: new Vector3(2, 2, 2), CFrame: at(3, 30, 0) })
    const bs = joint('BallSocketConstraint', a, b, at(1.5, 30, 0))
    run(0.5)
    expect(a.cframe.position.sub(b.cframe.position).magnitude).toBeCloseTo(3, 0) // fell together
    bs.set('Enabled', false)
    b.set('AssemblyLinearVelocity', new Vector3(20, 0, 0))
    run(0.5)
    expect(a.cframe.position.sub(b.cframe.position).magnitude).toBeGreaterThan(5)
  })
})

describe('constraints (2D)', () => {
  const setup = async () => {
    const { Physics2D, initPhysics2D } = await import('../src/engine/physics/Physics2D')
    const { worldPosition } = await import('../src/engine/classes2d')
    const { Vector2 } = await import('../src/engine/datatypes')
    await initPhysics2D()
    const game = new DataModel().initServices()
    const w2d = game.getService('World2D')
    w2d.set('Enabled', true)
    const body = (props: Record<string, unknown>) => make('RigidBody2D', { CollisionSize: new Vector2(16, 16), ...props }, w2d)
    let phys: InstanceType<typeof Physics2D> | null = null
    const run = (s: number) => { phys ??= new Physics2D(game); for (let t = 0; t < s; t += 1 / 60) phys.step(1 / 60) }
    return { w2d, body, run, Vector2, worldPosition, value: (c: Instance) => phys!.constraintValue(c) }
  }

  it('a hinge inside a body pins it to the world; a motor turns it', async () => {
    const { body, run, Vector2, worldPosition, value } = await setup()
    // a bar whose hinge sits 40px to its left: it swings down around that point, staying 40px away
    const bar = body({ Position: new Vector2(40, 0), CollisionSize: new Vector2(80, 8) })
    make('HingeConstraint2D', { Position: new Vector2(-40, 0) }, bar)
    run(2)
    const p = worldPosition(bar)
    expect(Math.hypot(p.x, p.y)).toBeCloseTo(40, -0.5)
    expect(p.y).toBeGreaterThan(20) // swung down (y points down)
    // a wheel on a motor
    const wheel = body({ Position: new Vector2(300, 0), GravityScale: 0 })
    const m = make('HingeConstraint2D', { Mode: enumItem('JointMode', 'Motor'), Speed: 90 }, wheel)
    run(0.5)
    const a0 = value(m)
    run(0.5)
    expect(value(m) - a0).toBeGreaterThan(35)
  })

  it('a slider moves along its up, within its limits; a rope and a spring hold a body up', async () => {
    const { body, run, Vector2, worldPosition, value, w2d } = await setup()
    const lift = body({ Position: new Vector2(0, 0) })
    const s = make('SliderConstraint2D', { Mode: enumItem('JointMode', 'Motor'), Speed: 100, LimitsEnabled: true, LowerLimit: 0, UpperLimit: 60 }, lift)
    run(2)
    expect(value(s)).toBeCloseTo(60, -0.5)
    expect(worldPosition(lift).y).toBeCloseTo(-60, -0.5) // "up" is towards -y
    expect(Math.abs(worldPosition(lift).x)).toBeLessThan(1)

    const ball = body({ Position: new Vector2(200, 0) })
    const rope = make('RopeConstraint2D', { Length: 50, End1: new Vector2(200, -100) }, ball) // tied to a world point above
    run(2)
    expect(value(rope)).toBeLessThan(51)
    expect(worldPosition(ball).y).toBeCloseTo(-50, -0.5)

    const weight = body({ Position: new Vector2(400, 0) })
    const spring = make('SpringConstraint2D', { FreeLength: 40, Damping: 20, End1: new Vector2(400, -100) }, weight)
    run(4)
    expect(value(spring)).toBeGreaterThan(40) // stretched a little by the weight
    expect(value(spring)).toBeLessThan(100)
    void w2d
  })
})
