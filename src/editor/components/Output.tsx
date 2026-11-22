import { useEffect, useRef, useState } from 'react'
import { AlertTriangle, CircleAlert, Info, Trash2 } from 'lucide-react'
import { editor, useEditor } from '../store'

export function Output() {
  const ed = useEditor()
  const listRef = useRef<HTMLDivElement>(null)
  const [filter, setFilter] = useState<'all' | 'error' | 'warn'>('all')
  const logs = ed.logs.filter((l) => filter === 'all' || l.kind === filter)
  const stick = useRef(true)
  useEffect(() => {
    const el = listRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [ed.logs.length])

  /** "ScriptService.Main:12: message" -> open the script at line 12 */
  const openLocation = (msg: string) => {
    const m = /^([\w. ]+):(\d+):/.exec(msg) ?? /^\s*([\w. ]+):(\d+)/m.exec(msg)
    if (!m) return
    const path = m[1].split('.')
    let inst: any = editor.game
    for (const p of path) {
      inst = inst?.children.find((c: any) => c.name === p)
      if (!inst) break
    }
    // scripts copied at runtime (e.g. into PlayerGui) map back by name
    if (!inst) inst = editor.game.getDescendants().find((d) => d.isA('LuaSourceContainer') && d.name === path[path.length - 1])
    if (inst?.isA?.('LuaSourceContainer')) editor.openScript(inst, Number(m[2]))
  }

  const errors = ed.logs.filter((l) => l.kind === 'error').length
  const warns = ed.logs.filter((l) => l.kind === 'warn').length
  return (
    <div className="output">
      <div className="output-bar">
        <div className="seg">
          <button className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>All</button>
          <button className={filter === 'error' ? 'on' : ''} onClick={() => setFilter('error')}><CircleAlert size={12} /> {errors}</button>
          <button className={filter === 'warn' ? 'on' : ''} onClick={() => setFilter('warn')}><AlertTriangle size={12} /> {warns}</button>
        </div>
        <div className="spacer" />
        <button className="btn small icon" onClick={() => editor.clearLogs()} title="Clear output"><Trash2 size={12} /> Clear</button>
      </div>
      <div
        className="log-list"
        ref={listRef}
        onScroll={(e) => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24 }}
      >
        {logs.length === 0 && <div className="muted small pad">Script output appears here. Press Play (F5) to run your game.</div>}
        {logs.map((l) => (
          <div key={l.id} className={`log log-${l.kind}`} onClick={() => l.kind === 'error' && openLocation(l.message)} title={l.kind === 'error' ? 'Click to open the script' : undefined}>
            <span className="log-time">{l.time}</span>
            {l.kind === 'error' ? <CircleAlert size={12} className="log-ic" /> : l.kind === 'warn' ? <AlertTriangle size={12} className="log-ic" /> : l.kind === 'system' ? <Info size={12} className="log-ic" /> : <span className="log-ic" />}
            <span className="log-msg">{l.message}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
