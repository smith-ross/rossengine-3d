import { describe, it, expect } from 'vitest'
import '../src/engine/classes'
import { demoPlace } from '../src/engine/templates'
import { Ctx, membersOf, resolveExpression, stringArgumentOptions, trailingExpression } from '../src/editor/completion/context'

const game = demoPlace()
const script = game.getService('ScriptService').findFirstChild('CoinSpawner')!
const kill = game.workspace.findFirstChild('KillBrick')!.findFirstChild('Kill')!
const ctx = (before: string, s = script, lang: Ctx['lang'] = 'Luau'): Ctx => ({ game, script: s, before, lang })
const names = (before: string, s = script, lang: Ctx['lang'] = 'Luau') => {
  const expr = trailingExpression(before.replace(/[.:]\w*$/, ''))
  const t = resolveExpression(expr, ctx(before, s, lang))
  return t ? membersOf(t, lang).map((m) => m.name) : null
}

describe('completion context', () => {
  it('knows the place tree', () => {
    expect(names('workspace.')).toEqual(expect.arrayContaining(['Baseplate', 'Tower', 'KillBrick', 'Size'.slice(0, 0) || 'Gravity']))
    expect(names('game.Workspace.Tower.')).toEqual(expect.arrayContaining(['Spinner', 'Step', 'PrimaryPart', 'GetPivot']))
    expect(names('script.Parent.', kill)).toEqual(expect.arrayContaining(['Kill', 'Touched', 'Size', 'Anchored']))
    expect(names('game:GetService("Players").')).toEqual(expect.arrayContaining(['LocalPlayer', 'PlayerAdded']))
    expect(names('workspace:WaitForChild("Tower"):FindFirstChild("Spinner").')).toEqual(expect.arrayContaining(['Spin', 'CFrame']))
  })

  it('follows locals, Instance.new and handler parameters', () => {
    expect(names('local part = Instance.new("Part")\npart.')).toEqual(expect.arrayContaining(['Shape', 'Touched', 'Anchored']))
    expect(names('local tower = workspace.Tower\nlocal s = tower.Spinner\ns.')).toEqual(expect.arrayContaining(['Spin', 'Size']))
    expect(names('workspace.KillBrick.Touched:Connect(function(hit)\n  hit.')).toEqual(expect.arrayContaining(['Parent', 'Size', 'Touched']))
    expect(names('local p = workspace.Baseplate\np.Touched:')).toEqual(['Connect', 'Once', 'Wait'])
    expect(names('const players = game.GetService("Players")\nplayers.', script, 'TypeScript')).toEqual(expect.arrayContaining(['LocalPlayer']))
    expect(names('player = game.Players.LocalPlayer\nplayer.', script, 'Python')).toEqual(expect.arrayContaining(['Character', 'LoadCharacter']))
  })

  it('only offers methods after ":"', () => {
    const t = resolveExpression('workspace', ctx('workspace:'))!
    const ms = membersOf(t, 'Luau')
    expect(ms.find((m) => m.name === 'WaitForChild')?.kind).toBe('method')
  })

  it('completes string arguments', () => {
    const svc = stringArgumentOptions(ctx('game:GetService("Pl'))!
    expect(svc.prefix).toBe('Pl')
    expect(svc.options.map((o) => o.label)).toContain('Players')
    expect(stringArgumentOptions(ctx('workspace:WaitForChild("'))!.options.map((o) => o.label)).toContain('KillBrick')
    expect(stringArgumentOptions(ctx('Instance.new("'))!.options.map((o) => o.label)).toContain('Part')
    expect(stringArgumentOptions(ctx('local x = 1 print("'))).toBeNull()
  })
})
