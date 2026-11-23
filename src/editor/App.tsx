import { useEffect, useRef, useState } from 'react'
import { Box, FileCode2, FolderOpen, Gamepad2, Globe, Languages, Package, Sparkles, Terminal, X } from 'lucide-react'
import { editor, useEditor } from './store'
import { Toolbar } from './components/Toolbar'
import { Explorer } from './components/Explorer'
import { Properties } from './components/Properties'
import { Viewport } from './components/Viewport'
import { Output } from './components/Output'
import { AssetsPanel, useAssets } from './components/AssetsPanel'
import { ScriptEditor } from './components/ScriptEditor'
import { BuildDialog } from './components/BuildDialog'
import { ClassIcon } from './components/icons'
import {
  copySelection, cutSelection, deleteSelection, duplicateSelection, groupSelection, paste, ungroupSelection,
} from './ops'
import { openPlace, savePlace } from './fileio'
import { BasePart } from '../engine/classes'
import { formatBytes } from './assetOps'
import { desktop } from './desktop'
import { EXTENSION, languageOf } from '../engine/scripting/languages'

// ---- resizable layout ----------------------------------------------------------
const LAYOUT_KEY = 'rossengine.layout'
interface Layout { side: number; split: number; bottom: number }
function loadLayout(): Layout {
  try { return { side: 320, split: 0.5, bottom: 210, ...JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}') } } catch { return { side: 320, split: 0.5, bottom: 210 } }
}

function Splitter({ dir, onDrag }: { dir: 'x' | 'y'; onDrag: (delta: number) => void }) {
  return (
    <div
      className={`splitter ${dir}`}
      onMouseDown={(e) => {
        e.preventDefault()
        let last = dir === 'x' ? e.clientX : e.clientY
        const move = (ev: MouseEvent) => {
          const p = dir === 'x' ? ev.clientX : ev.clientY
          onDrag(p - last)
          last = p
        }
        const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); document.body.classList.remove('resizing') }
        document.body.classList.add('resizing')
        window.addEventListener('mousemove', move)
        window.addEventListener('mouseup', up)
      }}
    />
  )
}

export function App() {
  const ed = useEditor()
  const [building, setBuilding] = useState(false)
  const [layout, setLayout] = useState(loadLayout)
  const sideRef = useRef<HTMLDivElement>(null)
  useShortcuts()
  useEffect(() => {
    const onSave = () => void savePlace()
    window.addEventListener('ross:save', onSave)
    return () => window.removeEventListener('ross:save', onSave)
  }, [])
  useEffect(() => {
    document.title = `${ed.dirty ? '● ' : ''}${ed.placeName} — RossEngine Studio`
    desktop?.setDirty(ed.dirty)
  }, [ed.placeName, ed.dirty])
  // native menu (RossEngine Studio desktop app)
  useEffect(() => desktop?.onMenu(async (id) => {
    const discardOk = () => !editor.dirty || window.confirm('Discard unsaved changes to this place?')
    switch (id) {
      case 'new-baseplate': if (discardOk()) editor.newPlace('baseplate'); break
      case 'new-demo': if (discardOk()) editor.newPlace('demo'); break
      case 'new-languages': if (discardOk()) editor.newPlace('languages'); break
      case 'new-platformer': if (discardOk()) editor.newPlace('platformer'); break
      case 'new-2d': if (discardOk()) editor.newPlace('2d'); break
      case 'open': if (discardOk()) void openPlace(); break
      case 'save': void savePlace(); break
      case 'save-as': void savePlace(true); break
      case 'build': setBuilding(true); break
      case 'undo': editor.undo(); break
      case 'redo': editor.redo(); break
      case 'play': void editor.play(); break
      case 'stop': editor.stop(); break
      case 'save-and-close':
        if (editor.playing) editor.stop()
        if (await savePlace()) desktop?.closeNow()
        break
    }
  }), [])
  useEffect(() => { try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout)) } catch { /* ignore */ } }, [layout])

  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))

  return (
    <div className="app">
      <Toolbar onBuild={() => setBuilding(true)} />
      <div className="main">
        <div className="center">
          <div className="tabs">
            <PlaceTab />
            {ed.tabs.map((t) => (
              <div key={t.id} className={`tab${ed.activeTab === t ? ' active' : ''}`} onClick={() => { editor.activeTab = t; editor.emit() }}
                onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); editor.closeTab(t) } }}>
                <ClassIcon cls={t.className} size={13} lang={languageOf(t)} /> {t.name}<span className="tab-ext">.{t.className === 'Shader' || t.className === 'ScreenShader' ? 'glsl' : EXTENSION[languageOf(t)]}</span>
                <span className="tab-close" onClick={(e) => { e.stopPropagation(); editor.closeTab(t) }}><X size={12} /></span>
              </div>
            ))}
          </div>
          <div className="center-body">
            <Viewport />
            {ed.activeTab && <div className="script-layer"><ScriptEditor script={ed.activeTab} /></div>}
            {ed.showStart && !ed.playing && <StartScreen />}
          </div>
          <Splitter dir="y" onDrag={(d) => setLayout((l) => ({ ...l, bottom: clamp(l.bottom - d, 60, window.innerHeight * 0.7) }))} />
          <div className="bottom" style={{ height: layout.bottom }}>
            <BottomTabs />
            {ed.bottomTab === 'output' ? <Output /> : <AssetsPanel />}
          </div>
        </div>
        <Splitter dir="x" onDrag={(d) => setLayout((l) => ({ ...l, side: clamp(l.side - d, 220, window.innerWidth * 0.5) }))} />
        <div className="side" ref={sideRef} style={{ width: layout.side }}>
          <div style={{ flex: `${layout.split} 1 0`, minHeight: 80, display: 'flex' }}><Explorer /></div>
          <Splitter dir="y" onDrag={(d) => setLayout((l) => {
            const h = sideRef.current?.clientHeight ?? 600
            return { ...l, split: clamp(l.split + d / h, 0.15, 0.85) }
          })} />
          <div style={{ flex: `${1 - layout.split} 1 0`, minHeight: 80, display: 'flex' }}><Properties /></div>
        </div>
      </div>
      <StatusBar />
      {building && <BuildDialog onClose={() => setBuilding(false)} />}
    </div>
  )
}

/** The place tab; double-click to rename the place. */
function PlaceTab() {
  const ed = useEditor()
  const [editing, setEditing] = useState(false)
  return (
    <div className={`tab${ed.activeTab ? '' : ' active'}`} onClick={() => { editor.activeTab = null; editor.emit() }}
      onDoubleClick={() => !ed.playing && setEditing(true)} title="Double-click to rename the place">
      <Globe size={13} />
      {editing ? (
        <input className="tab-rename" autoFocus defaultValue={ed.placeName}
          onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setEditing(false) }}
          onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== editor.placeName) { editor.placeName = v; editor.dirty = true; editor.emit() } setEditing(false) }} />
      ) : ed.placeName}
      {ed.playing ? <span className="live-badge">RUNNING</span> : null}
    </div>
  )
}

function BottomTabs() {
  const ed = useEditor()
  useAssets()
  const errors = ed.logs.filter((l) => l.kind === 'error').length
  const tab = (id: 'output' | 'assets', label: string, icon: React.ReactNode, badge?: React.ReactNode) => (
    <div className={`btab${ed.bottomTab === id ? ' active' : ''}`} onClick={() => { editor.bottomTab = id; editor.emit() }}>{icon} {label}{badge}</div>
  )
  return (
    <div className="btabs">
      {tab('output', 'Output', <Terminal size={13} />, errors ? <span className="badge err">{errors}</span> : null)}
      {tab('assets', 'Assets', <Package size={13} />)}
    </div>
  )
}

function StatusBar() {
  const ed = useEditor()
  const assets = useAssets()
  const parts = ed.viewGame.workspace.getDescendants().filter((d) => d instanceof BasePart).length
  const scripts = ed.viewGame.getDescendants().filter((d) => d.isA('LuaSourceContainer')).length
  const sel = ed.selection
  return (
    <div className="statusbar">
      <span className={`dot ${ed.playing ? 'run' : 'edit'}`} /> {ed.playing ? 'Running' : 'Editing'}
      <span className="sep" />
      <span className={ed.dirty ? 'warn-text' : ''}>{ed.dirty ? 'Unsaved changes (autosaved in browser)' : 'Saved'}</span>
      <span className="sep" />
      {sel.length === 0 ? 'Nothing selected' : sel.length === 1 ? `${sel[0].className} “${sel[0].name}”` : `${sel.length} objects selected`}
      <div className="spacer" />
      <span>{parts} parts</span>
      <span className="sep" />
      <span>{scripts} scripts</span>
      <span className="sep" />
      <span>{assets.list().length} assets ({formatBytes(assets.totalBytes())})</span>
      <span className="sep" />
      <span>Snap {ed.snap || 'off'} · {ed.rotateSnap ? `${ed.rotateSnap}°` : 'off'}</span>
    </div>
  )
}

function StartScreen() {
  const ed = useEditor()
  const card = (icon: React.ReactNode, title: string, desc: string, onClick: () => void) => (
    <button className="start-card" onClick={onClick}>
      <span className="start-ic">{icon}</span>
      <span className="start-title">{title}</span>
      <span className="start-desc">{desc}</span>
    </button>
  )
  const hasContent = ed.game.workspace.children.length > 3 || ed.game.getService('ScriptService').children.length > 0
  return (
    <div className="start">
      <div className="start-inner">
        <div className="start-head"><Box size={28} /> <div><h1>RossEngine Studio</h1><p>Build 3D games in your browser and script them in Luau.</p></div></div>
        <div className="start-grid">
          {hasContent && card(<Sparkles size={22} />, `Continue “${ed.placeName}”`, 'Pick up where you left off (autosaved in this browser).', () => { editor.showStart = false; editor.emit() })}
          {card(<Globe size={22} />, 'Baseplate', 'An empty world with a spawn point.', () => editor.newPlace('baseplate'))}
          {card(<FileCode2 size={22} />, 'Coin Collector', 'A small sample game with scripts, GUI, tweens and physics.', () => editor.newPlace('demo'))}
          {card(<Gamepad2 size={22} />, '2D Platformer', 'Tilemap level, animated sprites, coins and a camera that follows you.', () => editor.newPlace('platformer'))}
          {card(<Languages size={22} />, 'Languages Demo', 'Luau, TypeScript and Python scripts that import each other.', () => editor.newPlace('languages'))}
          {card(<FolderOpen size={22} />, 'Open place…', 'Open a .rbe place file from disk.', () => void openPlace())}
        </div>
        <div className="start-tips">
          <div><b>F5</b> Play · <b>Shift+F5</b> Stop · <b>Ctrl+S</b> Save · <b>F</b> focus selection · drag files onto the viewport to import</div>
        </div>
      </div>
    </div>
  )
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      const inText = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable || !!t.closest?.('.monaco-editor'))
      const ctrl = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()
      if (e.key === 'F5') { e.preventDefault(); if (e.shiftKey) editor.stop(); else void editor.play(); return }
      if (ctrl && k === 's') { e.preventDefault(); void savePlace(e.shiftKey); return }
      if (ctrl && k === 'o') { e.preventDefault(); void openPlace(); return }
      if (inText || editor.playing) return
      if (ctrl && k === 'z') { e.preventDefault(); editor.undo() }
      else if (ctrl && (k === 'y' || (e.shiftKey && k === 'z'))) { e.preventDefault(); editor.redo() }
      else if (ctrl && k === 'd') { e.preventDefault(); duplicateSelection() }
      else if (ctrl && k === 'c') { copySelection() }
      else if (ctrl && k === 'x') { cutSelection() }
      else if (ctrl && k === 'v') { e.preventDefault(); paste(e.shiftKey ? editor.selection[0] : undefined) }
      else if (ctrl && k === 'g') { e.preventDefault(); groupSelection() }
      else if (ctrl && k === 'u') { e.preventDefault(); ungroupSelection() }
      else if (ctrl && ['1', '2', '3', '4'].includes(k)) { e.preventDefault(); editor.setTool((['select', 'move', 'scale', 'rotate'] as const)[Number(k) - 1]) }
      else if (e.key === 'Delete') { e.preventDefault(); deleteSelection() }
      else if (e.key === 'Escape') { editor.select([]) }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
