// Script languages and the module path resolution shared by every language.
import { EnumItem } from '../datatypes'
import { Instance } from '../instance'

export type ScriptLanguage = 'Luau' | 'TypeScript' | 'Python'
export const LANGUAGES: ScriptLanguage[] = ['Luau', 'TypeScript', 'Python']

export function languageOf(s: Instance): ScriptLanguage {
  return ((s.get<EnumItem | null>('Language')?.name) ?? 'Luau') as ScriptLanguage
}

export const EXTENSION: Record<ScriptLanguage, string> = { Luau: 'luau', TypeScript: 'ts', Python: 'py' }

export const DEFAULT_SOURCE: Record<ScriptLanguage, { script: string; module: string }> = {
  Luau: {
    script: 'print("Hello world!")\n',
    module: 'local module = {}\n\nreturn module\n',
  },
  TypeScript: {
    script: 'print("Hello world!")\n',
    module: 'export function hello(name: string): string {\n\treturn `Hello, ${name}!`\n}\n',
  },
  Python: {
    script: 'print("Hello world!")\n',
    module: 'def hello(name: str) -> str:\n    return f"Hello, {name}!"\n',
  },
}

/**
 * Resolve a module specifier from a script.
 *   "./Util", "../Shared/Util"  relative to the script's parent ("." / ".." for Python)
 *   "Storage/Util"              path from the game root (first segment is a service)
 *   "Util"                      bare name: searched in Storage, then ScriptService
 * `sep` is "/" for TypeScript/Luau strings and "." for Python imports.
 */
export function resolveModule(spec: string, from: Instance | null, sep: '/' | '.' = '/'): Instance | null {
  const game = from?.dataModel
  if (!game) return null
  const svc = (name: string) => game.children.find((c) => c.className === name || c.name === name) ?? null
  let parts: string[]
  let base: Instance | null
  if (sep === '/' && (spec.startsWith('./') || spec.startsWith('../'))) {
    base = from!.parent
    parts = spec.split('/').filter((p) => p !== '' && p !== '.')
    while (parts[0] === '..') { base = base?.parent ?? null; parts.shift() }
  } else {
    parts = spec.split(sep).filter(Boolean)
    if (parts.length === 1) {
      const name = parts[0]
      const service = svc(name)
      if (service) return service
      for (const root of [svc('Storage'), svc('ScriptService'), from!.parent]) {
        const hit = root && (root.findFirstChild(name) ?? root.getDescendants().find((d) => d.name === name && d.className === 'ModuleScript'))
        if (hit) return hit
      }
      return null
    }
    base = svc(parts.shift()!)
  }
  for (const p of parts) {
    if (!base) return null
    base = base.findFirstChild(p)
  }
  return base
}
