// The built-in class library: Roblox-style Instances available to Luau scripts.
import { CFrame, Color3, UDim, UDim2, Vector2, Vector3, enumItem, EnumItem } from './datatypes'
import { register2DClasses } from './classes2d'
import { DEFAULT_SCREEN_SHADER_SOURCE, DEFAULT_SHADER_SOURCE } from './shaderDefaults'
import {
  DataModelLike, DataModelObserver, Instance, createInstance, defineClass, getClass, isA, setEnumResolver,
} from './instance'

setEnumResolver(enumItem)

/** Services the running game provides to class methods (physics, input, ...). Null in edit mode. */
export interface Runtime {
  raycast(origin: Vector3, direction: Vector3, params: Map<string, unknown> | null): Map<string, unknown> | null
  isKeyDown(key: EnumItem): boolean
  isMouseButtonPressed(t: EnumItem): boolean
  mouseLocation(): Vector2
  viewportSize(): Vector2
  worldToScreen(p: Vector3): [Vector3, boolean]
  screenPointToRay(x: number, y: number): [Vector3, Vector3]
  applyImpulse(part: Instance, impulse: Vector3): void
  getMass(part: Instance): number
  createTween(inst: Instance, info: TweenInfoData, goals: Map<string, unknown>): Instance
  tweenControl(tween: Instance, action: 'Play' | 'Pause' | 'Cancel'): void
  addDebris(inst: Instance, lifetime: number): void
  loadCharacter(player: Instance): void
  humanoidMove(h: Instance, dir: Vector3, relativeToCamera: boolean): void
  humanoidMoveTo(h: Instance, pos: Vector3): void
  humanoidJump(h: Instance): void
  soundControl(sound: Instance, action: 'Play' | 'Stop' | 'Pause' | 'Resume'): void
  animationControl(player: Instance, action: 'Play' | 'Stop' | 'Pause' | 'Resume' | 'Seek', arg?: unknown): void
  kick(player: Instance, message: string): void
  time(): number
}

export interface TweenInfoData {
  time: number; style: string; direction: string; repeatCount: number; reverses: boolean; delay: number
}

let activeRuntime: Runtime | null = null
/** The running game (used for instances that are not parented to a DataModel, e.g. Tweens). */
export function setActiveRuntime(r: Runtime | null) { activeRuntime = r }

function rt(self: Instance): Runtime {
  const r = (self.dataModel as DataModel | null)?.runtime ?? activeRuntime
  if (!r) throw new Error('This method can only be called while the game is running')
  return r
}

const str = (v: unknown) => (v == null ? '' : String(v))
const children = (self: Instance) => [...self.children]

// ---- Instance ---------------------------------------------------------------
class InstanceBase extends Instance {}
defineClass(InstanceBase, {
  name: 'Instance',
  creatable: false,
  props: {
    Name: { type: 'string', category: 'Data' },
    ClassName: { type: 'string', readonly: true, get: (i: Instance) => i.className, category: 'Data' },
    Parent: { type: 'Instance', get: (i: Instance) => i.parent, set: (i: Instance, v: Instance | null) => i.setParent(v), category: 'Data' },
    Archivable: { type: 'bool', default: () => true, category: 'Behavior' },
    Tags: { type: 'string', hidden: true },
  },
  methods: {
    Destroy: (self: Instance) => { self.destroy() },
    Remove: (self: Instance) => { self.setParent(null) },
    Clone: (self: Instance) => (self.get('Archivable') ? self.clone() : null),
    FindFirstChild: (self: Instance, name: unknown, recursive: unknown) => self.findFirstChild(str(name), !!recursive),
    FindFirstChildOfClass: (self: Instance, cls: unknown) => self.children.find((c) => c.className === cls) ?? null,
    FindFirstChildWhichIsA: (self: Instance, cls: unknown, recursive: unknown) => {
      const list = recursive ? self.getDescendants() : self.children
      return list.find((c) => c.isA(str(cls))) ?? null
    },
    FindFirstDescendant: (self: Instance, name: unknown) => self.getDescendants().find((c) => c.name === name) ?? null,
    FindFirstAncestor: (self: Instance, name: unknown) => {
      for (let p = self.parent; p; p = p.parent) if (p.name === name) return p
      return null
    },
    FindFirstAncestorOfClass: (self: Instance, cls: unknown) => {
      for (let p = self.parent; p; p = p.parent) if (p.className === cls) return p
      return null
    },
    FindFirstAncestorWhichIsA: (self: Instance, cls: unknown) => {
      for (let p = self.parent; p; p = p.parent) if (p.isA(str(cls))) return p
      return null
    },
    GetChildren: children,
    GetDescendants: (self: Instance) => self.getDescendants(),
    IsA: (self: Instance, cls: unknown) => self.isA(str(cls)),
    IsDescendantOf: (self: Instance, other: unknown) => other instanceof Instance && self.isDescendantOf(other),
    IsAncestorOf: (self: Instance, other: unknown) => other instanceof Instance && other.isDescendantOf(self),
    ClearAllChildren: (self: Instance) => { for (const c of [...self.children]) c.destroy() },
    GetFullName: (self: Instance) => self.getFullName(),
    GetAttribute: (self: Instance, name: unknown) => self.attributes.get(str(name)) ?? null,
    SetAttribute: (self: Instance, name: unknown, value: unknown) => {
      const key = str(name)
      if (value == null) self.attributes.delete(key)
      else self.attributes.set(key, value)
      self.fire('AttributeChanged', key)
      self.fire('AttributeChanged:' + key)
      self.dataModel?.notifyChanged(self, 'Attributes')
    },
    GetAttributes: (self: Instance) => new Map(self.attributes),
    GetTags: (self: Instance) => tagsOf(self),
    HasTag: (self: Instance, tag: unknown) => tagsOf(self).includes(str(tag)),
    AddTag: (self: Instance, tag: unknown) => addTag(self, str(tag)),
    RemoveTag: (self: Instance, tag: unknown) => removeTag(self, str(tag)),
  },
  events: ['ChildAdded', 'ChildRemoved', 'DescendantAdded', 'DescendantRemoving', 'AncestryChanged', 'Changed', 'AttributeChanged', 'Destroying'],
})

function tagsOf(i: Instance): string[] {
  const t = i.props.get('Tags') as string
  return t ? t.split(',').filter(Boolean) : []
}
function addTag(i: Instance, tag: string) {
  const t = tagsOf(i)
  if (!t.includes(tag)) { t.push(tag); i.set('Tags', t.join(',')) }
}
function removeTag(i: Instance, tag: string) {
  i.set('Tags', tagsOf(i).filter((x) => x !== tag).join(','))
}

// ---- DataModel ---------------------------------------------------------------
export const SERVICE_ORDER = ['Workspace', 'World2D', 'Players', 'Lighting', 'ScriptService', 'Storage', 'StarterGui', 'StarterPlayer', 'SoundService']
/**
 * RossEngine games run entirely on the player's machine, so there is no server/client split:
 * one Script class, scripts run in ScriptService, and Storage holds modules and templates.
 * Roblox names are accepted as aliases so familiar code (and older places) keep working.
 */
export const SERVICE_ALIASES: Record<string, string> = {
  ServerScriptService: 'ScriptService', ReplicatedStorage: 'Storage', ServerStorage: 'Storage',
  ReplicatedFirst: 'ScriptService',
}
// non-visible services, created on demand by GetService
const HIDDEN_SERVICES = ['RunService', 'UserInputService', 'TweenService', 'Debris', 'HttpService', 'CollectionService', 'ContextActionService']

export class DataModel extends Instance implements DataModelLike {
  observers = new Set<DataModelObserver>()
  runtime: Runtime | null = null
  constructor() {
    super()
    this.dataModel = this
    this.rawSet('Name', 'Game')
  }
  /** Create the standard set of services (used for new places). */
  initServices() {
    for (const s of SERVICE_ORDER) this.getService(s)
    const sp = this.getService('StarterPlayer')
    // migrate older places: StarterPlayerScripts -> ScriptService
    const sps = sp.findFirstChild('StarterPlayerScripts')
    if (sps) {
      for (const c of [...sps.children]) c.setParent(this.getService('ScriptService'))
      sps.destroy()
    }
    if (!sp.findFirstChild('StarterCharacterScripts')) createInstance('StarterCharacterScripts').setParent(sp)
    return this
  }
  getService(name: string): Instance {
    name = SERVICE_ALIASES[name] ?? name
    const existing = this.children.find((c) => c.className === name)
    if (existing) return existing
    const info = getClass(name)
    if (!info || !info.service) throw new Error(`'${name}' is not a valid Service name`)
    const s = new info.ctor()
    s.setParent(this)
    s.parentLocked = true
    if (HIDDEN_SERVICES.includes(name)) (s as any).transient = true
    return s
  }
  get workspace() { return this.getService('Workspace') as Workspace }
  notifyAdded(inst: Instance) { for (const o of this.observers) o.added?.(inst) }
  notifyRemoving(inst: Instance, oldParent: Instance | null) { for (const o of this.observers) o.removing?.(inst, oldParent) }
  notifyChanged(inst: Instance, prop: string) { for (const o of this.observers) o.changed?.(inst, prop) }
  notifyReparented(inst: Instance, oldParent: Instance | null) { for (const o of this.observers) o.reparented?.(inst, oldParent) }
  observe(o: DataModelObserver) { this.observers.add(o); return () => { this.observers.delete(o) } }
}
defineClass(DataModel, {
  name: 'DataModel', superclass: 'Instance', creatable: false,
  props: {
    PlaceId: { type: 'int', readonly: true, hidden: true },
    GameId: { type: 'int', readonly: true, hidden: true },
  },
  methods: {
    GetService: (self: DataModel, name: unknown) => self.getService(str(name)),
    FindService: (self: DataModel, name: unknown) => {
      const n = SERVICE_ALIASES[str(name)] ?? str(name)
      return self.children.find((c) => c.className === n) ?? null
    },
    IsLoaded: () => true,
  },
})

function service(name: string, props: Record<string, any> = {}, methods: Record<string, any> = {}, events: string[] = []) {
  class S extends Instance {}
  Object.defineProperty(S, 'name', { value: name })
  defineClass(S, { name, superclass: 'Instance', creatable: false, service: true, props, methods, events })
  return S
}

// ---- Workspace & Camera ------------------------------------------------------
export class Workspace extends Instance {}
defineClass(Workspace, {
  name: 'Workspace', superclass: 'Instance', creatable: false, service: true,
  props: {
    Gravity: { type: 'number', default: () => 196.2, category: 'Physics' },
    CurrentCamera: { type: 'Instance', noSave: true, category: 'Camera' },
    FallenPartsDestroyHeight: { type: 'number', default: () => -500, category: 'Physics' },
  },
  methods: {
    Raycast: (self: Instance, origin: Vector3, direction: Vector3, params: Map<string, unknown> | null) =>
      rt(self).raycast(origin, direction, params ?? null),
    GetServerTimeNow: (self: Instance) => rt(self).time(),
  },
})

class Camera extends Instance {}
defineClass(Camera, {
  name: 'Camera', superclass: 'Instance', category: 'World',
  props: {
    CFrame: { type: 'CFrame', default: () => CFrame.lookAt(new Vector3(0, 20, 30), new Vector3(0, 0, 0)), category: 'Data' },
    Focus: { type: 'CFrame', hidden: true },
    FieldOfView: { type: 'number', default: () => 70, category: 'Data' },
    CameraType: { type: 'Enum.CameraType', default: () => enumItem('CameraType', 'Custom'), category: 'Camera' },
    CameraSubject: { type: 'Instance', noSave: true, category: 'Camera' },
    ViewportSize: { type: 'Vector2', readonly: true, noSave: true, get: (i: Instance) => (i.dataModel as DataModel)?.runtime?.viewportSize() ?? new Vector2(1280, 720) },
  },
  methods: {
    WorldToScreenPoint: (self: Instance, p: Vector3) => multi(...rt(self).worldToScreen(p)),
    WorldToViewportPoint: (self: Instance, p: Vector3) => multi(...rt(self).worldToScreen(p)),
    ScreenPointToRay: (self: Instance, x: number, y: number) => ray(...rt(self).screenPointToRay(x, y)),
    ViewportPointToRay: (self: Instance, x: number, y: number) => ray(...rt(self).screenPointToRay(x, y)),
  },
})

/** Marker for returning multiple values to Luau. */
export class Multi { constructor(public values: unknown[]) {} }
export const multi = (...values: unknown[]) => new Multi(values)
const ray = (origin: Vector3, direction: Vector3) => new Map<string, unknown>([['Origin', origin], ['Direction', direction]])

// ---- Containers --------------------------------------------------------------
class Folder extends Instance {}
defineClass(Folder, { name: 'Folder', superclass: 'Instance', category: 'Containers' })

export class PVInstance extends Instance {}
defineClass(PVInstance, { name: 'PVInstance', superclass: 'Instance', creatable: false })

export function partsOf(inst: Instance): BasePart[] {
  const out: BasePart[] = []
  if (inst instanceof BasePart) out.push(inst)
  for (const d of inst.getDescendants()) if (d instanceof BasePart) out.push(d)
  return out
}

export function boundingBox(parts: BasePart[]): { cframe: CFrame; size: Vector3 } {
  if (!parts.length) return { cframe: CFrame.identity, size: Vector3.zero }
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (const p of parts) {
    const cf = p.cframe, s = p.size
    for (const sx of [-0.5, 0.5]) for (const sy of [-0.5, 0.5]) for (const sz of [-0.5, 0.5]) {
      const w = cf.pointToWorld(new Vector3(s.x * sx, s.y * sy, s.z * sz))
      const c = [w.x, w.y, w.z]
      for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], c[i]); max[i] = Math.max(max[i], c[i]) }
    }
  }
  return {
    cframe: CFrame.fromPosition(new Vector3((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2)),
    size: new Vector3(max[0] - min[0], max[1] - min[1], max[2] - min[2]),
  }
}

export class Model extends PVInstance {
  getPivot(): CFrame {
    const pp = this.get<Instance | null>('PrimaryPart')
    if (pp instanceof BasePart) return pp.cframe
    return boundingBox(partsOf(this)).cframe
  }
  pivotTo(cf: CFrame) {
    const delta = cf.mul(this.getPivot().inverse())
    for (const p of partsOf(this)) p.set('CFrame', delta.mul(p.cframe))
  }
}
defineClass(Model, {
  name: 'Model', superclass: 'PVInstance', category: 'Containers',
  props: { PrimaryPart: { type: 'Instance', category: 'Data' } },
  methods: {
    GetPivot: (self: Model) => self.getPivot(),
    PivotTo: (self: Model, cf: CFrame) => self.pivotTo(cf),
    SetPrimaryPartCFrame: (self: Model, cf: CFrame) => self.pivotTo(cf),
    GetPrimaryPartCFrame: (self: Model) => self.getPivot(),
    MoveTo: (self: Model, pos: Vector3) => {
      const bb = boundingBox(partsOf(self))
      const piv = self.getPivot()
      const offset = piv.position.sub(bb.cframe.position)
      self.pivotTo(piv.withPosition(pos.add(new Vector3(offset.x, bb.size.y / 2 + offset.y, offset.z))))
    },
    GetBoundingBox: (self: Model) => { const b = boundingBox(partsOf(self)); return multi(b.cframe, b.size) },
    GetExtentsSize: (self: Model) => boundingBox(partsOf(self)).size,
  },
})

// ---- Parts -----------------------------------------------------------------
export class BasePart extends PVInstance {
  get cframe() { return this.props.get('CFrame') as CFrame }
  get size() { return this.props.get('Size') as Vector3 }
  protected override onPropChanged(prop: string) {
    if (prop === 'CFrame') { this.changed('Position'); this.changed('Orientation') }
  }
}
defineClass(BasePart, {
  name: 'BasePart', superclass: 'PVInstance', creatable: false,
  props: {
    CFrame: { type: 'CFrame', hidden: true, category: 'Transform' },
    Position: {
      type: 'Vector3', category: 'Transform',
      get: (p: BasePart) => p.cframe.position,
      set: (p: BasePart, v: Vector3) => p.set('CFrame', p.cframe.withPosition(v)),
    },
    Orientation: {
      type: 'Vector3', category: 'Transform',
      get: (p: BasePart) => p.cframe.toOrientation(),
      set: (p: BasePart, v: Vector3) => p.set('CFrame', CFrame.fromOrientation(p.cframe.position, v)),
    },
    Size: { type: 'Vector3', default: () => new Vector3(4, 1, 2), category: 'Transform' },
    Color: { type: 'Color3', default: () => Color3.fromRGB(163, 162, 165), category: 'Appearance' },
    BrickColor: { type: 'string', hidden: true, noSave: true, get: (p: BasePart) => (p.get('Color') as Color3).toHex(), set: () => {} },
    Material: { type: 'Enum.Material', default: () => enumItem('Material', 'Plastic'), category: 'Appearance' },
    Transparency: { type: 'number', category: 'Appearance' },
    Reflectance: { type: 'number', category: 'Appearance' },
    CastShadow: { type: 'bool', default: () => true, category: 'Appearance' },
    Anchored: { type: 'bool', category: 'Behavior' },
    CanCollide: { type: 'bool', default: () => true, category: 'Behavior' },
    CanTouch: { type: 'bool', default: () => true, category: 'Behavior' },
    CanQuery: { type: 'bool', default: () => true, category: 'Behavior' },
    Locked: { type: 'bool', category: 'Behavior' },
    Massless: { type: 'bool', category: 'Physics' },
    AssemblyLinearVelocity: { type: 'Vector3', category: 'Physics' },
    AssemblyAngularVelocity: { type: 'Vector3', category: 'Physics' },
    Velocity: {
      type: 'Vector3', hidden: true,
      get: (p: BasePart) => p.get('AssemblyLinearVelocity'),
      set: (p: BasePart, v: Vector3) => p.set('AssemblyLinearVelocity', v),
    },
  },
  methods: {
    GetMass: (self: BasePart) => rt(self).getMass(self),
    ApplyImpulse: (self: BasePart, v: Vector3) => rt(self).applyImpulse(self, v),
    GetPivot: (self: BasePart) => self.cframe,
    PivotTo: (self: BasePart, cf: CFrame) => self.set('CFrame', cf),
  },
  events: ['Touched', 'TouchEnded'],
})

export class Part extends BasePart {}
defineClass(Part, {
  name: 'Part', superclass: 'BasePart', category: 'Parts',
  props: { Shape: { type: 'Enum.PartType', default: () => enumItem('PartType', 'Block'), category: 'Appearance' } },
})
export class MeshPart extends BasePart {}
defineClass(MeshPart, {
  name: 'MeshPart', superclass: 'BasePart', category: 'Parts',
  props: {
    MeshId: { type: 'Content', content: 'mesh', category: 'Appearance' },
    TextureID: { type: 'Content', content: 'image', category: 'Appearance' },
    CollisionFidelity: { type: 'Enum.CollisionFidelity', default: () => enumItem('CollisionFidelity', 'Box'), category: 'Physics' },
    Size: { type: 'Vector3', default: () => new Vector3(4, 4, 4), category: 'Transform' },
  },
})

/** An image stuck on one face of its parent part. */
class Decal extends Instance {}
defineClass(Decal, {
  name: 'Decal', superclass: 'Instance', category: 'Appearance',
  props: {
    Texture: { type: 'Content', content: 'image', category: 'Appearance' },
    Face: { type: 'Enum.NormalId', default: () => enumItem('NormalId', 'Front'), category: 'Appearance' },
    Color3: { type: 'Color3', default: () => new Color3(1, 1, 1), category: 'Appearance' },
    Transparency: { type: 'number', category: 'Appearance' },
  },
})

/**
 * Custom GLSL for the object it's inside (a 3D part, or a 2D sprite / tile map / text). Source holds
 * `vec4 fragment()` and optionally `vec3 vertex()`; the shader's attributes become uniforms.
 */
export class Shader extends Instance {}
defineClass(Shader, {
  name: 'Shader', superclass: 'Instance', category: 'Rendering',
  props: {
    Source: { type: 'string', hidden: true, default: () => DEFAULT_SHADER_SOURCE },
    /** visual steps (JSON); when set, Source is generated from it */
    Recipe: { type: 'string', hidden: true },
    Enabled: { type: 'bool', default: () => true, category: 'Shader' },
    Transparent: { type: 'bool', category: 'Shader' },
  },
})
/** Post-processing over the whole screen. Goes in Lighting (3D) or World2D (2D); several run in order. */
export class ScreenShader extends Instance {}
defineClass(ScreenShader, {
  name: 'ScreenShader', superclass: 'Instance', category: 'Rendering',
  props: {
    Source: { type: 'string', hidden: true, default: () => DEFAULT_SCREEN_SHADER_SOURCE },
    Recipe: { type: 'string', hidden: true },
    Enabled: { type: 'bool', default: () => true, category: 'Shader' },
  },
})

class WedgePart extends BasePart {}
defineClass(WedgePart, { name: 'WedgePart', superclass: 'BasePart', category: 'Parts' })
class SpawnLocation extends Part {}
defineClass(SpawnLocation, {
  name: 'SpawnLocation', superclass: 'Part', category: 'Parts',
  props: { Neutral: { type: 'bool', default: () => true, category: 'Data' }, Enabled: { type: 'bool', default: () => true, category: 'Data' } },
})

class WeldConstraint extends Instance {}
defineClass(WeldConstraint, {
  name: 'WeldConstraint', superclass: 'Instance', category: 'Constraints',
  props: {
    Part0: { type: 'Instance', category: 'Data' },
    Part1: { type: 'Instance', category: 'Data' },
    Enabled: { type: 'bool', default: () => true, category: 'Data' },
  },
})

// ---- Lights / effects --------------------------------------------------------
class Light extends Instance {}
defineClass(Light, {
  name: 'Light', superclass: 'Instance', creatable: false,
  props: {
    Enabled: { type: 'bool', default: () => true, category: 'Data' },
    Brightness: { type: 'number', default: () => 1, category: 'Data' },
    Color: { type: 'Color3', default: () => new Color3(1, 1, 1), category: 'Data' },
    Range: { type: 'number', default: () => 16, category: 'Data' },
    Shadows: { type: 'bool', category: 'Data' },
  },
})
class PointLight extends Light {}
defineClass(PointLight, { name: 'PointLight', superclass: 'Light', category: 'Lights' })
class SpotLight extends Light {}
defineClass(SpotLight, {
  name: 'SpotLight', superclass: 'Light', category: 'Lights',
  props: { Angle: { type: 'number', default: () => 90, category: 'Data' }, Face: { type: 'Enum.NormalId', default: () => enumItem('NormalId', 'Front'), category: 'Data' } },
})

class Sound extends Instance {}
defineClass(Sound, {
  name: 'Sound', superclass: 'Instance', category: 'Sound',
  props: {
    SoundId: { type: 'Content', content: 'audio', category: 'Data' },
    Volume: { type: 'number', default: () => 0.5, category: 'Data' },
    PlaybackSpeed: { type: 'number', default: () => 1, category: 'Data' },
    Looped: { type: 'bool', category: 'Data' },
    Playing: { type: 'bool', noSave: true, category: 'Data' },
    PlayOnRemove: { type: 'bool', category: 'Data' },
    TimePosition: { type: 'number', noSave: true, hidden: true },
  },
  methods: {
    Play: (self: Instance) => rt(self).soundControl(self, 'Play'),
    Stop: (self: Instance) => rt(self).soundControl(self, 'Stop'),
    Pause: (self: Instance) => rt(self).soundControl(self, 'Pause'),
    Resume: (self: Instance) => rt(self).soundControl(self, 'Resume'),
  },
  events: ['Ended', 'Played'],
})

// ---- Rigs --------------------------------------------------------------------
/** The rig of an imported skinned MeshPart: a tree of Bones mirroring the model's skeleton. */
export class Skeleton extends Instance {}
defineClass(Skeleton, {
  name: 'Skeleton', superclass: 'Instance', category: 'Animation',
  props: { ShowBones: { type: 'bool', category: 'Appearance' } },
})
/**
 * One bone of a Skeleton. CFrame is its rest pose relative to its parent bone (in the model's own
 * units) and Scale its rest size; Transform (an extra offset) and PoseScale (a size multiplier) go on
 * top, and are what animations change (identity / 1,1,1 = the rest pose).
 */
export class Bone extends Instance {}
defineClass(Bone, {
  name: 'Bone', superclass: 'Instance', category: 'Animation',
  props: {
    CFrame: { type: 'CFrame', default: () => CFrame.identity, category: 'Rest pose' },
    Position: {
      type: 'Vector3', category: 'Rest pose',
      get: (b: Instance) => b.get<CFrame>('CFrame').position,
      set: (b: Instance, v: Vector3) => b.set('CFrame', b.get<CFrame>('CFrame').withPosition(v)),
    },
    Orientation: {
      type: 'Vector3', category: 'Rest pose',
      get: (b: Instance) => b.get<CFrame>('CFrame').toOrientation(),
      set: (b: Instance, v: Vector3) => b.set('CFrame', CFrame.fromOrientation(b.get<CFrame>('CFrame').position, v)),
    },
    Scale: { type: 'Vector3', default: () => new Vector3(1, 1, 1), category: 'Rest pose' },
    Transform: { type: 'CFrame', default: () => CFrame.identity, category: 'Pose' },
    PoseOffset: {
      type: 'Vector3', category: 'Pose',
      get: (b: Instance) => b.get<CFrame>('Transform').position,
      set: (b: Instance, v: Vector3) => b.set('Transform', b.get<CFrame>('Transform').withPosition(v)),
    },
    PoseRotation: {
      type: 'Vector3', category: 'Pose',
      get: (b: Instance) => b.get<CFrame>('Transform').toOrientation(),
      set: (b: Instance, v: Vector3) => b.set('Transform', CFrame.fromOrientation(b.get<CFrame>('Transform').position, v)),
    },
    /** multiplies Scale (1, 1, 1 = rest size); animatable */
    PoseScale: { type: 'Vector3', default: () => new Vector3(1, 1, 1), category: 'Pose' },
  },
})

// ---- Animation ---------------------------------------------------------------
/** Keyframes for any properties of the AnimationPlayer's parent and the objects inside it. */
export class Animation extends Instance {}
defineClass(Animation, {
  name: 'Animation', superclass: 'Instance', category: 'Animation',
  props: {
    Length: { type: 'number', default: () => 2, category: 'Animation' },
    Looped: { type: 'bool', category: 'Animation' },
    /** keyframe tracks (JSON), edited in the Animation editor */
    Tracks: { type: 'string', hidden: true },
  },
})
/** Plays the Animations inside it on its parent (a part, model, 2D node or anything else). */
export class AnimationPlayer extends Instance {}
defineClass(AnimationPlayer, {
  name: 'AnimationPlayer', superclass: 'Instance', category: 'Animation',
  props: {
    Autoplay: { type: 'string', category: 'Animation' },
    Speed: { type: 'number', default: () => 1, category: 'Animation' },
    Playing: { type: 'bool', noSave: true, readonly: true, category: 'Animation' },
    CurrentAnimation: { type: 'string', noSave: true, category: 'Animation' },
    TimePosition: { type: 'number', noSave: true, readonly: true, category: 'Animation' },
  },
  methods: {
    Play: (self: Instance, name?: unknown) => rt(self).animationControl(self, 'Play', name == null ? null : String(name)),
    Stop: (self: Instance) => rt(self).animationControl(self, 'Stop'),
    Pause: (self: Instance) => rt(self).animationControl(self, 'Pause'),
    Resume: (self: Instance) => rt(self).animationControl(self, 'Resume'),
    Seek: (self: Instance, time: unknown) => rt(self).animationControl(self, 'Seek', Number(time)),
    GetAnimation: (self: Instance, name: unknown) => self.children.find((c) => c.className === 'Animation' && c.name === String(name)) ?? null,
    GetAnimations: (self: Instance) => self.children.filter((c) => c.className === 'Animation'),
  },
  events: ['Played', 'Stopped', 'Ended'],
})

// ---- Scripts -----------------------------------------------------------------
export class LuaSourceContainer extends Instance {}
defineClass(LuaSourceContainer, {
  name: 'LuaSourceContainer', superclass: 'Instance', creatable: false,
  props: {
    Source: { type: 'string', hidden: true },
    Language: { type: 'Enum.ScriptLanguage', default: () => enumItem('ScriptLanguage', 'Luau'), category: 'Behavior' },
  },
})
export class BaseScript extends LuaSourceContainer {}
defineClass(BaseScript, {
  name: 'BaseScript', superclass: 'LuaSourceContainer', creatable: false,
  props: {
    Enabled: { type: 'bool', default: () => true, category: 'Behavior' },
    Disabled: { type: 'bool', hidden: true, noSave: true, get: (s: Instance) => !s.get('Enabled'), set: (s: Instance, v: boolean) => s.set('Enabled', !v) },
  },
})
export class Script extends BaseScript {}
defineClass(Script, {
  name: 'Script', superclass: 'BaseScript', category: 'Scripts',
  props: { Source: { type: 'string', hidden: true, default: () => 'print("Hello world!")\n' } },
})
export class ModuleScript extends LuaSourceContainer {}
defineClass(ModuleScript, {
  name: 'ModuleScript', superclass: 'LuaSourceContainer', category: 'Scripts',
  props: { Source: { type: 'string', hidden: true, default: () => 'local module = {}\n\nreturn module\n' } },
})

// ---- Values & communication ----------------------------------------------------
function valueClass(name: string, type: any, def?: () => unknown) {
  class V extends Instance {}
  Object.defineProperty(V, 'name', { value: name })
  defineClass(V, { name, superclass: 'ValueBase', category: 'Values', props: { Value: { type, default: def, category: 'Data' } } })
}
class ValueBase extends Instance {}
defineClass(ValueBase, { name: 'ValueBase', superclass: 'Instance', creatable: false })
valueClass('StringValue', 'string')
valueClass('NumberValue', 'number')
valueClass('IntValue', 'int')
valueClass('BoolValue', 'bool')
valueClass('Vector3Value', 'Vector3')
valueClass('CFrameValue', 'CFrame')
valueClass('Color3Value', 'Color3')
valueClass('ObjectValue', 'Instance')

// These are implemented mostly on the Luau side (see prelude) so arbitrary Luau values pass through.
for (const [name, events] of [
  ['BindableEvent', ['Event']], ['BindableFunction', []],
] as const) {
  class C extends Instance {}
  Object.defineProperty(C, 'name', { value: name })
  defineClass(C, {
    name, superclass: 'Instance', category: 'Communication', events: [...events],
    // Fire goes through the engine, so listeners in every language (Luau, TypeScript, Python) receive it
    methods: name === 'BindableEvent' ? { Fire: (self: Instance, ...args: unknown[]) => { self.fire('Event', ...args) } } : {},
  })
}

class ClickDetector extends Instance {}
defineClass(ClickDetector, {
  name: 'ClickDetector', superclass: 'Instance', category: 'Interaction',
  props: { MaxActivationDistance: { type: 'number', default: () => 32, category: 'Data' } },
  events: ['MouseClick', 'RightMouseClick', 'MouseHoverEnter', 'MouseHoverLeave'],
})

// ---- Players / characters ----------------------------------------------------
service('Players', {
  LocalPlayer: { type: 'Instance', readonly: true, noSave: true },
  MaxPlayers: { type: 'int', default: () => 1 },
  CharacterAutoLoads: { type: 'bool', default: () => true },
}, {
  GetPlayers: (self: Instance) => self.children.filter((c) => c.className === 'Player'),
  GetPlayerFromCharacter: (self: Instance, ch: unknown) => self.children.find((p) => p.get('Character') === ch) ?? null,
  GetPlayerByUserId: (self: Instance, id: unknown) => self.children.find((p) => p.get('UserId') === id) ?? null,
}, ['PlayerAdded', 'PlayerRemoving'])

class Player extends Instance {}
defineClass(Player, {
  name: 'Player', superclass: 'Instance', creatable: false,
  props: {
    UserId: { type: 'int', readonly: true },
    DisplayName: { type: 'string' },
    Character: { type: 'Instance', noSave: true },
    RespawnLocation: { type: 'Instance', noSave: true },
  },
  methods: {
    LoadCharacter: (self: Instance) => rt(self).loadCharacter(self),
    Kick: (self: Instance, msg: unknown) => rt(self).kick(self, str(msg)),
    GetMouse: (self: Instance) => self.findFirstChild('__Mouse') ?? null,
  },
  events: ['CharacterAdded', 'CharacterRemoving', 'Chatted'],
})
class Mouse extends Instance {}
defineClass(Mouse, {
  name: 'Mouse', superclass: 'Instance', creatable: false,
  props: {
    Hit: { type: 'CFrame', readonly: true, noSave: true },
    Target: { type: 'Instance', readonly: true, noSave: true },
    X: { type: 'number', readonly: true, noSave: true },
    Y: { type: 'number', readonly: true, noSave: true },
    Icon: { type: 'string', noSave: true },
  },
  events: ['Button1Down', 'Button1Up', 'Button2Down', 'Button2Up', 'Move', 'WheelForward', 'WheelBackward', 'KeyDown', 'KeyUp'],
})
for (const name of ['PlayerGui']) {
  class C extends Instance {}
  Object.defineProperty(C, 'name', { value: name })
  defineClass(C, { name, superclass: 'Instance', creatable: false })
}

export class Humanoid extends Instance {
  dead = false
  protected override onPropChanged(prop: string, old: unknown) {
    if (prop === 'Health') {
      const max = this.get<number>('MaxHealth')
      const h = this.get<number>('Health')
      if (h > max) { this.props.set('Health', max) }
      if (h !== old) this.fire('HealthChanged', this.get('Health'))
      if (h <= 0 && !this.dead) {
        this.dead = true
        this.fire('Died')
      }
    }
  }
}
defineClass(Humanoid, {
  name: 'Humanoid', superclass: 'Instance', category: 'Characters',
  props: {
    Health: { type: 'number', default: () => 100, category: 'Game' },
    MaxHealth: { type: 'number', default: () => 100, category: 'Game' },
    WalkSpeed: { type: 'number', default: () => 16, category: 'Game' },
    JumpPower: { type: 'number', default: () => 50, category: 'Game' },
    HipHeight: { type: 'number', default: () => 2, category: 'Game' },
    AutoRotate: { type: 'bool', default: () => true, category: 'Game' },
    DisplayName: { type: 'string', category: 'Data' },
    MoveDirection: { type: 'Vector3', readonly: true, noSave: true },
    Jump: { type: 'bool', noSave: true },
    FloorMaterial: { type: 'Enum.Material', readonly: true, noSave: true },
    RootPart: { type: 'Instance', readonly: true, noSave: true, get: (h: Instance) => h.parent?.findFirstChild('HumanoidRootPart') ?? null },
  },
  methods: {
    TakeDamage: (self: Humanoid, amount: unknown) => {
      if (self.parent?.findFirstChildOfClass('ForceField')) return
      self.set('Health', Math.max(0, self.get<number>('Health') - Number(amount)))
    },
    Move: (self: Instance, dir: Vector3, rel: unknown) => rt(self).humanoidMove(self, dir, !!rel),
    MoveTo: (self: Instance, pos: Vector3) => rt(self).humanoidMoveTo(self, pos),
    GetState: (self: Humanoid) => enumItem('HumanoidStateType', self.dead ? 'Dead' : 'Running'),
  },
  events: ['Died', 'HealthChanged', 'Jumping', 'Running', 'FreeFalling', 'StateChanged', 'MoveToFinished', 'Touched'],
})
class ForceField extends Instance {}
defineClass(ForceField, { name: 'ForceField', superclass: 'Instance', category: 'Characters', props: { Visible: { type: 'bool', default: () => true } } })

// ---- Services ----------------------------------------------------------------
service('Lighting', {
  ClockTime: { type: 'number', default: () => 14, category: 'Appearance' },
  Brightness: { type: 'number', default: () => 2, category: 'Appearance' },
  Ambient: { type: 'Color3', default: () => Color3.fromRGB(70, 70, 70), category: 'Appearance' },
  OutdoorAmbient: { type: 'Color3', default: () => Color3.fromRGB(128, 128, 128), category: 'Appearance' },
  FogColor: { type: 'Color3', default: () => Color3.fromRGB(192, 192, 192), category: 'Fog' },
  FogStart: { type: 'number', default: () => 0, category: 'Fog' },
  FogEnd: { type: 'number', default: () => 100000, category: 'Fog' },
  GlobalShadows: { type: 'bool', default: () => true, category: 'Appearance' },
}, {
  GetMinutesAfterMidnight: (self: Instance) => self.get<number>('ClockTime') * 60,
  SetMinutesAfterMidnight: (self: Instance, m: unknown) => self.set('ClockTime', (Number(m) / 60) % 24),
})
service('ScriptService')
service('Storage')
service('StarterGui')
service('SoundService')
service('StarterPlayer', {
  CharacterWalkSpeed: { type: 'number', default: () => 16, category: 'Character' },
  CharacterJumpPower: { type: 'number', default: () => 50, category: 'Character' },
  CameraMaxZoomDistance: { type: 'number', default: () => 128, category: 'Camera' },
  CameraMinZoomDistance: { type: 'number', default: () => 0.5, category: 'Camera' },
})
for (const name of ['StarterCharacterScripts']) {
  class C extends Instance {}
  Object.defineProperty(C, 'name', { value: name })
  defineClass(C, { name, superclass: 'Instance', creatable: false })
}
service('RunService', {}, {
  IsStudio: () => false, IsRunning: () => true,
  IsRunMode: () => false, IsEdit: () => false,
}, ['Heartbeat', 'RenderStepped', 'Stepped', 'PreSimulation', 'PostSimulation'])
service('UserInputService', {
  MouseEnabled: { type: 'bool', default: () => true, readonly: true },
  KeyboardEnabled: { type: 'bool', default: () => true, readonly: true },
  TouchEnabled: { type: 'bool', readonly: true },
  MouseIconEnabled: { type: 'bool', default: () => true },
}, {
  IsKeyDown: (self: Instance, k: EnumItem) => rt(self).isKeyDown(k),
  IsMouseButtonPressed: (self: Instance, t: EnumItem) => rt(self).isMouseButtonPressed(t),
  GetMouseLocation: (self: Instance) => rt(self).mouseLocation(),
}, ['InputBegan', 'InputEnded', 'InputChanged', 'JumpRequest'])
service('ContextActionService')
service('TweenService', {}, {
  Create: (self: Instance, inst: Instance, info: TweenInfoData, goals: Map<string, unknown>) => {
    if (!(inst instanceof Instance)) throw new Error('TweenService:Create expects an Instance')
    return rt(self).createTween(inst, info, goals)
  },
})
class Tween extends Instance {}
defineClass(Tween, {
  name: 'Tween', superclass: 'Instance', creatable: false,
  props: {
    PlaybackState: { type: 'string', readonly: true, noSave: true, default: () => 'Begin' },
    Instance: { type: 'Instance', readonly: true, noSave: true },
  },
  methods: {
    Play: (self: Instance) => rt(self).tweenControl(self, 'Play'),
    Pause: (self: Instance) => rt(self).tweenControl(self, 'Pause'),
    Cancel: (self: Instance) => rt(self).tweenControl(self, 'Cancel'),
  },
  events: ['Completed'],
})
service('Debris', {}, {
  AddItem: (self: Instance, inst: Instance, t: unknown) => rt(self).addDebris(inst, t == null ? 10 : Number(t)),
})
service('HttpService', {}, {
  GenerateGUID: (_self: Instance, braces: unknown) => {
    const g = crypto.randomUUID().toUpperCase()
    return braces === false ? g : `{${g}}`
  },
  JSONEncode: (_self: Instance, v: unknown) => JSON.stringify(toJSON(v)),
  JSONDecode: (_self: Instance, s: unknown) => fromJSON(JSON.parse(str(s))),
})
service('CollectionService', {}, {
  AddTag: (_s: Instance, i: Instance, tag: unknown) => addTag(i, str(tag)),
  RemoveTag: (_s: Instance, i: Instance, tag: unknown) => removeTag(i, str(tag)),
  HasTag: (_s: Instance, i: Instance, tag: unknown) => tagsOf(i).includes(str(tag)),
  GetTags: (_s: Instance, i: Instance) => tagsOf(i),
  GetTagged: (self: Instance, tag: unknown) => (self.dataModel ? self.dataModel.getDescendants().filter((d) => tagsOf(d).includes(str(tag))) : []),
})

function toJSON(v: unknown): unknown {
  if (v instanceof Map) {
    const keys = [...v.keys()]
    if (keys.length && keys.every((k, i) => k === i + 1)) return [...v.values()].map(toJSON)
    const o: Record<string, unknown> = {}
    for (const [k, val] of v) o[String(k)] = toJSON(val)
    return o
  }
  if (Array.isArray(v)) return v.map(toJSON)
  if (v instanceof Instance) throw new Error('Cannot JSONEncode an Instance')
  return v
}
function fromJSON(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(fromJSON)
  if (v && typeof v === 'object') {
    const m = new Map<string, unknown>()
    for (const [k, val] of Object.entries(v)) m.set(k, fromJSON(val))
    return m
  }
  return v
}

// ---- Input -------------------------------------------------------------------
class InputObject extends Instance {}
defineClass(InputObject, {
  name: 'InputObject', superclass: 'Instance', creatable: false,
  props: {
    KeyCode: { type: 'Enum.KeyCode', default: () => enumItem('KeyCode', 'Unknown') },
    UserInputType: { type: 'Enum.UserInputType', default: () => enumItem('UserInputType', 'None') },
    UserInputState: { type: 'Enum.UserInputState', default: () => enumItem('UserInputState', 'None') },
    Position: { type: 'Vector3' },
    Delta: { type: 'Vector3' },
  },
})

// ---- GUI -----------------------------------------------------------------------
class LayerCollector extends Instance {}
defineClass(LayerCollector, { name: 'LayerCollector', superclass: 'Instance', creatable: false })
class ScreenGui extends LayerCollector {}
defineClass(ScreenGui, {
  name: 'ScreenGui', superclass: 'LayerCollector', category: 'GUI',
  props: {
    Enabled: { type: 'bool', default: () => true, category: 'Behavior' },
    DisplayOrder: { type: 'int', category: 'Behavior' },
    ResetOnSpawn: { type: 'bool', default: () => true, category: 'Behavior' },
    IgnoreGuiInset: { type: 'bool', category: 'Behavior' },
  },
})
export class GuiObject extends Instance {}
defineClass(GuiObject, {
  name: 'GuiObject', superclass: 'Instance', creatable: false,
  props: {
    Position: { type: 'UDim2', category: 'Layout' },
    Size: { type: 'UDim2', default: () => new UDim2(0, 100, 0, 100), category: 'Layout' },
    AnchorPoint: { type: 'Vector2', category: 'Layout' },
    Rotation: { type: 'number', category: 'Layout' },
    ZIndex: { type: 'int', default: () => 1, category: 'Layout' },
    LayoutOrder: { type: 'int', category: 'Layout' },
    BackgroundColor3: { type: 'Color3', default: () => Color3.fromRGB(255, 255, 255), category: 'Appearance' },
    BackgroundTransparency: { type: 'number', category: 'Appearance' },
    BorderSizePixel: { type: 'int', default: () => 0, category: 'Appearance' },
    BorderColor3: { type: 'Color3', default: () => Color3.fromRGB(27, 42, 53), category: 'Appearance' },
    Visible: { type: 'bool', default: () => true, category: 'Appearance' },
    ClipsDescendants: { type: 'bool', category: 'Appearance' },
    AbsolutePosition: { type: 'Vector2', readonly: true, noSave: true, hidden: true },
    AbsoluteSize: { type: 'Vector2', readonly: true, noSave: true, hidden: true },
  },
  events: ['MouseEnter', 'MouseLeave', 'InputBegan', 'InputEnded'],
})
class Frame extends GuiObject {}
defineClass(Frame, { name: 'Frame', superclass: 'GuiObject', category: 'GUI' })
const textProps = {
  Text: { type: 'string', default: () => 'Label', category: 'Text' },
  TextColor3: { type: 'Color3', default: () => Color3.fromRGB(0, 0, 0), category: 'Text' },
  TextSize: { type: 'number', default: () => 14, category: 'Text' },
  TextScaled: { type: 'bool', category: 'Text' },
  TextWrapped: { type: 'bool', category: 'Text' },
  TextTransparency: { type: 'number', category: 'Text' },
  TextStrokeTransparency: { type: 'number', default: () => 1, category: 'Text' },
  TextStrokeColor3: { type: 'Color3', default: () => Color3.fromRGB(0, 0, 0), category: 'Text' },
  Font: { type: 'Enum.Font', default: () => enumItem('Font', 'SourceSans'), category: 'Text' },
  TextXAlignment: { type: 'Enum.TextXAlignment', default: () => enumItem('TextXAlignment', 'Center'), category: 'Text' },
  TextYAlignment: { type: 'Enum.TextYAlignment', default: () => enumItem('TextYAlignment', 'Center'), category: 'Text' },
} as const
class TextLabel extends GuiObject {}
defineClass(TextLabel, { name: 'TextLabel', superclass: 'GuiObject', category: 'GUI', props: { ...textProps } as any })
class GuiButton extends GuiObject {}
defineClass(GuiButton, {
  name: 'GuiButton', superclass: 'GuiObject', creatable: false,
  props: { AutoButtonColor: { type: 'bool', default: () => true, category: 'Behavior' } },
  events: ['MouseButton1Click', 'MouseButton1Down', 'MouseButton1Up', 'MouseButton2Click', 'Activated'],
})
class TextButton extends GuiButton {}
defineClass(TextButton, { name: 'TextButton', superclass: 'GuiButton', category: 'GUI', props: { ...textProps, Text: { type: 'string', default: () => 'Button', category: 'Text' } } as any })
class TextBox extends GuiObject {}
defineClass(TextBox, {
  name: 'TextBox', superclass: 'GuiObject', category: 'GUI',
  props: {
    ...textProps, Text: { type: 'string', default: () => '', category: 'Text' },
    PlaceholderText: { type: 'string', category: 'Text' },
    ClearTextOnFocus: { type: 'bool', default: () => true, category: 'Behavior' },
  } as any,
  events: ['FocusLost', 'Focused'],
})
const imageProps = {
  Image: { type: 'Content', content: 'image', category: 'Image' },
  ImageColor3: { type: 'Color3', default: () => new Color3(1, 1, 1), category: 'Image' },
  ImageTransparency: { type: 'number', category: 'Image' },
} as const
class ImageLabel extends GuiObject {}
defineClass(ImageLabel, { name: 'ImageLabel', superclass: 'GuiObject', category: 'GUI', props: { ...imageProps } as any })
class ImageButton extends GuiButton {}
defineClass(ImageButton, { name: 'ImageButton', superclass: 'GuiButton', category: 'GUI', props: { ...imageProps } as any })
class UICorner extends Instance {}
defineClass(UICorner, { name: 'UICorner', superclass: 'Instance', category: 'GUI', props: { CornerRadius: { type: 'UDim', default: () => new UDim(0, 8), category: 'Data' } } })
class UIStroke extends Instance {}
defineClass(UIStroke, {
  name: 'UIStroke', superclass: 'Instance', category: 'GUI',
  props: {
    Color: { type: 'Color3', default: () => Color3.fromRGB(0, 0, 0), category: 'Data' },
    Thickness: { type: 'number', default: () => 1, category: 'Data' },
    Transparency: { type: 'number', category: 'Data' },
  },
})
class UIListLayout extends Instance {}
defineClass(UIListLayout, {
  name: 'UIListLayout', superclass: 'Instance', category: 'GUI',
  props: {
    Padding: { type: 'UDim', category: 'Data' },
    FillDirection: { type: 'Enum.FillDirection', default: () => enumItem('FillDirection', 'Vertical'), category: 'Data' },
  },
})

export function isScriptRunnable(s: Instance) {
  return isA(s.classInfo, 'BaseScript') && s.get('Enabled')
}
export { createInstance }

// 2D classes (World2D, sprites, tilemaps, 2D physics bodies)
register2DClasses()
