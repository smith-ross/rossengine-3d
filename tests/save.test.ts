import { describe, it, expect } from 'vitest'
import '../src/engine/classes'
import { DataModel } from '../src/engine/classes'
import { CFrame, Color3, Vector3 } from '../src/engine/datatypes'
import { Instance } from '../src/engine/instance'
import { DEFAULT_SLOT, SaveStore, checkSlotName, fromSaveJSON, memoryBackend, toSaveJSON } from '../src/engine/save'

const events = () => {
  const log: string[] = []
  return { log, ev: { changed: (k: string, v: unknown) => log.push(`changed ${k}=${JSON.stringify(toSaveJSON(v))}`), loaded: (s: string) => log.push(`loaded ${s}`), saved: (s: string) => log.push(`saved ${s}`), warn: (m: string) => log.push(`warn ${m}`) } }
}

describe('save data', () => {
  it('round-trips script values through readable JSON', () => {
    const inventory = new Map<unknown, unknown>([[1, 'Sword'], [2, 'Shield']])
    const stats = new Map<unknown, unknown>([['hp', 10], ['spawn', new Vector3(1, 2, 3)], ['tint', new Color3(1, 0, 0.5)], ['items', inventory]])
    const json = toSaveJSON(stats)
    expect(json).toEqual({ hp: 10, spawn: { $type: 'Vector3', value: [1, 2, 3] }, tint: { $type: 'Color3', value: [1, 0, 0.5] }, items: ['Sword', 'Shield'] })
    const back = fromSaveJSON(JSON.parse(JSON.stringify(json))) as Map<string, unknown>
    expect(back.get('spawn')).toEqual(new Vector3(1, 2, 3))
    expect((back.get('items') as Map<number, string>).get(2)).toBe('Shield')
    expect(fromSaveJSON(toSaveJSON(new CFrame(1, 2, 3)))).toEqual(new CFrame(1, 2, 3))
    // plain objects / live tables (TypeScript, Python, Luau proxies) work too
    expect(toSaveJSON({ 1: 'a', 2: 'b' })).toEqual(['a', 'b'])
    expect(toSaveJSON({ level: 3, name: 'Ross' })).toEqual({ level: 3, name: 'Ross' })
    // things that can't be saved say so
    expect(() => toSaveJSON(new Map([['part', new Instance()]]), 'Coins')).toThrow(/Can't save an Instance \(Coins\.part\)/)
    expect(() => toSaveJSON(() => 1, 'cb')).toThrow(/function/)
    expect(() => toSaveJSON(Infinity, 'x')).toThrow()
  })

  it('saves automatically, keeps slots apart, and falls back to defaults', async () => {
    const backend = memoryBackend()
    const { log, ev } = events()
    const store = new SaveStore(backend, new Map([['Coins', 0], ['Name', 'Hero']]), ev)
    store.load(DEFAULT_SLOT)
    expect(store.get('Coins')).toBe(0) // default
    expect(store.get('Missing', 42)).toBe(42)
    expect(store.hasSave()).toBe(false)
    store.set('Coins', 5)
    const inv = new Map<unknown, unknown>([[1, 'Sword']])
    store.set('Inventory', inv)
    inv.set(2, 'Hacked') // changing the script's table afterwards doesn't change the save
    expect(backend.files.size).toBe(0) // not written yet: autosave is debounced
    await new Promise((r) => setTimeout(r, 600))
    const file = JSON.parse(backend.files.get(DEFAULT_SLOT)!)
    expect(file.format).toBe('rossengine-save')
    expect(file.data).toEqual({ Coins: 5, Inventory: ['Sword'] })
    expect(log).toContain('saved Default')

    // another slot starts from the defaults; switching back finds the first save again
    store.load('Slot 2')
    expect(store.get('Coins')).toBe(0)
    store.set('Coins', 99)
    store.load(DEFAULT_SLOT) // saves "Slot 2" first
    expect(store.get('Coins')).toBe(5)
    expect(store.listSlots()).toEqual(['Default', 'Slot 2'])
    expect(store.hasSave()).toBe(true)

    // clear: back to defaults; delete a slot
    store.clear()
    expect(store.get('Coins')).toBe(0)
    store.deleteSlot('Slot 2')
    expect(store.listSlots()).toEqual(['Default'])
    expect(() => checkSlotName('../escape')).toThrow(/Bad save slot name/)
  })

  it('only writes when asked if AutoSave is off, and recovers from a broken file', () => {
    const backend = memoryBackend()
    const { log, ev } = events()
    const store = new SaveStore(backend, new Map(), ev)
    store.autoSave = false
    store.load()
    store.set('Level', 3)
    expect(backend.files.size).toBe(0)
    store.flush()
    expect(JSON.parse(backend.files.get(DEFAULT_SLOT)!).data).toEqual({ Level: 3 })
    backend.files.set('Broken', '{not json')
    store.load('Broken')
    expect(store.get('Level')).toBe(null)
    expect(log.some((l) => l.startsWith('warn Save slot "Broken" couldn\'t be read'))).toBe(true)
  })

  it('works through SaveService, mirroring simple values to attributes', () => {
    const game = new DataModel().initServices()
    const svc = game.getService('SaveService')
    const backend = memoryBackend()
    const fired: string[] = []
    svc.attributes.set('Coins', 10) // set in the editor: the starting value
    const store = new SaveStore(backend, new Map(svc.attributes), {
      changed: (k, v) => { if (v != null && typeof v !== 'object') svc.attributes.set(k, v); fired.push(k) },
      loaded: () => {}, saved: () => {}, warn: () => {},
    })
    store.load()
    ;(game as any).runtime = { saveStore: () => store, saveAttributeSet: (k: string, v: unknown) => store.set(k, v) }
    const call = (name: string, ...args: unknown[]) => svc.classInfo.methods.get(name)!(svc, ...args)
    expect(call('Get', 'Coins')).toBe(10)
    expect(call('Increment', 'Coins', 5)).toBe(15)
    expect(call('Increment', 'Deaths')).toBe(1)
    expect(call('Update', 'Coins', (c: number) => c * 2)).toBe(30)
    expect(svc.attributes.get('Coins')).toBe(30)
    // SetAttribute on SaveService saves too
    svc.classInfo.methods.get('SetAttribute')!(svc, 'BestTime', 12.5)
    expect(call('Get', 'BestTime')).toBe(12.5)
    expect(call('Has', 'Nope')).toBe(false)
    const all = call('GetAll') as Map<string, unknown>
    expect([...all.keys()].sort()).toEqual(['BestTime', 'Coins', 'Deaths'])
    call('SetSlot', 'Hard Mode')
    expect(call('GetSlot')).toBe('Hard Mode')
    expect(call('Get', 'Coins')).toBe(10) // new slot: the editor's starting value
    expect(() => call('Update', 'Coins', 5)).toThrow(/needs a function/)
    expect(fired).toContain('Deaths')
  })
})
