// Roblox-style Instance tree with a reflection system. Every class declares its
// properties (typed, for the editor + serialization + Luau bridge), methods
// (callable from Luau) and events (fired to Luau).
import { CFrame, Color3, EnumItem, UDim, UDim2, Vector3, Vector2 } from './datatypes'

export type PropType =
  | 'string' | 'number' | 'int' | 'bool' | 'Vector3' | 'Vector2' | 'CFrame' | 'Color3' | 'UDim' | 'UDim2' | 'Instance'
  | `Enum.${string}`

export interface PropDef {
  type: PropType
  default?: () => unknown
  /** Not writable from Luau or the properties panel. */
  readonly?: boolean
  /** Hidden from the properties panel. */
  hidden?: boolean
  /** Not stored in saved places. */
  noSave?: boolean
  category?: string
  /** Virtual property (derived from other state). */
  get?: (inst: any) => unknown
  set?: (inst: any, value: any) => void
}

export type LuauMethod = (self: any, ...args: any[]) => unknown

export interface ClassInfo {
  name: string
  superclass?: ClassInfo
  creatable: boolean
  service: boolean
  ctor: new () => Instance
  ownProps: Record<string, PropDef>
  ownMethods: Record<string, LuauMethod>
  ownEvents: string[]
  /** flattened (including inherited) */
  props: Map<string, PropDef>
  methods: Map<string, LuauMethod>
  events: Set<string>
  /** Hint for the editor's Insert Object menu */
  category?: string
}

const classes = new Map<string, ClassInfo>()

export function getClass(name: string) { return classes.get(name) }
export function allClasses() { return [...classes.values()] }

export interface ClassOptions {
  name: string
  superclass?: string
  creatable?: boolean
  service?: boolean
  category?: string
  props?: Record<string, PropDef>
  methods?: Record<string, LuauMethod>
  events?: string[]
}

export function defineClass(ctor: new () => Instance, opts: ClassOptions) {
  const superclass = opts.superclass ? classes.get(opts.superclass) : undefined
  if (opts.superclass && !superclass) throw new Error(`superclass ${opts.superclass} not defined`)
  const info: ClassInfo = {
    name: opts.name,
    superclass,
    creatable: opts.creatable ?? true,
    service: opts.service ?? false,
    ctor,
    ownProps: opts.props ?? {},
    ownMethods: opts.methods ?? {},
    ownEvents: opts.events ?? [],
    props: new Map(superclass?.props),
    methods: new Map(superclass?.methods),
    events: new Set(superclass?.events),
    category: opts.category,
  }
  for (const [k, v] of Object.entries(info.ownProps)) info.props.set(k, v)
  for (const [k, v] of Object.entries(info.ownMethods)) info.methods.set(k, v)
  for (const e of info.ownEvents) info.events.add(e)
  classes.set(opts.name, info)
  ;(ctor as any).classInfo = info
  return info
}

export function isA(info: ClassInfo | undefined, name: string): boolean {
  for (let c = info; c; c = c.superclass) if (c.name === name) return true
  return false
}

// ---------------------------------------------------------------------------

export interface DataModelObserver {
  added?(inst: Instance): void
  removing?(inst: Instance, oldParent: Instance | null): void
  changed?(inst: Instance, prop: string): void
  reparented?(inst: Instance, oldParent: Instance | null): void
}

export type EventSink = (inst: Instance, event: string, args: unknown[]) => void
const eventSinks = new Set<EventSink>()
export function addEventSink(sink: EventSink) {
  eventSinks.add(sink)
  return () => eventSinks.delete(sink)
}

let nextId = 1

export class Instance {
  readonly id = nextId++
  readonly props = new Map<string, unknown>()
  readonly attributes = new Map<string, unknown>()
  readonly children: Instance[] = []
  parent: Instance | null = null
  /** The DataModel this instance currently lives under (null if detached). */
  dataModel: DataModelLike | null = null
  destroyed = false
  /** parent is locked (services, destroyed instances) */
  parentLocked = false

  get classInfo(): ClassInfo { return (this.constructor as any).classInfo }
  get className() { return this.classInfo.name }

  constructor() {
    const info = (this.constructor as any).classInfo as ClassInfo
    if (info) {
      for (const [name, def] of info.props) {
        if (def.get || name === 'Parent') continue
        this.props.set(name, def.default ? def.default() : defaultFor(def.type))
      }
      this.props.set('Name', info.name)
    }
  }

  get name(): string { return this.props.get('Name') as string }
  set name(v: string) { this.set('Name', v) }

  get<T = unknown>(prop: string): T {
    if (prop === 'Parent') return this.parent as T
    if (prop === 'ClassName') return this.className as T
    const def = this.classInfo.props.get(prop)
    if (def?.get) return def.get(this) as T
    return this.props.get(prop) as T
  }

  /** Set a property; fires change notifications if the value changed. */
  set(prop: string, value: unknown) {
    if (prop === 'Parent') { this.setParent(value as Instance | null); return }
    const def = this.classInfo.props.get(prop)
    if (def?.set) { def.set(this, value); return }
    const old = this.props.get(prop)
    if (old === value) return
    this.props.set(prop, value)
    this.onPropChanged(prop, old)
    this.changed(prop)
  }

  /** Set without change notifications (bulk loading). */
  rawSet(prop: string, value: unknown) { this.props.set(prop, value) }

  changed(prop: string) {
    this.dataModel?.notifyChanged(this, prop)
  }

  findFirstChildOfClass(cls: string): Instance | null {
    return this.children.find((c) => c.className === cls) ?? null
  }

  protected onPropChanged(_prop: string, _old: unknown) {}

  fire(event: string, ...args: unknown[]) {
    for (const s of eventSinks) s(this, event, args)
  }

  isA(name: string) { return isA(this.classInfo, name) }

  setParent(newParent: Instance | null) {
    if (newParent === this.parent) return
    if (this.parentLocked) throw new Error(`The Parent property of ${this.name} is locked`)
    if (newParent) {
      if (newParent === this || newParent.isDescendantOf(this))
        throw new Error(`Attempt to set parent of ${this.getFullName()} to ${newParent.getFullName()} would result in circular reference`)
      if (newParent.destroyed) throw new Error(`Cannot parent to destroyed instance`)
    }
    const oldParent = this.parent
    const oldDM = this.dataModel
    const newDM = newParent ? newParent.dataModel : null
    if (oldParent) {
      const i = oldParent.children.indexOf(this)
      if (i >= 0) oldParent.children.splice(i, 1)
    }
    if (oldDM && oldDM !== newDM) oldDM.notifyRemoving(this, oldParent)
    this.parent = newParent
    if (newParent) newParent.children.push(this)
    if (oldDM !== newDM) setDataModelRecursive(this, newDM)
    if (newDM && oldDM !== newDM) newDM.notifyAdded(this)
    if (newDM && oldDM === newDM) newDM.notifyReparented(this, oldParent)
    oldParent?.fire('ChildRemoved', this)
    newParent?.fire('ChildAdded', this)
    // DescendantAdded/Removing on ancestors
    for (let a = oldParent; a; a = a.parent) a.fire('DescendantRemoving', this)
    for (let a = newParent; a; a = a.parent) a.fire('DescendantAdded', this)
    this.fire('AncestryChanged', this, newParent)
    this.changed('Parent')
  }

  isDescendantOf(other: Instance): boolean {
    for (let p = this.parent; p; p = p.parent) if (p === other) return true
    return false
  }

  destroy() {
    if (this.destroyed) return
    for (const c of [...this.children]) c.destroy()
    this.parentLocked = false
    this.setParent(null)
    this.destroyed = true
    this.parentLocked = true
    this.fire('Destroying')
    this.onDestroy()
  }
  protected onDestroy() {}

  findFirstChild(name: string, recursive = false): Instance | null {
    for (const c of this.children) if (c.name === name) return c
    if (recursive) for (const c of this.children) {
      const r = c.findFirstChild(name, true)
      if (r) return r
    }
    return null
  }

  getDescendants(out: Instance[] = []): Instance[] {
    for (const c of this.children) { out.push(c); c.getDescendants(out) }
    return out
  }

  getFullName(): string {
    const parts: string[] = []
    for (let p: Instance | null = this; p && p.className !== 'DataModel'; p = p.parent) parts.unshift(p.name)
    return parts.join('.')
  }

  clone(): Instance {
    return cloneInstance(this)
  }
}

export interface DataModelLike extends Instance {
  notifyAdded(inst: Instance): void
  notifyRemoving(inst: Instance, oldParent: Instance | null): void
  notifyChanged(inst: Instance, prop: string): void
  notifyReparented(inst: Instance, oldParent: Instance | null): void
}

function setDataModelRecursive(inst: Instance, dm: DataModelLike | null) {
  inst.dataModel = dm
  for (const c of inst.children) setDataModelRecursive(c, dm)
}

export function defaultFor(type: PropType): unknown {
  switch (type) {
    case 'string': return ''
    case 'number': case 'int': return 0
    case 'bool': return false
    case 'Vector3': return Vector3.zero
    case 'Vector2': return Vector2.zero
    case 'CFrame': return CFrame.identity
    case 'Color3': return new Color3(1, 1, 1)
    case 'UDim': return new UDim()
    case 'UDim2': return new UDim2()
    case 'Instance': return null
    default: return null
  }
}

export function createInstance(className: string): Instance {
  const info = classes.get(className)
  if (!info) throw new Error(`Unable to create an Instance of type "${className}"`)
  return new info.ctor()
}

// ---- Serialization ---------------------------------------------------------

export interface SerializedInstance {
  className: string
  ref: number
  props: Record<string, unknown>
  attributes?: Record<string, unknown>
  children: SerializedInstance[]
}

export function encodeValue(v: unknown, refOf: (i: Instance) => number | null): unknown {
  if (v instanceof Vector3) return { t: 'V3', v: [v.x, v.y, v.z] }
  if (v instanceof Vector2) return { t: 'V2', v: [v.x, v.y] }
  if (v instanceof CFrame) return { t: 'CF', v: v.components() }
  if (v instanceof Color3) return { t: 'C3', v: [v.r, v.g, v.b] }
  if (v instanceof UDim2) return { t: 'U2', v: [v.xs, v.xo, v.ys, v.yo] }
  if (v instanceof UDim) return { t: 'U1', v: [v.scale, v.offset] }
  if (v instanceof EnumItem) return { t: 'E', e: v.enumType, n: v.name }
  if (v instanceof Instance) { const r = refOf(v); return r == null ? null : { t: 'I', r } }
  return v
}

export function decodeValue(v: any, resolve: (ref: number) => Instance | null, enumItem: (e: string, n: string) => EnumItem): unknown {
  if (v && typeof v === 'object' && 't' in v) {
    switch (v.t) {
      case 'V3': return new Vector3(v.v[0], v.v[1], v.v[2])
      case 'V2': return new Vector2(v.v[0], v.v[1])
      case 'CF': return CFrame.fromComponents(v.v)
      case 'C3': return new Color3(v.v[0], v.v[1], v.v[2])
      case 'U2': return new UDim2(v.v[0], v.v[1], v.v[2], v.v[3])
      case 'U1': return new UDim(v.v[0], v.v[1])
      case 'E': return enumItem(v.e, v.n)
      case 'I': return resolve(v.r)
    }
  }
  return v
}

let enumResolver: (e: string, n: string) => EnumItem = () => { throw new Error('enum resolver not set') }
export function setEnumResolver(fn: typeof enumResolver) { enumResolver = fn }

export function serialize(root: Instance, includeRoot = true): SerializedInstance {
  // refs: instance ids are stable within a serialization; instance refs outside the tree are dropped
  const inTree = new Set<Instance>([root, ...root.getDescendants()])
  const refOf = (i: Instance) => (inTree.has(i) ? i.id : null)
  const ser = (inst: Instance): SerializedInstance => {
    const props: Record<string, unknown> = {}
    for (const [name, def] of inst.classInfo.props) {
      if (def.get || def.noSave || name === 'Parent') continue
      props[name] = encodeValue(inst.props.get(name), refOf)
    }
    props.Name = inst.name
    const out: SerializedInstance = { className: inst.className, ref: inst.id, props, children: [] }
    if (inst.attributes.size) {
      out.attributes = {}
      for (const [k, v] of inst.attributes) out.attributes[k] = encodeValue(v, refOf)
    }
    for (const c of inst.children) if (!(c as any).transient) out.children.push(ser(c))
    return out
  }
  void includeRoot
  return ser(root)
}

/** Build instances from serialized data. If `into` is given, the root's props/children are applied to it. */
/** Renamed/merged classes, so places saved by older versions (or Roblox-style names) still load. */
const CLASS_ALIASES: Record<string, string> = {
  LocalScript: 'Script',
  ServerScriptService: 'ScriptService',
  ReplicatedStorage: 'Storage',
  ServerStorage: 'Storage',
}
export function classAlias(name: string) { return CLASS_ALIASES[name] ?? name }

export function deserialize(data: SerializedInstance, into?: Instance, byRef = new Map<number, Instance>()): Instance {
  const pendingRefs: Array<() => void> = []
  const build = (d: SerializedInstance, existing?: Instance): Instance => {
    let inst = existing
    if (!inst) {
      const info = classes.get(classAlias(d.className))
      if (!info) { console.warn(`Unknown class ${d.className}, using Folder`) }
      inst = info ? new info.ctor() : createInstance('Folder')
    }
    byRef.set(d.ref, inst)
    for (const [name, raw] of Object.entries(d.props)) {
      const def = inst.classInfo.props.get(name)
      if (!def && name !== 'Name') continue
      if (raw && typeof raw === 'object' && (raw as any).t === 'I') {
        const r = (raw as any).r
        const target = inst
        pendingRefs.push(() => target.rawSet(name, byRef.get(r) ?? null))
      } else {
        inst.rawSet(name, decodeValue(raw, () => null, enumResolver))
      }
    }
    if (d.attributes) for (const [k, v] of Object.entries(d.attributes)) inst.attributes.set(k, decodeValue(v, () => null, enumResolver))
    for (const cd of d.children) {
      let child: Instance | undefined
      // services already exist in a fresh DataModel; merge into them
      if (existing && classes.get(classAlias(cd.className))?.service) {
        child = existing.children.find((c) => c.className === classAlias(cd.className))
      }
      const built = build(cd, child)
      if (!child) built.setParent(inst)
    }
    return inst
  }
  const root = build(data, into)
  for (const p of pendingRefs) p()
  return root
}

export function cloneInstance(inst: Instance): Instance {
  return deserialize(serialize(inst))
}
