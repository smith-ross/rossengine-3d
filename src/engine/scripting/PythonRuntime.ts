// Python 3 scripts, running on Pyodide (CPython compiled to WebAssembly).
// Scripts see the same API objects as TypeScript (through Pyodide's JS proxies). `import X` finds
// ModuleScripts written in any language; `await task.wait(1)` works at the top level of a script.
import type { PyodideAPI } from 'pyodide'
import { Instance } from '../instance'
import { LanguageRuntime, ScriptHost } from './ScriptHost'
import { resolveModule } from './languages'

const PRELUDE = String.raw`
import ast, sys, types, importlib.abc, importlib.machinery

_host = None          # the JS bridge object (set per game session)
_imported = set()     # module names this session put into sys.modules
_count = 0

def __ross_guard():
    global _count
    _count += 1
    if _count & 4095 == 0 and _host is not None and _host.timeExceeded():
        raise TimeoutError("Script timeout: exhausted allowed execution time")

class _Guard(ast.NodeTransformer):
    def _loop(self, node):
        self.generic_visit(node)
        node.body.insert(0, ast.Expr(ast.Call(ast.Name("__ross_guard", ast.Load()), [], [])))
        return node
    visit_While = _loop
    visit_For = _loop
    visit_AsyncFor = _loop

def _compile(src, filename, allow_await):
    flags = ast.PyCF_ALLOW_TOP_LEVEL_AWAIT if allow_await else 0
    tree = compile(src, filename, "exec", ast.PyCF_ONLY_AST | flags)
    tree = ast.fix_missing_locations(_Guard().visit(tree))
    return compile(tree, filename, "exec", flags)

def _fill(g, api):
    import js
    for k in js.Object.keys(api):
        g[k] = getattr(api, k)
    g["__ross_guard"] = __ross_guard

async def __ross_run(src, filename, api):
    g = {"__name__": "__main__", "__builtins__": __builtins__}
    _fill(g, api)
    r = eval(_compile(src, filename, True), g)
    if r is not None and hasattr(r, "__await__"):
        await r

def __ross_load_module(name, src, filename, api):
    m = types.ModuleType(name)
    _fill(m.__dict__, api)
    exec(_compile(src, filename, False), m.__dict__)
    return m

class _Finder(importlib.abc.MetaPathFinder, importlib.abc.Loader):
    """Resolves imports to ModuleScripts (any language) and containers (as packages)."""
    def find_spec(self, fullname, path=None, target=None):
        if _host is None:
            return None
        kind = _host.importKind(fullname)
        if not kind:
            return None
        return importlib.machinery.ModuleSpec(fullname, self, is_package=(kind == "package"))
    def create_module(self, spec):
        _imported.add(spec.name)
        if spec.submodule_search_locations is not None:
            pkg = types.ModuleType(spec.name)
            pkg.__path__ = []
            return pkg
        value = _host.importModule(spec.name)
        if isinstance(value, types.ModuleType):
            return value
        m = types.ModuleType(spec.name)
        m.__ross_value__ = value
        def __getattr__(attr, _v=value):
            try:
                return getattr(_v, attr)
            except Exception:
                raise AttributeError(attr)
        m.__getattr__ = __getattr__
        return m
    def exec_module(self, module):
        pass

sys.meta_path.append(_Finder())

def __ross_reset(host):
    global _host
    _host = host
    for name in list(_imported):
        sys.modules.pop(name, None)
    _imported.clear()
`

let pyodidePromise: Promise<PyodideAPI> | null = null

/** Load Pyodide once per page (it is ~14 MB, so only when a place actually uses Python). */
export function loadPython(indexURL?: string): Promise<PyodideAPI> {
  if (!pyodidePromise) {
    pyodidePromise = (async () => {
      const { loadPyodide } = await import('pyodide')
      const url = indexURL ?? (typeof document !== 'undefined' ? new URL('pyodide/', document.baseURI).href : undefined)
      const py = await loadPyodide(url ? { indexURL: url } : {})
      py.runPython(PRELUDE)
      return py
    })()
    pyodidePromise.catch(() => { pyodidePromise = null })
  }
  return pyodidePromise
}

export class PythonRuntime implements LanguageRuntime {
  readonly language = 'Python' as const
  private run!: (...a: unknown[]) => Promise<unknown>
  private load!: (...a: unknown[]) => unknown

  private constructor(private host: ScriptHost, readonly py: PyodideAPI) {}

  static async create(host: ScriptHost, indexURL?: string) {
    const py = await loadPython(indexURL)
    const rt = new PythonRuntime(host, py)
    rt.init()
    return rt
  }

  private init() {
    const { py, host } = this
    host.runtimes.set('Python', this)
    const PyProxy = (py as any).ffi?.PyProxy
    host.foreign = {
      isProxy: (v) => !!PyProxy && v instanceof PyProxy,
      toJs: (v) => (v as any).toJs({ dict_converter: (e: Iterable<[unknown, unknown]>) => new Map(e) }),
      keep: (fn) => {
        const kept = (fn as any).copy ? (fn as any).copy() : fn
        return (...args: unknown[]) => kept(...args)
      },
    }
    host.formatters.unshift((e) => this.formatError(e))
    py.setStdout({ batched: (s: string) => host.output('info', s) })
    py.setStderr({ batched: (s: string) => host.output('warn', s) })
    // per-session bridge used by the import hook and the loop guard
    const bridge = {
      timeExceeded: () => host.timeExceeded(),
      importKind: (fullname: string) => {
        const inst = resolveModule(fullname, this.importer(), '.')
        if (!inst) return null
        return inst.className === 'ModuleScript' ? 'module' : 'package'
      },
      importModule: (fullname: string) => {
        const inst = resolveModule(fullname, this.importer(), '.')
        if (!inst) throw new Error(`No module named '${fullname}'`)
        return host.requireModule(inst)
      },
    }
    ;(py.globals.get('__ross_reset') as (b: unknown) => void)(bridge)
    this.run = py.globals.get('__ross_run')
    this.load = py.globals.get('__ross_load_module')
  }

  /** The script whose import is being resolved (relative names resolve from there). */
  private importer(): Instance | null {
    return this.host.currentScript ?? this.host.game.getService('ScriptService')
  }

  private apiFor(script: Instance) {
    const g = this.host.globalsFor(script, '.')
    delete g.print // Python keeps its own print (sep=, end=, file=...), routed to the Output
    return g
  }

  runScript(script: Instance) {
    const name = script.getFullName()
    const p = this.run(script.get<string>('Source') ?? '', name, this.apiFor(script))
    Promise.resolve(p).catch((e) => this.host.reportError(e, script))
  }

  loadModule(module: Instance): unknown {
    const name = module.getFullName()
    return this.load(module.name, module.get<string>('Source') ?? '', name, this.apiFor(module))
  }

  /** Turn a Python traceback into "Script.Name:line: Error: message" plus the script frames. */
  formatError(e: unknown): string | null {
    const err = e as { type?: string; message?: string; constructor?: { name?: string } }
    if (!err || err.constructor?.name !== 'PythonError' || typeof err.message !== 'string') return null
    const lines = err.message.trim().split('\n')
    const last = lines[lines.length - 1]
    const frames: Array<[string, number]> = []
    for (const l of lines) {
      const m = /File "([^"<>/\\]+)", line (\d+)/.exec(l)
      if (m) frames.push([m[1], Number(m[2])])
    }
    const top = frames[frames.length - 1]
    const trace = frames.slice(0, -1).reverse().map(([f, n]) => `  ${f}:${n}`).join('\n')
    return top ? `${top[0]}:${top[1]}: ${last}${trace ? '\n' + trace : ''}` : last
  }
}
