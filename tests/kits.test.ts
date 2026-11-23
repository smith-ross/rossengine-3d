import { describe, it, expect, beforeAll } from 'vitest'
import '../src/engine/classes'
import { BasePart, DataModel } from '../src/engine/classes'
import { CFrame, Vector3 } from '../src/engine/datatypes'
import { Instance, createInstance } from '../src/engine/instance'
import { Physics, initPhysics } from '../src/engine/physics/Physics'
import { buildCar } from '../src/engine/kits'
import { CharacterController, buildDefaultCharacter } from '../src/engine/game/Character'
import { Humanoid, Model } from '../src/engine/classes'

beforeAll(() => initPhysics())

function scene() {
  const game = new DataModel().initServices()
  const ground = createInstance('Part') as BasePart
  ground.set('Anchored', true)
  ground.set('Size', new Vector3(2000, 2, 2000))
  ground.set('CFrame', new CFrame(0, -1, 0))
  ground.setParent(game.workspace)
  const car = buildCar(CFrame.identity)
  car.setParent(game.workspace)
  const physics = new Physics(game)
  const chassis = car.findFirstChild('Chassis') as BasePart
  const joints = (suffix: string) => car.getDescendants().filter((d) => d.className === 'HingeConstraint' && d.name.endsWith(suffix))
  /** what the Drive LocalScript does each frame */
  const drive = (throttle: number, steer: number) => {
    const spin = (throttle * (throttle > 0 ? 60 : 25)) / 1.25 * (180 / Math.PI)
    for (const w of joints('Axle')) { w.set('Speed', -spin); w.set('MaxTorque', throttle ? 1500 : 40) }
    for (const s of joints('Steering')) s.set('TargetAngle', -steer * 30)
  }
  const run = (seconds: number, each?: () => void) => { for (let t = 0; t < seconds; t += 1 / 60) { each?.(); physics.step(1 / 60) } }
  return { game, car, chassis, physics, drive, run, joints }
}

const finite = (p: Instance[]) => p.every((x) => x instanceof BasePart ? Number.isFinite(x.cframe.position.y) : true)

describe('car kit', () => {
  it('settles on its wheels without falling through or bouncing away', () => {
    const { chassis, run, car } = scene()
    run(3)
    const p = chassis.cframe.position
    expect(finite(car.getDescendants())).toBe(true)
    expect(p.y).toBeGreaterThan(1.2)
    expect(p.y).toBeLessThan(2.2)
    expect(Math.abs(p.x) + Math.abs(p.z)).toBeLessThan(0.3) // didn't roll off
    expect(chassis.cframe.upVector.y).toBeGreaterThan(0.99) // level
    for (const w of car.children.filter((c) => c.name.endsWith('Wheel')) as BasePart[]) {
      expect(w.cframe.position.y).toBeCloseTo(1.25, 0) // on the ground
    }
  })

  it('drives forwards with W, backwards with S', () => {
    const { chassis, run, drive } = scene()
    run(1)
    run(3, () => drive(1, 0))
    const p = chassis.cframe.position
    expect(p.z).toBeLessThan(-60) // forwards is -Z (the look direction)
    expect(Math.abs(p.x)).toBeLessThan(3) // fairly straight
    expect(chassis.cframe.upVector.y).toBeGreaterThan(0.95)
    const v = chassis.get<Vector3>('AssemblyLinearVelocity')
    expect(-v.z).toBeGreaterThan(40)
    expect(-v.z).toBeLessThan(66)
    run(3, () => drive(0, 0))
    run(3, () => drive(-1, 0))
    expect(chassis.get<Vector3>('AssemblyLinearVelocity').z).toBeGreaterThan(10) // reversing
  })

  it('steers: D turns right', () => {
    const { chassis, run, drive } = scene()
    run(1)
    run(1, () => drive(1, 0))
    run(2, () => drive(1, 1))
    const look = chassis.cframe.lookVector
    expect(look.x).toBeGreaterThan(0.3) // facing right of where it started (-Z)
    expect(chassis.cframe.upVector.y).toBeGreaterThan(0.9) // didn't roll over
  })

  it('a character sits in the seat, rides along, and gets out beside the car with Jump', () => {
    const { game, car, chassis, physics, drive } = scene()
    const ch = buildDefaultCharacter('Player1')
    ch.setParent(game.workspace)
    for (const p of ch.getDescendants()) if (p instanceof BasePart) p.set('CFrame', p.cframe.mul(new CFrame(-12, 3, 0)))
    const h = ch.findFirstChildOfClass('Humanoid') as Humanoid
    let t = 0
    const ctl = new CharacterController(ch as Model, h, physics, () => t)
    const run = (seconds: number, each?: () => void) => { for (let i = 0; i < seconds * 60; i++) { each?.(); t += 1 / 60; physics.step(1 / 60, (dt) => ctl.update(dt)) } }
    run(1)
    const seat = car.findFirstChild('DriverSeat') as BasePart
    h.set('SeatPart', seat)
    run(0.5)
    const root = ch.findFirstChild('HumanoidRootPart') as BasePart
    const onSeat = () => seat.cframe.PointToObjectSpace(root.cframe.position)
    expect(onSeat().magnitude).toBeLessThan(2.5) // sitting on it
    expect(chassis.cframe.upVector.y).toBeGreaterThan(0.99) // and not shoving the car around
    run(2, () => drive(1, 0))
    expect(chassis.cframe.position.z).toBeLessThan(-30) // the car went...
    expect(onSeat().magnitude).toBeLessThan(2.5) // ...and took the driver with it
    run(2, () => drive(0, 0))
    h.set('Jump', true)
    run(0.25)
    expect(h.get('SeatPart')).toBe(null)
    const out = chassis.cframe.PointToObjectSpace(root.cframe.position)
    expect(out.x).toBeLessThan(-3.5) // standing on the car's left (the seat's ExitOffset)
    expect(Math.abs(out.y)).toBeLessThan(2)
  })
})
