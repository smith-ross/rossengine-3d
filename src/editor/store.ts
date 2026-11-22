// Central editor state. React components subscribe via useEditor().
import { useSyncExternalStore } from 'react'
import '../engine/classes'
import { DataModel } from '../engine/classes'
import { Instance, SerializedInstance, deserialize, serialize } from '../engine/instance'
import { baseplatePlace, demoPlace } from '../engine/templates'
import type { GameSession } from '../engine/game/GameSession'
import type { OutputKind } from '../engine/luau/LuauRuntime'

export type Tool = 'select' | 'move' | 'scale' | 'rotate'

export interface LogEntry { id: number; kind: OutputKind | 'system'; message: string; source?: string; time: string }

export interface PlaceFile {
  format: 'rossengine-place'
  version: 1
  name: string
  settings?: GameSettings
  root: SerializedInstance
}

export interface GameSettings { width: number; height: number; fullscreen: boolean }

const AUTOSAVE_KEY = 'rossengine.autosave'

let logId = 1

class EditorStore {
  game: DataModel
  placeName = 'Untitled'
  settings: GameSettings = { width: 1280, height: 720, fullscreen: false }
  selection: Instance[] = []
  tool: Tool = 'move'
  snap = 1
  rotateSnap = 15
  /** open script tabs; null = 3D viewport */
  tabs: Instance[] = []
  activeTab: Instance | null = null
  logs: LogEntry[] = []
  session: GameSession | null = null
  playing = false
  starting = false
  dirty = false
  fileHandle: any = null
  version = 0 // bumps on any change, for React re-renders
  structureVersion = 0 // bumps when the tree changes
  private listeners = new Set<() => void>()
  private undoStack: SerializedInstance[] = []
  private redoStack: SerializedInstance[] = []
  private unobserve: (() => void) | null = null
  revealLine: { script: Instance; line: number } | null = null

  constructor() {
    this.game = this.loadAutosave() ?? baseplatePlace()
    this.attach(this.game)
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }
  private scheduled = false
  emit = () => {
    if (this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      this.version++
      for (const l of this.listeners) l()
    })
  }

  /** The DataModel shown in the explorer: the running game while playing. */
  get viewGame(): DataModel {
    return this.playing && this.session ? this.session.game : this.game
  }

  private attach(game: DataModel) {
    this.unobserve?.()
    this.unobserve = game.observe({
      added: () => { this.structureVersion++; this.markDirty() },
      removing: (inst) => {
        this.structureVersion++
        this.selection = this.selection.filter((s) => s !== inst && !s.isDescendantOf(inst))
        this.tabs = this.tabs.filter((t) => t !== inst && !t.isDescendantOf(inst))
        if (this.activeTab && !this.tabs.includes(this.activeTab)) this.activeTab = null
        this.markDirty()
      },
      reparented: () => { this.structureVersion++; this.markDirty() },
      changed: (_i, prop) => { if (prop === 'Name') this.structureVersion++; this.markDirty() },
    })
  }

  private markDirty() {
    if (!this.playing) { this.dirty = true; this.scheduleAutosave() }
    this.emit()
  }

  private autosaveTimer: number | null = null
  private scheduleAutosave() {
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer)
    this.autosaveTimer = window.setTimeout(() => {
      try { localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(this.toFile())) } catch { /* quota */ }
    }, 800)
  }

  private loadAutosave(): DataModel | null {
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY)
      if (!raw) return null
      const file = JSON.parse(raw) as PlaceFile
      this.placeName = file.name || 'Untitled'
      if (file.settings) this.settings = file.settings
      return this.fromFile(file)
    } catch (e) {
      console.warn('autosave load failed', e)
      return null
    }
  }

  // ------------------------------------------------------------------ files
  toFile(): PlaceFile {
    return { format: 'rossengine-place', version: 1, name: this.placeName, settings: this.settings, root: serialize(this.game) }
  }

  private fromFile(file: PlaceFile): DataModel {
    if (file.format !== 'rossengine-place') throw new Error('Not a RossEngine place file')
    const g = new DataModel()
    deserialize(file.root, g)
    g.initServices()
    return g
  }

  openFile(file: PlaceFile, handle: any = null) {
    if (this.playing) this.stop()
    const g = this.fromFile(file)
    this.placeName = file.name || 'Untitled'
    if (file.settings) this.settings = { ...this.settings, ...file.settings }
    this.fileHandle = handle
    this.replaceGame(g)
    this.undoStack = []
    this.redoStack = []
    this.dirty = false
    this.log('system', `Opened "${this.placeName}"`)
  }

  newPlace(template: 'baseplate' | 'demo') {
    if (this.playing) this.stop()
    const g = template === 'demo' ? demoPlace() : baseplatePlace()
    this.placeName = template === 'demo' ? 'Coin Collector' : 'Untitled'
    this.fileHandle = null
    this.replaceGame(g)
    this.undoStack = []
    this.redoStack = []
    this.log('system', `New place from template "${template}"`)
  }

  private replaceGame(g: DataModel) {
    this.game = g
    this.selection = []
    this.tabs = []
    this.activeTab = null
    this.attach(g)
    this.structureVersion++
    this.scheduleAutosave()
    this.emit()
  }

  // ------------------------------------------------------------------ undo
  /** Record an undo point before mutating the edit DataModel. */
  checkpoint() {
    if (this.playing) return
    this.undoStack.push(serialize(this.game))
    if (this.undoStack.length > 60) this.undoStack.shift()
    this.redoStack = []
  }

  mutate<T>(fn: () => T): T {
    this.checkpoint()
    const r = fn()
    this.emit()
    return r
  }

  canUndo() { return !this.playing && this.undoStack.length > 0 }
  canRedo() { return !this.playing && this.redoStack.length > 0 }

  undo() { this.restore(this.undoStack, this.redoStack) }
  redo() { this.restore(this.redoStack, this.undoStack) }

  private restore(from: SerializedInstance[], to: SerializedInstance[]) {
    if (this.playing) return
    const snap = from.pop()
    if (!snap) return
    to.push(serialize(this.game))
    const selectedIds = this.selection.map((s) => s.id)
    const openIds = this.tabs.map((t) => t.id)
    const activeId = this.activeTab?.id
    const g = new DataModel()
    const byRef = new Map<number, Instance>()
    deserialize(snap, g, byRef)
    g.initServices()
    this.replaceGame(g)
    this.selection = selectedIds.map((id) => byRef.get(id)).filter((x): x is Instance => !!x)
    this.tabs = openIds.map((id) => byRef.get(id)).filter((x): x is Instance => !!x)
    this.activeTab = activeId ? byRef.get(activeId) ?? null : null
    this.emit()
  }

  // ------------------------------------------------------------------ selection & tabs
  select(insts: Instance[]) {
    this.selection = insts
    this.emit()
  }

  openScript(inst: Instance, line?: number) {
    if (!this.tabs.includes(inst)) this.tabs = [...this.tabs, inst]
    this.activeTab = inst
    if (line) this.revealLine = { script: inst, line }
    this.emit()
  }

  closeTab(inst: Instance) {
    this.tabs = this.tabs.filter((t) => t !== inst)
    if (this.activeTab === inst) this.activeTab = this.tabs[this.tabs.length - 1] ?? null
    this.emit()
  }

  setTool(t: Tool) { this.tool = t; this.emit() }

  // ------------------------------------------------------------------ output
  log(kind: LogEntry['kind'], message: string, source?: string) {
    this.logs = [...this.logs.slice(-999), { id: logId++, kind, message, source, time: new Date().toLocaleTimeString() }]
    this.emit()
  }
  clearLogs() { this.logs = []; this.emit() }

  // ------------------------------------------------------------------ play
  playContainer: HTMLElement | null = null

  async play() {
    if (this.playing || this.starting || !this.playContainer) return
    this.starting = true
    this.activeTab = null
    this.emit()
    const { GameSession } = await import('../engine/game/GameSession')
    try {
      this.log('system', 'Starting game…')
      const session = await GameSession.start(this.playContainer, serialize(this.game), {
        output: (kind, message, source) => this.log(kind, message, source),
      })
      this.session = session
      this.playing = true
      this.selection = []
      this.unobserve?.()
      this.unobserve = session.game.observe({
        added: () => { this.structureVersion++; this.emit() },
        removing: (inst) => {
          this.structureVersion++
          this.selection = this.selection.filter((s) => s !== inst && !s.isDescendantOf(inst))
          this.emit()
        },
        reparented: () => { this.structureVersion++; this.emit() },
        changed: () => this.emitThrottled(),
      })
    } catch (e) {
      this.log('error', `Failed to start: ${(e as Error)?.stack ?? e}`)
    } finally {
      this.starting = false
      this.structureVersion++
      this.emit()
    }
  }

  private throttle = 0
  private emitThrottled() {
    const now = performance.now()
    if (now - this.throttle > 150) { this.throttle = now; this.emit() }
  }

  stop() {
    if (!this.session) return
    this.session.stop()
    this.session = null
    this.playing = false
    this.selection = []
    this.attach(this.game)
    this.structureVersion++
    this.log('system', 'Stopped.')
    this.emit()
  }
}

export const editor = new EditorStore()
;(window as any).__editor = editor

export function useEditor() {
  useSyncExternalStore(editor.subscribe, () => editor.version)
  return editor
}
