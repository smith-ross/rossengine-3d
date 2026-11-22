// Editing operations on the edit DataModel (all undoable).
import { CFrame, Color3, Vector3, enumItem } from '../engine/datatypes'
import { Instance, SerializedInstance, createInstance, deserialize, getClass, serialize } from '../engine/instance'
import { BasePart, Model, boundingBox, partsOf } from '../engine/classes'
import { editor } from './store'
import { DEFAULT_SOURCE, ScriptLanguage } from '../engine/scripting/languages'

/** Insert a Script or ModuleScript in the given language, with a starter source. */
export function insertScript(cls: 'Script' | 'ModuleScript', lang: ScriptLanguage, parent?: Instance): Instance {
  return editor.mutate(() => {
    const s = createInstance(cls)
    s.set('Language', enumItem('ScriptLanguage', lang))
    s.set('Source', DEFAULT_SOURCE[lang][cls === 'Script' ? 'script' : 'module'])
    s.setParent(parent ?? defaultParentFor(cls))
    editor.selection = [s]
    editor.openScript(s)
    return s
  })
}

let clipboard: SerializedInstance[] = []
/** Where new parts go: set by the viewport to the point in front of the camera. */
export const insertHint = { position: new Vector3(0, 5, 0) }

const isService = (i: Instance) => i.classInfo.service || i.className === 'DataModel'

export function defaultParentFor(className: string): Instance {
  const g = editor.game
  const sel = editor.selection[0]
  const info = getClass(className)
  if (sel && !(sel instanceof BasePart && info && (isA(info.name, 'BasePart')))) {
    // insert into the selected container
    return sel
  }
  if (className === 'Script') return g.getService('ScriptService')
  if (className === 'ModuleScript') return g.getService('Storage')
  if (className === 'ScreenGui') return g.getService('StarterGui')
  return g.workspace
}

function isA(cls: string, base: string) {
  for (let c = getClass(cls); c; c = c.superclass) if (c.name === base) return true
  return false
}

export function insertObject(className: string, parent?: Instance): Instance {
  return editor.mutate(() => {
    const inst = createInstance(className)
    if (inst instanceof BasePart) {
      inst.set('Anchored', true)
      const p = insertHint.position
      inst.set('CFrame', CFrame.fromPosition(new Vector3(Math.round(p.x), Math.round(p.y) + 0.5, Math.round(p.z))))
      if (className === 'SpawnLocation') { inst.set('Size', new Vector3(12, 1, 12)) }
    }
    if (className === 'Part' || className === 'WedgePart') inst.set('Color', Color3.fromRGB(163, 162, 165))
    if (className === 'Frame' || className === 'TextLabel' || className === 'TextButton' || className === 'TextBox' || className === 'ImageLabel') {
      const p = parent ?? defaultParentFor(className)
      if (!(p.className === 'ScreenGui' || p.isA('GuiObject'))) {
        // GUI objects need a ScreenGui
        const sg = createInstance('ScreenGui')
        sg.setParent(editor.game.getService('StarterGui'))
        inst.setParent(sg)
        editor.selection = [inst]
        return inst
      }
    }
    inst.setParent(parent ?? defaultParentFor(className))
    editor.selection = [inst]
    if (inst.isA('LuaSourceContainer')) editor.openScript(inst)
    return inst
  })
}

export function insertPart(shape: 'Block' | 'Ball' | 'Cylinder' | 'Wedge' | 'Spawn') {
  const cls = shape === 'Wedge' ? 'WedgePart' : shape === 'Spawn' ? 'SpawnLocation' : 'Part'
  const parent = editor.game.workspace
  const part = insertObject(cls, parent)
  if (shape === 'Ball') { part.set('Shape', enumItem('PartType', 'Ball')); part.set('Size', new Vector3(4, 4, 4)) }
  if (shape === 'Cylinder') { part.set('Shape', enumItem('PartType', 'Cylinder')); part.set('Size', new Vector3(2, 4, 4)) }
  return part
}

function topLevelSelection(): Instance[] {
  const sel = editor.selection.filter((s) => !isService(s) && !s.parentLocked)
  return sel.filter((s) => !sel.some((o) => o !== s && s.isDescendantOf(o)))
}

export function deleteSelection() {
  const sel = topLevelSelection()
  if (!sel.length) return
  editor.mutate(() => {
    for (const s of sel) if (!(s instanceof BasePart && s.get('Locked') && sel.length > 1)) s.destroy()
    editor.selection = []
  })
}

export function duplicateSelection() {
  const sel = topLevelSelection()
  if (!sel.length) return
  editor.mutate(() => {
    const copies = sel.map((s) => {
      const c = s.clone()
      c.setParent(s.parent)
      return c
    })
    editor.selection = copies
  })
}

export function copySelection() {
  clipboard = topLevelSelection().map((s) => serialize(s))
}

export function cutSelection() {
  copySelection()
  deleteSelection()
}

export function paste(into?: Instance) {
  if (!clipboard.length) return
  editor.mutate(() => {
    const target = into ?? editor.selection[0]?.parent ?? editor.game.workspace
    const made = clipboard.map((d) => {
      const i = deserialize(d)
      i.setParent(target)
      return i
    })
    editor.selection = made
  })
}

export function groupSelection() {
  const sel = topLevelSelection()
  if (!sel.length) return
  editor.mutate(() => {
    const model = createInstance('Model')
    model.setParent(sel[0].parent)
    for (const s of sel) s.setParent(model)
    editor.selection = [model]
  })
}

export function ungroupSelection() {
  const sel = topLevelSelection().filter((s) => s.className === 'Model' || s.className === 'Folder')
  if (!sel.length) return
  editor.mutate(() => {
    const out: Instance[] = []
    for (const m of sel) {
      for (const c of [...m.children]) { c.setParent(m.parent); out.push(c) }
      m.destroy()
    }
    editor.selection = out
  })
}

export function reparent(insts: Instance[], parent: Instance) {
  const valid = insts.filter((i) => !isService(i) && !i.parentLocked && i !== parent && !parent.isDescendantOf(i))
  if (!valid.length) return
  editor.mutate(() => { for (const i of valid) i.setParent(parent) })
}

export function weldSelection() {
  const parts = topLevelSelection().flatMap((s) => partsOf(s))
  if (parts.length < 2) return
  editor.mutate(() => {
    const root = parts[0]
    for (const p of parts.slice(1)) {
      const w = createInstance('WeldConstraint')
      w.set('Part0', root)
      w.set('Part1', p)
      w.setParent(root)
    }
  })
}

export function selectionPivot(sel: Instance[]): CFrame | null {
  if (sel.length === 1) {
    const s = sel[0]
    if (s instanceof BasePart) return s.cframe
    if (s instanceof Model) return s.getPivot()
  }
  const parts = sel.flatMap((s) => partsOf(s))
  if (!parts.length) return null
  return boundingBox(parts).cframe
}

/** Apply a rigid transform delta to the selection (world space: newCF = delta * oldCF). */
export function transformSelection(sel: Instance[], startCFs: Map<BasePart, CFrame>, delta: CFrame) {
  for (const [p, cf] of startCFs) p.set('CFrame', delta.mul(cf))
  void sel
}
