import { describe, it, expect } from 'vitest'
import '../src/engine/classes'
import { DataModel } from '../src/engine/classes'
import { Instance, addEventSink, createInstance } from '../src/engine/instance'
import { CFrame, Color3, Vector2, Vector3 } from '../src/engine/datatypes'
import { AnimationRunner, Track, applyPose, evaluate, keyValue, restFrame, setKey, tracksOf, writeTracks } from '../src/engine/animation'

const make = (cls: string, props: Record<string, unknown>, parent?: Instance | null) => {
  const i = createInstance(cls)
  for (const [k, v] of Object.entries(props)) i.set(k, v)
  if (parent) i.setParent(parent)
  return i
}

describe('animation', () => {
  it('interpolates between keys with easing, holds before the first and after the last', () => {
    const tr: Track = { path: [], prop: 'Transparency', keys: [] }
    setKey(tr, 1, 0.5)
    setKey(tr, 0, 0)
    setKey(tr, 2, 1, { ease: 'Constant' })
    expect(tr.keys.map((k) => k.t)).toEqual([0, 1, 2]) // kept sorted
    expect(evaluate(tr, -1)).toBe(0)
    expect(evaluate(tr, 0.5)).toBeCloseTo(0.25)
    expect(evaluate(tr, 5)).toBe(1)
    tr.keys[0].ease = 'Quad'; tr.keys[0].dir = 'In'
    expect(evaluate(tr, 0.5)).toBeCloseTo(0.125) // 0.5 * 0.5²
    tr.keys[1].ease = 'Constant'
    expect(evaluate(tr, 1.9)).toBe(0.5)
    setKey(tr, 1.0004, 0.7) // the same moment: replaces
    expect(tr.keys.length).toBe(3)
    expect(evaluate(tr, 1)).toBe(0.7)
  })

  it('interpolates colours, vectors and CFrames', () => {
    const c: Track = { path: [], prop: 'Color', keys: [] }
    setKey(c, 0, new Color3(0, 0, 0)); setKey(c, 1, new Color3(1, 0.5, 0))
    const mid = evaluate(c, 0.5) as Color3
    expect([mid.r, mid.g, mid.b]).toEqual([0.5, 0.25, 0])
    const p: Track = { path: [], prop: 'Position', keys: [] }
    setKey(p, 0, new Vector2(0, 0)); setKey(p, 2, new Vector2(10, -4))
    expect(evaluate(p, 1)).toEqual(new Vector2(5, -2))
    const cf: Track = { path: [], prop: 'CFrame', keys: [] }
    setKey(cf, 0, CFrame.fromPosition(new Vector3(0, 0, 0))); setKey(cf, 1, CFrame.fromPosition(new Vector3(0, 10, 0)))
    expect((evaluate(cf, 0.25) as CFrame).position.y).toBeCloseTo(2.5)
  })

  it("stores part CFrames relative to the root's rest pose, so copies animate where they are", () => {
    const model = make('Model', {})
    const door = make('Part', { Name: 'Door', CFrame: CFrame.fromPosition(new Vector3(100, 5, 0)) }, model)
    model.set('PrimaryPart', door)
    const rest = restFrame(model)
    // record: the door slides up 4 studs
    const tr: Track = { path: ['Door'], prop: 'CFrame', keys: [] }
    setKey(tr, 0, keyValue(door, 'CFrame', rest))
    door.set('CFrame', CFrame.fromPosition(new Vector3(100, 9, 0)))
    setKey(tr, 1, keyValue(door, 'CFrame', rest))
    expect((evaluate(tr, 1) as CFrame).position).toEqual(new Vector3(0, 4, 0)) // stored relative
    // a copy somewhere else plays relative to its own rest pose
    const copy = make('Model', {})
    const door2 = make('Part', { Name: 'Door', CFrame: CFrame.fromPosition(new Vector3(-50, 0, 20)) }, copy)
    copy.set('PrimaryPart', door2)
    applyPose(copy, [tr], 1, restFrame(copy))
    expect(door2.cframe.position).toEqual(new Vector3(-50, 4, 20))
  })

  it('tells apart objects with the same name (models often have several "Part"s)', async () => {
    const { locate, trackTarget, sameLocation } = await import('../src/engine/animation')
    const model = make('Model', {})
    const a = make('Part', { Name: 'Part' }, model)
    const b = make('Part', { Name: 'Part' }, model)
    const inner = make('Part', { Name: 'Part' }, b)
    expect(locate(model, a)).toEqual({ path: ['Part'] }) // the first: no index stored
    expect(locate(model, b)).toEqual({ path: ['Part'], idx: [1] })
    expect(locate(model, inner)).toEqual({ path: ['Part', 'Part'], idx: [1, 0] })
    const tr: Track = { ...locate(model, b)!, prop: 'Transparency', keys: [] }
    setKey(tr, 0, 0.75)
    expect(trackTarget(model, tr)).toBe(b)
    applyPose(model, [tr], 0, CFrame.identity)
    expect(b.get('Transparency')).toBe(0.75)
    expect(a.get('Transparency')).toBe(0)
    expect(sameLocation({ path: ['Part'] }, { path: ['Part'], idx: [0] })).toBe(true)
    expect(sameLocation({ path: ['Part'] }, { path: ['Part'], idx: [1] })).toBe(false)
  })

  it('plays, loops, ends and fires events through AnimationPlayer', () => {
    const game = new DataModel().initServices()
    const part = make('Part', { Name: 'Lamp', Transparency: 0 }, game.workspace)
    const player = make('AnimationPlayer', { Autoplay: 'Fade' }, part)
    const fade = make('Animation', { Name: 'Fade', Length: 1 }, player)
    const tr: Track = { path: [], prop: 'Transparency', keys: [] }
    setKey(tr, 0, 0); setKey(tr, 1, 1)
    writeTracks(fade, [tr])
    expect(tracksOf(fade)).toEqual([tr])

    const events: string[] = []
    const runner = new AnimationRunner((inst, ev, ...args) => events.push(`${inst.className}.${ev}(${args.join()})`))
    runner.autoplay([player])
    expect(player.get('Playing')).toBe(true)
    runner.update(0.5)
    expect(part.get<number>('Transparency')).toBeCloseTo(0.5)
    expect(player.get<number>('TimePosition')).toBeCloseTo(0.5)
    runner.update(0.6)
    expect(part.get<number>('Transparency')).toBe(1)
    expect(player.get('Playing')).toBe(false)
    expect(events).toEqual(['AnimationPlayer.Played(Fade)', 'AnimationPlayer.Ended(Fade)'])

    // looped + speed + pause/resume + stop
    fade.set('Looped', true)
    player.set('Speed', 2)
    runner.play(player, 'Fade')
    runner.update(0.75) // 1.5 s at double speed -> wraps to 0.5
    expect(part.get<number>('Transparency')).toBeCloseTo(0.5)
    runner.pause(player)
    runner.update(1)
    expect(part.get<number>('Transparency')).toBeCloseTo(0.5)
    runner.resume(player)
    runner.seek(player, 0.25)
    expect(part.get<number>('Transparency')).toBeCloseTo(0.25)
    runner.stop(player)
    expect(events.at(-1)).toBe('AnimationPlayer.Stopped(Fade)')
    expect(() => runner.play(player, 'Missing')).toThrow(/no Animation named "Missing"/)
  })

  it('works from scripts via the AnimationPlayer methods while the game runs', () => {
    const game = new DataModel().initServices()
    const node = make('Sprite2D', { Name: 'Coin', Position: new Vector2(0, 0) }, game.getService('World2D'))
    const player = make('AnimationPlayer', {}, node)
    const bob = make('Animation', { Name: 'Bob', Length: 2 }, player)
    const tr: Track = { path: [], prop: 'Position', keys: [] }
    setKey(tr, 0, new Vector2(0, 0)); setKey(tr, 2, new Vector2(0, -8))
    writeTracks(bob, [tr])
    const runner = new AnimationRunner((inst, ev, ...args) => inst.fire(ev, ...args))
    const runtime = { animationControl: (p: Instance, a: string, arg?: unknown) => (a === 'Play' ? runner.play(p, arg as string) : runner.stop(p)) }
    ;(game as any).runtime = runtime
    let ended = ''
    addEventSink((i: Instance, ev: string, args: unknown[]) => { if (i === player && ev === 'Ended') ended = String(args[0]) })
    player.classInfo.methods.get('Play')!(player, 'Bob')
    runner.update(1)
    expect(node.get<Vector2>('Position').y).toBeCloseTo(-4)
    runner.update(1.5)
    expect(ended).toBe('Bob')
  })
})
