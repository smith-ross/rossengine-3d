import { isCode } from '../ops'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Instance, allClasses } from '../../engine/instance'
import { SERVICE_ORDER } from '../../engine/classes'
import { editor, useEditor } from '../store'
import {
  copySelection, cutSelection, deleteSelection, duplicateSelection, groupSelection, insertObject, paste, reparent, ungroupSelection,
} from '../ops'
import { ClassIcon } from './icons'
import { languageOf } from '../../engine/scripting/languages'
import { ChevronDown, ChevronRight, Plus, Search } from 'lucide-react'

const expanded = new Set<number>()

function sortedChildren(inst: Instance): Instance[] {
  if (inst.className === 'DataModel') {
    const order = (c: Instance) => {
      const i = SERVICE_ORDER.indexOf(c.className)
      return i < 0 ? 99 : i
    }
    return inst.children.filter((c) => !(c as any).transient).sort((a, b) => order(a) - order(b))
  }
  return inst.children.filter((c) => c.name !== '__Mouse')
}

interface MenuState { x: number; y: number; target: Instance; insertOnly?: boolean }

export function Explorer() {
  const ed = useEditor()
  const game = ed.viewGame
  const [filter, setFilter] = useState('')
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [renaming, setRenaming] = useState<Instance | null>(null)
  const [dragOver, setDragOver] = useState<Instance | null>(null)
  const dragging = useRef<Instance[]>([])
  const lastClicked = useRef<Instance | null>(null)
  const treeRef = useRef<HTMLDivElement>(null)

  // expand ancestors of the selection so it is visible
  useEffect(() => {
    for (const s of ed.selection) for (let p = s.parent; p; p = p.parent) expanded.add(p.id)
  }, [ed.selection])

  const rows = useMemo(() => {
    const out: Array<{ inst: Instance; depth: number }> = []
    const f = filter.trim().toLowerCase()
    const walk = (inst: Instance, depth: number) => {
      for (const c of sortedChildren(inst)) {
        if (f) {
          if (c.name.toLowerCase().includes(f) || c.className.toLowerCase().includes(f)) out.push({ inst: c, depth: 0 })
          walk(c, depth + 1)
        } else {
          out.push({ inst: c, depth })
          if (expanded.has(c.id)) walk(c, depth + 1)
        }
      }
    }
    walk(game, 0)
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [game, ed.structureVersion, ed.version, filter])

  const onRowClick = (e: React.MouseEvent, inst: Instance) => {
    if (e.ctrlKey || e.metaKey) {
      editor.select(ed.selection.includes(inst) ? ed.selection.filter((s) => s !== inst) : [...ed.selection, inst])
    } else if (e.shiftKey && lastClicked.current) {
      const a = rows.findIndex((r) => r.inst === lastClicked.current), b = rows.findIndex((r) => r.inst === inst)
      const [lo, hi] = a < b ? [a, b] : [b, a]
      editor.select(rows.slice(lo, hi + 1).map((r) => r.inst))
    } else {
      editor.select([inst])
    }
    lastClicked.current = inst
  }

  // keep the selected row visible
  useEffect(() => {
    const s = ed.selection[ed.selection.length - 1]
    if (!s) return
    requestAnimationFrame(() => treeRef.current?.querySelector(`[data-id="${s.id}"]`)?.scrollIntoView({ block: 'nearest' }))
  }, [ed.selection])

  const onTreeKey = (e: React.KeyboardEvent) => {
    const cur = ed.selection[ed.selection.length - 1]
    const i = cur ? rows.findIndex((r) => r.inst === cur) : -1
    const go = (j: number) => { const r = rows[Math.max(0, Math.min(rows.length - 1, j))]; if (r) { editor.select([r.inst]); lastClicked.current = r.inst } }
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); go(i + 1); break
      case 'ArrowUp': e.preventDefault(); go(i - 1); break
      case 'ArrowRight': e.preventDefault(); if (cur && sortedChildren(cur).length) { if (!expanded.has(cur.id)) toggle(cur); else go(i + 1) } break
      case 'ArrowLeft':
        e.preventDefault()
        if (cur && expanded.has(cur.id)) toggle(cur)
        else if (cur?.parent && cur.parent !== game) editor.select([cur.parent])
        break
      case 'F2': e.preventDefault(); if (cur && !ed.playing && !cur.parentLocked) setRenaming(cur); break
      case 'Enter': if (cur && isCode(cur)) editor.openScript(cur); break
    }
  }

  const toggle = (inst: Instance) => {
    if (expanded.has(inst.id)) expanded.delete(inst.id)
    else expanded.add(inst.id)
    editor.emit()
  }

  return (
    <div className="panel explorer" onClick={() => setMenu(null)}>
      <div className="panel-title">Explorer{ed.playing && <span className="live-badge">LIVE</span>}</div>
      <div className="search filter"><Search size={12} /><input placeholder="Filter (name or class)" value={filter} onChange={(e) => setFilter(e.target.value)} onKeyDown={(e) => e.stopPropagation()} /></div>
      <div className="tree" ref={treeRef} tabIndex={0} onKeyDown={onTreeKey} onContextMenu={(e) => e.preventDefault()}>
        {rows.map(({ inst, depth }) => {
          const hasChildren = sortedChildren(inst).length > 0
          const selected = ed.selection.includes(inst)
          return (
            <div
              key={inst.id}
              data-id={inst.id}
              className={`tree-row${selected ? ' selected' : ''}${dragOver === inst ? ' drag-over' : ''}`}
              style={{ paddingLeft: 6 + depth * 14 }}
              onClick={(e) => onRowClick(e, inst)}
              onDoubleClick={() => {
                if (isCode(inst)) editor.openScript(inst)
                else if (!ed.playing) setRenaming(inst)
              }}
              onContextMenu={(e) => {
                e.preventDefault()
                e.stopPropagation()
                if (!ed.selection.includes(inst)) editor.select([inst])
                setMenu({ x: e.clientX, y: e.clientY, target: inst })
              }}
              draggable={!ed.playing && !inst.parentLocked}
              onDragStart={(e) => {
                dragging.current = ed.selection.includes(inst) ? ed.selection : [inst]
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', inst.name)
              }}
              onDragOver={(e) => { if (dragging.current.length) { e.preventDefault(); setDragOver(inst) } }}
              onDragLeave={() => setDragOver(null)}
              onDrop={(e) => {
                e.preventDefault()
                setDragOver(null)
                reparent(dragging.current, inst)
                expanded.add(inst.id)
                dragging.current = []
              }}
            >
              <span className="tree-arrow" onClick={(e) => { e.stopPropagation(); if (hasChildren) toggle(inst) }}>
                {hasChildren ? (expanded.has(inst.id) || filter ? <ChevronDown size={12} /> : <ChevronRight size={12} />) : null}
              </span>
              <ClassIcon cls={inst.className} lang={inst.isA('LuaSourceContainer') ? languageOf(inst) : undefined} />
              {renaming === inst ? (
                <input
                  className="tree-rename"
                  autoFocus
                  defaultValue={inst.name}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                    if (e.key === 'Escape') setRenaming(null)
                    e.stopPropagation()
                  }}
                  onBlur={(e) => {
                    const v = e.target.value.trim()
                    if (v && v !== inst.name) editor.mutate(() => inst.set('Name', v))
                    setRenaming(null)
                  }}
                />
              ) : (
                <span className="tree-name">{inst.name}</span>
              )}
              {!ed.playing && (
                <button
                  className="row-add"
                  title={`Insert object into ${inst.name}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                    editor.select([inst])
                    setMenu({ x: r.left, y: r.bottom, target: inst, insertOnly: true })
                  }}
                ><Plus size={12} /></button>
              )}
            </div>
          )
        })}
      </div>
      {menu && !menu.insertOnly && <ContextMenu menu={menu} onClose={() => setMenu(null)} onRename={(i) => setRenaming(i)} />}
      {menu?.insertOnly && (
        <div className="context-menu" style={{ left: Math.min(menu.x - 200, window.innerWidth - 260), top: Math.min(menu.y, window.innerHeight - 420), width: 250 }} onClick={(e) => e.stopPropagation()}>
          <InsertMenu parent={menu.target} onDone={() => setMenu(null)} inline />
        </div>
      )}
    </div>
  )
}

function ContextMenu({ menu, onClose, onRename }: { menu: MenuState; onClose: () => void; onRename: (i: Instance) => void }) {
  const ed = useEditor()
  const [sub, setSub] = useState(false)
  const playing = ed.playing
  const target = menu.target
  const item = (label: string, fn: () => void, disabled = false, shortcut = '') => (
    <div className={`menu-item${disabled ? ' disabled' : ''}`} onClick={(e) => { e.stopPropagation(); if (!disabled) { fn(); onClose() } }}>
      <span>{label}</span><span className="menu-shortcut">{shortcut}</span>
    </div>
  )
  const style: React.CSSProperties = { left: Math.min(menu.x, window.innerWidth - 220), top: Math.min(menu.y, window.innerHeight - 380) }
  return (
    <div className="context-menu" style={style} onClick={(e) => e.stopPropagation()} onMouseLeave={() => setSub(false)}>
      {isCode(target) && item(target.isA('LuaSourceContainer') ? 'Open Script' : 'Open Shader', () => editor.openScript(target))}
      <div className={`menu-item${playing ? ' disabled' : ''}`} onMouseEnter={() => setSub(true)}>
        <span>Insert Object</span><span className="menu-shortcut">▸</span>
        {sub && !playing && <InsertMenu parent={target} onDone={onClose} />}
      </div>
      <div className="menu-sep" />
      {item('Cut', cutSelection, playing, 'Ctrl+X')}
      {item('Copy', copySelection, false, 'Ctrl+C')}
      {item('Paste Into', () => paste(target), playing, 'Ctrl+Shift+V')}
      {item('Duplicate', duplicateSelection, playing, 'Ctrl+D')}
      {item('Delete', deleteSelection, playing || target.parentLocked, 'Del')}
      {item('Rename', () => onRename(target), playing || target.parentLocked, 'F2')}
      <div className="menu-sep" />
      {item('Group', groupSelection, playing, 'Ctrl+G')}
      {item('Ungroup', ungroupSelection, playing || !(target.className === 'Model' || target.className === 'Folder'), 'Ctrl+U')}
    </div>
  )
}

export function InsertMenu({ parent, onDone, inline }: { parent?: Instance; onDone: () => void; inline?: boolean }) {
  const [q, setQ] = useState('')
  const groups = useMemo(() => {
    const m = new Map<string, string[]>()
    for (const c of allClasses()) {
      if (!c.creatable || c.service || !c.category) continue
      if (q && !c.name.toLowerCase().includes(q.toLowerCase())) continue
      const list = m.get(c.category) ?? []
      list.push(c.name)
      m.set(c.category, list)
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [q])
  return (
    <div className={inline ? 'insert-inline' : 'context-menu submenu'} onClick={(e) => e.stopPropagation()}>
      <input
        className="panel-filter"
        autoFocus
        placeholder="Search objects… (Enter inserts)"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter' && groups.length) { insertObject(groups[0][1].sort()[0], parent); onDone() }
          if (e.key === 'Escape') onDone()
        }}
      />
      <div className="submenu-scroll">
        {groups.map(([cat, names]) => (
          <div key={cat}>
            <div className="menu-cat">{cat}</div>
            {names.sort().map((n) => (
              <div key={n} className="menu-item" onClick={() => { insertObject(n, parent); onDone() }}>
                <span><ClassIcon cls={n} /> {n}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
