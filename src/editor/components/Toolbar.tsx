import { useState } from 'react'
import { editor, Tool, useEditor } from '../store'
import { insertObject, insertPart, groupSelection, weldSelection } from '../ops'
import { openPlace, savePlace } from '../fileio'
import { InsertMenu } from './Explorer'

export function Toolbar({ onBuild }: { onBuild: () => void }) {
  const ed = useEditor()
  const [menu, setMenu] = useState<'file' | 'part' | 'insert' | null>(null)
  const playing = ed.playing
  const close = () => setMenu(null)
  const tool = (t: Tool, label: string, icon: string, key: string) => (
    <button className={`tool${ed.tool === t ? ' active' : ''}`} disabled={playing} onClick={() => editor.setTool(t)} title={`${label} (${key})`}>
      <span className="tool-icon">{icon}</span><span>{label}</span>
    </button>
  )
  return (
    <div className="toolbar" onMouseLeave={close}>
      <div className="brand">◆ RossEngine</div>
      <div className="tb-group">
        <div className="dropdown">
          <button className="tool" onClick={() => setMenu(menu === 'file' ? null : 'file')}><span className="tool-icon">☰</span><span>File</span></button>
          {menu === 'file' && (
            <div className="dropdown-menu" onClick={close}>
              <div className="menu-item" onClick={() => confirmDiscard() && editor.newPlace('baseplate')}>New Baseplate</div>
              <div className="menu-item" onClick={() => confirmDiscard() && editor.newPlace('demo')}>New from Demo (Coin Collector)</div>
              <div className="menu-sep" />
              <div className="menu-item" onClick={() => confirmDiscard() && openPlace()}>Open… <span className="menu-shortcut">Ctrl+O</span></div>
              <div className="menu-item" onClick={() => savePlace()}>Save <span className="menu-shortcut">Ctrl+S</span></div>
              <div className="menu-item" onClick={() => savePlace(true)}>Save As… <span className="menu-shortcut">Ctrl+Shift+S</span></div>
              <div className="menu-sep" />
              <div className="menu-item" onClick={onBuild}>Build Game…</div>
            </div>
          )}
        </div>
        <button className="tool" disabled={!editor.canUndo()} onClick={() => editor.undo()} title="Undo (Ctrl+Z)"><span className="tool-icon">↶</span><span>Undo</span></button>
        <button className="tool" disabled={!editor.canRedo()} onClick={() => editor.redo()} title="Redo (Ctrl+Y)"><span className="tool-icon">↷</span><span>Redo</span></button>
      </div>
      <div className="tb-sep" />
      <div className="tb-group">
        {tool('select', 'Select', '⌖', 'Ctrl+1')}
        {tool('move', 'Move', '✥', 'Ctrl+2')}
        {tool('scale', 'Scale', '⤡', 'Ctrl+3')}
        {tool('rotate', 'Rotate', '⟳', 'Ctrl+4')}
        <div className="snap">
          <label title="Move/scale snap (studs)">Move <input type="number" min={0} step={0.25} value={ed.snap} onChange={(e) => { editor.snap = Number(e.target.value); editor.emit() }} /></label>
          <label title="Rotate snap (degrees)">Rotate <input type="number" min={0} step={5} value={ed.rotateSnap} onChange={(e) => { editor.rotateSnap = Number(e.target.value); editor.emit() }} /></label>
        </div>
      </div>
      <div className="tb-sep" />
      <div className="tb-group">
        <div className="dropdown">
          <button className="tool" disabled={playing} onClick={() => setMenu(menu === 'part' ? null : 'part')}><span className="tool-icon">■</span><span>Part ▾</span></button>
          {menu === 'part' && (
            <div className="dropdown-menu" onClick={close}>
              <div className="menu-item" onClick={() => insertPart('Block')}>■ Block</div>
              <div className="menu-item" onClick={() => insertPart('Ball')}>● Sphere</div>
              <div className="menu-item" onClick={() => insertPart('Cylinder')}>▮ Cylinder</div>
              <div className="menu-item" onClick={() => insertPart('Wedge')}>◣ Wedge</div>
              <div className="menu-item" onClick={() => insertPart('Spawn')}>⊕ SpawnLocation</div>
            </div>
          )}
        </div>
        <button className="tool" disabled={playing} onClick={() => insertObject('Script')} title="Insert Script"><span className="tool-icon">📜</span><span>Script</span></button>
        <button className="tool" disabled={playing} onClick={() => insertObject('LocalScript')} title="Insert LocalScript"><span className="tool-icon">📜</span><span>LocalScript</span></button>
        <div className="dropdown">
          <button className="tool" disabled={playing} onClick={() => setMenu(menu === 'insert' ? null : 'insert')}><span className="tool-icon">＋</span><span>Object ▾</span></button>
          {menu === 'insert' && <div className="dropdown-anchor"><InsertMenu onDone={close} /></div>}
        </div>
        <button className="tool" disabled={playing || !ed.selection.length} onClick={groupSelection} title="Group (Ctrl+G)"><span className="tool-icon">◈</span><span>Group</span></button>
        <button className="tool" disabled={playing || ed.selection.length < 2} onClick={weldSelection} title="Weld selected parts together"><span className="tool-icon">⛓</span><span>Weld</span></button>
      </div>
      <div className="tb-sep" />
      <div className="tb-group">
        {!playing ? (
          <button className="tool play" disabled={ed.starting} onClick={() => editor.play()} title="Play (F5)"><span className="tool-icon">▶</span><span>Play</span></button>
        ) : (
          <button className="tool stop" onClick={() => editor.stop()} title="Stop (Shift+F5)"><span className="tool-icon">■</span><span>Stop</span></button>
        )}
        <button className="tool" disabled={playing} onClick={onBuild} title="Build a standalone desktop app"><span className="tool-icon">📦</span><span>Build</span></button>
      </div>
      <div className="spacer" />
      <input
        className="place-name"
        value={ed.placeName}
        onChange={(e) => { editor.placeName = e.target.value; editor.dirty = true; editor.emit() }}
        title="Place name"
      />
      {ed.dirty && <span className="dirty" title="Unsaved changes (autosaved to this browser)">●</span>}
    </div>
  )
}

function confirmDiscard() {
  return !editor.dirty || window.confirm('Discard unsaved changes to this place? (They are still autosaved in this browser until you open another place.)')
}
