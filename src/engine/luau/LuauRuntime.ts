// Hosts a Luau VM (via @luau-rs/luau WASM) and bridges it to the Instance tree.
import { Lua, LuaFunction, LuaTable, LuaVector, intoLua } from '@luau-rs/luau'
import preludeSource from './prelude.luau?raw'
import { CFrame, Color3, EnumItem, Enums, UDim, UDim2, Vector2, Vector3, enumItem } from '../datatypes'
import { Instance, PropDef, addEventSink, createInstance, getClass, isA } from '../instance'
import { DataModel, Multi, TweenInfoData } from '../classes'
import { languageOf, resolveModule } from '../scripting/languages'

export type OutputKind = 'info' | 'warn' | 'error'
export interface OutputSink {
  (kind: OutputKind, message: string, source?: string): void
}

const SCRIPT_TIMEOUT_MS = 8000

export class LuauRuntime {
  readonly byId = new Map<number, Instance>()
  readonly listened = new Map<number, Set<string>>()
  private internals!: LuaTable
  private fnDispatch!: LuaFunction
  private fnStep!: LuaFunction
  private fnRunScript!: LuaFunction
  private fnMakeEnv!: LuaFunction
  private fnKill!: LuaFunction
  private fnRevive!: LuaFunction
  private fnRenderStep!: LuaFunction
  private fnAction!: LuaFunction
  private depth = 0
  private entryStart = 0
  private queue: Array<[number, string, unknown[]]> = []
  private disposeSink: () => void
  private disposeObserver: () => void
  destroyed = false
  private startTime = performance.now()
  /** cross-language hooks, installed by ScriptHost */
  foreignRequire: ((inst: Instance) => unknown) | null = null
  unwrapApi: ((v: unknown) => Instance | null) | null = null
  // JS values referenced from Luau (tag 13)
  private jsRefs = new Map<number, unknown>()
  private jsRefIds = new Map<unknown, number>()
  private jsOwners = new Map<number, unknown>()
  private nextJsRef = 1
  // Luau values wrapped for JS
  private luaOf = new WeakMap<object, LuaTable | LuaFunction>()
  private fnGetLive!: LuaFunction
  private fnSetLive!: LuaFunction
  private fnKeysLive!: LuaFunction
  private fnCallLive!: LuaFunction
  private fnRequireLive!: LuaFunction

  private constructor(readonly lua: Lua, readonly game: DataModel, readonly output: OutputSink) {
    this.disposeSink = addEventSink((inst, event, args) => this.onEngineEvent(inst, event, args))
    this.disposeObserver = game.observe({
      changed: (inst, prop) => this.onChanged(inst, prop),
    })
  }

  static async create(game: DataModel, output: OutputSink) {
    const lua = await Lua.create({ sandbox: false })
    const rt = new LuauRuntime(lua, game, output)
    rt.init()
    return rt
  }

  // ---------------------------------------------------------------- setup
  private init() {
    const { lua } = this
    lua.addEventListener('print', (e) => this.output('info', e.text))
    const H = lua.createTable()
    const fn = (name: string, f: (...args: any[]) => any) => H.set(name, lua.createFunction(f))

    fn('setVectorMetatable', (mt: LuaTable) => { lua.setTypeMetatable('vector', mt) })
    fn('game', () => this.ret([this.game]))
    fn('members', (cls: string) => lua.createTable(this.members(cls) as any[]))
    fn('enumItems', (name: string) => (Enums[name] ? lua.createTable(Enums[name]) : null))
    fn('get', (id: number, prop: string) => this.ret([this.getProp(this.inst(id), prop)]))
    fn('set', (id: number, prop: string, ...flat: unknown[]) => {
      this.setProp(this.inst(id), prop, this.decodeFirst(flat))
    })
    fn('call', (id: number, method: string, ...flat: unknown[]) => this.callMethod(this.inst(id), method, this.decodeAll(flat)))
    fn('child', (id: number, name: string) => {
      const c = this.inst(id).findFirstChild(name)
      return c ? this.ret([c]) : undefined
    })
    fn('fullName', (id: number) => this.inst(id).getFullName())
    fn('new', (cls: string) => {
      const info = getClass(cls)
      if (!info || !info.creatable) throw new Error(`Unable to create an Instance of type "${cls}"`)
      return this.ret([createInstance(cls)])
    })
    fn('listen', (id: number, event: string) => {
      let s = this.listened.get(id)
      if (!s) { s = new Set(); this.listened.set(id, s) }
      s.add(event)
    })
    fn('loadModule', (id: number) => {
      const m = this.inst(id)
      return this.compile(m) ?? `Requested module "${m.getFullName()}" failed to compile`
    })
    fn('scriptError', (msg: string, tb: string, scriptId: number) => {
      const s = this.byId.get(scriptId)
      const clean = String(msg).split('\nstack traceback:')[0]
      this.output('error', clean + (tb ? '\n' + cleanTraceback(tb) : ''), s?.getFullName())
    })
    fn('print', (kind: number, msg: string) => this.output(kind === 1 ? 'warn' : 'info', msg))
    // ---- cross-language: foreign (TypeScript/Python) modules and JS values inside Luau
    fn('isForeign', (id: number) => languageOf(this.inst(id)) !== 'Luau')
    fn('requireForeign', (id: number) => {
      if (!this.foreignRequire) throw new Error('Cross-language require is not available')
      return this.retLive([this.foreignRequire(this.inst(id))])
    })
    fn('resolve', (scriptId: number, spec: string) => {
      const from = this.byId.get(scriptId) ?? null
      const m = resolveModule(String(spec), from, '/')
      if (!m) throw new Error(`Module "${spec}" was not found`)
      return this.ret([m])
    })
    fn('jsget', (ref: number, ...flat: unknown[]) => {
      const obj = this.jsRefs.get(ref) as any
      let key = this.decodeFirst(flat) as any
      if (Array.isArray(obj) && typeof key === 'number') key = key - 1
      let v = obj?.[key]
      if (typeof v === 'function' && !isForeignProxy(v)) v = v.bind(obj)
      const out = this.retLive([v])
      if (typeof v === 'function') this.jsOwners.set(this.jsRefIds.get(v)!, obj)
      return out
    })
    fn('jsset', (ref: number, ...flat: unknown[]) => {
      const obj = this.jsRefs.get(ref) as any
      const [k, v] = this.decodeAll(flat)
      obj[Array.isArray(obj) && typeof k === 'number' ? k - 1 : (k as any)] = plainify(v)
    })
    fn('jscall', (ref: number, ...flat: unknown[]) => {
      const f = this.jsRefs.get(ref) as any
      let args = this.decodeAll(flat).map(plainify)
      // obj:method(...) passes the object as `self`; JS/Python functions don't expect it
      if (args.length && this.jsOwners.has(ref) && args[0] === this.jsOwners.get(ref)) args = args.slice(1)
      if (typeof f !== 'function') throw new Error('attempt to call a non-function foreign value')
      return this.retLive([f(...args)])
    })
    fn('jskeys', (ref: number) => {
      const obj = this.jsRefs.get(ref) as any
      if (Array.isArray(obj)) return this.lua.createTable(obj.map((_: unknown, i: number) => i + 1))
      const keys = obj instanceof Map ? [...obj.keys()] : isForeignProxy(obj) && typeof obj.keys === 'function' ? [...obj.keys()] : Object.keys(obj ?? {})
      return this.lua.createTable(keys.map(String))
    })
    fn('jslen', (ref: number) => {
      const obj = this.jsRefs.get(ref) as any
      return Number(obj?.length ?? obj?.size ?? 0)
    })
    fn('jsstr', (ref: number) => String(this.jsRefs.get(ref)))
    fn('clock', () => Date.now() / 1000)

    // Interrupt long-running code (infinite loops without yields).
    lua.setInterruptHooks({
      execution: () => {
        if (this.depth > 0 && performance.now() - this.entryStart > SCRIPT_TIMEOUT_MS) {
          this.entryStart = performance.now()
          this.output('error', 'Script timeout: exhausted allowed execution time')
          return 'break'
        }
      },
    })

    const prelude = lua.load(preludeSource, { name: '=RossEngine.Prelude' })
    const [internals] = prelude.call(H) as [LuaTable]
    this.internals = internals
    this.fnDispatch = internals.get('dispatch') as LuaFunction
    this.fnStep = internals.get('step') as LuaFunction
    this.fnRunScript = internals.get('runScript') as LuaFunction
    this.fnMakeEnv = internals.get('makeEnv') as LuaFunction
    this.fnKill = internals.get('killScript') as LuaFunction
    this.fnRevive = internals.get('reviveScript') as LuaFunction
    this.fnRenderStep = internals.get('renderStep') as LuaFunction
    this.fnAction = internals.get('action') as LuaFunction
    this.fnGetLive = internals.get('getLive') as LuaFunction
    this.fnSetLive = internals.get('setLive') as LuaFunction
    this.fnKeysLive = internals.get('keysLive') as LuaFunction
    this.fnCallLive = internals.get('callLive') as LuaFunction
    this.fnRequireLive = internals.get('requireLive') as LuaFunction
  }

  // ---------------------------------------------------------------- cross-language (live values)
  /** Call into Luau from JS code (another language), keeping the timeout and propagating errors. */
  private callIn<T>(f: () => T): T {
    const outer = this.depth === 0
    if (outer) this.entryStart = performance.now()
    this.depth++
    try {
      return f()
    } catch (e) {
      throw new Error(String((e as Error)?.message ?? e).split('\nstack traceback:')[0].replace(/^runtime error: /, ''))
    } finally {
      this.depth--
      if (outer) this.flush()
    }
  }

  /** require() a Luau ModuleScript from another language; returns a live JS view of its result. */
  requireLive(inst: Instance): unknown {
    this.register(inst)
    return this.callIn(() => this.decodeLive(this.fnRequireLive.call(inst.id, inst.className) as unknown[]))[0]
  }

  private retLive(values: unknown[]) {
    return intoLua.multiple(...(this.encodeLive(values) as any[]))
  }

  /** Encode for Luau, passing non-engine JS objects/functions by reference (tag 13). */
  encodeLive(values: unknown[]): unknown[] {
    const out: unknown[] = []
    for (const raw of values) {
      const v = this.unwrapApi?.(raw) ?? raw
      const lv = v && (typeof v === 'object' || typeof v === 'function') ? this.luaOf.get(v as object) : undefined
      if (lv) { out.push(12, lv); continue }
      if (v === null || v === undefined || typeof v !== 'object' && typeof v !== 'function' || isEngineValue(v)) {
        this.encode(v, out)
        continue
      }
      let id = this.jsRefIds.get(v)
      if (!id) { id = this.nextJsRef++; this.jsRefIds.set(v, id); this.jsRefs.set(id, v) }
      out.push(13, id)
    }
    return out
  }

  /** Decode values coming from Luau where tables/functions are passed live (tag 12). */
  decodeLive(flat: unknown[]): unknown[] {
    return this.decodeAll(flat)
  }

  private wrapLuaFunction(fn: LuaFunction): (...args: unknown[]) => unknown {
    const w = (...args: unknown[]) => {
      const r = this.callIn(() => this.fnCallLive.call(fn, ...(this.encodeLive(args) as any[])) as unknown[])
      const vals = this.decodeLive(r)
      return vals.length <= 1 ? vals[0] : vals
    }
    this.luaOf.set(w, fn)
    return w
  }

  private wrapLuaTable(t: LuaTable): object {
    const rt = this
    const key = (k: string | symbol) => (typeof k === 'string' && /^-?\d+(\.\d+)?$/.test(k) ? Number(k) : k)
    const p = new Proxy({}, {
      get(_o, k) {
        if (typeof k === 'symbol') {
          if (k === Symbol.iterator) return function* () { for (const kk of rt.tableKeys(t)) yield rt.tableGet(t, kk) }
          return undefined
        }
        if (k === 'then' || k === 'toJSON') return undefined
        return rt.tableGet(t, key(k))
      },
      set(_o, k, v) {
        if (typeof k === 'symbol') return false
        rt.callIn(() => rt.fnSetLive.call(t, ...(rt.encodeLive([key(k), v]) as any[])))
        return true
      },
      has(_o, k) { return typeof k === 'string' && rt.tableGet(t, key(k)) !== null },
      ownKeys() { return rt.tableKeys(t).map(String) },
      getOwnPropertyDescriptor(_o, k) {
        if (typeof k === 'symbol') return undefined
        const v = rt.tableGet(t, key(k))
        return v === null ? undefined : { value: v, enumerable: true, configurable: true, writable: true }
      },
    })
    this.luaOf.set(p, t)
    return p
  }

  private tableGet(t: LuaTable, k: unknown) {
    return this.decodeLive(this.callIn(() => this.fnGetLive.call(t, ...(this.encodeLive([k]) as any[])) as unknown[]))[0] ?? null
  }

  private tableKeys(t: LuaTable): unknown[] {
    return this.callIn(() => this.fnKeysLive.call(t) as unknown[])
  }

  private memberCache = new Map<string, unknown[]>()
  private members(cls: string): unknown[] {
    let m = this.memberCache.get(cls)
    if (m) return m
    const info = getClass(cls)
    if (!info) throw new Error(`Unknown class ${cls}`)
    m = []
    for (const [name, def] of info.props) m.push(name, def.readonly ? 'R' : 'P')
    for (const name of info.methods.keys()) m.push(name, 'M')
    for (const name of info.events) m.push(name, 'E')
    m.push('@ancestry')
    for (let c: typeof info | undefined = info; c; c = c.superclass) m.push(c.name)
    this.memberCache.set(cls, m)
    return m
  }

  private inst(id: number): Instance {
    const i = this.byId.get(id)
    if (!i) throw new Error(`Invalid instance reference ${id}`)
    return i
  }

  // ---------------------------------------------------------------- entry points
  /** Run Luau code from the host, enforcing the timeout and flushing deferred events. */
  private enter<T>(f: () => T): T | undefined {
    if (this.destroyed) return undefined
    const outer = this.depth === 0
    if (outer) this.entryStart = performance.now()
    this.depth++
    try {
      return f()
    } catch (e) {
      this.output('error', String((e as Error)?.message ?? e))
      return undefined
    } finally {
      this.depth--
      if (outer) this.flush()
    }
  }

  private flush() {
    let guard = 0
    while (this.queue.length && guard++ < 50 && !this.destroyed) {
      const batch = this.queue
      this.queue = []
      this.depth++
      try {
        for (const [id, name, flat] of batch) {
          try { this.fnDispatch.call(id, name, ...(flat as any[])) } catch (e) { this.output('error', String((e as Error)?.message ?? e)) }
        }
      } finally { this.depth-- }
    }
  }

  compile(script: Instance): LuaFunction | null {
    this.register(script)
    const source = script.get<string>('Source') ?? ''
    const [env] = this.fnMakeEnv.call(script.id, script.className) as [LuaTable]
    try {
      return this.lua.load(source, { name: '=' + script.getFullName(), environment: env })
    } catch (e) {
      this.output('error', String((e as Error)?.message ?? e), script.getFullName())
      return null
    }
  }

  runScript(script: Instance) {
    this.enter(() => {
      this.fnRevive.call(script.id)
      const fn = this.compile(script)
      if (fn) this.fnRunScript.call(fn, script.id)
    })
  }

  killScript(script: Instance) {
    this.enter(() => this.fnKill.call(script.id))
  }

  step(gameTime: number) {
    this.enter(() => this.fnStep.call(gameTime))
  }

  renderStep(dt: number) {
    this.enter(() => this.fnRenderStep.call(dt))
  }

  contextAction(keyName: string, state: string, input: Instance) {
    this.register(input)
    this.enter(() => this.fnAction.call(keyName, state, input.id, input.className))
  }

  /** Fire an event to Luau right away (used for frame events like Heartbeat). */
  fireNow(inst: Instance, event: string, args: unknown[]) {
    if (!this.listened.get(inst.id)?.has(event)) return
    const flat = this.encodeList(args)
    this.enter(() => this.fnDispatch.call(inst.id, event, ...(flat as any[])))
  }

  isListening(inst: Instance, event: string) {
    return !!this.listened.get(inst.id)?.has(event)
  }

  elapsed() { return (performance.now() - this.startTime) / 1000 }

  private onEngineEvent(inst: Instance, event: string, args: unknown[]) {
    if (this.destroyed) return
    const s = this.listened.get(inst.id)
    if (!s || !s.has(event)) return
    this.queue.push([inst.id, event, this.encodeList(args)])
    if (this.depth === 0) this.flush()
  }

  private onChanged(inst: Instance, prop: string) {
    const s = this.listened.get(inst.id)
    if (!s) return
    if (s.has('Changed')) {
      const isValue = isA(inst.classInfo, 'ValueBase')
      if (!isValue) this.queue.push([inst.id, 'Changed', this.encodeList([prop])])
      else if (prop === 'Value') this.queue.push([inst.id, 'Changed', this.encodeList([inst.get('Value')])])
    }
    if (s.has('Changed:' + prop)) this.queue.push([inst.id, 'Changed:' + prop, []])
    if (this.depth === 0) this.flush()
  }

  destroy() {
    this.destroyed = true
    this.disposeSink()
    this.disposeObserver()
    try { this.lua.removeInterruptHooks() } catch { /* ignore */ }
  }

  // ---------------------------------------------------------------- properties & methods
  private getProp(inst: Instance, prop: string): unknown {
    const def = inst.classInfo.props.get(prop)
    if (!def && prop !== 'ClassName') throw new Error(`${prop} is not a valid member of ${inst.className}`)
    return inst.get(prop)
  }

  private setProp(inst: Instance, prop: string, value: unknown) {
    const def = inst.classInfo.props.get(prop)
    if (!def) throw new Error(`${prop} is not a valid member of ${inst.className} "${inst.getFullName()}"`)
    if (def.readonly) throw new Error(`Unable to assign property ${prop}. Property is read only`)
    inst.set(prop, coerce(def, prop, value))
  }

  private callMethod(inst: Instance, method: string, args: unknown[]) {
    const m = inst.classInfo.methods.get(method)
    if (!m) throw new Error(`${method} is not a valid member of ${inst.className} "${inst.getFullName()}"`)
    const r = m(inst, ...args)
    if (r instanceof Multi) return this.ret(r.values)
    if (r === undefined) return undefined
    return this.ret([r])
  }

  // ---------------------------------------------------------------- marshalling
  register(inst: Instance) {
    if (!this.byId.has(inst.id)) this.byId.set(inst.id, inst)
  }

  private ret(values: unknown[]) {
    return intoLua.multiple(...(this.encodeList(values) as any[]))
  }

  encodeList(values: unknown[]): unknown[] {
    const out: unknown[] = []
    for (const v of values) this.encode(v, out)
    return out
  }

  private encode(v: unknown, out: unknown[]) {
    if (v === null || v === undefined) { out.push(0); return }
    switch (typeof v) {
      case 'number': case 'string': case 'boolean': out.push(1, v); return
      case 'bigint': out.push(1, Number(v)); return
    }
    if (v instanceof Instance) { this.register(v); out.push(2, v.id, v.className); return }
    if (v instanceof Vector3) { out.push(1, new LuaVector(v.x, v.y, v.z)); return }
    if (v instanceof CFrame) { out.push(5, ...v.components()); return }
    if (v instanceof Color3) { out.push(6, v.r, v.g, v.b); return }
    if (v instanceof Vector2) { out.push(4, v.x, v.y); return }
    if (v instanceof UDim2) { out.push(7, v.xs, v.xo, v.ys, v.yo); return }
    if (v instanceof UDim) { out.push(8, v.scale, v.offset); return }
    if (v instanceof EnumItem) { out.push(9, v.enumType, v.name); return }
    if (v instanceof Map) {
      out.push(11, v.size)
      for (const [k, val] of v) { this.encode(k, out); this.encode(val, out) }
      return
    }
    if (Array.isArray(v)) {
      out.push(11, v.length)
      v.forEach((val, i) => { out.push(1, i + 1); this.encode(val, out) })
      return
    }
    // raw Luau values (functions etc.)
    out.push(12, v)
  }

  decodeAll(flat: unknown[]): unknown[] {
    const out: unknown[] = []
    let i = 0
    while (i < flat.length) {
      const [v, n] = this.decodeAt(flat, i)
      out.push(v)
      i = n
    }
    return out
  }

  private decodeFirst(flat: unknown[]): unknown {
    if (!flat.length) return null
    return this.decodeAt(flat, 0)[0]
  }

  private decodeAt(a: unknown[], i: number): [unknown, number] {
    const tag = a[i] as number
    const n = (k: number) => a[i + k] as number
    switch (tag) {
      case 0: return [null, i + 1]
      case 1: {
        const v = a[i + 1]
        if (v instanceof LuaVector) return [new Vector3(v.x, v.y, v.z), i + 2]
        if (typeof v === 'bigint') return [Number(v), i + 2]
        return [v, i + 2]
      }
      case 2: return [this.inst(n(1)), i + 2]
      case 4: return [new Vector2(n(1), n(2)), i + 3]
      case 5: return [CFrame.fromComponents(a.slice(i + 1, i + 13) as number[]), i + 13]
      case 6: return [new Color3(n(1), n(2), n(3)), i + 4]
      case 7: return [new UDim2(n(1), n(2), n(3), n(4)), i + 5]
      case 8: return [new UDim(n(1), n(2)), i + 3]
      case 9: return [enumItem(a[i + 1] as string, a[i + 2] as string), i + 3]
      case 10: {
        const ti: TweenInfoData = {
          time: n(1), style: a[i + 2] as string, direction: a[i + 3] as string,
          repeatCount: n(4), reverses: !!a[i + 5], delay: n(6),
        }
        return [ti, i + 7]
      }
      case 11: {
        const count = n(1)
        const m = new Map<unknown, unknown>()
        let j = i + 2
        for (let k = 0; k < count; k++) {
          const [key, j2] = this.decodeAt(a, j)
          const [val, j3] = this.decodeAt(a, j2)
          m.set(key, val)
          j = j3
        }
        return [m, j]
      }
      case 12: {
        const v = a[i + 1]
        if (v instanceof LuaFunction) return [this.wrapLuaFunction(v), i + 2]
        if (v instanceof LuaTable) return [this.wrapLuaTable(v), i + 2]
        return [v, i + 2]
      }
      case 13: return [this.jsRefs.get(n(1)), i + 2]
    }
    throw new Error(`bad bridge tag ${tag}`)
  }
}

/** Validate/convert a value assigned from Luau to a typed property. */
export function coerce(def: PropDef, prop: string, v: unknown): unknown {
  const t = def.type
  const fail = (): never => {
    throw new Error(`Unable to assign property ${prop}. ${t.startsWith('Enum.') ? 'EnumItem' : t} expected, got ${luauTypeName(v)}`)
  }
  switch (t) {
    case 'string': case 'Content':
      if (typeof v === 'string') return v
      if (typeof v === 'number') return String(v)
      return fail()
    case 'number':
      if (typeof v === 'number') return v
      if (typeof v === 'string' && v.trim() !== '' && !isNaN(Number(v))) return Number(v)
      return fail()
    case 'int':
      if (typeof v === 'number') return Math.trunc(v)
      return fail()
    case 'bool':
      if (typeof v === 'boolean') return v
      return v != null // Luau truthiness
    case 'Vector3': return v instanceof Vector3 ? v : fail()
    case 'Vector2': return v instanceof Vector2 ? v : fail()
    case 'CFrame': return v instanceof CFrame ? v : fail()
    case 'Color3': return v instanceof Color3 ? v : fail()
    case 'UDim2': return v instanceof UDim2 ? v : fail()
    case 'UDim': return v instanceof UDim ? v : fail()
    case 'Instance': return v === null || v instanceof Instance ? v : fail()
  }
  if (t.startsWith('Enum.')) {
    const enumType = t.slice(5)
    if (v instanceof EnumItem) { if (v.enumType === enumType) return v; return fail() }
    if (typeof v === 'string') return enumItem(enumType, v)
    if (typeof v === 'number') {
      const name = Enums[enumType]?.[v]
      if (name) return enumItem(enumType, name)
    }
    return fail()
  }
  return v
}

function luauTypeName(v: unknown) {
  if (v === null || v === undefined) return 'nil'
  if (v instanceof Instance) return 'Instance'
  if (typeof v === 'object') return (v as object).constructor?.name ?? 'table'
  return typeof v
}

function cleanTraceback(tb: string) {
  return tb
    .split('\n')
    .filter((l) => l.trim() && !l.includes('RossEngine.Prelude') && l.trim() !== '[C]' && !l.includes('stack traceback'))
    .map((l) => '  ' + l.trim())
    .join('\n')
}

const isEngineValue = (v: unknown) =>
  v instanceof Instance || v instanceof Vector3 || v instanceof CFrame || v instanceof Color3 || v instanceof Vector2
  || v instanceof UDim2 || v instanceof UDim || v instanceof EnumItem || v instanceof Multi

/** Pyodide proxies (detected structurally so the Luau runtime doesn't depend on Pyodide). */
function isForeignProxy(v: unknown) {
  return !!v && (typeof v === 'object' || typeof v === 'function') && typeof (v as any).toJs === 'function' && typeof (v as any).destroy === 'function'
}

/** Luau tables arrive as Maps; foreign code expects arrays/objects. */
export function plainify(v: unknown): unknown {
  if (v instanceof Map) {
    const keys = [...v.keys()]
    if (keys.length && keys.every((k, i) => k === i + 1)) return [...v.values()].map(plainify)
    const o: Record<string, unknown> = {}
    for (const [k, x] of v) o[String(k)] = plainify(x)
    return o
  }
  return v
}
