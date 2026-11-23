import { ReactNode, useEffect, useRef, useState } from 'react'
import {
  Anchor, Box, Braces, ChevronDown, Circle, CircleStop, Cylinder, FileCode2, FilePlus, FolderOpen, Group, Hammer, Link,
  MapPin, Menu, MousePointer2, Move, Play, Plus, Redo2, RotateCw, Save, Scaling, Shapes, Triangle, Undo2, Ungroup, Upload, Layers,
  Trash2, Users, Cog, Car, PersonStanding,
} from 'lucide-react'
import { editor, Tool, useEditor } from '../store'
import { characterControllerTarget, insertCar, insertCharacterController, insertConstraint, insertRagdollScript, insertObject, insertPart, insertScript, groupSelection, ungroupSelection, weldSelection } from '../ops'
import { LANGUAGES, ScriptLanguage } from '../../engine/scripting/languages'
import { ClassIcon } from './icons'
import { openPlace, savePlace } from '../fileio'
import { importFiles, insertAsset, pickFiles } from '../assetOps'
import { InsertMenu } from './Explorer'
import { BasePart } from '../../engine/classes'

function Group_({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rb-group">
      <div className="rb-items">{children}</div>
      <div className="rb-label">{label}</div>
    </div>
  )
}

function Btn({ icon, label, onClick, active, disabled, title, className }: {
  icon: ReactNode; label: string; onClick?: () => void; active?: boolean; disabled?: boolean; title?: string; className?: string
}) {
  return (
    <button className={`tool${active ? ' active' : ''}${className ? ' ' + className : ''}`} disabled={disabled} onClick={onClick} title={title ?? label}>
      <span className="tool-icon">{icon}</span><span className="tool-label">{label}</span>
    </button>
  )
}

/** A button with a dropdown that closes on outside click. */
function Drop({ icon, label, disabled, children, wide }: { icon: ReactNode; label: string; disabled?: boolean; children: (close: () => void) => ReactNode; wide?: boolean }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ left: 0, top: 0 })
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    window.addEventListener('mousedown', onDown)
    return () => window.removeEventListener('mousedown', onDown)
  }, [open])
  return (
    <div className="dropdown" ref={ref}>
      <button className={`tool${open ? ' active' : ''}`} disabled={disabled} title={label} onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect()
        setPos({ left: Math.min(r.left, window.innerWidth - 280), top: r.bottom + 2 })
        setOpen(!open)
      }}>
        <span className="tool-icon">{icon}</span><span className="tool-label">{label} <ChevronDown size={10} /></span>
      </button>
      {open && <div className={`dropdown-menu${wide ? ' wide' : ''}`} style={pos}>{children(() => setOpen(false))}</div>}
    </div>
  )
}

export function Toolbar({ onBuild }: { onBuild: () => void }) {
  const ed = useEditor()
  const playing = ed.playing
  const tool = (t: Tool, label: string, icon: ReactNode, key: string) => (
    <Btn icon={icon} label={label} active={ed.tool === t} disabled={playing} onClick={() => editor.setTool(t)} title={`${label} (${key})`} />
  )
  const selParts = ed.selection.filter((s): s is BasePart => s instanceof BasePart)
  const allAnchored = selParts.length > 0 && selParts.every((p) => p.get('Anchored'))
  return (
    <div className="toolbar">
      <div className="brand"><Box size={18} /> RossEngine</div>
      <Group_ label="Place">
        <Drop icon={<Menu size={18} />} label="File">
          {(close) => (
            <div onClick={close}>
              <div className="menu-item" onClick={() => confirmDiscard() && editor.newPlace('baseplate')}><span><FilePlus size={13} /> New Baseplate</span></div>
              <div className="menu-item" onClick={() => confirmDiscard() && editor.newPlace('2d')}><span><FilePlus size={13} /> New 2D Place</span></div>
              <div className="menu-item" onClick={() => confirmDiscard() && editor.newPlace('demo')}><span><FilePlus size={13} /> New Sample: Coin Collector (3D)</span></div>
              <div className="menu-item" onClick={() => confirmDiscard() && editor.newPlace('platformer')}><span><FilePlus size={13} /> New Sample: Platformer (2D)</span></div>
              <div className="menu-sep" />
              <div className="menu-item" onClick={() => confirmDiscard() && openPlace()}><span><FolderOpen size={13} /> Open…</span><span className="menu-shortcut">Ctrl+O</span></div>
              <div className="menu-item" onClick={() => savePlace()}><span><Save size={13} /> Save</span><span className="menu-shortcut">Ctrl+S</span></div>
              <div className="menu-item" onClick={() => savePlace(true)}><span><Save size={13} /> Save As…</span><span className="menu-shortcut">Ctrl+Shift+S</span></div>
              <div className="menu-sep" />
              <div className="menu-item" onClick={onBuild}><span><Hammer size={13} /> Build Game…</span></div>
              <div className="menu-item" title="Play mode remembers SaveService data between plays; start fresh" onClick={() => { if (window.confirm(`Delete the save data your Play tests of "${editor.placeName}" have made?`)) editor.clearSaveData() }}><span><Trash2 size={13} /> Clear Save Data</span></div>
            </div>
          )}
        </Drop>
        <Btn icon={<Undo2 size={18} />} label="Undo" disabled={!editor.canUndo()} onClick={() => editor.undo()} title="Undo (Ctrl+Z)" />
        <Btn icon={<Redo2 size={18} />} label="Redo" disabled={!editor.canRedo()} onClick={() => editor.redo()} title="Redo (Ctrl+Y)" />
      </Group_>
      <Group_ label="Tools">
        {tool('select', 'Select', <MousePointer2 size={18} />, 'Ctrl+1')}
        {tool('move', 'Move', <Move size={18} />, 'Ctrl+2')}
        {tool('scale', 'Scale', <Scaling size={18} />, 'Ctrl+3')}
        {tool('rotate', 'Rotate', <RotateCw size={18} />, 'Ctrl+4')}
        <div className="snap">
          <label title="Move/scale snap in studs (0 = off)">Move <input type="number" min={0} step={0.25} value={ed.snap} onChange={(e) => { editor.snap = Number(e.target.value); editor.emit() }} onKeyDown={(e) => e.stopPropagation()} /></label>
          <label title="Rotate snap in degrees (0 = off)">Rotate <input type="number" min={0} step={5} value={ed.rotateSnap} onChange={(e) => { editor.rotateSnap = Number(e.target.value); editor.emit() }} onKeyDown={(e) => e.stopPropagation()} /></label>
        </div>
      </Group_>
      <Group_ label="Insert">
        <Drop icon={<Box size={18} />} label="Part" disabled={playing}>
          {(close) => (
            <div onClick={close}>
              <div className="menu-item" onClick={() => insertPart('Block')}><span><Box size={13} /> Block</span></div>
              <div className="menu-item" onClick={() => insertPart('Ball')}><span><Circle size={13} /> Sphere</span></div>
              <div className="menu-item" onClick={() => insertPart('Cylinder')}><span><Cylinder size={13} /> Cylinder</span></div>
              <div className="menu-item" onClick={() => insertPart('Wedge')}><span><Triangle size={13} /> Wedge</span></div>
              <div className="menu-item" onClick={() => insertPart('Spawn')}><span><MapPin size={13} /> SpawnLocation</span></div>
            </div>
          )}
        </Drop>
        <Drop icon={<Layers size={18} />} label="2D" disabled={playing} wide>
          {(close) => (
            <div onClick={close}>
              <div className="menu-cat">2D objects</div>
              {[
                ['Sprite2D', 'Sprite'], ['AnimatedSprite2D', 'Animated Sprite'], ['TileMap', 'Tile Map'], ['CharacterBody2D', 'Character Body'],
                ['RigidBody2D', 'Rigid Body'], ['StaticBody2D', 'Static Body'], ['Area2D', 'Area (trigger)'], ['Camera2D', 'Camera'],
                ['Text2D', 'Text'], ['ParticleEmitter2D', 'Particles'], ['BillboardGui', 'Billboard label'], ['Node2D', 'Node (group)'], ['SpriteAnimation', 'Sprite Animation'],
              ].map(([cls, label]) => (
                <div key={cls} className="menu-item" onClick={() => insertObject(cls)}><span><ClassIcon cls={cls} /> {label}</span><span className="menu-shortcut">{cls}</span></div>
              ))}
              <div className="menu-sep" />
              <div className="menu-item" onClick={() => editor.mutate(() => { const w = editor.game.getService('World2D'); w.set('Enabled', !w.get('Enabled')) })}>
                <span><Layers size={13} /> {ed.game.getService('World2D').get('Enabled') ? 'Switch place to 3D' : 'Switch place to 2D'}</span>
              </div>
            </div>
          )}
        </Drop>
        <Btn icon={<Shapes size={18} />} label="Model" disabled={playing} title="Import a 3D model file (.glb, .gltf, .obj, .fbx, .stl) as a MeshPart"
          onClick={async () => { for (const a of await importFiles(await pickFiles('mesh'))) await insertAsset(a) }} />
        <Drop icon={<FileCode2 size={18} />} label="Script" disabled={playing}>
          {(close) => <LanguageMenu onPick={(l) => { insertScript('Script', l); close() }} onCharacter={(l) => { insertCharacterController(l); close() }} onLocal={(l) => { insertScript('LocalScript', l); close() }} />}
        </Drop>
        <Drop icon={<Braces size={18} />} label="Module" disabled={playing}>
          {(close) => <LanguageMenu module onPick={(l) => { insertScript('ModuleScript', l); close() }} />}
        </Drop>
        <Drop icon={<Plus size={18} />} label="Object" disabled={playing} wide>
          {(close) => <InsertMenu onDone={close} inline />}
        </Drop>
      </Group_>
      <Group_ label="Arrange">
        <Btn icon={<Group size={18} />} label="Group" disabled={playing || !ed.selection.length} onClick={groupSelection} title="Group into a Model (Ctrl+G)" />
        <Btn icon={<Ungroup size={18} />} label="Ungroup" disabled={playing || !ed.selection.some((s) => s.className === 'Model' || s.className === 'Folder')} onClick={ungroupSelection} title="Ungroup (Ctrl+U)" />
        <Btn icon={<Anchor size={18} />} label="Anchor" active={allAnchored} disabled={playing || !selParts.length}
          onClick={() => editor.mutate(() => { for (const p of selParts) p.set('Anchored', !allAnchored) })} title="Toggle Anchored on the selected parts" />
        <Btn icon={<Link size={18} />} label="Weld" disabled={playing || ed.selection.length < 2} onClick={weldSelection} title="Weld the selected parts together" />
        <Drop icon={<Cog size={18} />} label="Joint" disabled={playing} wide>
          {(close) => {
            const in2d = !!ed.game.getService('World2D').get('Enabled')
            const list: Array<[string, string, string]> = [
              ['HingeConstraint', 'Hinge', 'doors, wheels, levers: turns around the pivot\'s up axis'],
              ['BallSocketConstraint', 'Ball socket', 'pendulums, ragdolls: turns any way'],
              ['SliderConstraint', 'Slider', 'lifts, pistons, drawers: slides along the pivot\'s up axis'],
              ['SpringConstraint', 'Spring', 'suspension, bouncy things'],
              ['RopeConstraint', 'Rope', 'swings, chains, tow ropes'],
            ]
            const items = in2d ? list.filter(([c]) => c !== 'BallSocketConstraint').map(([c, l, d]): [string, string, string] => [c + '2D', l, d]) : list
            return (
              <div onClick={close}>
                <div className="menu-cat">{in2d ? 'Select the moving body, then (optionally) the one it hangs on' : 'Select the moving part, then (optionally) what it hangs on'}</div>
                {items.map(([cls, label, hint]) => (
                  <div key={cls} className="menu-item" title={hint} onClick={() => insertConstraint(cls)}>
                    <span><ClassIcon cls={cls} /> {label}</span><span className="menu-shortcut">{hint.split(':')[0]}</span>
                  </div>
                ))}
                {!in2d && <>
                  <div className="menu-sep" />
                  <div className="menu-cat">Built from joints (edit them like anything else)</div>
                  <div className="menu-item" title="Parts, hinges, sliders and springs, plus a Script and a LocalScript: walk into the seat to drive" onClick={insertCar}>
                    <span><Car size={13} /> Car</span><span className="menu-shortcut">drive with WASD</span>
                  </div>
                  <div className="menu-item" title="A Script in ScriptService: characters that die keep their limbs on ball sockets and hinges" onClick={insertRagdollScript}>
                    <span><PersonStanding size={13} /> Ragdoll script</span><span className="menu-shortcut">characters flop when they die</span>
                  </div>
                </>}
              </div>
            )
          }}
        </Drop>
      </Group_>
      <Group_ label="Assets">
        <Btn icon={<Upload size={18} />} label="Import" disabled={playing} onClick={async () => { await importFiles(await pickFiles()); editor.bottomTab = 'assets'; editor.emit() }} title="Import sounds, images and 3D models" />
      </Group_>
      <Group_ label="Test">
        {!playing ? (
          <Btn icon={<Play size={18} />} label="Play" className="play" disabled={ed.starting} onClick={() => editor.play()} title="Play (F5)" />
        ) : (
          <Btn icon={<CircleStop size={18} />} label="Stop" className="stop" onClick={() => editor.stop()} title="Stop (Shift+F5)" />
        )}
        <Drop icon={<Users size={18} />} label="Players" disabled={playing || ed.starting}>
          {(close) => (
            <div onClick={close}>
              <div className="menu-cat">Test multiplayer</div>
              {[2, 3, 4].map((n) => (
                <div key={n} className="menu-item" title="You host the game here; the other players get their own windows"
                  onClick={() => void editor.playMultiplayer(n)}><span><Users size={13} /> {n} players</span></div>
              ))}
              <div className="menu-sep" />
              <div className="menu-item" onClick={() => editor.mutate(() => { const n = editor.game.getService('NetworkService'); n.set('Enabled', !n.get('Enabled')) })}>
                <span>{ed.game.getService('NetworkService').get('Enabled') ? 'Make the game single-player' : 'Make the game multiplayer'}</span>
              </div>
            </div>
          )}
        </Drop>
        <Btn icon={<Hammer size={18} />} label="Build" disabled={playing} onClick={onBuild} title="Build a standalone desktop app" />
      </Group_>
    </div>
  )
}

function LanguageMenu({ onPick, module, onCharacter, onLocal }: { onPick: (l: ScriptLanguage) => void; module?: boolean; onCharacter?: (l: ScriptLanguage) => void; onLocal?: (l: ScriptLanguage) => void }) {
  // a CharacterBody3D (or something holding one) is selected: offer the ready-made controller too
  const target = onCharacter ? characterControllerTarget() : null
  const hint: Record<ScriptLanguage, string> = {
    Luau: 'Roblox-style Luau',
    TypeScript: 'typed, async/await',
    Python: 'Python 3 (Pyodide)',
  }
  return (
    <div>
      <div className="menu-cat">{module ? 'New ModuleScript' : 'New Script'}</div>
      {LANGUAGES.map((l) => (
        <div key={l} className="menu-item" onClick={() => onPick(l)}>
          <span><ClassIcon cls={module ? 'ModuleScript' : 'Script'} lang={l} /> {l}</span>
          <span className="menu-shortcut">{hint[l]}</span>
        </div>
      ))}
      {onLocal && !!editor.game.getService('NetworkService').get('Enabled') && (
        <>
          <div className="menu-sep" />
          <div className="menu-cat">New LocalScript (runs for each player)</div>
          {LANGUAGES.map((l) => (
            <div key={'l' + l} className="menu-item" title="Multiplayer: runs on each player's own machine (input, camera, GUI). Scripts run once, on the host." onClick={() => onLocal(l)}>
              <span><ClassIcon cls="LocalScript" lang={l} /> {l}</span>
              <span className="menu-shortcut">{hint[l]}</span>
            </div>
          ))}
        </>
      )}
      {target && (
        <>
          <div className="menu-sep" />
          <div className="menu-cat">Character controller for “{target.name}”</div>
          {LANGUAGES.map((l) => (
            <div key={'c' + l} className="menu-item" title="Walk, sprint and jump with a following camera: a normal script you can edit" onClick={() => onCharacter!(l)}>
              <span><ClassIcon cls="Script" lang={l} /> {l}</span>
              <span className="menu-shortcut">move · jump · camera</span>
            </div>
          ))}
        </>
      )}
    </div>
  )
}

function confirmDiscard() {
  return !editor.dirty || window.confirm('Discard unsaved changes to this place? (The current place stays in the browser autosave until you open or create another one.)')
}
