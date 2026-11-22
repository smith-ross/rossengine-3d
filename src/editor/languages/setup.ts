// Monaco support for TypeScript and Python scripts (Luau lives in ../luau).
import * as monaco from '../luau/monacoCore'
import 'monaco-esm/languages/definitions/typescript/register.js'
import 'monaco-esm/languages/definitions/python/register.js'
import * as ts from 'monaco-esm/languages/features/typescript/register.js'
import { Instance } from '../../engine/instance'
import { EXTENSION, languageOf, ScriptLanguage } from '../../engine/scripting/languages'
import { generateTsDefinitions } from './tsDefinitions'

let configured = false
export function setupLanguages() {
  if (configured) return
  configured = true
  const defaults = (ts as any).typescriptDefaults
  defaults.setCompilerOptions({
    target: 99, // ESNext
    module: 99, // ESNext
    moduleResolution: 2, // node-style lookup of "Storage/Util" via baseUrl/paths
    moduleDetection: 3, // every script is its own module (no clashes between scripts)
    allowNonTsExtensions: true,
    allowSyntheticDefaultImports: true,
    esModuleInterop: true,
    strict: false,
    noImplicitAny: false,
    noEmit: true,
    lib: ['es2022'],
    baseUrl: 'file:///game/',
    paths: { '*': ['*', 'Storage/*', 'ScriptService/*'] },
  })
  defaults.setDiagnosticsOptions({ noSemanticValidation: false, noSyntaxValidation: false, diagnosticCodesToIgnore: [1375, 1378, 2307] })
  defaults.addExtraLib(generateTsDefinitions(), 'file:///rossengine/globals.d.ts')
  defaults.setEagerModelSync(true)
}

/** Model URI for a script: TypeScript files live at their instance path so imports resolve. */
export function uriFor(script: Instance, lang: ScriptLanguage): string {
  if (lang === 'TypeScript') return `file:///game/${script.getFullName().split('.').map(encodeURIComponent).join('/')}.ts`
  return `inmemory://scripts/${script.id}.${EXTENSION[lang]}`
}

export const MONACO_LANGUAGE: Record<ScriptLanguage, string> = { Luau: 'luau', TypeScript: 'typescript', Python: 'python' }

/**
 * Give the TypeScript service every TypeScript script of the place (so imports type-check) and an
 * `any`-typed stub for Luau/Python modules (so importing them from TypeScript is allowed).
 */
const stubLibs = new Map<string, monaco.IDisposable>()
export function syncTypeScriptWorkspace(game: Instance, ensureModel: (s: Instance) => void) {
  const defaults = (ts as any).typescriptDefaults
  const wanted = new Set<string>()
  for (const d of game.getDescendants()) {
    if (!d.isA('LuaSourceContainer')) continue
    const lang = languageOf(d)
    if (lang === 'TypeScript') ensureModel(d)
    else if (d.className === 'ModuleScript') {
      const path = `file:///game/${d.getFullName().split('.').map(encodeURIComponent).join('/')}.d.ts`
      wanted.add(path)
      if (!stubLibs.has(path)) {
        stubLibs.set(path, defaults.addExtraLib(`/** ${lang} module */\ndeclare const __module: any\nexport = __module\n`, path))
      }
    }
  }
  for (const [path, lib] of stubLibs) if (!wanted.has(path)) { lib.dispose(); stubLibs.delete(path) }
}

// ---- Python syntax checking (uses Pyodide, loaded on demand) ---------------------------------
let pyCheck: ((src: string) => string | null) | null = null
let pyLoading: Promise<void> | null = null

export function loadPythonChecker(): Promise<void> {
  if (!pyLoading) {
    pyLoading = import('../../engine/scripting/PythonRuntime').then(async ({ loadPython }) => {
      const py = await loadPython()
      py.runPython(`
import ast as _ast
def __ross_check(src):
    try:
        compile(src, "<script>", "exec", _ast.PyCF_ONLY_AST | _ast.PyCF_ALLOW_TOP_LEVEL_AWAIT)
        return None
    except SyntaxError as e:
        return f"{e.lineno or 1}:{e.offset or 1}:{e.end_lineno or e.lineno or 1}:{e.end_offset or 0}:{e.msg}"
`)
      const fn = py.globals.get('__ross_check')
      pyCheck = (src) => fn(src) ?? null
    })
  }
  return pyLoading
}

export function checkPython(src: string): monaco.editor.IMarkerData[] | null {
  if (!pyCheck) return null
  const r = pyCheck(src)
  if (!r) return []
  const [line, col, endLine, endCol, ...msg] = r.split(':')
  const l = Number(line), c = Number(col)
  return [{
    startLineNumber: l, startColumn: c, endLineNumber: Number(endLine) || l,
    endColumn: Math.max(Number(endCol) || c + 1, c + 1), message: `SyntaxError: ${msg.join(':')}`,
    severity: monaco.MarkerSeverity.Error, source: 'Python',
  }]
}

