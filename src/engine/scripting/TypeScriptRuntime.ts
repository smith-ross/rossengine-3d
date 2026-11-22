// TypeScript scripts: transpiled with sucrase (types stripped, ES imports -> require), loops
// instrumented with a timeout guard, then run against the ScriptHost API.
import { transform } from 'sucrase'
import * as acorn from 'acorn'
import { simple as walkSimple } from 'acorn-walk'
import { Instance } from '../instance'
import { LanguageRuntime, ScriptHost } from './ScriptHost'

/** Browser globals hidden from game scripts (shadowed by undefined parameters). */
const SHADOWED = [
  'window', 'document', 'globalThis', 'self', 'top', 'parent', 'frames', 'localStorage', 'sessionStorage', 'indexedDB',
  'fetch', 'XMLHttpRequest', 'WebSocket', 'Worker', 'SharedWorker', 'navigator', 'location', 'history', 'process', 'importScripts',
]
const GUARD = '__ross_guard'

export class TypeScriptError extends Error {
  constructor(message: string, readonly script: string, readonly line?: number) { super(message) }
}

/** TS source -> JS (CommonJS-style imports). Line numbers are preserved. */
export function compileTypeScript(source: string, name: string, isModule: boolean): string {
  let js: string
  try {
    js = transform(source, { transforms: ['typescript', 'imports'], filePath: name + '.ts', production: true, disableESTransforms: true }).code
  } catch (e) {
    const m = /\((\d+):(\d+)\)/.exec(String((e as Error).message))
    throw new TypeScriptError(`SyntaxError: ${String((e as Error).message).replace(/\s*\(\d+:\d+\)\s*$/, '')}`, name, m ? Number(m[1]) : undefined)
  }
  return instrumentLoops(js, name, isModule)
}

/** Insert a guard call at the top of every loop body so runaway loops can be stopped. */
function instrumentLoops(js: string, name: string, isModule: boolean): string {
  let ast: acorn.Node
  try {
    ast = acorn.parse(js, {
      ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: !isModule, allowHashBang: true, locations: true,
    })
  } catch (e) {
    const loc = (e as any).loc
    throw new TypeScriptError(`SyntaxError: ${String((e as Error).message).replace(/\s*\(\d+:\d+\)\s*$/, '')}`, name, loc?.line)
  }
  const inserts: Array<[number, string]> = []
  const visit = (node: any) => {
    const body = node.body
    if (!body) return
    if (body.type === 'BlockStatement') inserts.push([body.start + 1, `${GUARD}();`])
    else { inserts.push([body.start, `{${GUARD}();`]); inserts.push([body.end, '}']) }
  }
  walkSimple(ast, {
    WhileStatement: visit, DoWhileStatement: visit, ForStatement: visit, ForInStatement: visit, ForOfStatement: visit,
  })
  inserts.sort((a, b) => b[0] - a[0])
  let out = js
  for (const [pos, text] of inserts) out = out.slice(0, pos) + text + out.slice(pos)
  return out
}

export class TypeScriptRuntime implements LanguageRuntime {
  readonly language = 'TypeScript' as const
  private guardCount = 0

  constructor(private host: ScriptHost) {
    host.runtimes.set('TypeScript', this)
    host.formatters.push((e) => this.formatError(e))
  }

  private guard = () => {
    if ((++this.guardCount & 4095) === 0 && this.host.timeExceeded()) {
      throw new Error(`Script timeout: exhausted allowed execution time (${this.host.timeoutMs / 1000}s without yielding)`)
    }
  }

  private build(script: Instance, isModule: boolean) {
    const name = script.getFullName()
    const js = compileTypeScript(script.get<string>('Source') ?? '', name, isModule)
    const globals = this.host.globalsFor(script, '/')
    const names = Object.keys(globals).filter((k) => /^[A-Za-z_$][\w$]*$/.test(k))
    const params = [...names, ...SHADOWED, 'exports', 'module', GUARD]
    // keep the code on the first line so stack line numbers match the source
    const wrapped = `(${isModule ? '' : 'async '}function(${params.join(',')}){${js}\n})\n//# sourceURL=${encodeURI(name)}.ts`
    const fn = (0, eval)(wrapped) as (...a: unknown[]) => unknown
    const module = { exports: {} as Record<string, unknown> }
    const args = [...names.map((k) => globals[k]), ...SHADOWED.map(() => undefined), module.exports, module, this.guard]
    return { fn, args, module }
  }

  runScript(script: Instance) {
    const { fn, args } = this.build(script, false)
    const r = fn(...args) as Promise<unknown>
    r.catch((e) => this.host.reportError(e, script))
  }

  loadModule(module: Instance): unknown {
    const { fn, args, module: m } = this.build(module, true)
    fn(...args)
    const ex = m.exports as Record<string, unknown>
    // `export default x` alone -> the module's value is x (what Luau/Python callers expect)
    const keys = Object.keys(ex)
    if (keys.length === 1 && keys[0] === 'default') return ex.default
    if (keys.length === 0 && 'default' in ex) return ex.default
    return ex
  }

  formatError(e: unknown): string | null {
    if (e instanceof TypeScriptError) return `${e.script}${e.line ? ':' + e.line : ''}: ${e.message}`
    const err = e as Error
    if (!err || typeof err !== 'object' || typeof err.stack !== 'string') return null
    // find the first stack frame inside a script (sourceURL "<FullName>.ts")
    for (const line of err.stack.split('\n')) {
      const m = /([\w%. -]+)\.ts:(\d+):\d+\)?\s*$/.exec(line)
      if (m && !line.includes('/src/') && !line.includes('node_modules')) {
        return `${decodeURI(m[1].trim())}:${m[2]}: ${err.name && err.name !== 'Error' ? err.name + ': ' : ''}${err.message}`
      }
    }
    return null
  }
}
