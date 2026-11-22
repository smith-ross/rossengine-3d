// Monaco completion items from the place-aware resolver (see context.ts).
import * as monaco from '../luau/monacoCore'
import { Enums } from '../../engine/datatypes'
import { Instance } from '../../engine/instance'
import { DataModel } from '../../engine/classes'
import { ScriptLanguage } from '../../engine/scripting/languages'
import { Ctx, isIdentifier, membersOf, resolveExpression, stringArgumentOptions, trailingExpression } from './context'

const K = monaco.languages.CompletionItemKind

export interface ResolvedCompletions {
  items: monaco.languages.CompletionItem[]
  /** true when the resolver understood the context, so other sources should be skipped */
  exclusive: boolean
}

export function placeCompletions(
  model: monaco.editor.ITextModel, position: monaco.Position, script: Instance, game: DataModel, lang: ScriptLanguage,
  opts: { childrenOnly?: boolean } = {},
): ResolvedCompletions | null {
  const before = model.getValueInRange(new monaco.Range(1, 1, position.lineNumber, position.column))
  const ctx: Ctx = { game, script, before, lang }
  const word = model.getWordUntilPosition(position)
  const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)

  // inside a string argument: GetService("|"), WaitForChild("|"), Instance.new("|"), require("|")
  const sa = stringArgumentOptions(ctx)
  if (sa) {
    const startCol = position.column - sa.prefix.length
    const r = new monaco.Range(position.lineNumber, startCol, position.lineNumber, position.column)
    return {
      exclusive: true,
      items: sa.options.map((o, i) => ({ label: o.label, kind: K.Value, detail: o.detail, insertText: o.label, range: r, sortText: String(i).padStart(4, '0') })),
    }
  }

  // member access: <expr>.| or <expr>:|
  const m = /([.:])(\w*)$/.exec(before)
  if (!m) return null
  const sep = m[1] as '.' | ':'
  const exprText = trailingExpression(before.slice(0, before.length - m[0].length))
  if (!exprText) return null
  const target = resolveExpression(exprText, ctx)
  if (!target) return null
  const dotCol = position.column - m[2].length - 1
  const dotRange = new monaco.Range(position.lineNumber, dotCol, position.lineNumber, dotCol + 1)
  const items: monaco.languages.CompletionItem[] = []
  for (const mem of membersOf(target, lang)) {
    if (opts.childrenOnly && mem.kind !== 'child') continue
    const isMethod = mem.kind === 'method'
    if (sep === ':' && !isMethod) continue // Luau: obj:x only calls methods
    const item: monaco.languages.CompletionItem = {
      label: { label: mem.name, description: mem.detail },
      kind: mem.kind === 'child' ? K.Folder : mem.kind === 'event' ? K.Event : isMethod ? K.Method : K.Property,
      detail: mem.kind === 'child' ? `${mem.detail} (child)` : mem.detail,
      insertText: mem.name,
      range,
      sortText: { child: '0', property: '1', event: '2', method: '3' }[mem.kind] + mem.name,
    }
    if (isMethod) {
      item.insertText = `${mem.name}($0)`
      item.insertTextRules = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
      // Luau methods are called with ':' — fix a typed '.' automatically
      if (lang === 'Luau' && sep === '.') item.additionalTextEdits = [{ range: dotRange, text: ':' }]
    }
    if (mem.kind === 'child' && !isIdentifier(mem.name)) {
      if (lang === 'Python') continue
      item.insertText = `["${mem.name}"]`
      item.additionalTextEdits = [{ range: dotRange, text: '' }]
      item.filterText = `.${mem.name}`
    }
    items.push(item)
  }
  return { items, exclusive: true }
}

// ---- Python: everything the API exposes outside of instances ----------------------------------
const PY_KEYWORDS = ['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del',
  'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or',
  'pass', 'raise', 'return', 'try', 'while', 'with', 'yield']
const PY_BUILTINS = ['print', 'len', 'range', 'enumerate', 'zip', 'list', 'dict', 'set', 'tuple', 'str', 'int', 'float', 'bool',
  'abs', 'min', 'max', 'sum', 'round', 'sorted', 'reversed', 'isinstance', 'getattr', 'setattr', 'hasattr', 'type', 'any', 'all', 'map', 'filter']
const ENGINE_GLOBALS: Array<[string, string]> = [
  ['game', 'DataModel'], ['workspace', 'Workspace'], ['script', 'this script'], ['Instance', 'Instance.new(className)'],
  ['Vector3', 'datatype'], ['Vector2', 'datatype'], ['CFrame', 'datatype'], ['Color3', 'datatype'], ['UDim', 'datatype'],
  ['UDim2', 'datatype'], ['TweenInfo', 'datatype'], ['RaycastParams', 'datatype'], ['Enum', 'enums'], ['task', 'scheduler'],
  ['wait', 'await wait(seconds)'], ['warn', 'function'], ['tick', 'function'], ['time', 'function'], ['require', 'require(module)'],
]
const NAMESPACES: Record<string, string[]> = {
  task: ['wait', 'spawn', 'defer', 'delay', 'cancel'],
  Vector3: ['new', 'zero', 'one', 'xAxis', 'yAxis', 'zAxis'],
  Vector2: ['new', 'zero'],
  CFrame: ['new', 'Angles', 'fromEulerAnglesXYZ', 'fromEulerAnglesYXZ', 'fromAxisAngle', 'lookAt', 'identity'],
  Color3: ['new', 'fromRGB', 'fromHSV', 'fromHex'],
  UDim2: ['new', 'fromScale', 'fromOffset'],
  UDim: ['new'],
  TweenInfo: ['new'],
  RaycastParams: ['new'],
  Instance: ['new'],
  Enum: Object.keys(Enums),
}

export function pythonCompletions(model: monaco.editor.ITextModel, position: monaco.Position, script: Instance, game: DataModel): monaco.languages.CompletionItem[] {
  const placed = placeCompletions(model, position, script, game, 'Python')
  if (placed) return placed.items
  const word = model.getWordUntilPosition(position)
  const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
  const before = model.getValueInRange(new monaco.Range(1, 1, position.lineNumber, position.column))
  const dot = /([\w.]+)\.(\w*)$/.exec(before)
  if (dot) {
    const enumM = /^Enum\.(\w+)$/.exec(dot[1])
    const names = enumM ? Enums[enumM[1]] ?? [] : NAMESPACES[dot[1]] ?? []
    return names.map((n) => ({ label: n, kind: K.Property, insertText: n, range }))
  }
  // module names after import/from
  if (/(?:^|\n)\s*(?:import|from)\s+[\w.]*$/.test(before)) {
    const mods = game.getDescendants().filter((d) => d.className === 'ModuleScript').map((d) => d.name)
    const svcs = ['Storage', 'ScriptService']
    return [...new Set([...svcs, ...mods])].map((n) => ({ label: n, kind: K.Module, insertText: n, range }))
  }
  const locals = new Set<string>()
  for (const mm of before.matchAll(/(?:^|\n)\s*(?:def\s+|class\s+)?([A-Za-z_]\w*)\s*(?:=|\()/g)) locals.add(mm[1])
  const out: monaco.languages.CompletionItem[] = []
  for (const [n, d] of ENGINE_GLOBALS) out.push({ label: { label: n, description: d }, kind: K.Variable, insertText: n, range, sortText: '0' + n })
  for (const n of locals) if (!ENGINE_GLOBALS.some(([g]) => g === n)) out.push({ label: n, kind: K.Variable, insertText: n, range, sortText: '1' + n })
  for (const n of PY_BUILTINS) out.push({ label: n, kind: K.Function, insertText: n, range, sortText: '2' + n })
  for (const n of PY_KEYWORDS) out.push({ label: n, kind: K.Keyword, insertText: n, range, sortText: '3' + n })
  return out
}
