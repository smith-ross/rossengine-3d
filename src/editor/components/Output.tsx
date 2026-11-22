import { useEffect, useRef, useState } from 'react'
import { editor, useEditor } from '../store'

export function Output() {
  const ed = useEditor()
  const listRef = useRef<HTMLDivElement>(null)
  const [filter, setFilter] = useState<'all' | 'error' | 'warn'>('all')
  const logs = ed.logs.filter((l) => filter === 'all' || l.kind === filter)
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [ed.logs.length])

  /** "Workspace.Part.Script:12: message" -> open the script at line 12 */
  const openLocation = (msg: string) => {
    const m = /^([\w. ]+):(\d+):/.exec(msg) ?? /^\s*([\w. ]+):(\d+)/m.exec(msg)
    if (!m) return
    const path = m[1].split('.')
    let inst: any = editor.game
    for (const p of path) {
      inst = inst?.children.find((c: any) => c.name === p) ?? (inst === editor.game ? inst?.children.find((c: any) => c.className === p) : undefined)
      if (!inst) break
    }
    // scripts that only exist in the running game (e.g. PlayerScripts copies) map back by name
    if (!inst) inst = editor.game.getDescendants().find((d) => d.isA('LuaSourceContainer') && d.name === path[path.length - 1])
    if (inst?.isA?.('LuaSourceContainer')) editor.openScript(inst, Number(m[2]))
  }

  return (
    <div className="panel output">
      <div className="panel-title">
        Output
        <div className="panel-actions">
          <select value={filter} onChange={(e) => setFilter(e.target.value as any)}>
            <option value="all">All messages</option>
            <option value="error">Errors</option>
            <option value="warn">Warnings</option>
          </select>
          <button className="btn small" onClick={() => editor.clearLogs()}>Clear</button>
        </div>
      </div>
      <div className="log-list" ref={listRef}>
        {logs.map((l) => (
          <div key={l.id} className={`log log-${l.kind}`} onClick={() => l.kind === 'error' && openLocation(l.message)}>
            <span className="log-time">{l.time}</span>
            <span className="log-msg">{l.message}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
