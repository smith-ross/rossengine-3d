// 2D game classes: World2D, Node2D hierarchy, sprites + animation, tilemaps, 2D physics bodies.
// Coordinates are pixels with y pointing down; rotations are degrees, clockwise.
import { Color3, EnumItem, Vector2, enumItem } from './datatypes'
import { Instance, defineClass, isA } from './instance'
import { emitterMethods, emitterProps } from './particleClasses'

/** Provided by the running game (GameSession) for methods that need physics or the viewport. */
export interface Runtime2D {
  moveAndSlide(body: Instance): Vector2
  bodyState(body: Instance): { floor: boolean; wall: boolean; ceiling: boolean; floorNormal: Vector2 }
  applyImpulse2D(body: Instance, impulse: Vector2): void
  screenToWorld2D(p: Vector2): Vector2
  worldToScreen2D(p: Vector2): Vector2
  raycast2D(origin: Vector2, direction: Vector2, exclude: Instance[]): Map<string, unknown> | null
}

function rt2d(self: Instance): Runtime2D {
  const r = (self.dataModel as any)?.runtime2d as Runtime2D | null
  if (!r) throw new Error('This method can only be called while a 2D game is running')
  return r
}

// ---- transforms ------------------------------------------------------------------------------
export interface Xform { a: number; b: number; c: number; d: number; tx: number; ty: number }
const IDENTITY: Xform = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 }
const mul = (p: Xform, q: Xform): Xform => ({
  a: p.a * q.a + p.c * q.b, b: p.b * q.a + p.d * q.b,
  c: p.a * q.c + p.c * q.d, d: p.b * q.c + p.d * q.d,
  tx: p.a * q.tx + p.c * q.ty + p.tx, ty: p.b * q.tx + p.d * q.ty + p.ty,
})
export function localXform(n: Instance): Xform {
  const p = n.get<Vector2>('Position'), s = n.get<Vector2>('Scale') ?? new Vector2(1, 1)
  const r = ((n.get<number>('Rotation') ?? 0) * Math.PI) / 180
  const cos = Math.cos(r), sin = Math.sin(r)
  return { a: cos * s.x, b: sin * s.x, c: -sin * s.y, d: cos * s.y, tx: p.x, ty: p.y }
}
/** World transform of a Node2D (composes all Node2D ancestors). */
export function worldXform(n: Instance): Xform {
  let m = localXform(n)
  for (let p = n.parent; p; p = p.parent) if (isNode2D(p)) m = mul(localXform(p), m)
  return m
}
export function parentXform(n: Instance): Xform {
  for (let p = n.parent; p; p = p.parent) if (isNode2D(p)) return worldXform(p)
  return IDENTITY
}
export function apply(m: Xform, x: number, y: number) { return { x: m.a * x + m.c * y + m.tx, y: m.b * x + m.d * y + m.ty } }
export function invert(m: Xform): Xform {
  const det = m.a * m.d - m.b * m.c || 1
  return { a: m.d / det, b: -m.b / det, c: -m.c / det, d: m.a / det, tx: (m.c * m.ty - m.d * m.tx) / det, ty: (m.b * m.tx - m.a * m.ty) / det }
}
export const xformRotation = (m: Xform) => Math.atan2(m.b, m.a)
export const xformScale = (m: Xform) => ({ x: Math.hypot(m.a, m.b), y: Math.hypot(m.c, m.d) })
export const isNode2D = (i: Instance) => isA(i.classInfo, 'Node2D')

/** World position of a node. */
export function worldPosition(n: Instance): Vector2 {
  const m = worldXform(n)
  return new Vector2(m.tx, m.ty)
}
/** Set a node's world position (converts to its parent's space). */
export function setWorldPosition(n: Instance, p: Vector2) {
  const inv = invert(parentXform(n))
  const l = apply(inv, p.x, p.y)
  n.set('Position', new Vector2(l.x, l.y))
}

// ---- World2D service ----------------------------------------------------------------------------
class World2D extends Instance {}

// ---- Node2D ---------------------------------------------------------------------------------------
export class Node2D extends Instance {}

const spriteProps = {
  Image: { type: 'Content', content: 'image', category: 'Appearance' },
  Size: { type: 'Vector2', default: () => new Vector2(32, 32), category: 'Appearance' },
  Color: { type: 'Color3', default: () => new Color3(1, 1, 1), category: 'Appearance' },
  Transparency: { type: 'number', category: 'Appearance' },
  FlipX: { type: 'bool', category: 'Appearance' },
  FlipY: { type: 'bool', category: 'Appearance' },
  Pivot: { type: 'Vector2', default: () => new Vector2(0.5, 0.5), category: 'Appearance' },
  Shape: { type: 'Enum.Shape2D', default: () => enumItem('Shape2D', 'Rectangle'), category: 'Appearance' },
  HFrames: { type: 'int', default: () => 1, category: 'Sprite Sheet' },
  VFrames: { type: 'int', default: () => 1, category: 'Sprite Sheet' },
  Frame: { type: 'int', category: 'Sprite Sheet' },
  PixelArt: { type: 'bool', default: () => true, category: 'Appearance' },
  ScrollFactor: { type: 'Vector2', default: () => new Vector2(1, 1), category: 'Appearance' },
} as const

export class Sprite2D extends Node2D {}

/** Plays SpriteAnimation children (frame lists over the sprite sheet). */
export class AnimatedSprite2D extends Sprite2D {}

class SpriteAnimation extends Instance {}

/**
 * Auto-tiling rules for a TileMap (child of the TileMap). Tiles lists the tileset indices in the
 * order the Mode expects:
 *   Block3x3       9 tiles: top-left, top, top-right, left, centre, right, bottom-left, bottom, bottom-right
 *   Block3x3Inner  those 9 + inner corners: top-left, top-right, bottom-left, bottom-right
 *   Cardinal16     16 tiles indexed by neighbours: up=1, right=2, down=4, left=8
 */
export class TileTerrain extends Instance {}

/** "0-3, 6, 8-6" -> [0,1,2,3,6,8,7,6] */
export function parseFrames(spec: string): number[] {
  const out: number[] = []
  for (const part of String(spec ?? '').split(/[,\s]+/).filter(Boolean)) {
    const r = /^(\d+)\s*-\s*(\d+)$/.exec(part)
    if (r) {
      const a = Number(r[1]), b = Number(r[2])
      for (let i = a; a <= b ? i <= b : i >= b; i += a <= b ? 1 : -1) out.push(i)
    } else if (/^\d+$/.test(part)) out.push(Number(part))
  }
  return out
}

// ---- TileMap ------------------------------------------------------------------------------------
export class TileMap extends Node2D {
  cells = new Map<string, number>()
  key(x: number, y: number) { return `${x},${y}` }
  getCell(x: number, y: number) { return this.cells.get(this.key(Math.floor(x), Math.floor(y))) ?? -1 }
  setCell(x: number, y: number, tile: number, notify = true) {
    const k = this.key(Math.floor(x), Math.floor(y))
    if (tile < 0) { if (!this.cells.delete(k)) return } else { if (this.cells.get(k) === tile) return; this.cells.set(k, Math.floor(tile)) }
    if (notify) this.changed('Cells')
  }
  encodeCells(): string {
    const parts: string[] = []
    for (const [k, t] of this.cells) parts.push(`${k}:${t}`)
    return parts.join(';')
  }
  decodeCells(s: string) {
    this.cells.clear()
    for (const p of String(s ?? '').split(';')) {
      const m = /^(-?\d+),(-?\d+):(\d+)$/.exec(p)
      if (m) this.cells.set(`${m[1]},${m[2]}`, Number(m[3]))
    }
  }
  // ---- auto-tiling ------------------------------------------------------------------------------
  /** TileTerrain children by name */
  terrains(): Instance[] { return this.children.filter((c) => c.className === 'TileTerrain') }
  terrain(name: string): Instance | null { return this.terrains().find((t) => t.name === name) ?? null }
  terrainTiles(t: Instance): number[] { return parseFrames(t.get<string>('Tiles')) }
  /** The terrain a cell belongs to (its tile is one of the terrain's tiles). */
  terrainAt(x: number, y: number): Instance | null {
    const tile = this.getCell(x, y)
    if (tile < 0) return null
    for (const t of this.terrains()) if (this.terrainTiles(t).includes(tile)) return t
    return null
  }
  /** Paint (or erase, with null) a terrain cell and re-pick the tiles of it and its neighbours. */
  setCellTerrain(x: number, y: number, terrain: Instance | string | null, notify = true) {
    x = Math.floor(x); y = Math.floor(y)
    const t = typeof terrain === 'string' ? this.terrain(terrain) : terrain
    if (typeof terrain === 'string' && !t) throw new Error(`TileMap "${this.name}" has no TileTerrain named "${terrain}"`)
    if (t) {
      const tiles = this.terrainTiles(t)
      if (!tiles.length) throw new Error(`TileTerrain "${t.name}" has no Tiles set`)
      // placeholder: any tile of the terrain marks membership; the real tile is picked below
      this.cells.set(this.key(x, y), tiles[Math.min(4, tiles.length - 1)])
    } else this.cells.delete(this.key(x, y))
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) this.retile(x + dx, y + dy)
    if (notify) this.changed('Cells')
  }
  /** Re-pick every terrain cell's tile (after editing Tiles or painting plain tiles). */
  updateTerrain(notify = true) {
    for (const k of [...this.cells.keys()]) { const [x, y] = k.split(',').map(Number); this.retile(x, y) }
    if (notify) this.changed('Cells')
  }
  private retile(x: number, y: number) {
    const t = this.terrainAt(x, y)
    if (!t) return
    const tiles = this.terrainTiles(t)
    const same = (dx: number, dy: number) => this.terrainAt(x + dx, y + dy) === t
    const n = same(0, -1), s = same(0, 1), e = same(1, 0), w = same(-1, 0)
    const mode = t.get<EnumItem>('Mode')?.name ?? 'Block3x3'
    let tile: number | undefined
    if (mode === 'Cardinal16') {
      tile = tiles[(n ? 1 : 0) | (e ? 2 : 0) | (s ? 4 : 0) | (w ? 8 : 0)]
    } else {
      const row = !n ? 0 : !s ? 2 : 1
      const col = !w ? 0 : !e ? 2 : 1
      let i = row * 3 + col
      if (i === 4 && mode === 'Block3x3Inner' && tiles.length >= 13) {
        if (!same(-1, -1)) i = 9
        else if (!same(1, -1)) i = 10
        else if (!same(-1, 1)) i = 11
        else if (!same(1, 1)) i = 12
      }
      tile = tiles[i]
    }
    if (tile !== undefined) this.cells.set(this.key(x, y), tile)
  }

  /** Tiles marked solid ("all", "", or a list like "0-3, 7"). */
  solidSet(): Set<number> | 'all' {
    const s = String(this.get('SolidTiles') ?? '').trim().toLowerCase()
    if (s === 'all') return 'all'
    return new Set(parseFrames(s))
  }
}

// ---- Camera & text ------------------------------------------------------------------------------
class Camera2D extends Node2D {}

class Text2D extends Node2D {}

// ---- physics bodies ----------------------------------------------------------------------------
const bodyProps = {
  CollisionShape: { type: 'Enum.Shape2D', default: () => enumItem('Shape2D', 'Rectangle'), category: 'Collision' },
  CollisionSize: { type: 'Vector2', default: () => new Vector2(32, 32), category: 'Collision' },
  CollisionOffset: { type: 'Vector2', category: 'Collision' },
  CanCollide: { type: 'bool', default: () => true, category: 'Collision' },
  Friction: { type: 'number', default: () => 0.2, category: 'Collision' },
  Restitution: { type: 'number', category: 'Collision' },
} as const

export class PhysicsBody2D extends Node2D {}

class StaticBody2D extends PhysicsBody2D {}

class RigidBody2D extends PhysicsBody2D {}

class CharacterBody2D extends PhysicsBody2D {}

class Area2D extends PhysicsBody2D {}

/** Particles that stream out of this node (drawn by Renderer2D; see render/particles.ts). */
export class ParticleEmitter2D extends Node2D {}


/** Called once from classes.ts after the base classes exist (avoids import-order problems). */
let registered = false
export function register2DClasses() {
  if (registered) return
  registered = true
  defineClass(TileTerrain, {
    name: 'TileTerrain', superclass: 'Instance', category: '2D',
    props: {
      Mode: { type: 'Enum.TerrainMode', default: () => enumItem('TerrainMode', 'Block3x3'), category: 'Terrain' },
      Tiles: { type: 'string', category: 'Terrain' },
    },
  })
  defineClass(World2D, {
    name: 'World2D', superclass: 'Instance', creatable: false, service: true,
    props: {
      Enabled: { type: 'bool', category: 'Behavior' },
      Gravity: { type: 'Vector2', default: () => new Vector2(0, 980), category: 'Physics' },
      BackgroundColor: { type: 'Color3', default: () => Color3.fromRGB(104, 180, 232), category: 'Appearance' },
      CurrentCamera: { type: 'Instance', category: 'Camera' },
      PixelsPerMeter: { type: 'number', default: () => 32, category: 'Physics' },
    },
    methods: {
      Raycast: (self: Instance, origin: Vector2, direction: Vector2, exclude: Map<number, Instance> | null) =>
        rt2d(self).raycast2D(origin, direction, exclude ? [...exclude.values()] : []),
    },
  })
  defineClass(Node2D, {
    name: 'Node2D', superclass: 'Instance', category: '2D',
    props: {
      Position: { type: 'Vector2', category: 'Transform' },
      Rotation: { type: 'number', category: 'Transform' },
      Scale: { type: 'Vector2', default: () => new Vector2(1, 1), category: 'Transform' },
      ZIndex: { type: 'int', category: 'Appearance' },
      Visible: { type: 'bool', default: () => true, category: 'Appearance' },
      WorldPosition: {
        type: 'Vector2', category: 'Transform', hidden: true, noSave: true,
        get: (n: Instance) => worldPosition(n), set: (n: Instance, v: Vector2) => setWorldPosition(n, v),
      },
    },
    methods: {
      GetWorldPosition: (self: Instance) => worldPosition(self),
      SetWorldPosition: (self: Instance, p: Vector2) => setWorldPosition(self, p),
      LookAt: (self: Instance, target: Vector2) => {
        const w = worldPosition(self)
        self.set('Rotation', (Math.atan2(target.y - w.y, target.x - w.x) * 180) / Math.PI)
      },
      Translate: (self: Instance, delta: Vector2) => self.set('Position', self.get<Vector2>('Position').add(delta)),
    },
  })
  defineClass(Sprite2D, { name: 'Sprite2D', superclass: 'Node2D', category: '2D', props: { ...spriteProps } as any })
  defineClass(AnimatedSprite2D, {
    name: 'AnimatedSprite2D', superclass: 'Sprite2D', category: '2D',
    props: {
      Animation: { type: 'string', category: 'Animation' },
      Playing: { type: 'bool', default: () => true, category: 'Animation' },
      SpeedScale: { type: 'number', default: () => 1, category: 'Animation' },
    },
    methods: {
      Play: (self: Instance, name?: unknown) => {
        if (typeof name === 'string' && name !== self.get('Animation')) self.set('Animation', name)
        self.set('Playing', true)
      },
      Stop: (self: Instance) => { self.set('Playing', false) },
      GetAnimations: (self: Instance) => self.children.filter((c) => c.className === 'SpriteAnimation').map((c) => c.name),
    },
    events: ['AnimationFinished', 'FrameChanged'],
  })
  defineClass(SpriteAnimation, {
    name: 'SpriteAnimation', superclass: 'Instance', category: '2D',
    props: {
      Frames: { type: 'string', default: () => '0-3', category: 'Animation' },
      FPS: { type: 'number', default: () => 8, category: 'Animation' },
      Loop: { type: 'bool', default: () => true, category: 'Animation' },
    },
  })
  defineClass(TileMap, {
    name: 'TileMap', superclass: 'Node2D', category: '2D',
    props: {
      TileSet: { type: 'Content', content: 'image', category: 'Tiles' },
      TileSize: { type: 'Vector2', default: () => new Vector2(16, 16), category: 'Tiles' },
      SolidTiles: { type: 'string', default: () => 'all', category: 'Tiles' },
      Collision: { type: 'bool', default: () => true, category: 'Tiles' },
      Color: { type: 'Color3', default: () => new Color3(1, 1, 1), category: 'Appearance' },
      ScrollFactor: { type: 'Vector2', default: () => new Vector2(1, 1), category: 'Appearance' },
      Cells: {
        type: 'string', hidden: true, persist: true,
        get: (t: TileMap) => t.encodeCells(),
        set: (t: TileMap, v: string) => { t.decodeCells(v); t.changed('Cells') },
      },
    },
    methods: {
      SetCell: (self: TileMap, x: number, y: number, tile: unknown) => self.setCell(Number(x), Number(y), tile == null ? -1 : Number(tile)),
      GetCell: (self: TileMap, x: number, y: number) => self.getCell(Number(x), Number(y)),
      ClearCell: (self: TileMap, x: number, y: number) => self.setCell(Number(x), Number(y), -1),
      Clear: (self: TileMap) => { self.cells.clear(); self.changed('Cells') },
      GetUsedCells: (self: TileMap) => [...self.cells.keys()].map((k) => { const [x, y] = k.split(',').map(Number); return new Vector2(x, y) }),
      SetCellTerrain: (self: TileMap, x: number, y: number, terrain: unknown) => self.setCellTerrain(Number(x), Number(y), terrain == null ? null : String(terrain)),
    GetCellTerrain: (self: TileMap, x: number, y: number) => self.terrainAt(Number(x), Number(y))?.name ?? null,
    UpdateTerrain: (self: TileMap) => self.updateTerrain(),
    WorldToCell: (self: TileMap, p: Vector2) => {
        const l = apply(invert(worldXform(self)), p.x, p.y), ts = self.get<Vector2>('TileSize')
        return new Vector2(Math.floor(l.x / ts.x), Math.floor(l.y / ts.y))
      },
      CellToWorld: (self: TileMap, c: Vector2) => {
        const ts = self.get<Vector2>('TileSize')
        const w = apply(worldXform(self), (c.x + 0.5) * ts.x, (c.y + 0.5) * ts.y)
        return new Vector2(w.x, w.y)
      },
    },
  })
  defineClass(Camera2D, {
    name: 'Camera2D', superclass: 'Node2D', category: '2D',
    props: {
      Zoom: { type: 'number', default: () => 2, category: 'Camera' },
      Follow: { type: 'Instance', category: 'Camera' },
      Smoothing: { type: 'number', default: () => 0.15, category: 'Camera' },
      Offset: { type: 'Vector2', category: 'Camera' },
    },
    methods: {
      ScreenToWorld: (self: Instance, p: Vector2) => rt2d(self).screenToWorld2D(p),
      WorldToScreen: (self: Instance, p: Vector2) => rt2d(self).worldToScreen2D(p),
    },
  })
  defineClass(Text2D, {
    name: 'Text2D', superclass: 'Node2D', category: '2D',
    props: {
      Text: { type: 'string', default: () => 'Text', category: 'Text' },
      TextColor: { type: 'Color3', default: () => new Color3(1, 1, 1), category: 'Text' },
      TextSize: { type: 'number', default: () => 16, category: 'Text' },
      Font: { type: 'Enum.Font', default: () => enumItem('Font', 'GothamBold'), category: 'Text' },
      StrokeColor: { type: 'Color3', default: () => new Color3(0, 0, 0), category: 'Text' },
      StrokeThickness: { type: 'number', default: () => 2, category: 'Text' },
    },
  })
  defineClass(PhysicsBody2D, { name: 'PhysicsBody2D', superclass: 'Node2D', creatable: false, props: { ...bodyProps } as any, events: ['Touched', 'TouchEnded'] })
  defineClass(StaticBody2D, { name: 'StaticBody2D', superclass: 'PhysicsBody2D', category: '2D' })
  defineClass(RigidBody2D, {
    name: 'RigidBody2D', superclass: 'PhysicsBody2D', category: '2D',
    props: {
      Velocity: { type: 'Vector2', category: 'Physics' },
      AngularVelocity: { type: 'number', category: 'Physics' },
      GravityScale: { type: 'number', default: () => 1, category: 'Physics' },
      Density: { type: 'number', default: () => 1, category: 'Physics' },
      FixedRotation: { type: 'bool', category: 'Physics' },
      LinearDamping: { type: 'number', category: 'Physics' },
    },
    methods: { ApplyImpulse: (self: Instance, v: Vector2) => rt2d(self).applyImpulse2D(self, v) },
  })
  defineClass(CharacterBody2D, {
    name: 'CharacterBody2D', superclass: 'PhysicsBody2D', category: '2D',
    props: {
      Velocity: { type: 'Vector2', category: 'Physics' },
      UseGravity: { type: 'bool', default: () => true, category: 'Physics' },
      MaxStepHeight: { type: 'number', default: () => 4, category: 'Physics' },
    },
    methods: {
      MoveAndSlide: (self: Instance) => rt2d(self).moveAndSlide(self),
      IsOnFloor: (self: Instance) => rt2d(self).bodyState(self).floor,
      IsOnWall: (self: Instance) => rt2d(self).bodyState(self).wall,
      IsOnCeiling: (self: Instance) => rt2d(self).bodyState(self).ceiling,
    },
  })
  defineClass(ParticleEmitter2D, {
    name: 'ParticleEmitter2D', superclass: 'Node2D', category: '2D',
    props: emitterProps('2d'),
    methods: emitterMethods,
  })
  defineClass(Area2D, {
    name: 'Area2D', superclass: 'PhysicsBody2D', category: '2D',
    events: ['BodyEntered', 'BodyExited'],
  })
}
