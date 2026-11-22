import { describe, it, expect, beforeAll } from 'vitest'
import '../src/engine/classes'
import { DataModel } from '../src/engine/classes'
import { Instance, addEventSink, createInstance } from '../src/engine/instance'
import { Vector2, enumItem } from '../src/engine/datatypes'
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

describe('auto-tiling', () => {
  // 3x3 block at tiles 0-2 / 8-10 / 16-18 plus inner corners 3, 4, 11, 12 (8-column tileset)
  const TILES = '0, 1, 2, 8, 9, 10, 16, 17, 18, 3, 4, 11, 12'
  const setup = (mode = 'Block3x3Inner', tiles = TILES) => {
    const { w2d } = world()
    const map = make('TileMap', {}, w2d) as TileMap
    make('TileTerrain', { Name: 'Grass', Mode: enumItem('TerrainMode', mode), Tiles: tiles }, map)
    return map
  }
  const grid = (map: TileMap, x0: number, y0: number, x1: number, y1: number) => {
    const rows: string[] = []
    for (let y = y0; y <= y1; y++) { const r: string[] = []; for (let x = x0; x <= x1; x++) r.push(String(map.getCell(x, y)).padStart(2)); rows.push(r.join(' ')) }
    return rows
  }

  it('picks edge and corner tiles for a block', () => {
    const map = setup('Block3x3')
    for (let y = 0; y < 3; y++) for (let x = 0; x < 4; x++) map.setCellTerrain(x, y, 'Grass')
    expect(grid(map, 0, 0, 3, 2)).toEqual([
      ' 0  1  1  2',
      ' 8  9  9 10',
      '16 17 17 18',
    ])
    expect(map.terrainAt(1, 1)?.name).toBe('Grass')
    // erasing a cell re-tiles its neighbours
    map.setCellTerrain(1, 0, null)
    expect(grid(map, 0, 0, 3, 1)).toEqual([
      ' 0 -1  0  2',
      ' 8  1  9 10',
    ])
  })

  it('uses inner corners and the 16-tile cardinal layout', () => {
    const map = setup()
    // an L-shape: inner corner where the step meets the ground
    for (let x = 0; x < 5; x++) for (let y = 2; y < 4; y++) map.setCellTerrain(x, y, 'Grass')
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) map.setCellTerrain(x, y, 'Grass')
    expect(map.getCell(1, 2)).toBe(4) // inner top-right corner: where the step meets the ground
    expect(map.getCell(0, 2)).toBe(8) // left edge below the step
    expect(map.getCell(2, 2)).toBe(1) // ground top next to the wall
    const c16 = setup('Cardinal16', Array.from({ length: 16 }, (_, i) => 100 + i).join(','))
    c16.setCellTerrain(0, 0, 'Grass'); c16.setCellTerrain(1, 0, 'Grass'); c16.setCellTerrain(1, 1, 'Grass')
    expect(c16.getCell(0, 0)).toBe(100 + 2) // right neighbour only
    expect(c16.getCell(1, 0)).toBe(100 + 4 + 8) // down + left
    expect(c16.getCell(1, 1)).toBe(100 + 1) // up only
  })
})
