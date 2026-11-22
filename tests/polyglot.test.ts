import { describe, it, expect, beforeAll } from 'vitest'
import '../src/engine/classes'
import { DataModel } from '../src/engine/classes'
import { Instance, createInstance } from '../src/engine/instance'
import { enumItem } from '../src/engine/datatypes'
import { LuauRuntime } from '../src/engine/luau/LuauRuntime'
import { ScriptHost } from '../src/engine/scripting/ScriptHost'
import { TypeScriptRuntime } from '../src/engine/scripting/TypeScriptRuntime'
import { PythonRuntime, loadPython } from '../src/engine/scripting/PythonRuntime'

type Lang = 'Luau' | 'TypeScript' | 'Python'

async function setup() {
  const game = new DataModel().initServices()
  const out: string[] = []
  const output = (k: string, m: string) => out.push(`${k}: ${m}`)
  const luau = await LuauRuntime.create(game, output)
  const host = new ScriptHost(game, output, luau)
  new TypeScriptRuntime(host)
  await PythonRuntime.create(host)
  let t = 0
  const add = (cls: 'Script' | 'ModuleScript', lang: Lang, name: string, source: string, parent: Instance) => {
    const s = createInstance(cls)
    s.name = name
    s.set('Language', enumItem('ScriptLanguage', lang))
    s.set('Source', source)
    s.setParent(parent)
    return s
  }
  const run = async (s: Instance, frames = 0) => {
    host.runScript(s)
    await settle()
    for (let i = 0; i < frames; i++) { t += 0.1; host.step(t); await settle() }
  }
  return { game, out, host, add, run, storage: game.getService('Storage'), ss: game.getService('ScriptService') }
}
const settle = () => new Promise((r) => setTimeout(r, 30))
async function until(cond: () => boolean, ms = 3000) {
  const t0 = Date.now()
  while (!cond() && Date.now() - t0 < ms) await settle()
}

beforeAll(async () => { await loadPython() }, 60000)

describe('TypeScript scripts', () => {
  it('use the engine API', async () => {
    const { out, add, run, ss } = await setup()
    const s = add('Script', 'TypeScript', 'Main', `
      const p = Instance.new("Part")
      p.Name = "Brick"
      p.Size = Vector3.new(2, 3, 4)
      p.Position = new Vector3(0, 10, 0)
      p.Material = Enum.Material.Neon
      p.Parent = workspace
      const size: Vector3 = workspace.Brick.Size
      print(p.Name, size.X + size.Y, p.Material, p.IsA("BasePart"), p.Position.add(Vector3.new(1, 0, 0)))
      p.GetPropertyChangedSignal("Name").Connect(() => print("renamed to", p.Name))
      p.Name = "Renamed"
      const t = await task.wait(0.25)
      print("waited", t >= 0.25)
    `, ss)
    await run(s, 4)
    expect(out).toContain('info: Brick 5 Enum.Material.Neon true 1, 10, 0')
    expect(out).toContain('info: renamed to Renamed')
    expect(out).toContain('info: waited true')
  })

  it('reports errors with the script line', async () => {
    const { out, add, run, ss } = await setup()
    await run(add('Script', 'TypeScript', 'Broken', `const a = 1\nconst x: any = undefined\nx.foo()`, ss))
    expect(out.join('\n')).toMatch(/error: ScriptService\.Broken:3: TypeError/)
  })

  it('stops runaway loops', async () => {
    const { out, add, run, host, ss } = await setup()
    host.timeoutMs = 300
    await run(add('Script', 'TypeScript', 'Loop', `let i = 0\nwhile (true) { i++ }`, ss))
    expect(out.join('\n')).toContain('Script timeout')
  })
})

describe('Python scripts', () => {
  it('use the engine API, events and await', async () => {
    const { out, add, run, ss } = await setup()
    const s = add('Script', 'Python', 'Main', [
      'p = Instance.new("Part")',
      'p.Name = "Brick"',
      'p.Size = Vector3.new(2, 3, 4)',
      'p.Parent = workspace',
      'print(p.Name, workspace.Brick.Size.Y, p.ClassName)',
      'def on_child(c):',
      '    print("child added:", c.Name)',
      'workspace.ChildAdded.Connect(on_child)',
      'f = Instance.new("Folder")',
      'f.Parent = workspace',
      'await task.wait(0.2)',
      'print("after wait", [c.Name for c in workspace.GetChildren()][-1])',
    ].join('\n'), ss)
    await run(s, 4)
    expect(out).toContain('info: Brick 3 Part')
    expect(out).toContain('info: child added: Folder')
    expect(out).toContain('info: after wait Folder')
  })

  it('reports errors with the script line and stops runaway loops', async () => {
    const { out, add, run, host, ss } = await setup()
    await run(add('Script', 'Python', 'Broken', 'x = 1\nprint(undefined_name)', ss))
    expect(out.join('\n')).toMatch(/error: ScriptService\.Broken:2: NameError/)
    host.timeoutMs = 300
    await run(add('Script', 'Python', 'Loop', 'n = 0\nwhile True:\n    n += 1', ss))
    await until(() => out.join('\n').includes('Script timeout'))
    expect(out.join('\n')).toContain('Script timeout')
  })
})

describe('cross-language modules', () => {
  it('lets every language require every other language', async () => {
    const { out, add, run, storage, ss } = await setup()
    add('ModuleScript', 'Luau', 'LuauMath', `
      local M = {}
      M.factor = 3
      function M.triple(x) return x * M.factor end
      function M.apply(f, x) return f(x) + 1 end
      return M`, storage)
    add('ModuleScript', 'TypeScript', 'TsStrings', `
      export function shout(s: string): string { return s.toUpperCase() + "!" }
      export const items = ["a", "b", "c"]
      export function callBack(fn: (n: number) => number) { return fn(10) }`, storage)
    add('ModuleScript', 'Python', 'PyStats', [
      'def mean(xs):',
      '    xs = list(xs)',
      '    return sum(xs) / len(xs)',
      'GREETING = "hi from python"',
    ].join('\n'), storage)

    // TypeScript -> Luau and Python (import syntax and require)
    await run(add('Script', 'TypeScript', 'FromTs', `
      import LuauMath from "Storage/LuauMath"
      import { mean, GREETING } from "PyStats"
      print("ts->luau", LuauMath.triple(5), LuauMath.apply((x: number) => x * 2, 4))
      print("ts->py", mean([1, 2, 3, 6]), GREETING)
    `, ss))
    // Python -> Luau and TypeScript (import statement)
    await run(add('Script', 'Python', 'FromPy', [
      'import LuauMath',
      'from TsStrings import shout',
      'from Storage import TsStrings',
      'print("py->luau", LuauMath.triple(7))',
      'print("py->ts", shout("hey"), TsStrings.items[1], TsStrings.callBack(lambda n: n * 5))',
    ].join('\n'), ss))
    // Luau -> TypeScript and Python
    await run(add('Script', 'Luau', 'FromLuau', `
      local Ts = require(game.Storage.TsStrings)
      local Py = require("Storage/PyStats")
      print("luau->ts", Ts.shout("yo"), #Ts.items, Ts.items[1], Ts.callBack(function(n) return n + 0.5 end))
      print("luau->py", Py.mean({2, 4}), Py.GREETING, typeof(Ts))
    `, ss))

    const text = out.join('\n')
    expect(text).not.toContain('error')
    expect(out).toContain('info: ts->luau 15 9')
    expect(out).toContain('info: ts->py 3 hi from python')
    expect(out).toContain('info: py->luau 21')
    expect(out).toContain('info: py->ts HEY! b 50')
    expect(out).toContain('info: luau->ts YO! 3 a 10.5')
    expect(out).toContain('info: luau->py 3 hi from python Foreign')
  }, 30000)

  it('delivers BindableEvents across languages', async () => {
    const { out, add, run, storage, ss } = await setup()
    const ev = createInstance('BindableEvent')
    ev.name = 'Bus'
    ev.setParent(storage)
    await run(add('Script', 'Python', 'PyListener', 'game.Storage.Bus.Event.Connect(lambda msg, n: print("py got", msg, n))', ss))
    await run(add('Script', 'TypeScript', 'TsListener', 'game.Storage.Bus.Event.Connect((msg: string, n: number) => print("ts got", msg, n))', ss))
    await run(add('Script', 'Luau', 'LuauSender', 'game.Storage.Bus:Fire("hello", 42)', ss))
    await settle()
    expect(out).toContain('info: py got hello 42')
    expect(out).toContain('info: ts got hello 42')
  }, 30000)
})
