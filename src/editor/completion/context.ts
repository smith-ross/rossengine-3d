// Resolves what the code before the cursor refers to, using the real place tree, so completions know
// about children (workspace.Baseplate), services, locals assigned from those, Instance.new(...) and
// event-handler parameters. Shared by Luau, TypeScript and Python.
import { Instance, getClass, allClasses, isA } from '../../engine/instance'
import { DataModel, SERVICE_ALIASES } from '../../engine/classes'
import { ScriptLanguage } from '../../engine/scripting/languages'

export type Target =
  | { kind: 'instance'; inst: Instance | null; cls: string }
  | { kind: 'signal'; event: string; owner: string }

export interface Ctx {
  game: DataModel
  script: Instance
  /** source text before the cursor */
  before: string
  lang: ScriptLanguage
}

/** Classes passed to event handlers, for typing `function(hit)` parameters. */
export const EVENT_ARG_CLASSES: Record<string, string[]> = {
  Touched: ['BasePart'], TouchEnded: ['BasePart'], ChildAdded: ['Instance'], ChildRemoved: ['Instance'],
  DescendantAdded: ['Instance'], DescendantRemoving: ['Instance'], PlayerAdded: ['Player'], PlayerRemoving: ['Player'],
  CharacterAdded: ['Model'], CharacterRemoving: ['Model'], InputBegan: ['InputObject'], InputEnded: ['InputObject'],
  InputChanged: ['InputObject'], MouseClick: ['Player'], RightMouseClick: ['Player'], MouseHoverEnter: ['Player'],
  BodyEntered: ['Node2D'], BodyExited: ['Node2D'],
}

/** Instance-typed properties whose class is more specific than "Instance". */
const PROP_CLASS: Record<string, string> = {
  PrimaryPart: 'BasePart', Character: 'Model', LocalPlayer: 'Player', CurrentCamera: 'Camera', Target: 'BasePart',
  Part0: 'BasePart', Part1: 'BasePart', CameraSubject: 'Humanoid', RootPart: 'BasePart', CurrentCamera2D: 'Camera2D',
}

const IDENT = /^[A-Za-z_][\w]*/

/** Extract the member-access chain that ends at the cursor, e.g. `script.Parent:WaitForChild("Door")`. */
export function trailingExpression(text: string): string {
  let i = text.length - 1
  let depth = 0
  while (i >= 0) {
    const c = text[i]
    if (c === ')' || c === ']') { depth++; i--; continue }
    if (c === '(' || c === '[') { if (depth === 0) break; depth--; i--; continue }
    if (c === '"' || c === "'" || c === '`') {
      const q = c
      i--
      while (i >= 0 && text[i] !== q) i--
      i--
      continue
    }
    if (depth > 0) { i--; continue }
    if (/[\w.:]/.test(c)) { i--; continue }
    break
  }
  return text.slice(i + 1).replace(/^await\s+/, '')
}

interface Seg { sep: '.' | ':' | '['; name: string; call: boolean; arg?: string }

function parseChain(expr: string): { root: string; segs: Seg[] } | null {
  const m = IDENT.exec(expr)
  if (!m) return null
  const root = m[0]
  let i = root.length
  const segs: Seg[] = []
  while (i < expr.length) {
    const c = expr[i]
    if (c === '.' || c === ':') {
      const n = IDENT.exec(expr.slice(i + 1))
      if (!n) return { root, segs }
      i += 1 + n[0].length
      const seg: Seg = { sep: c, name: n[0], call: false }
      if (expr[i] === '(') {
        const close = matching(expr, i)
        if (close < 0) return { root, segs }
        const inner = expr.slice(i + 1, close)
        seg.call = true
        const s = /^\s*(["'`])(.*?)\1/.exec(inner)
        if (s) seg.arg = s[2]
        i = close + 1
      }
      segs.push(seg)
    } else if (c === '[') {
      const close = matching(expr, i)
      if (close < 0) return { root, segs }
      const s = /^\s*(["'])(.*?)\1\s*$/.exec(expr.slice(i + 1, close))
      if (!s) return null
      segs.push({ sep: '[', name: s[2], call: false })
      i = close + 1
    } else if (c === '(' && segs.length === 0) {
      // root call like Instance.new handled by segments; plain calls are unknown
      return null
    } else return { root, segs }
  }
  return { root, segs }
}

function matching(s: string, open: number) {
  const o = s[open], cl = o === '(' ? ')' : ']'
  let d = 0
  for (let i = open; i < s.length; i++) {
    if (s[i] === '"' || s[i] === "'") { const q = s[i]; i++; while (i < s.length && s[i] !== q) i++; continue }
    if (s[i] === o) d++
    else if (s[i] === cl) { d--; if (d === 0) return i }
  }
  return -1
}

const inst = (i: Instance | null, cls?: string): Target => ({ kind: 'instance', inst: i, cls: cls ?? i?.className ?? 'Instance' })

/** Resolve an expression (no trailing separator) to an instance/class or a signal. */
export function resolveExpression(expr: string, ctx: Ctx, depth = 0): Target | null {
  if (depth > 6) return null
  expr = expr.trim().replace(/^await\s+/, '')
  // Instance.new("Part") / Instance.new("Part", parent)
  const newM = /^Instance\.new\(\s*["'](\w+)["']/.exec(expr)
  if (newM) {
    const rest = expr.slice(matching(expr, expr.indexOf('(')) + 1)
    const base = inst(null, newM[1])
    return rest ? walk(base, parseChain('x' + rest)?.segs ?? [], ctx) : base
  }
  const chain = parseChain(expr)
  if (!chain) return null
  let t: Target | null = null
  const g = ctx.game
  switch (chain.root) {
    case 'game': case 'Game': t = inst(g); break
    case 'workspace': case 'Workspace': t = inst(g.workspace); break
    case 'script': t = inst(ctx.script); break
    default: t = resolveLocal(chain.root, ctx, depth)
  }
  if (!t) return null
  return walk(t, chain.segs, ctx)
}

function walk(start: Target, segs: Seg[], ctx: Ctx): Target | null {
  let t: Target | null = start
  for (const s of segs) {
    if (!t) return null
    t = step(t, s, ctx)
  }
  return t
}

function step(t: Target, s: Seg, ctx: Ctx): Target | null {
  if (t.kind === 'signal') return null
  const info = getClass(t.cls)
  const i = t.inst
  if (s.sep === '[') return i ? (i.findFirstChild(s.name) ? inst(i.findFirstChild(s.name)) : null) : null
  if (s.call) {
    switch (s.name) {
      case 'GetService': case 'FindService': {
        const name = s.arg ? SERVICE_ALIASES[s.arg] ?? s.arg : null
        if (!name) return null
        const svc = ctx.game.children.find((c) => c.className === name) ?? null
        return inst(svc, name)
      }
      case 'WaitForChild': case 'FindFirstChild': case 'FindFirstDescendant': {
        const c = i && s.arg ? (s.name === 'FindFirstDescendant' ? i.getDescendants().find((d) => d.name === s.arg) : i.findFirstChild(s.arg)) : null
        return c ? inst(c) : inst(null, 'Instance')
      }
      case 'FindFirstChildOfClass': case 'FindFirstChildWhichIsA': case 'FindFirstAncestorOfClass': case 'FindFirstAncestorWhichIsA': {
        if (!s.arg || !getClass(s.arg)) return null
        const c = i ? (s.name.includes('Ancestor')
          ? ancestors(i).find((a) => a.isA(s.arg!))
          : i.children.find((x) => x.isA(s.arg!))) ?? null : null
        return inst(c, s.arg)
      }
      case 'FindFirstAncestor': {
        const a = i && s.arg ? ancestors(i).find((x) => x.name === s.arg) ?? null : null
        return a ? inst(a) : inst(null, 'Instance')
      }
      case 'Clone': return inst(null, t.cls)
      case 'GetPropertyChangedSignal': case 'GetAttributeChangedSignal': return { kind: 'signal', event: 'Changed', owner: t.cls }
      case 'GetMouse': return inst(null, 'Mouse')
      case 'GetPlayerFromCharacter': return inst(null, 'Player')
      case 'Create': return t.cls === 'TweenService' ? inst(null, 'Tween') : null
      case 'Wait': return null
    }
    return null
  }
  if (s.name === 'Parent') return i?.parent ? inst(i.parent) : inst(null, 'Instance')
  if (info) {
    const def = info.props.get(s.name)
    if (def) {
      if (def.type !== 'Instance') return null
      const v = i ? (i.get(s.name) as Instance | null) : null
      return inst(v ?? null, v?.className ?? PROP_CLASS[s.name] ?? 'Instance')
    }
    if (info.events.has(s.name)) return { kind: 'signal', event: s.name, owner: t.cls }
  }
  if (i) {
    const c = i.findFirstChild(s.name)
    if (c) return inst(c)
    // services are reachable by name from game (game.Players)
    if (i.className === 'DataModel') {
      const svcName = SERVICE_ALIASES[s.name] ?? s.name
      if (getClass(svcName)?.service) return inst(i.children.find((x) => x.className === svcName) ?? null, svcName)
    }
  }
  return null
}

function ancestors(i: Instance) { const out: Instance[] = []; for (let p = i.parent; p; p = p.parent) out.push(p); return out }

/** Find what a local variable was last assigned (or which event handler it is a parameter of). */
function resolveLocal(name: string, ctx: Ctx, depth: number): Target | null {
  const lines = ctx.before.split('\n')
  for (let li = lines.length - 1; li >= 0; li--) {
    const line = lines[li]
    // assignment: local x = ..., const x: T = ..., x = ...
    const a = new RegExp(`(?:^|[\\s;])(?:local|const|let|var)?\\s*${name}\\s*(?::\\s*[\\w.<>| ]+)?=\\s*([^=].*)$`).exec(line)
    if (a && !/^\s*=/.test(a[1])) {
      const rhs = a[1].replace(/\s*(?:--|\/\/|#).*$/, '').replace(/\s+as\s+\w+\s*$/, '').replace(/[;,]\s*$/, '').trim()
      // `x or await ...` (Python/Luau fallbacks): use the first resolvable part
      for (const part of rhs.split(/\s+or\s+|\s*\|\|\s*|\s*\?\?\s*/)) {
        const r = resolveExpression(part, { ...ctx, before: lines.slice(0, li).join('\n') }, depth + 1)
        if (r) return r
      }
      const cast = /as\s+(\w+)\s*$/.exec(a[1])
      if (cast && getClass(cast[1])) return inst(null, cast[1])
      return null
    }
    // typed declaration without a resolvable value: `local part: BasePart`, `const p: Part = ...`
    const typed = new RegExp(`(?:local|const|let|var)\\s+${name}\\s*:\\s*(\\w+)`).exec(line)
    if (typed && getClass(typed[1])) return inst(null, typed[1])
    // event handler parameter: sig:Connect(function(a, b)  /  sig.Connect((a, b) =>  /  def handler(a)
    const h = /(.+?)[:.](?:Connect|Once)\(\s*(?:function\s*\(([^)]*)\)|\(?([\w\s,:]*?)\)?\s*=>)/.exec(line)
    if (h) {
      const params = (h[2] ?? h[3] ?? '').split(',').map((p) => p.split(':')[0].trim())
      const idx = params.indexOf(name)
      if (idx >= 0) {
        const sig = resolveExpression(trailingExpression(h[1]), { ...ctx, before: lines.slice(0, li).join('\n') }, depth + 1)
        const ev = sig?.kind === 'signal' ? sig.event : /(\w+)$/.exec(h[1])?.[1]
        const cls = ev ? EVENT_ARG_CLASSES[ev]?.[idx] : undefined
        if (cls) return inst(null, cls)
      }
    }
    // Python/Luau for loops over children: for child in x.GetChildren() / for _, child in x:GetChildren()
    const f = new RegExp(`for\\s+(?:\\w+\\s*,\\s*)?${name}\\s+in\\s+(?:i?pairs\\()?(.+?)[:.](?:GetChildren|GetDescendants)\\(`).exec(line)
    if (f) return inst(null, 'Instance')
  }
  return null
}

// ---- members ----------------------------------------------------------------------------------
export interface Member { name: string; kind: 'property' | 'method' | 'event' | 'child'; detail: string; colon?: boolean }

const LUAU_ONLY: Record<string, string[]> = {
  Instance: ['WaitForChild', 'GetPropertyChangedSignal', 'GetAttributeChangedSignal'],
  RunService: ['BindToRenderStep', 'UnbindFromRenderStep'],
  BindableFunction: ['Invoke'],
  RemoteFunction: ['InvokeServer', 'InvokeClient'],
  ContextActionService: ['BindAction', 'UnbindAction'],
}
const JS_ONLY: Record<string, string[]> = {
  Instance: ['WaitForChild', 'GetPropertyChangedSignal', 'GetAttributeChangedSignal'],
  RunService: ['BindToRenderStep', 'UnbindFromRenderStep'],
  BindableFunction: ['Invoke'],
  RemoteFunction: ['InvokeServer', 'InvokeClient'],
}

export function membersOf(t: Target, lang: ScriptLanguage): Member[] {
  if (t.kind === 'signal') {
    return ['Connect', 'Once', 'Wait'].map((n) => ({ name: n, kind: 'method' as const, detail: `RBXScriptSignal ${n}` }))
  }
  const info = getClass(t.cls)
  if (!info) return []
  const out: Member[] = []
  const seen = new Set<string>()
  const add = (m: Member) => { if (!seen.has(m.name)) { seen.add(m.name); out.push(m) } }
  if (t.inst) {
    for (const c of t.inst.children) {
      if ((c as any).transient || c.name === '__Mouse') continue
      add({ name: c.name, kind: 'child', detail: c.className })
    }
    if (t.inst.className === 'DataModel') for (const c of t.inst.children) add({ name: c.className, kind: 'child', detail: 'service' })
  }
  add({ name: 'Parent', kind: 'property', detail: 'Instance' })
  add({ name: 'Name', kind: 'property', detail: 'string' })
  add({ name: 'ClassName', kind: 'property', detail: 'string' })
  for (const [name, def] of info.props) if (name !== 'Tags') add({ name, kind: 'property', detail: def.type.startsWith('Enum.') ? def.type.replace('.', '') : def.type })
  for (const e of info.events) if (!e.startsWith('__')) add({ name: e, kind: 'event', detail: 'RBXScriptSignal' })
  const extra = lang === 'Luau' ? LUAU_ONLY : JS_ONLY
  const methods = new Set([...info.methods.keys()].filter((m) => !m.startsWith('__')))
  for (let c: typeof info | undefined = info; c; c = c.superclass) for (const m of extra[c.name] ?? []) methods.add(m)
  for (const m of methods) add({ name: m, kind: 'method', detail: 'method', colon: lang === 'Luau' })
  return out
}

// ---- string arguments ---------------------------------------------------------------------------
/** Completions inside a string argument, e.g. GetService("|"), WaitForChild("|"), Instance.new("|"), require("|"). */
export function stringArgumentOptions(ctx: Ctx): { options: Array<{ label: string; detail: string }>; prefix: string } | null {
  const m = /([\w.:\]\)]*?)[:.]?(GetService|FindService|WaitForChild|FindFirstChild|FindFirstAncestor|FindFirstChildOfClass|FindFirstChildWhichIsA|IsA|new|require|GetPropertyChangedSignal)\(\s*(["'`])([^"'`]*)$/.exec(ctx.before)
  if (!m) return null
  const fn = m[2], prefix = m[4]
  const receiver = trailingExpression(ctx.before.slice(0, ctx.before.length - m[0].length + m[1].length))
  const opts: Array<{ label: string; detail: string }> = []
  switch (fn) {
    case 'GetService': case 'FindService':
      for (const c of allClasses()) if (c.service) opts.push({ label: c.name, detail: 'service' })
      break
    case 'new':
      if (!/Instance$/.test(ctx.before.slice(0, ctx.before.length - m[0].length + m[1].length).trimEnd()) && m[1] !== 'Instance') return null
      for (const c of allClasses()) if (c.creatable && !c.service) opts.push({ label: c.name, detail: c.category ?? 'class' })
      break
    case 'IsA': case 'FindFirstChildOfClass': case 'FindFirstChildWhichIsA':
      for (const c of allClasses()) opts.push({ label: c.name, detail: 'class' })
      break
    case 'WaitForChild': case 'FindFirstChild': case 'FindFirstAncestor': {
      const t = resolveExpression(receiver, ctx)
      if (t?.kind === 'instance' && t.inst) {
        const list = fn === 'FindFirstAncestor' ? ancestors(t.inst) : t.inst.children
        for (const c of list) opts.push({ label: c.name, detail: c.className })
      }
      break
    }
    case 'GetPropertyChangedSignal': {
      const t = resolveExpression(receiver, ctx)
      const info = t?.kind === 'instance' ? getClass(t.cls) : undefined
      if (info) for (const [n, def] of info.props) if (!def.hidden) opts.push({ label: n, detail: def.type })
      break
    }
    case 'require':
      for (const d of ctx.game.getDescendants()) {
        if (d.className !== 'ModuleScript' || d === ctx.script) continue
        opts.push({ label: modulePath(d), detail: 'ModuleScript' })
      }
      break
  }
  return { options: opts, prefix }
}

export function modulePath(m: Instance) {
  const parts: string[] = []
  for (let p: Instance | null = m; p && p.className !== 'DataModel'; p = p.parent) parts.unshift(p.parent?.className === 'DataModel' ? p.className : p.name)
  return parts.join('/')
}

export function isIdentifier(name: string) { return /^[A-Za-z_]\w*$/.test(name) }
export { isA }
