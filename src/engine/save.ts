// Save data for games: SaveService keeps values in save slots on the player's machine.
//
// Values are saved automatically (shortly after a change, and when the game closes). A slot is a
// small readable JSON file: in an exported game it lives in the game's own app-data folder; in the
// editor's Play mode and the web player it's kept in the browser.
import { CFrame, Color3, EnumItem, UDim, UDim2, Vector2, Vector3, enumItem } from './datatypes'
import { Instance } from './instance'
import { isListMap, listMap } from './tables'

/** Where save slots are stored. All calls are synchronous (slots are small). */
export interface SaveBackend {
  read(slot: string): string | null
  write(slot: string, json: string): void
  list(): string[]
  remove(slot: string): void
}

export const DEFAULT_SLOT = 'Default'
/** Slot names are used as file names: keep them simple. */
export function checkSlotName(name: unknown): string {
  const s = String(name ?? '').trim()
  if (!/^[\w\- ]{1,48}$/.test(s)) throw new Error(`Bad save slot name "${s}": use 1-48 letters, numbers, spaces, - or _`)
  return s
}

// ------------------------------------------------------------------ values <-> JSON
/**
 * Engine values -> plain JSON. Tables become JSON arrays/objects; datatypes become
 * { "$type": "Vector3", "value": [x, y, z] } so save files stay readable.
 */
export function toSaveJSON(v: unknown, path = 'value'): unknown {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new Error(`Can't save ${v} (${path})`); return v }
  if (typeof v === 'string' || typeof v === 'boolean') return v
  if (v instanceof Vector3) return { $type: 'Vector3', value: [v.x, v.y, v.z] }
  if (v instanceof Vector2) return { $type: 'Vector2', value: [v.x, v.y] }
  if (v instanceof Color3) return { $type: 'Color3', value: [v.r, v.g, v.b] }
  if (v instanceof CFrame) return { $type: 'CFrame', value: v.components() }
  if (v instanceof UDim2) return { $type: 'UDim2', value: [v.xs, v.xo, v.ys, v.yo] }
  if (v instanceof UDim) return { $type: 'UDim', value: [v.scale, v.offset] }
  if (v instanceof EnumItem) return { $type: 'EnumItem', value: [v.enumType, v.name] }
  if (v instanceof Instance) throw new Error(`Can't save an Instance (${path}): save its name or properties instead`)
  if (v instanceof Map) {
    if (isListMap(v)) return [...v.values()].map((x, i) => toSaveJSON(x, `${path}[${i + 1}]`))
    const o: Record<string, unknown> = {}
    for (const [k, x] of v) {
      if (typeof k !== 'string' && typeof k !== 'number') throw new Error(`Can't save a table key of type ${typeof k} (${path})`)
      o[String(k)] = toSaveJSON(x, `${path}.${k}`)
    }
    return o
  }
  if (Array.isArray(v)) return v.map((x, i) => toSaveJSON(x, `${path}[${i + 1}]`))
  if (typeof v === 'function') throw new Error(`Can't save a function (${path})`)
  if (typeof v === 'object') {
    // plain objects (TypeScript/Python) and live script tables
    const keys = Object.keys(v as object)
    const obj = v as Record<string, unknown>
    if (keys.length && keys.every((k, i) => k === String(i + 1))) return keys.map((k) => toSaveJSON(obj[k], `${path}[${k}]`))
    const o: Record<string, unknown> = {}
    for (const k of keys) o[k] = toSaveJSON(obj[k], `${path}.${k}`)
    return o
  }
  throw new Error(`Can't save this kind of value (${path})`)
}

/** Plain JSON -> engine values (tables come back as Maps, like any script table). */
export function fromSaveJSON(v: unknown): unknown {
  if (Array.isArray(v)) return listMap(v.map((x) => fromSaveJSON(x)))
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    const val = o.value as any[]
    switch (o.$type) {
      case 'Vector3': return new Vector3(val[0], val[1], val[2])
      case 'Vector2': return new Vector2(val[0], val[1])
      case 'Color3': return new Color3(val[0], val[1], val[2])
      case 'CFrame': return CFrame.fromComponents(val)
      case 'UDim2': return new UDim2(val[0], val[1], val[2], val[3])
      case 'UDim': return new UDim(val[0], val[1])
      case 'EnumItem': try { return enumItem(val[0], val[1]) } catch { return null }
    }
    return new Map(Object.entries(o).map(([k, x]) => [k, fromSaveJSON(x)]))
  }
  return v
}

/** Values that can also live as attributes on SaveService (so GetAttributeChangedSignal works). */
export const attributeFriendly = (v: unknown) =>
  typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean' ||
  v instanceof Vector3 || v instanceof Vector2 || v instanceof Color3 || v instanceof CFrame || v instanceof UDim2 || v instanceof UDim

interface SaveFile { format: 'rossengine-save'; version: 1; savedAt: string; data: Record<string, unknown> }

// ------------------------------------------------------------------ the store
export interface SaveEvents {
  changed(key: string, value: unknown): void
  loaded(slot: string): void
  saved(slot: string): void
  warn(message: string): void
}

/** One game's save data: the current slot's values, saved through a backend. */
export class SaveStore {
  slot = DEFAULT_SLOT
  autoSave = true
  private data = new Map<string, unknown>()
  private exists = false
  private dirty = false
  private timer: ReturnType<typeof setTimeout> | null = null

  /** defaults: values to use for keys a save doesn't have (SaveService's attributes in the editor) */
  constructor(private backend: SaveBackend | null, private defaults: Map<string, unknown>, private events: SaveEvents) {}

  /** Load a slot (the current one is saved first). */
  load(slot = this.slot) {
    if (slot !== this.slot) this.flush()
    this.slot = checkSlotName(slot)
    this.data.clear()
    this.exists = false
    const json = this.backend?.read(this.slot) ?? null
    if (json) {
      try {
        const file = JSON.parse(json) as SaveFile
        for (const [k, v] of Object.entries(file.data ?? {})) this.data.set(k, fromSaveJSON(v))
        this.exists = true
      } catch (e) {
        this.events.warn(`Save slot "${this.slot}" couldn't be read (${(e as Error).message}); starting from the defaults.`)
      }
    }
    this.events.loaded(this.slot)
  }

  get(key: string, fallback: unknown = null): unknown {
    if (this.data.has(key)) return this.data.get(key)
    if (this.defaults.has(key)) return this.defaults.get(key)
    return fallback
  }
  has(key: string) { return this.data.has(key) || this.defaults.has(key) }

  set(key: string, value: unknown) {
    key = String(key)
    if (!key) throw new Error('Save keys must not be empty')
    if (value === null || value === undefined) { this.remove(key); return }
    // a copy in engine form: fails now (with a clear message) rather than when writing, and later
    // changes to the script's table don't change the saved data behind its back
    value = fromSaveJSON(toSaveJSON(value, key))
    this.data.set(key, value)
    this.touched(key, value)
  }

  remove(key: string) {
    if (!this.data.delete(key)) return
    this.touched(key, this.get(key))
  }

  /** Everything in the slot, defaults included. */
  all(): Map<string, unknown> {
    const out = new Map(this.defaults)
    for (const [k, v] of this.data) out.set(k, v)
    return out
  }

  /** Back to the defaults (the slot is written as empty). */
  clear() {
    const keys = [...this.data.keys()]
    this.data.clear()
    for (const k of keys) this.touched(k, this.get(k))
    if (!keys.length) { this.dirty = true; this.schedule() }
  }

  /** Is there saved data in the current slot (e.g. for a "Continue" button)? */
  hasSave() { return this.exists || this.data.size > 0 }
  listSlots() { return this.backend?.list() ?? [] }
  deleteSlot(slot: string) {
    slot = checkSlotName(slot)
    this.backend?.remove(slot)
    if (slot === this.slot) {
      if (this.timer) clearTimeout(this.timer)
      this.dirty = false
      const keys = [...this.data.keys()]
      this.data.clear()
      this.exists = false
      for (const k of keys) this.events.changed(k, this.get(k))
    }
  }

  private touched(key: string, value: unknown) {
    this.dirty = true
    this.events.changed(key, value)
    this.schedule()
  }
  private schedule() {
    if (!this.autoSave || this.timer) return
    this.timer = setTimeout(() => { this.timer = null; this.flush() }, 500)
  }

  /** Write the slot now (if anything changed). */
  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    if (!this.dirty || !this.backend) return
    const data: Record<string, unknown> = {}
    for (const [k, v] of this.data) {
      try { data[k] = toSaveJSON(v, k) } catch (e) { this.events.warn((e as Error).message) }
    }
    const file: SaveFile = { format: 'rossengine-save', version: 1, savedAt: new Date().toISOString(), data }
    try {
      this.backend.write(this.slot, JSON.stringify(file, null, 2))
      this.dirty = false
      this.exists = true
      this.events.saved(this.slot)
    } catch (e) {
      this.events.warn(`Couldn't save slot "${this.slot}": ${(e as Error).message}`)
    }
  }
}

// ------------------------------------------------------------------ browser storage
/** Slots in localStorage under a prefix (the editor's Play mode uses one per place). */
export function localStorageBackend(prefix: string): SaveBackend {
  const key = (slot: string) => `${prefix}${slot}`
  return {
    read: (slot) => { try { return localStorage.getItem(key(slot)) } catch { return null } },
    write: (slot, json) => localStorage.setItem(key(slot), json),
    list: () => {
      const out: string[] = []
      try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k?.startsWith(prefix)) out.push(k.slice(prefix.length)) } } catch { /* blocked */ }
      return out.sort()
    },
    remove: (slot) => { try { localStorage.removeItem(key(slot)) } catch { /* ignore */ } },
  }
}

/** A backend that keeps nothing (tests, or when storage isn't available). */
export function memoryBackend(): SaveBackend & { files: Map<string, string> } {
  const files = new Map<string, string>()
  return { files, read: (s) => files.get(s) ?? null, write: (s, j) => { files.set(s, j) }, list: () => [...files.keys()].sort(), remove: (s) => { files.delete(s) } }
}
