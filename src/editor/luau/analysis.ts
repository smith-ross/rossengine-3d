// Luau type checking / autocomplete / hover, running in a Web Worker.
import { AnalysisWorker } from '@luau-rs/luau/analysis/worker'
import type { AnalysisDiagnostic, AutocompleteEntry } from '@luau-rs/luau/analysis'
import { generateDefinitions, instanceClassNames } from './definitions'

let worker: AnalysisWorker | null = null
let failed = false
const instanceClasses = instanceClassNames()
let chain: Promise<unknown> = Promise.resolve()

function getWorker(): AnalysisWorker | null {
  if (failed) return null
  if (!worker) {
    try {
      worker = new AnalysisWorker({ mode: 'nonstrict', lint: true })
      worker.addDefinition('@rossengine', generateDefinitions())
    } catch (e) {
      console.warn('Luau analysis unavailable', e)
      failed = true
      return null
    }
  }
  return worker
}

/** Serialize requests: the worker handles one query at a time. */
function queue<T>(fn: (w: AnalysisWorker) => Promise<T>): Promise<T | null> {
  const w = getWorker()
  if (!w) return Promise.resolve(null)
  const p = chain.then(() => fn(w)).catch((e) => { console.warn('analysis error', e); return null })
  chain = p
  return p
}

const mod = (id: number) => `script_${id}`

export function checkScript(id: number, source: string): Promise<AnalysisDiagnostic[] | null> {
  return queue(async (w) => {
    w.setModule(mod(id), source, 'script')
    const r = await w.check(mod(id))
    return r.diagnostics.filter((d) => {
      // children are accessed by name (workspace.Baseplate), which the checker can't know about
      const m = /Key '.*' not found in (?:class|extern type) '(\w+)'/.exec(d.message)
      return !(m && instanceClasses.has(m[1]))
    })
  })
}

export function complete(id: number, source: string, line: number, column: number): Promise<AutocompleteEntry[] | null> {
  return queue(async (w) => {
    w.setModule(mod(id), source, 'script')
    const r = await w.autocomplete(mod(id), { line, column })
    return r.entries
  })
}

export function typeAt(id: number, source: string, line: number, column: number): Promise<string | null> {
  return queue(async (w) => {
    w.setModule(mod(id), source, 'script')
    const inspect = await w.inspectAt(mod(id), { line, column })
    if (inspect) return inspect.name ? `${inspect.name}: ${inspect.type}` : inspect.type
    return (await w.typeAt(mod(id), { line, column })) ?? null
  })
}
