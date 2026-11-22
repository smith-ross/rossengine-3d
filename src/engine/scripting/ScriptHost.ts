// The JavaScript-side scripting API, shared by TypeScript scripts (directly) and Python scripts
// (through Pyodide's JS proxies). It also owns the cross-language module registry: require() from
// any language goes through here, so Luau, TypeScript and Python modules can import each other.
import { CFrame, Color3, EnumItem, Enums, UDim, UDim2, Vector2, Vector3, enumItem } from '../datatypes'
import { Instance, addEventSink, createInstance, getClass, isA } from '../instance'
import { DataModel, Multi } from '../classes'
import { coerce, type LuauRuntime, type OutputSink } from '../luau/LuauRuntime'
import { ScriptLanguage, languageOf, resolveModule } from './languages'

export const SCRIPT_TIMEOUT_MS = 8000

export interface LanguageRuntime {
  readonly language: ScriptLanguage
  runScript(script: Instance): void
  loadModule(module: Instance): unknown
}

type Owner = Instance | null
type Fn = (...args: any[]) => any

// ---- API datatypes that only exist for JS/Python ----------------------------------------------
export class TweenInfo {
  constructor(
    public time = 1, public style = 'Quad', public direction = 'Out',
    public repeatCount = 0, public reverses = false, public delay = 0,
  ) {}
  static new(time = 1, style?: EnumItem, direction?: EnumItem, repeatCount = 0, reverses = false, delay = 0) {
    return new TweenInfo(time, style?.name ?? 'Quad', direction?.name ?? 'Out', repeatCount, reverses, delay)
  }
  get Time() { return this.time }
  get EasingStyle() { return enumItem('EasingStyle', this.style) }
  get EasingDirection() { return enumItem('EasingDirection', this.direction) }
  get RepeatCount() { return this.repeatCount }
  get Reverses() { return this.reverses }
  get DelayTime() { return this.delay }
}

export class RaycastParams {
  FilterDescendantsInstances: unknown[] = []
  FilterType: EnumItem = enumItem('RaycastFilterType', 'Exclude')
  RespectCanCollide = false
  static new() { return new RaycastParams() }
}

// ---- signals ---------------------------------------------------------------------------------
interface Conn { fn: Fn; owner: Owner; connected: boolean; once: boolean }

class Connection {
  constructor(private c: Conn, private list: Conn[]) {}
  get Connected() { return this.c.connected }
  Disconnect() {
    this.c.connected = false
    const i = this.list.indexOf(this.c)
    if (i >= 0) this.list.splice(i, 1)
  }
}

export class Signal {
  readonly conns: Conn[] = []
  private waiters: Array<{ resolve: (v: unknown) => void; owner: Owner }> = []
  constructor(private host: ScriptHost, readonly name: string) {}
  Connect(fn: Fn) {
    if (typeof fn !== 'function') throw new Error('Attempt to connect failed: Passed value is not a function')
    const c: Conn = { fn: this.host.keepCallback(fn), owner: this.host.currentScript, connected: true, once: false }
    this.conns.push(c)
    return new Connection(c, this.conns)
  }
  Once(fn: Fn) {
    const conn = this.Connect(fn)
    this.conns[this.conns.length - 1].once = true
    return conn
  }
  /** Resolves with the first argument the event fires with. */
  Wait(): Promise<unknown> {
    return new Promise((resolve) => this.waiters.push({ resolve, owner: this.host.currentScript }))
  }
  fire(args: unknown[]) {
    for (const c of [...this.conns]) {
      if (!c.connected || this.host.isDead(c.owner)) continue
      if (c.once) { c.connected = false; this.conns.splice(this.conns.indexOf(c), 1) }
      this.host.invoke(c.fn, args, c.owner)
    }
    const w = this.waiters.splice(0)
    for (const x of w) if (!this.host.isDead(x.owner)) x.resolve(args[0])
  }
  toString() { return `Signal ${this.name}` }
}

// ---- host -------------------------------------------------------------------------------------
export class ScriptHost {
  readonly runtimes = new Map<ScriptLanguage, LanguageRuntime>()
  readonly api: Record<string, unknown>
  currentScript: Owner = null
  entryStart = performance.now()
  time = 0
  destroyed = false
  /** set by the Python runtime: detects and converts Pyodide proxies */
  foreign: { isProxy(v: unknown): boolean; toJs(v: unknown): unknown; keep(fn: unknown): Fn } | null = null

  private proxies = new WeakMap<Instance, object>()
  private targets = new WeakMap<object, Instance>()
  private signals = new Map<Instance, Map<string, Signal>>()
  private waits: Array<{ resolve: (v: number) => void; at: number; start: number; owner: Owner }> = []
  private deferred: Array<() => void> = []
  private dead = new Set<Instance>()
  private modules = new Map<Instance, { loading: boolean; value?: unknown; error?: unknown }>()
  private renderBindings = new Map<string, { priority: number; fn: Fn; owner: Owner }>()
  private jsProps = new WeakMap<Instance, Map<string, unknown>>()
  private queue: Array<[Signal, unknown[]]> = []
  private flushScheduled = false
  private disposers: Array<() => void> = []

  constructor(readonly game: DataModel, readonly output: OutputSink, readonly luau: LuauRuntime | null) {
    this.disposers.push(addEventSink((inst, event, args) => this.onEngineEvent(inst, event, args)))
    this.disposers.push(game.observe({ changed: (inst, prop) => this.onChanged(inst, prop) }))
    this.api = this.buildApi()
    if (luau) {
      luau.foreignRequire = (inst) => this.requireModule(inst)
      luau.unwrapApi = (v) => this.unwrap(v)
    }
  }

  destroy() {
    this.destroyed = true
    for (const d of this.disposers) d()
    this.signals.clear()
    this.waits = []
  }

  // ------------------------------------------------------------------ wrapping
  wrap(inst: Instance): object {
    let p = this.proxies.get(inst)
    if (p) return p
    const host = this
    p = new Proxy({}, {
      get(_t, key) { return host.getMember(inst, key) },
      set(_t, key, value) { host.setMember(inst, key, value); return true },
      has(_t, key) { return typeof key === 'string' && host.hasMember(inst, key) },
    })
    this.proxies.set(inst, p)
    this.targets.set(p, inst)
    return p
  }

  unwrap(v: unknown): Instance | null {
    if (v instanceof Instance) return v
    if (!v || typeof v !== 'object') return null
    return this.targets.get(v as object) ?? null
  }

  /** Engine value -> API value */
  toApi(v: unknown): unknown {
    if (v instanceof Instance) return this.wrap(v)
    if (v instanceof Multi) return v.values.map((x) => this.toApi(x))
    if (Array.isArray(v)) return v.map((x) => this.toApi(x))
    if (v instanceof Map) {
      const keys = [...v.keys()]
      if (keys.length && keys.every((k, i) => k === i + 1)) return [...v.values()].map((x) => this.toApi(x))
      const o: Record<string, unknown> = {}
      for (const [k, x] of v) o[String(k)] = this.toApi(x)
      return o
    }
    return v
  }

  /** API value (JS or Python) -> engine value */
  fromApi(v: unknown): unknown {
    if (v === undefined || v === null) return null
    if (typeof v !== 'object' && typeof v !== 'function') return v
    const inst = this.unwrap(v)
    if (inst) return inst
    if (this.foreign?.isProxy(v)) {
      if (typeof v === 'function') return this.foreign.keep(v)
      return this.fromApi(this.foreign.toJs(v))
    }
    if (v instanceof RaycastParams) {
      return new Map<string, unknown>([
        ['FilterDescendantsInstances', this.fromApi(v.FilterDescendantsInstances)],
        ['FilterType', v.FilterType],
        ['RespectCanCollide', v.RespectCanCollide],
      ])
    }
    if (Array.isArray(v)) return new Map(v.map((x, i) => [i + 1, this.fromApi(x)]))
    if (v instanceof Map) return new Map([...v].map(([k, x]) => [k, this.fromApi(x)]))
    const proto = Object.getPrototypeOf(v)
    if (proto === Object.prototype || proto === null) return new Map(Object.entries(v as object).map(([k, x]) => [k, this.fromApi(x)]))
    return v
  }

  /** Keep a callback alive beyond the current call (Pyodide destroys borrowed proxies). */
  keepCallback(fn: Fn): Fn {
    return this.foreign?.isProxy(fn) ? this.foreign.keep(fn) : fn
  }

  // ------------------------------------------------------------------ members
  private jsMembers(inst: Instance, key: string): Fn | undefined {
    const host = this
    switch (key) {
      case 'WaitForChild':
        return async (name: string, timeout?: number) => {
          const start = host.time
          let warned = false
          for (;;) {
            const c = inst.findFirstChild(String(name))
            if (c) return host.wrap(c)
            if (timeout !== undefined && timeout !== null && host.time - start >= timeout) return null
            if (!warned && timeout == null && host.time - start > 5) {
              warned = true
              host.output('warn', `Infinite yield possible on '${inst.getFullName()}:WaitForChild("${name}")'`)
            }
            await host.wait(0)
          }
        }
      case 'GetPropertyChangedSignal':
        return (prop: string) => {
          if (!inst.classInfo.props.has(String(prop))) throw new Error(`${prop} is not a valid property name.`)
          return host.signal(inst, 'Changed:' + prop)
        }
      case 'GetAttributeChangedSignal':
        return (attr: string) => host.signal(inst, 'AttributeChanged:' + attr)
    }
    if (isA(inst.classInfo, 'BindableFunction') && key === 'Invoke') {
      return (...args: unknown[]) => {
        const f = host.jsProps.get(inst)?.get('OnInvoke') as Fn | undefined
        if (!f) throw new Error('BindableFunction has no OnInvoke callback')
        return f(...args)
      }
    }
    if (inst.className === 'RunService' && key === 'BindToRenderStep') {
      return (name: string, priority: number, fn: Fn) => {
        host.renderBindings.set(String(name), { priority: Number(priority) || 0, fn: host.keepCallback(fn), owner: host.currentScript })
      }
    }
    if (inst.className === 'RunService' && key === 'UnbindFromRenderStep') return (name: string) => { host.renderBindings.delete(String(name)) }
    return undefined
  }

  private getMember(inst: Instance, key: string | symbol): unknown {
    if (typeof key === 'symbol') {
      if (key === Symbol.toPrimitive) return () => inst.name
      if (key === Symbol.toStringTag) return 'Instance'
      return undefined
    }
    if (key === 'then' || key === 'constructor') return undefined // not a thenable, not a class
    if (key === 'toString') return () => inst.name
    if (key === 'ClassName') return inst.className
    const js = this.jsMembers(inst, key)
    if (js) return js
    const info = inst.classInfo
    if (key === 'Parent' || info.props.has(key)) return this.toApi(inst.get(key))
    const m = info.methods.get(key)
    if (m) return (...args: unknown[]) => this.toApi(m(inst, ...args.map((a) => this.fromApi(a))))
    if (info.events.has(key)) return this.signal(inst, key)
    const jp = this.jsProps.get(inst)
    if (jp?.has(key)) return jp.get(key)
    const child = inst.findFirstChild(key)
    if (child) return this.wrap(child)
    return undefined
  }

  private setMember(inst: Instance, key: string | symbol, value: unknown) {
    if (typeof key === 'symbol') return
    const def = inst.classInfo.props.get(key)
    if (def) {
      if (def.readonly) throw new Error(`Unable to assign property ${key}. Property is read only`)
      inst.set(key, coerce(def, key, this.fromApi(value)))
      return
    }
    if (key === 'Parent') { inst.setParent(this.unwrap(value)); return }
    if (key === 'OnInvoke' && isA(inst.classInfo, 'BindableFunction')) {
      let m = this.jsProps.get(inst)
      if (!m) { m = new Map(); this.jsProps.set(inst, m) }
      m.set(key, typeof value === 'function' ? this.keepCallback(value as Fn) : value)
      return
    }
    throw new Error(`${key} is not a valid member of ${inst.className} "${inst.getFullName()}"`)
  }

  private hasMember(inst: Instance, key: string) {
    const info = inst.classInfo
    return key === 'ClassName' || key === 'Parent' || info.props.has(key) || info.methods.has(key) || info.events.has(key)
      || !!this.jsMembers(inst, key) || !!inst.findFirstChild(key)
  }

  // ------------------------------------------------------------------ events
  signal(inst: Instance, name: string): Signal {
    let m = this.signals.get(inst)
    if (!m) { m = new Map(); this.signals.set(inst, m) }
    let s = m.get(name)
    if (!s) { s = new Signal(this, name); m.set(name, s) }
    return s
  }

  private enqueue(s: Signal, args: unknown[]) {
    this.queue.push([s, args])
    if (!this.flushScheduled) {
      this.flushScheduled = true
      queueMicrotask(() => this.flush())
    }
  }

  private flush() {
    this.flushScheduled = false
    let guard = 0
    while (this.queue.length && guard++ < 1000 && !this.destroyed) {
      const [s, args] = this.queue.shift()!
      s.fire(args)
    }
  }

  private onEngineEvent(inst: Instance, event: string, args: unknown[]) {
    if (this.destroyed) return
    const s = this.signals.get(inst)?.get(event)
    if (s && (s.conns.length || (s as any).waiters?.length)) this.enqueue(s, args.map((a) => this.toApi(a)))
  }

  private onChanged(inst: Instance, prop: string) {
    const m = this.signals.get(inst)
    if (!m || this.destroyed) return
    const changed = m.get('Changed')
    if (changed) {
      if (!isA(inst.classInfo, 'ValueBase')) this.enqueue(changed, [prop])
      else if (prop === 'Value') this.enqueue(changed, [this.toApi(inst.get('Value'))])
    }
    const specific = m.get('Changed:' + prop)
    if (specific) this.enqueue(specific, [])
  }

  /** Frame events (Heartbeat, RenderStepped...) are delivered immediately to every language. */
  fireFrame(inst: Instance, event: string, args: unknown[]) {
    this.luau?.fireNow(inst, event, args)
    const s = this.signals.get(inst)?.get(event)
    if (s) { this.entryStart = performance.now(); s.fire(args) }
  }

  renderStep(dt: number) {
    this.luau?.renderStep(dt)
    const list = [...this.renderBindings.values()].sort((a, b) => a.priority - b.priority)
    for (const b of list) if (!this.isDead(b.owner)) this.invoke(b.fn, [dt], b.owner)
  }

  // ------------------------------------------------------------------ scheduler
  wait(seconds = 0): Promise<number> {
    if (this.destroyed) return new Promise(() => {})
    return new Promise((resolve) => this.waits.push({ resolve, at: this.time + (Number(seconds) || 0), start: this.time, owner: this.currentScript }))
  }

  step(time: number) {
    this.time = time
    this.entryStart = performance.now()
    this.luau?.step(time)
    if (this.waits.length) {
      const due = this.waits.filter((w) => w.at <= time).sort((a, b) => a.at - b.at)
      if (due.length) {
        this.waits = this.waits.filter((w) => w.at > time)
        for (const w of due) if (!this.isDead(w.owner)) w.resolve(time - w.start)
      }
    }
    const d = this.deferred.splice(0)
    for (const f of d) f()
  }

  /** Run a script-owned callback with error reporting (sync errors and rejected promises). */
  invoke(fn: Fn, args: unknown[], owner: Owner) {
    if (this.destroyed) return
    const prev = this.currentScript
    this.currentScript = owner
    this.entryStart = performance.now()
    try {
      const r = fn(...args)
      if (r && typeof (r as any).then === 'function') Promise.resolve(r).catch((e) => this.reportError(e, owner))
      return r
    } catch (e) {
      this.reportError(e, owner)
    } finally {
      this.currentScript = prev
    }
  }

  isListening(inst: Instance, event: string) {
    const s = this.signals.get(inst)?.get(event)
    return !!this.luau?.isListening(inst, event) || !!(s && s.conns.length)
  }

  /** how long script code may run without yielding */
  timeoutMs = SCRIPT_TIMEOUT_MS
  timeExceeded() { return performance.now() - this.entryStart > this.timeoutMs }

  isDead(owner: Owner) { return !!owner && this.dead.has(owner) }

  // ------------------------------------------------------------------ scripts & modules
  runScript(script: Instance) {
    const lang = languageOf(script)
    this.dead.delete(script)
    if (lang === 'Luau') { this.luau?.runScript(script); return }
    const rt = this.runtimes.get(lang)
    if (!rt) { this.output('error', `${lang} scripts can't run: the ${lang} runtime is not available`, script.getFullName()); return }
    const prev = this.currentScript
    this.currentScript = script
    this.entryStart = performance.now()
    try { rt.runScript(script) } catch (e) { this.reportError(e, script) } finally { this.currentScript = prev }
  }

  kill(script: Instance) {
    this.dead.add(script)
    this.modules.delete(script)
    if (languageOf(script) === 'Luau') this.luau?.killScript(script)
  }

  /** require(target) as seen from `from`: target is a ModuleScript or a path string. */
  requireFrom(from: Instance | null, target: unknown, sep: '/' | '.' = '/'): unknown {
    const inst = typeof target === 'string' ? resolveModule(target, from, sep) : this.unwrap(target)
    if (!inst || inst.className !== 'ModuleScript') {
      throw new Error(typeof target === 'string' ? `Module "${target}" was not found` : 'Attempted to call require with invalid argument(s).')
    }
    return this.requireModule(inst)
  }

  requireModule(inst: Instance): unknown {
    const cached = this.modules.get(inst)
    if (cached) {
      if (cached.loading) throw new Error(`Circular require of "${inst.getFullName()}"`)
      if (cached.error) throw new Error('Requested module experienced an error while loading')
      return cached.value
    }
    const lang = languageOf(inst)
    const entry: { loading: boolean; value?: unknown; error?: unknown } = { loading: true }
    this.modules.set(inst, entry)
    try {
      let value: unknown
      if (lang === 'Luau') {
        if (!this.luau) throw new Error('Luau runtime unavailable')
        value = this.luau.requireLive(inst)
      } else {
        const rt = this.runtimes.get(lang)
        if (!rt) throw new Error(`the ${lang} runtime is not available`)
        const prev = this.currentScript
        this.currentScript = inst
        try { value = rt.loadModule(inst) } finally { this.currentScript = prev }
      }
      entry.value = value
      return value
    } catch (e) {
      entry.error = e
      this.reportError(e, inst)
      throw new Error('Requested module experienced an error while loading')
    } finally {
      entry.loading = false
    }
  }

  /** Globals for one script (or module) of a JS-hosted language. */
  globalsFor(script: Instance, sep: '/' | '.' = '/'): Record<string, unknown> {
    return { ...this.api, script: this.wrap(script), require: (t: unknown) => this.requireFrom(script, t, sep) }
  }

  // ------------------------------------------------------------------ errors & output
  /** Language runtimes register a formatter that turns their errors into "Script:line: message". */
  formatters: Array<(e: unknown) => string | null> = []

  reportError(e: unknown, owner: Owner) {
    if (this.destroyed) return
    let msg: string | null = null
    for (const f of this.formatters) { msg = f(e); if (msg) break }
    if (!msg) msg = String((e as Error)?.message ?? e)
    this.output('error', msg, owner?.getFullName())
  }

  // ------------------------------------------------------------------ API
  private buildApi(): Record<string, unknown> {
    const host = this
    const fmt = (args: unknown[]) => args.map((a) => (a === undefined || a === null ? 'nil' : String(a))).join(' ')
    const task = {
      wait: (t?: number) => host.wait(t),
      spawn: (fn: Fn, ...args: unknown[]) => host.invoke(host.keepCallback(fn), args, host.currentScript),
      defer: (fn: Fn, ...args: unknown[]) => {
        const f = host.keepCallback(fn), owner = host.currentScript
        host.deferred.push(() => host.invoke(f, args, owner))
      },
      delay: (t: number, fn: Fn, ...args: unknown[]) => {
        const f = host.keepCallback(fn), owner = host.currentScript
        const handle = { cancelled: false }
        void host.wait(t).then(() => { if (!handle.cancelled) host.invoke(f, args, owner) })
        return handle
      },
      cancel: (handle: { cancelled?: boolean } | null) => { if (handle) handle.cancelled = true },
    }
    const enumProxy = new Proxy({}, {
      get(_t, typeName) {
        if (typeof typeName !== 'string' || !Enums[typeName]) return undefined
        const items = Enums[typeName]
        return new Proxy({}, {
          get(_u, item) {
            if (item === 'GetEnumItems') return () => items.map((n) => enumItem(typeName, n))
            if (typeof item !== 'string' || !items.includes(item)) return undefined
            return enumItem(typeName, item)
          },
          has(_u, item) { return typeof item === 'string' && items.includes(item) },
        })
      },
      has(_t, typeName) { return typeof typeName === 'string' && !!Enums[typeName] },
    })
    return {
      game: this.wrap(this.game),
      workspace: this.wrap(this.game.workspace),
      Instance: {
        new: (className: string, parent?: unknown) => {
          const info = getClass(String(className))
          if (!info || !info.creatable) throw new Error(`Unable to create an Instance of type "${className}"`)
          const inst = createInstance(String(className))
          const p = this.unwrap(parent)
          if (p) inst.setParent(p)
          return this.wrap(inst)
        },
      },
      Vector3, Vector2, CFrame, Color3, UDim, UDim2, TweenInfo, RaycastParams,
      Enum: enumProxy,
      task,
      wait: (t?: number) => host.wait(t ?? 0.03),
      delay: task.delay,
      spawn: task.defer,
      tick: () => Date.now() / 1000,
      time: () => host.time,
      print: (...args: unknown[]) => host.output('info', fmt(args)),
      warn: (...args: unknown[]) => host.output('warn', fmt(args)),
    }
  }
}
