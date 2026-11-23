// Animation editor: a timeline of keyframes for an AnimationPlayer's animations.
import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Circle, Clapperboard, Diamond, Pause, Play, Plus, Repeat, SkipBack, Trash2, X } from 'lucide-react'
import { Instance, createInstance } from '../../engine/instance'
import { EASING_DIRECTIONS, EASING_STYLES, Location, Track, resolvePath, sameLocation, trackLabel } from '../../engine/animation'
import { editor, useEditor } from '../store'
import { animEditor } from './animEditor'
import { ClassIcon } from '../components/icons'

const ROW = 24

function useAnimEditor() {
  const [, force] = useReducer((x: number) => x + 1, 0)
  useEffect(() => { const off = animEditor.subscribe(force); return () => { off() } }, [])
  return animEditor
}

const fmt = (t: number) => t.toFixed(2)

export function AnimationPanel() {
  const ed = useEditor()
  const ae = useAnimEditor()
  const players = ed.game.getDescendants().filter((d) => d.className === 'AnimationPlayer')
  const player = ae.player
  const anim = ae.anim
  const root = ae.root

  // open the selected object's AnimationPlayer (or the only one in the place)
  useEffect(() => {
    if (player || ed.playing) return
    const sel = ed.selection[0]
    const fromSel = sel ? (sel.className === 'AnimationPlayer' ? sel : sel.className === 'Animation' ? sel.parent : sel.children.find((c) => c.className === 'AnimationPlayer')) : null
    const pick = fromSel ?? (players.length === 1 ? players[0] : null)
    if (pick) ae.open(pick, ed.selection[0]?.className === 'Animation' ? ed.selection[0].name : null)
  }, [player, ed.selection, players.length, ed.playing]) // eslint-disable-line react-hooks/exhaustive-deps

  if (ed.playing) return <div className="anim-empty">The game is running. Stop it to edit animations.</div>

  if (!player || !anim || !root) {
    const sel = ed.selection[0]
    const canCreate = sel && !['AnimationPlayer', 'Animation'].includes(sel.className) && !sel.classInfo.service && sel.className !== 'DataModel'
    return (
      <div className="anim-empty">
        <Clapperboard size={22} />
        <div>
          <b>Animate anything</b>
          <p>Select a part, model or 2D object, then create an AnimationPlayer for it. You can animate its position, rotation, size, colour, transparency or any other property, including everything inside a model.</p>
          <div className="row-inline">
            <button className="btn primary small" disabled={!canCreate} onClick={() => createPlayer(sel!)}>
              <Plus size={13} /> {canCreate ? `Animate "${sel!.name}"` : 'Select something to animate'}
            </button>
            {players.length > 0 && (
              <select className="anim-select" value="" onChange={(e) => { const p = players.find((x) => String(x.id) === e.target.value); if (p) ae.open(p) }}>
                <option value="">Open an existing AnimationPlayer…</option>
                {players.map((p) => <option key={p.id} value={p.id}>{p.parent?.name}</option>)}
              </select>
            )}
          </div>
        </div>
      </div>
    )
  }
  return <Timeline player={player} anim={anim} root={root} players={players} />
}

/** Insert an AnimationPlayer with one Animation into an object, and open it. */
export function createPlayer(target: Instance) {
  editor.mutate(() => {
    const p = createInstance('AnimationPlayer')
    p.setParent(target)
    const a = createInstance('Animation')
    a.name = 'Animation'
    a.setParent(p)
    editor.selection = [target]
  })
  const p = target.children.find((c) => c.className === 'AnimationPlayer')
  editor.bottomTab = 'animation'
  if (p) animEditor.open(p)
  editor.emit()
}

function Timeline({ player, anim, root, players }: { player: Instance; anim: Instance; root: Instance; players: Instance[] }) {
  const ae = animEditor
  const tracks = ae.tracks()
  const length = ae.length()
  const areaRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(600)
  const [menu, setMenu] = useState<{ x: number; y: number; track: number; t: number } | null>(null)
  const [renaming, setRenaming] = useState(false)
  const pad = 14
  useEffect(() => {
    const el = areaRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])
  const scale = Math.max(10, (width - pad * 2) / length) // pixels per second
  const xOf = (t: number) => pad + t * scale
  const tOf = (x: number) => Math.max(0, Math.min(length, (x - pad) / scale))
  const snapT = (t: number) => (ae.snap ? Math.round(t / ae.snap) * ae.snap : t)
  const anims = player.children.filter((c) => c.className === 'Animation')

  // keyboard: Delete removes selected keys, Space plays
  const onKey = (e: React.KeyboardEvent) => {
    if ((e.key === 'Delete' || e.key === 'Backspace') && ae.selected.size) {
      e.preventDefault()
      const sel = new Set(ae.selected)
      ae.selected.clear()
      ae.editTracks((ts) => ts.forEach((t, i) => { t.keys = t.keys.filter((k) => !sel.has(`${i}:${k.t}`)) }))
    }
    if (e.key === ' ') { e.preventDefault(); ae.togglePreview() }
  }

  // scrub on the ruler
  const scrub = (e: React.PointerEvent) => {
    const rect = areaRef.current!.getBoundingClientRect()
    ae.stopPreview()
    const move = (x: number) => ae.seek(snapT(tOf(x - rect.left + areaRef.current!.scrollLeft)))
    move(e.clientX)
    const onMove = (ev: PointerEvent) => move(ev.clientX)
    const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp) }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // drag selected keys in time
  const dragKeys = (e: React.PointerEvent, track: number, t: number) => {
    e.stopPropagation()
    const id = `${track}:${t}`
    if (e.shiftKey) { if (ae.selected.has(id)) ae.selected.delete(id); else ae.selected.add(id) }
    else if (!ae.selected.has(id)) { ae.selected.clear(); ae.selected.add(id) }
    ae.seek(t)
    const startX = e.clientX
    let moved = false, lastDelta = 0
    const onMove = (ev: PointerEvent) => {
      const delta = snapT((ev.clientX - startX) / scale)
      if (!moved && Math.abs(ev.clientX - startX) < 3) return
      if (!moved) { moved = true; editor.checkpoint() }
      if (delta === lastDelta) return
      const step = delta - lastDelta
      lastDelta = delta
      const next = new Set<string>()
      ae.editTracks((ts) => ts.forEach((tr, i) => {
        for (const k of tr.keys) {
          const kid = `${i}:${k.t}`
          if (!currentSel.has(kid)) continue
          k.t = Math.max(0, Math.min(length, +(k.t + step).toFixed(4)))
          next.add(`${i}:${k.t}`)
        }
        tr.keys.sort((a, b) => a.t - b.t)
      }), false)
      currentSel = next
      ae.selected = new Set(next)
    }
    let currentSel = new Set(ae.selected)
    const onUp = () => { window.removeEventListener('pointermove', onMove); window.removeEventListener('pointerup', onUp) }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  /** double-click on a row: key that track at the clicked time with the value it shows there */
  const addKeyAt = (track: number, t: number) => {
    ae.seek(snapT(t))
    ae.keyTrack(track)
  }

  const ticks = useMemo(() => {
    const step = [0.1, 0.25, 0.5, 1, 2, 5, 10].find((s) => s * scale >= 46) ?? 10
    const out: number[] = []
    for (let t = 0; t <= length + 1e-6; t += step) out.push(+t.toFixed(3))
    return out
  }, [scale, length])

  const groups = useMemo(() => {
    // tracks grouped by object, in order of first appearance
    const g: Array<{ loc: Location; items: Array<{ track: Track; index: number }> }> = []
    tracks.forEach((track, index) => {
      let grp = g.find((x) => sameLocation(x.loc, track))
      if (!grp) { grp = { loc: { path: track.path, idx: track.idx }, items: [] }; g.push(grp) }
      grp.items.push({ track, index })
    })
    return g
  }, [tracks])
  const rows: Array<{ kind: 'object'; loc: Location } | { kind: 'track'; track: Track; index: number }> = []
  for (const g of groups) { rows.push({ kind: 'object', loc: g.loc }); for (const it of g.items) rows.push({ kind: 'track', ...it }) }
  const objAt = (loc: Location) => resolvePath(root, loc.path, loc.idx)

  return (
    <div className="anim" tabIndex={0} onKeyDown={onKey} onClick={() => setMenu(null)}>
      <div className="anim-bar">
        <select className="anim-select" title="AnimationPlayer" value={player.id} onChange={(e) => { const p = players.find((x) => String(x.id) === e.target.value); if (p) ae.open(p) }}>
          {players.map((p) => <option key={p.id} value={p.id}>{p.parent?.name ?? '?'}</option>)}
        </select>
        {renaming ? (
          <input className="anim-rename" autoFocus defaultValue={anim.name}
            onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setRenaming(false) }}
            onBlur={(e) => {
              const v = e.target.value.trim()
              if (v && v !== anim.name) {
                editor.mutate(() => { if (player.get('Autoplay') === anim.name) player.set('Autoplay', v); anim.name = v })
                ae.selectAnimation(v)
              }
              setRenaming(false)
            }} />
        ) : (
          <select className="anim-select" title="Animation (double-click the name to rename)" value={anim.name}
            onDoubleClick={() => setRenaming(true)}
            onChange={(e) => {
              if (e.target.value === '\u0000new') {
                const name = uniqueName(anims.map((a) => a.name), 'Animation')
                editor.mutate(() => { const a = createInstance('Animation'); a.name = name; a.setParent(player) })
                ae.selectAnimation(name)
              } else ae.selectAnimation(e.target.value)
            }}>
            {anims.map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}
            <option value={'\u0000new'}>+ New animation</option>
          </select>
        )}
        <button className="icon-btn plain" title="Rename this animation" onClick={() => setRenaming(true)}>✎</button>
        <span className="anim-sep" />
        <button className="icon-btn plain" title="Back to the start" onClick={() => { ae.stopPreview(); ae.seek(0) }}><SkipBack size={14} /></button>
        <button className={`anim-play${ae.previewing ? ' on' : ''}`} title="Preview (Space)" onClick={() => ae.togglePreview()}>{ae.previewing ? <Pause size={14} /> : <Play size={14} />}</button>
        <span className="anim-time">{fmt(ae.time)} / </span>
        <input className="anim-len" type="number" min={0.1} step={0.1} value={length} title="Length in seconds"
          onChange={(e) => { const v = Math.max(0.1, Number(e.target.value) || 0.1); editor.mutate(() => anim.set('Length', v)); ae.seek(Math.min(ae.time, v)) }} /> s
        <label className="anim-check" title="Start again from the beginning when it ends"><input type="checkbox" checked={!!anim.get('Looped')} onChange={(e) => editor.mutate(() => anim.set('Looped', e.target.checked))} /><Repeat size={13} /> Loop</label>
        <label className="anim-check" title="Play this animation as soon as the game starts"><input type="checkbox" checked={player.get('Autoplay') === anim.name} onChange={(e) => editor.mutate(() => player.set('Autoplay', e.target.checked ? anim.name : ''))} /> Play on start</label>
        <span className="anim-sep" />
        <button className={`anim-rec${ae.recording ? ' on' : ''}`} onClick={() => { ae.recording = !ae.recording; ae.seek(ae.time) }}
          title={ae.recording ? 'Changes you make are saved as keyframes at the playhead. Click to edit the starting pose instead.' : 'Changes edit the starting pose. Click to record keyframes again.'}>
          <Circle size={10} fill={ae.recording ? 'currentColor' : 'none'} /> {ae.recording ? 'Recording changes' : 'Editing start pose'}
        </button>
        <button className="btn small" title="Add a key to every track at the playhead" disabled={!tracks.length} onClick={() => ae.keyAll()}><Diamond size={12} /> Key all</button>
        <select className="anim-select" title="Snap keys and the playhead" value={ae.snap} onChange={(e) => { ae.snap = Number(e.target.value); ae.seek(ae.time) }}>
          {[0, 0.05, 0.1, 0.25, 0.5, 1].map((s) => <option key={s} value={s}>{s ? `Snap ${s}s` : 'No snap'}</option>)}
        </select>
        <span className="anim-spacer" />
        <button className="icon-btn" title="Delete this animation" onClick={() => {
          if (!window.confirm(`Delete the animation "${anim.name}"?`)) return
          const next = anims.find((a) => a !== anim)?.name
          editor.mutate(() => anim.destroy())
          if (next) ae.selectAnimation(next); else ae.open(player)
        }}><Trash2 size={14} /></button>
      </div>

      <div className="anim-body">
        <div className="anim-names">
          <div className="anim-ruler-pad">Animating <b>{root.name}</b></div>
          {rows.map((r, i) => r.kind === 'object' ? (
            <div key={'o' + i} className="anim-obj" onClick={() => { const inst = objAt(r.loc); if (inst) editor.select([inst]) }}>
              <ClassIcon cls={objAt(r.loc)?.className ?? 'Part'} size={13} /> {r.loc.path.length ? r.loc.path[r.loc.path.length - 1] : root.name}
              {(r.loc.idx?.[r.loc.idx.length - 1] ?? 0) > 0 && <span className="anim-nth">#{(r.loc.idx![r.loc.idx!.length - 1]) + 1}</span>}
              {!objAt(r.loc) && <span className="anim-missing" title="No object with this name: it was renamed or deleted">missing</span>}
            </div>
          ) : (
            <div key={'t' + r.index} className="anim-track-name" title={trackLabel(r.track)}>
              <span>{r.track.prop}</span>
              <button className="icon-btn" title="Remove this track" onClick={() => ae.editTracks((ts) => { ts[r.index].keys = [] })}><X size={12} /></button>
            </div>
          ))}
          {!tracks.length && (
            <div className="anim-tip">
              {ae.recording
                ? <>Move the playhead, then move, rotate, resize or recolour <b>{root.name}</b> (or anything inside it), or change any of its properties. Each change becomes a keyframe.</>
                : <>Recording is off: changes now edit the starting pose.</>}
            </div>
          )}
        </div>

        <div className="anim-area" ref={areaRef}>
          <div className="anim-ruler" onPointerDown={scrub}>
            {ticks.map((t) => <span key={t} className="anim-tick" style={{ left: xOf(t) }}>{t}s</span>)}
          </div>
          {rows.map((r, i) => r.kind === 'object' ? (
            <div key={'o' + i} className="anim-row obj" />
          ) : (
            <div key={'t' + r.index} className="anim-row"
              onDoubleClick={(e) => { const rect = areaRef.current!.getBoundingClientRect(); addKeyAt(r.index, tOf(e.clientX - rect.left)) }}>
              {r.track.keys.map((k) => {
                const id = `${r.index}:${k.t}`
                return (
                  <span key={k.t} className={`anim-key ease-${k.ease.toLowerCase()}${ae.selected.has(id) ? ' sel' : ''}`} style={{ left: xOf(k.t) }}
                    title={`${fmt(k.t)}s · ${k.ease === 'Linear' || k.ease === 'Constant' ? k.ease : `${k.ease} ${k.dir}`}\nRight-click for easing. Drag to move. Delete removes.`}
                    onPointerDown={(e) => { if (e.button === 0) dragKeys(e, r.index, k.t) }}
                    onContextMenu={(e) => {
                      e.preventDefault(); e.stopPropagation()
                      if (!ae.selected.has(id)) { ae.selected.clear(); ae.selected.add(id) }
                      setMenu({ x: e.clientX, y: e.clientY, track: r.index, t: k.t })
                    }} />
                )
              })}
            </div>
          ))}
          <div className="anim-playhead" style={{ left: xOf(ae.time) }} />
          <div className="anim-end" style={{ left: xOf(length) }} />
        </div>
      </div>

      {menu && <EaseMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
    </div>
  )
}

/** Right-click menu on keys: how the value moves to the next key. */
function EaseMenu({ x, y, onClose }: { x: number; y: number; onClose: () => void }) {
  const ae = animEditor
  const setEase = (ease?: string, dir?: string) => {
    const sel = new Set(ae.selected)
    ae.editTracks((ts) => ts.forEach((t, i) => t.keys.forEach((k) => {
      if (!sel.has(`${i}:${k.t}`)) return
      if (ease) k.ease = ease as typeof k.ease
      if (dir) k.dir = dir as typeof k.dir
    })))
    onClose()
  }
  const LABEL: Record<string, string> = {
    Linear: 'Linear (steady)', Constant: 'Constant (jump)', Sine: 'Sine (gentle)', Quad: 'Quad (smooth)', Cubic: 'Cubic (smoother)',
    Back: 'Back (overshoot)', Bounce: 'Bounce', Elastic: 'Elastic (springy)',
  }
  return (
    <div className="context-menu" style={{ left: Math.min(x, window.innerWidth - 200), top: Math.max(8, y - 300) }} onClick={(e) => e.stopPropagation()}>
      <div className="menu-cat">Move to the next key</div>
      {EASING_STYLES.map((s) => <div key={s} className="menu-item" onClick={() => setEase(s)}><span>{LABEL[s]}</span></div>)}
      <div className="menu-sep" />
      <div className="menu-cat">Easing direction</div>
      {EASING_DIRECTIONS.map((d) => <div key={d} className="menu-item" onClick={() => setEase(undefined, d)}><span>{d === 'InOut' ? 'Ease in and out' : d === 'In' ? 'Ease in (start slow)' : 'Ease out (end slow)'}</span></div>)}
      <div className="menu-sep" />
      <div className="menu-item" onClick={() => {
        const sel = new Set(ae.selected)
        ae.selected.clear()
        ae.editTracks((ts) => ts.forEach((t, i) => { t.keys = t.keys.filter((k) => !sel.has(`${i}:${k.t}`)) }))
        onClose()
      }}><span>Delete key{ae.selected.size > 1 ? 's' : ''}</span><span className="menu-shortcut">Del</span></div>
    </div>
  )
}

function uniqueName(taken: string[], base: string) {
  if (!taken.includes(base)) return base
  for (let i = 2; ; i++) if (!taken.includes(`${base}${i}`)) return `${base}${i}`
}
