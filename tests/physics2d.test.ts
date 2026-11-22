import { describe, it, expect, beforeAll } from 'vitest'
import '../src/engine/classes'
import { DataModel } from '../src/engine/classes'
import { Instance, addEventSink, createInstance } from '../src/engine/instance'
import { Vector2 } from '../src/engine/datatypes'
import { TileMap, parseFrames, worldPosition } from '../src/engine/classes2d'
import { Physics2D, initPhysics2D } from '../src/engine/physics/Physics2D'
import { Animator2D } from '../src/engine/game/Animator2D'

beforeAll(() => initPhysics2D())

function world() {
  const game = new DataModel().initServices()
  const w2d = game.getService('World2D')
  w2d.set('Enabled', true)
  return { game, w2d }
}
const make = (cls: string, props: Record<string, unknown>, parent: Instance) => {
  const i = createInstance(cls)
  for (const [k, v] of Object.entries(props)) i.set(k, v)
  i.setParent(parent)
  return i
}

describe('2D physics', () => {
  it('lands a character on a tilemap floor and reports IsOnFloor', () => {
    const { game, w2d } = world()
    const map = make('TileMap', { TileSize: new Vector2(16, 16) }, w2d) as TileMap
    for (let x = -10; x <= 10; x++) map.setCell(x, 5, 0) // floor top at y = 80
    const player = make('CharacterBody2D', { Position: new Vector2(0, 0), CollisionSize: new Vector2(12, 24) }, w2d)
    const phys = new Physics2D(game)
    for (let f = 0; f < 90; f++) { phys.step(1 / 60); phys.moveAndSlide(player) }
    const y = worldPosition(player).y
    expect(y).toBeGreaterThan(80 - 12 - 2)
    expect(y).toBeLessThan(80 - 12 + 1)
    expect(phys.bodyState(player).floor).toBe(true)
    // walk right into a wall
    for (let y2 = 0; y2 < 5; y2++) map.setCell(4, y2, 0)
    player.set('Velocity', new Vector2(200, 0))
    for (let f = 0; f < 60; f++) { phys.step(1 / 60); phys.moveAndSlide(player); player.set('Velocity', new Vector2(200, player.get<Vector2>('Velocity').y)) }
    expect(worldPosition(player).x).toBeLessThan(64 - 6 + 1)
    expect(phys.bodyState(player).wall).toBe(true)
    phys.dispose()
  })

  it('drops rigid bodies onto static bodies and fires area events', () => {
    const { game, w2d } = world()
    make('StaticBody2D', { Position: new Vector2(0, 100), CollisionSize: new Vector2(400, 20) }, w2d)
    const crate = make('RigidBody2D', { Position: new Vector2(0, 0), CollisionSize: new Vector2(20, 20) }, w2d)
    const area = make('Area2D', { Position: new Vector2(0, 60), CollisionSize: new Vector2(40, 10) }, w2d)
    const entered: string[] = []
    addEventSink((i: Instance, ev: string, args: unknown[]) => { if (i === area && ev === 'BodyEntered') entered.push((args[0] as Instance).className) })
    const phys = new Physics2D(game)
    for (let f = 0; f < 120; f++) phys.step(1 / 60)
    expect(crate.get<Vector2>('Position').y).toBeGreaterThan(78)
    expect(crate.get<Vector2>('Position').y).toBeLessThan(81)
    expect(entered).toContain('RigidBody2D')
    phys.dispose()
  })
})

describe('2D animation and tilemaps', () => {
  it('parses frame lists and steps animations', () => {
    expect(parseFrames('0-3, 6, 9-7')).toEqual([0, 1, 2, 3, 6, 9, 8, 7])
    const { w2d } = world()
    const s = make('AnimatedSprite2D', { Animation: 'run' }, w2d)
    make('SpriteAnimation', { Name: 'run', Frames: '4-7', FPS: 10, Loop: false }, s)
    const shown: number[] = []
    let done = ''
    const a = new Animator2D()
    for (let k = 0; k < 10; k++) a.update(0.05, [s], (_i, f) => shown.push(f), (_i, n) => { done = n })
    expect(shown).toEqual([4, 5, 6, 7])
    expect(done).toBe('run')
  })

  it('saves and restores tilemap cells', async () => {
    const { serialize, deserialize } = await import('../src/engine/instance')
    const { w2d } = world()
    const map = make('TileMap', {}, w2d) as TileMap
    map.setCell(1, 2, 3); map.setCell(-4, 0, 1)
    const copy = deserialize(serialize(map)) as TileMap
    expect(copy.getCell(1, 2)).toBe(3)
    expect(copy.getCell(-4, 0)).toBe(1)
    expect(copy.getCell(0, 0)).toBe(-1)
  })
})
