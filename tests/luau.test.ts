import { describe, it, expect } from 'vitest'
import '../src/engine/classes'
import { DataModel } from '../src/engine/classes'
import { createInstance } from '../src/engine/instance'
import { LuauRuntime } from '../src/engine/luau/LuauRuntime'

async function run(src: string, steps = 0) {
  const game = new DataModel().initServices()
  const out: string[] = []
  const rt = await LuauRuntime.create(game, (k, m) => out.push(`${k}: ${m}`))
  const s = createInstance('Script')
  s.set('Source', src)
  s.setParent(game.getService('Workspace'))
  rt.runScript(s)
  for (let i = 1; i <= steps; i++) rt.step(i * 0.1)
  return { out, game, rt }
}

describe('luau bridge', () => {
  it('runs basic scripts with Roblox API', async () => {
    const { out, game } = await run(`
      local p = Instance.new("Part")
      p.Name = "Brick"
      p.Size = Vector3.new(2, 3, 4)
      p.Position = Vector3.new(0, 10, 0)
      p.Color = Color3.fromRGB(255, 0, 0)
      p.Material = Enum.Material.Neon
      p.Anchored = true
      p.Parent = workspace
      print(p.Name, p.Size, p.Position.Y, p.Material, typeof(p), p:IsA("BasePart"), p.ClassName)
      print(workspace.Brick == p, game.Workspace.Brick.Size.X, script.Name, script.Parent == workspace)
      local cf = CFrame.new(1, 2, 3) * CFrame.Angles(0, math.pi/2, 0)
      p.CFrame = cf
      print(math.round(p.Orientation.Y), p.CFrame.Position)
      print(#workspace:GetChildren(), game:GetService("Lighting").ClockTime)
    `)
    expect(out.join('\n')).not.toContain('error')
    expect(out[0]).toBe('info: Brick 2, 3, 4 10 Enum.Material.Neon Instance true Part')
    expect(out[1]).toBe('info: true 2 Script true')
    expect(out[2]).toBe('info: 90 1, 2, 3')
    const brick = game.getService('Workspace').findFirstChild('Brick')!
    expect(brick.get('Anchored')).toBe(true)
  })

  it('reports errors with script name and line', async () => {
    const { out } = await run(`local x = nil\nprint(x.y)`)
    expect(out[0]).toMatch(/error: Workspace\.Script:2: attempt to index nil/)
  })

  it('supports task.wait, events and signals', async () => {
    const { out } = await run(`
      local b = Instance.new("BindableEvent")
      b.Event:Connect(function(a, t) print("got", a, t.k) end)
      local f = Instance.new("Folder", workspace)
      f.ChildAdded:Connect(function(c) print("child", c.Name) end)
      f:GetPropertyChangedSignal("Name"):Connect(function() print("renamed", f.Name) end)
      task.spawn(function() task.wait(0.25) print("waited") end)
      b:Fire(5, {k = "v"})
      local v = Instance.new("NumberValue", f)
      v.Changed:Connect(function(nv) print("value", nv) end)
      f.Name = "Renamed"
      v.Value = 42
      print("end")
    `, 5)
    expect(out).toContain('info: got 5 v')
    expect(out).toContain('info: child NumberValue')
    expect(out).toContain('info: renamed Renamed')
    expect(out).toContain('info: value 42')
    expect(out).toContain('info: waited')
    expect(out.indexOf('info: end')).toBeLessThan(out.indexOf('info: waited'))
  })

  it('validates property types', async () => {
    const { out } = await run(`local p = Instance.new("Part") p.Size = 5`)
    expect(out[0]).toContain('Unable to assign property Size. Vector3 expected, got number')
  })

  it('requires modules', async () => {
    const game = new DataModel().initServices()
    const out: string[] = []
    const rt = await LuauRuntime.create(game, (k, m) => out.push(`${k}: ${m}`))
    const m = createInstance('ModuleScript'); m.name = 'Util'
    m.set('Source', 'local M = {} function M.add(a: number, b: number): number return a + b end return M')
    m.setParent(game.getService('ReplicatedStorage'))
    const s = createInstance('Script')
    s.set('Source', 'local U = require(game.ReplicatedStorage.Util) print(U.add(2, 3)) print(require(game.ReplicatedStorage:WaitForChild("Util")) == U)')
    s.setParent(game.getService('ServerScriptService'))
    rt.runScript(s)
    expect(out).toEqual(['info: 5', 'info: true'])
  })

  it('times out infinite loops', async () => {
    const { out } = await run(`while true do end`)
    expect(out.join('\n')).toContain('timeout')
  }, 20000)
})
