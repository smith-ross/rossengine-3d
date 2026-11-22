import { useEffect, useState } from 'react'
import { editor, useEditor } from './store'
import { Toolbar } from './components/Toolbar'
import { Explorer } from './components/Explorer'
import { Properties } from './components/Properties'
import { Viewport } from './components/Viewport'
import { Output } from './components/Output'
import { ScriptEditor } from './components/ScriptEditor'
import { BuildDialog } from './components/BuildDialog'
import { ClassIcon } from './components/icons'
import {
  copySelection, cutSelection, deleteSelection, duplicateSelection, groupSelection, paste, ungroupSelection,
} from './ops'
import { openPlace, savePlace } from './fileio'

export function App() {
  const ed = useEditor()
  const [building, setBuilding] = useState(false)
  useShortcuts()
  useEffect(() => {
    const onSave = () => void savePlace()
    window.addEventListener('ross:save', onSave)
    return () => window.removeEventListener('ross:save', onSave)
  }, [])
  useEffect(() => {
    document.title = `${ed.dirty ? '● ' : ''}${ed.placeName} — RossEngine Studio`
  }, [ed.placeName, ed.dirty])

  return (
    <div className="app">
      <Toolbar onBuild={() => setBuilding(true)} />
      <div className="main">
        <div className="center">
          <div className="tabs">
            <div className={`tab${ed.activeTab ? '' : ' active'}`} onClick={() => { editor.activeTab = null; editor.emit() }}>
              🌐 {ed.placeName}{ed.playing ? ' (running)' : ''}
            </div>
            {ed.tabs.map((t) => (
              <div key={t.id} className={`tab${ed.activeTab === t ? ' active' : ''}`} onClick={() => { editor.activeTab = t; editor.emit() }}>
                <ClassIcon cls={t.className} /> {t.name}
                <span className="tab-close" onClick={(e) => { e.stopPropagation(); editor.closeTab(t) }}>✕</span>
              </div>
            ))}
          </div>
          <div className="center-body">
            <Viewport />
            {ed.activeTab && (
              <div className="script-layer"><ScriptEditor script={ed.activeTab} /></div>
            )}
          </div>
          <Output />
        </div>
        <div className="side">
          <Explorer />
          <Properties />
        </div>
      </div>
      {building && <BuildDialog onClose={() => setBuilding(false)} />}
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
      // global shortcuts (work everywhere)
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
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
