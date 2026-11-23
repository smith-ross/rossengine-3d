// Editing operations on the edit DataModel (all undoable).
import { CFrame, Color3, UDim2, Vector2, Vector3, enumItem } from '../engine/datatypes'
import { Instance, SerializedInstance, createInstance, deserialize, getClass, serialize } from '../engine/instance'
import { BasePart, Model, boundingBox, partsOf } from '../engine/classes'
import { editor } from './store'
import { view2d } from './components/Viewport2D'
import { DEFAULT_SOURCE, ScriptLanguage } from '../engine/scripting/languages'
import { CHARACTER_CONTROLLER } from '../engine/scripting/characterController'
import { compileRecipe, defaultRecipe } from '../engine/shaderRecipe'

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

/** Instances edited in the code editor: scripts and shaders. */
export const isCode = (i: Instance) => i.isA('LuaSourceContainer') || i.className === 'Shader' || i.className === 'ScreenShader'

/**
 * Where a character controller script can go: the selection if it is a CharacterBody3D or has one
 * inside it (e.g. a model holding the body and its mesh).
 */
export function characterControllerTarget(): Instance | null {
  const sel = editor.selection[0]
  if (!sel || editor.playing) return null
  if (sel.className === 'CharacterBody3D') return sel
  return sel.getDescendants().some((d) => d.className === 'CharacterBody3D') ? sel : null
}

/** Insert the default CharacterBody3D controller (an ordinary, editable script) in a language. */
export function insertCharacterController(lang: ScriptLanguage): Instance | null {
  const target = characterControllerTarget()
  if (!target) return null
  return editor.mutate(() => {
    const s = createInstance('Script')
    s.name = 'CharacterController'
    s.set('Language', enumItem('ScriptLanguage', lang))
    s.set('Source', CHARACTER_CONTROLLER[lang])
    s.setParent(target)
    // the body replaces the default character (set here too, so it never spawns even for a moment)
    const players = editor.game.getService('Players')
    if (players.get('CharacterAutoLoads')) {
      players.set('CharacterAutoLoads', false)
      editor.log('info', 'Players.CharacterAutoLoads is now off: your CharacterBody3D is the player character.')
    }
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
  if (info && isA(info.name, 'Node2D')) {
    return sel && isA(sel.className, 'Node2D') && !(sel.className === 'TileMap') ? sel : g.getService('World2D')
  }
  if (className === 'Shader') {
    // inside the selected part / 2D drawable (or the parent of a selected Shader)
    const drawable = (i?: Instance | null) => !!i && (i instanceof BasePart || ['Sprite2D', 'AnimatedSprite2D', 'TileMap', 'Text2D'].includes(i.className))
    if (drawable(sel)) return sel!
    if (sel?.className === 'Shader' && drawable(sel.parent)) return sel.parent!
  }
  if (className === 'ScreenShader') return g.getService('World2D').get('Enabled') ? g.getService('World2D') : g.getService('Lighting')
  if (sel && !(sel instanceof BasePart && info && (isA(info.name, 'BasePart')))) {
    // insert into the selected container
    return sel
  }
  if (info && isA(info.name, 'Node2D')) {
    // inside the selected 2D node, otherwise at the top of the 2D world
    return sel && isA(sel.className, 'Node2D') ? sel : g.getService('World2D')
  }
  if (className === 'TileTerrain') return sel?.className === 'TileMap' ? sel : sel?.parent?.className === 'TileMap' ? sel.parent : g.getService('World2D')
  if (className === 'SpriteAnimation') return sel?.className === 'AnimatedSprite2D' ? sel : (sel?.parent?.className === 'AnimatedSprite2D' ? sel.parent : g.getService('World2D'))
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
      if (className === 'CharacterBody3D') {
        // a person-sized capsule standing on the ground
        inst.set('Size', new Vector3(2, 5, 2))
        inst.set('Color', Color3.fromRGB(95, 160, 255))
        inst.set('CFrame', CFrame.fromPosition(new Vector3(Math.round(p.x), Math.round(p.y) + 2.5, Math.round(p.z))))
      }
    }
    if (className === 'Part' || className === 'WedgePart') inst.set('Color', Color3.fromRGB(163, 162, 165))
    if (isA(className, 'Node2D') && !(parent ?? defaultParentFor(className)).isA('Node2D')) {
      // drop new 2D objects at the centre of the 2D view
      inst.set('Position', new Vector2(Math.round(view2d.x), Math.round(view2d.y)))
    }
    if (className === 'Camera2D') editor.game.getService('World2D').set('CurrentCamera', inst)
    if (className === 'BillboardGui') return insertBillboard(inst, parent)
    if (className === 'ParticleEmitter' && !((parent ?? defaultParentFor(className)) instanceof BasePart)) {
      // particles stream out of a part: with no part selected, make an invisible one to hold them
      const holder = createInstance('Part')
      holder.name = 'Particles'
      const p = insertHint.position
      holder.set('Anchored', true)
      holder.set('CanCollide', false)
      holder.set('Transparency', 1)
      holder.set('Size', new Vector3(2, 1, 2))
      holder.set('CFrame', CFrame.fromPosition(new Vector3(Math.round(p.x), Math.round(p.y) + 0.5, Math.round(p.z))))
      holder.setParent(editor.game.workspace)
      inst.setParent(holder)
      editor.selection = [inst]
      return inst
    }
    if (className === 'Frame' || className === 'TextLabel' || className === 'TextButton' || className === 'TextBox' || className === 'ImageLabel') {
      const p = parent ?? defaultParentFor(className)
      if (!(p.isA('LayerCollector') || p.isA('GuiObject'))) {
        // GUI objects need a ScreenGui
        const sg = createInstance('ScreenGui')
        sg.setParent(editor.game.getService('StarterGui'))
        inst.setParent(sg)
        editor.selection = [inst]
        return inst
      }
    }
    inst.setParent(parent ?? defaultParentFor(className))
    if (className === 'AnimationPlayer') {
      // ready to animate: one Animation inside, and the Animation editor opens on it
      const a = createInstance('Animation')
      a.name = 'Animation'
      a.setParent(inst)
      editor.bottomTab = 'animation'
      void import('./animation/animEditor').then(({ animEditor }) => animEditor.open(inst))
    }
    if (className === 'Shader' || className === 'ScreenShader') {
      // new shaders start as visual steps (no GLSL knowledge needed); "Convert to code" switches to GLSL
      const kind = className === 'ScreenShader' ? 'screen' : inst.parent && /2D$|^TileMap$/.test(inst.parent.className) ? '2d' : '3d'
      const recipe = defaultRecipe(kind)
      const compiled = compileRecipe(recipe, kind)
      inst.set('Recipe', JSON.stringify(recipe))
      inst.set('Source', compiled.source)
      if (className === 'Shader') inst.set('Transparent', compiled.transparent)
    }
    editor.selection = [inst]
    if (isCode(inst)) editor.openScript(inst)
    return inst
  })
}

/**
 * A BillboardGui with a label in it, ready to edit: on the selected part / model / 2D object, or on a
 * new invisible holder (a part in 3D, a node in 2D) when nothing like that is selected.
 */
function insertBillboard(bb: Instance, parent?: Instance): Instance {
  const in2d = !!editor.game.getService('World2D').get('Enabled')
  const target = parent ?? editor.selection[0]
  const fits = (i?: Instance | null) => !!i && (in2d ? i.isA('Node2D') : i instanceof BasePart || i.className === 'Model')
  if (parent && (parent.className === 'StarterGui' || parent.isA('LayerCollector'))) {
    // in a GUI container it shows on whatever its Adornee is set to
    bb.setParent(parent)
    editor.selection = [bb]
    return bb
  }
  let holder: Instance
  if (fits(target)) holder = target!
  else if (in2d) {
    holder = createInstance('Node2D')
    holder.name = 'Billboard'
    holder.set('Position', new Vector2(Math.round(view2d.x), Math.round(view2d.y)))
    holder.setParent(editor.game.getService('World2D'))
  } else {
    holder = createInstance('Part')
    holder.name = 'Billboard'
    const p = insertHint.position
    holder.set('Anchored', true)
    holder.set('CanCollide', false)
    holder.set('Transparency', 1)
    holder.set('Size', new Vector3(1, 1, 1))
    holder.set('CFrame', CFrame.fromPosition(new Vector3(Math.round(p.x), Math.round(p.y) + 3, Math.round(p.z))))
    holder.setParent(editor.game.workspace)
  }
  if (in2d) { bb.set('Size', new UDim2(0, 120, 0, 30)); bb.set('StudsOffset', new Vector3(0, -20, 0)) }
  else if (holder !== target || !(holder instanceof BasePart)) bb.set('StudsOffset', new Vector3(0, 0, 0))
  else bb.set('StudsOffset', new Vector3(0, (holder as BasePart).size.y / 2 + 1, 0)) // just above the part
  bb.setParent(holder)
  const label = createInstance('TextLabel')
  label.set('Size', new UDim2(1, 0, 1, 0))
  label.set('BackgroundTransparency', 1)
  label.set('Text', 'Hello!')
  label.set('TextScaled', true)
  label.set('TextColor3', Color3.fromRGB(255, 255, 255))
  label.set('TextStrokeTransparency', 0)
  label.set('Font', enumItem('Font', 'GothamBold'))
  label.setParent(bb)
  editor.selection = [bb]
  return bb
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
    // copies get the objects' real values, not an animation pose being previewed
    const copies = editor.withRestPose(() => sel.map((s) => s.clone())).map((c, i) => { c.setParent(sel[i].parent); return c })
    editor.selection = copies
  })
}

export function copySelection() {
  clipboard = editor.withRestPose(() => topLevelSelection().map((s) => serialize(s)))
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
