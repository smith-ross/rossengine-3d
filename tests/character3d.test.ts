import { describe, it, expect, beforeAll } from 'vitest'
import '../src/engine/classes'
import { BasePart, DataModel } from '../src/engine/classes'
import { CFrame, Vector3 } from '../src/engine/datatypes'
import { Instance, createInstance } from '../src/engine/instance'
import { Physics, initPhysics } from '../src/engine/physics/Physics'

beforeAll(() => initPhysics())

const make = (cls: string, props: Record<string, unknown>, parent: Instance) => {
  const i = createInstance(cls)
  for (const [k, v] of Object.entries(props)) i.set(k, v)
  i.setParent(parent)
  return i as BasePart
}

function world() {
  const game = new DataModel().initServices()
  make('Part', { Anchored: true, Size: new Vector3(200, 1, 200), CFrame: CFrame.fromPosition(new Vector3(0, -0.5, 0)) }, game.workspace)
  const body = make('CharacterBody3D', { Size: new Vector3(2, 5, 2), CFrame: CFrame.fromPosition(new Vector3(0, 6, 0)) }, game.workspace)
  const physics = new Physics(game)
  /** what a controller script does each frame */
  const tick = (vx = 0, vz = 0, jump = 0, frames = 1) => {
    for (let f = 0; f < frames; f++) {
      const v = body.get<Vector3>('Velocity')
      body.set('Velocity', new Vector3(vx, jump && physics.characterState(body).floor ? jump : v.y, vz))
      physics.moveAndSlide(body, 1 / 60)
      physics.step(1 / 60)
    }
  }
  return { game, body, physics, tick }
}

describe('CharacterBody3D', () => {
  it('falls onto the floor and stays there without bouncing', () => {
    const { body, physics, tick } = world()
    tick(0, 0, 0, 90)
    const y = body.cframe.position.y
    expect(y).toBeGreaterThan(2.5)
    expect(y).toBeLessThan(2.6) // half its height (2.5) plus the small skin gap
    expect(physics.characterState(body).floor).toBe(true)
    expect(body.get<Vector3>('Velocity').y).toBe(0)
    tick(0, 0, 0, 60)
    expect(body.cframe.position.y).toBeCloseTo(y, 3)
    physics.dispose()
  })

  it('walks, climbs a step, and stops at a wall it cannot step over', () => {
    const { game, body, physics, tick } = world()
    make('Part', { Anchored: true, Size: new Vector3(20, 1, 6), CFrame: CFrame.fromPosition(new Vector3(0, 0.5, -10)) }, game.workspace) // 1 stud step
    make('Part', { Anchored: true, Size: new Vector3(20, 3, 2), CFrame: CFrame.fromPosition(new Vector3(0, 1.5, -25)) }, game.workspace) // 3 stud wall
    tick(0, 0, 0, 60)
    let maxY = 0
    for (let f = 0; f < 150; f++) { tick(0, -16); maxY = Math.max(maxY, body.cframe.position.y) }
    expect(maxY).toBeGreaterThan(3.4) // went up onto the step
    const p = body.cframe.position
    expect(p.z).toBeGreaterThan(-23.1) // stopped by the wall (its face is at z = -24, the capsule's radius is 1)
    expect(p.z).toBeLessThan(-22.8)
    expect(p.y).toBeLessThan(2.6) // back down on the ground
    expect(physics.characterState(body).wall).toBe(true)
    expect(Math.abs(body.get<Vector3>('Velocity').z)).toBeLessThan(0.5) // speed into the wall is dropped
    physics.dispose()
  })

  it('jumps only from the floor and lands again', () => {
    const { body, tick } = world()
    tick(0, 0, 0, 60)
    tick(0, 0, 50, 1)
    expect(body.get<Vector3>('Velocity').y).toBeGreaterThan(40)
    let peak = 0
    for (let f = 0; f < 120; f++) { tick(0, 0, 50); peak = Math.max(peak, body.cframe.position.y) } // holding jump keeps hopping
    expect(peak).toBeGreaterThan(8)
    tick(0, 0, 0, 120)
    expect(body.cframe.position.y).toBeLessThan(2.6)
  })

  it('carries parts inside it and parts welded to it, turning with it', () => {
    const { game, body, physics, tick } = world()
    const hat = make('Part', { Size: new Vector3(1, 1, 1), CFrame: CFrame.fromPosition(new Vector3(0, 9, 0)), CanCollide: false }, body) // inside
    const mesh = make('Part', { Size: new Vector3(3, 5, 1), CFrame: CFrame.fromPosition(new Vector3(0, 6, 0.5)), CanCollide: false }, game.workspace)
    make('WeldConstraint', { Part0: body, Part1: mesh }, game.workspace)
    tick(0, 0, 0, 60) // settle on the floor
    const offHat = body.cframe.inverse().mul(hat.cframe).position
    const offMesh = body.cframe.inverse().mul(mesh.cframe).position
    tick(10, 0, 0, 60)
    expect(body.cframe.inverse().mul(hat.cframe).position.sub(offHat).magnitude).toBeLessThan(1e-6)
    expect(body.cframe.inverse().mul(mesh.cframe).position.sub(offMesh).magnitude).toBeLessThan(1e-6)
    // a script turning the body turns its riders too
    body.set('CFrame', CFrame.fromOrientation(body.cframe.position, new Vector3(0, 90, 0)))
    physics.step(1 / 60)
    expect(body.cframe.inverse().mul(mesh.cframe).position.sub(offMesh).magnitude).toBeLessThan(1e-6)
    // riders aren't pushed around by physics while they ride
    const before = mesh.cframe.position
    physics.step(1 / 60); physics.step(1 / 60)
    expect(mesh.cframe.position.sub(before).magnitude).toBeLessThan(1e-6)
    physics.dispose()
  })
})
