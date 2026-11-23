// Central editor state. React components subscribe via useEditor().
import { localStorageBackend } from '../engine/save'
import { useSyncExternalStore } from 'react'
import '../engine/classes'
import { DataModel } from '../engine/classes'
import { Instance, SerializedInstance, deserialize, serialize } from '../engine/instance'
import { baseplatePlace, demoPlace } from '../engine/templates'
import { empty2DPlace, platformerPlace } from '../engine/templates2d'
import type { GameSession } from '../engine/game/GameSession'
import type { OutputKind } from '../engine/luau/LuauRuntime'
import { assets, SerializedAsset } from '../engine/assets'
import { idbGet, idbSet } from './persist'
import { onMeshError } from '../engine/render/meshes'
import { onShaderErrors, shaderKindFor } from '../engine/render/shaders'
import { RecipeKind, compileRecipe, parseRecipe } from '../engine/shaderRecipe'
import { DEFAULT_SOURCE, languageOf } from '../engine/scripting/languages'

export type Tool = 'select' | 'move' | 'scale' | 'rotate'

export interface LogEntry { id: number; kind: OutputKind | 'system'; message: string; source?: string; time: string }

export interface PlaceFile {
  format: 'rossengine-place'
  version: 1 | 2
  name: string
  settings?: GameSettings
  root: SerializedInstance
  /** imported files (sounds, images, meshes), embedded as base64 */
  assets?: SerializedAsset[]
}

export interface GameSettings { width: number; height: number; fullscreen: boolean }

const AUTOSAVE_KEY = 'rossengine.autosave'
const IDB_AUTOSAVE = 'autosave'

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
  bottomTab: 'output' | 'assets' | 'animation' = 'output'
  /**
   * Set by the Animation editor while it shows a pose: saving, undo snapshots and Play must see the
   * objects' real (rest) values, not the previewed pose.
   */
  poseGuard: { restore(): void; reapply(): void } | null = null
  /** Run fn with the animation preview taken off (objects at their real values). */
  withRestPose<T>(fn: () => T): T {
    const g = this.poseGuard
    if (!g) return fn()
    g.restore()
    try { return fn() } finally { g.reapply() }
  }
  /** serialize the edit tree with the animation preview taken off */
  private snapshot(): SerializedInstance { return this.withRestPose(() => serialize(this.game)) }

  /** true until the user picks/opens a place this session (shows the start screen) */
  showStart = true

  constructor() {
    this.game = baseplatePlace()
    this.attach(this.game)
    // problems loading imported models show up in Output
    onMeshError((name, message) => this.log('warn', `Model "${name}": ${message}`))
    onShaderErrors((errs) => {
      for (const e of errs) this.log('error', `${e.shader.getFullName()}:${e.line ?? 1}: ${e.message}`, 'Shader')
    })
    assets.subscribe(() => { if (!this.playing && this.ready) { this.dirty = true; this.scheduleAutosave() } this.emit() })
  }

  ready = false
  /** Restore the autosaved place (IndexedDB; falls back to the old localStorage autosave). */
  async init() {
    try {
      let file = await idbGet<PlaceFile>(IDB_AUTOSAVE)
      if (!file) {
        const raw = localStorage.getItem(AUTOSAVE_KEY)
        if (raw) file = JSON.parse(raw) as PlaceFile
      }
      if (file) {
        const g = this.fromFile(file)
        this.placeName = file.name || 'Untitled'
        if (file.settings) this.settings = file.settings
        assets.load(file.assets)
        this.replaceGame(g)
        this.dirty = false
      }
    } catch (e) {
      console.warn('autosave load failed', e)
    }
    this.ready = true
    this.emit()
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
      changed: (inst, prop) => {
        if (prop === 'Name') this.structureVersion++
        if (prop === 'Language') this.swapTemplateSource(inst)
        this.markDirty()
      },
    })
  }

  /** Switching a script's language replaces an untouched starter source with the new language's. */
  private swapTemplateSource(inst: Instance) {
    const src = inst.get<string>('Source') ?? ''
    const isTemplate = !src.trim() || Object.values(DEFAULT_SOURCE).some((d) => d.script === src || d.module === src)
    if (!isTemplate) return
    const lang = languageOf(inst)
    inst.set('Source', DEFAULT_SOURCE[lang][inst.className === 'ModuleScript' ? 'module' : 'script'])
  }

  private markDirty() {
    if (!this.playing) { this.dirty = true; this.scheduleAutosave() }
    this.emit()
  }

  private autosaveTimer: number | null = null
  private scheduleAutosave() {
    if (this.autosaveTimer) clearTimeout(this.autosaveTimer)
    this.autosaveTimer = window.setTimeout(() => {
      if (!this.ready) return
      idbSet(IDB_AUTOSAVE, this.toFile())
        .then(() => { try { localStorage.removeItem(AUTOSAVE_KEY) } catch { /* ignore */ } })
        .catch((e) => console.warn('autosave failed', e))
    }, 800)
  }

  // ------------------------------------------------------------------ files
  toFile(): PlaceFile {
    return { format: 'rossengine-place', version: 2, name: this.placeName, settings: this.settings, root: this.snapshot(), assets: assets.serialize() }
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
    assets.load(file.assets)
    this.showStart = false
    this.fileHandle = handle
    this.replaceGame(g)
    this.undoStack = []
    this.redoStack = []
    this.dirty = false
    this.log('system', `Opened "${this.placeName}"`)
  }

  newPlace(template: 'baseplate' | 'demo' | '2d' | 'platformer') {
    if (this.playing) this.stop()
    if (template === '2d' || template === 'platformer') {
      // 2D templates generate their pixel-art assets, which is asynchronous
      assets.clear()
      this.showStart = false
      void (async () => {
        const g = template === 'platformer' ? await platformerPlace() : empty2DPlace()
        this.placeName = template === 'platformer' ? 'Platformer 2D' : 'Untitled 2D'
        this.fileHandle = null
        this.replaceGame(g)
        this.undoStack = []
        this.redoStack = []
        this.log('system', `New place from template "${template}"`)
      })()
      return
    }
    const g = template === 'demo' ? demoPlace() : baseplatePlace()
    this.placeName = template === 'demo' ? 'Coin Collector' : 'Untitled'
    assets.clear()
    this.showStart = false
    this.fileHandle = null
    this.replaceGame(g)
    this.undoStack = []
    this.redoStack = []
    this.log('system', `New place from template "${template}"`)
  }

  private replaceGame(g: DataModel) {
    refreshVisualShaders(g)
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
    this.undoStack.push(this.snapshot())
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
    to.push(this.snapshot())
    const selectedIds = this.selection.map((s) => s.id)
    const openIds = this.tabs.map((t) => t.id)
    const activeId = this.activeTab?.id
    const g = new DataModel()
    const byRef = new Map<number, Instance>()
    deserialize(snap, g, byRef)
    // the rebuilt objects keep the ids they had in the snapshot, so anything remembered by id
    // (expanded Explorer folders, selection, open tabs) still finds them, even after several undos
    for (const [ref, inst] of byRef) (inst as unknown as { id: number }).id = ref
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
    if (kind === 'error') this.bottomTab = 'output'
    this.logs = [...this.logs.slice(-999), { id: logId++, kind, message, source, time: new Date().toLocaleTimeString() }]
    this.emit()
  }
  clearLogs() { this.logs = []; this.emit() }

  // ------------------------------------------------------------------ save data (Play mode)
  /** Play mode keeps SaveService slots in the browser, separately for each place. */
  saveBackend() { return localStorageBackend(`ross-save:${this.placeName}:`) }
  /** Forget this place's Play-mode save data (all slots). */
  clearSaveData() {
    const b = this.saveBackend()
    const slots = b.list()
    for (const s of slots) b.remove(s)
    this.log('system', slots.length ? `Cleared save data for "${this.placeName}" (${slots.join(', ')})` : `"${this.placeName}" has no save data`)
  }

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
      const session = await GameSession.start(this.playContainer, this.snapshot(), {
        output: (kind, message, source) => this.log(kind, message, source),
        saveBackend: this.saveBackend(),
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

/** Visual (step) shaders store generated GLSL: regenerate it so places pick up fixes to the steps. */
function refreshVisualShaders(g: DataModel) {
  for (const sh of g.getDescendants()) {
    if (sh.className !== 'Shader' && sh.className !== 'ScreenShader') continue
    const recipe = parseRecipe(sh.get<string>('Recipe'))
    if (!recipe) continue
    try {
      const out = compileRecipe(recipe, shaderKindFor(sh) as RecipeKind)
      if (out.source !== sh.get<string>('Source')) sh.set('Source', out.source)
    } catch (e) {
      console.warn('could not regenerate visual shader', sh.getFullName(), e)
    }
  }
}
