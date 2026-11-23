// 2D edit viewport: pan/zoom, select & drag nodes, paint tiles, preview sprite animations.
import { useEffect, useRef, useState } from 'react'
import { Brush, Eraser, Grid3x3, Shapes, SquareDashed, Video } from 'lucide-react'
import { EnumItem, Vector2, enumItem } from '../../engine/datatypes'
import { Instance, createInstance } from '../../engine/instance'
import { TileMap, isNode2D, setWorldPosition, worldPosition } from '../../engine/classes2d'
import { Renderer2D } from '../../engine/render/Renderer2D'
import { Animator2D } from '../../engine/game/Animator2D'
import { BillboardLayer } from '../../engine/gui/BillboardLayer'
import { GuiRenderer } from '../../engine/gui/GuiRenderer'
import { assets, contentRef } from '../../engine/assets'
import { editor, useEditor } from '../store'
import { importFiles } from '../assetOps'
import { ASSET_DRAG_TYPE } from './AssetsPanel'

/** editor 2D camera, kept across rebuilds */
export const view2d = { x: 0, y: 0, zoom: 2 }
export const tileTool = { tile: 0, mode: 'paint' as 'paint' | 'erase' | 'rect', terrain: null as string | null }
const overlays = { grid: true, collision: true, camera: true }

/** pick the thing users mean: the physics body (or top-level node) rather than its sprite */
function selectable(hit: Instance | null, exact: boolean): Instance | null {
  if (!hit || exact) return hit
  for (let p: Instance | null = hit; p && isNode2D(p); p = p.parent) if (p.isA('PhysicsBody2D')) return p
  return hit
}

export function Viewport2D() {
  const ed = useEditor()
  const hostRef = useRef<HTMLDivElement>(null)
  const rRef = useRef<Renderer2D | null>(null)
  const camLabelRef = useRef<HTMLDivElement>(null)
  const zoomRef = useRef<HTMLSpanElement>(null)
  const [, force] = useState(0)
  const game = ed.game
  const selectedMap = ed.selection.length === 1 && ed.selection[0] instanceof TileMap ? (ed.selection[0] as TileMap) : null

  useEffect(() => {
    const el = hostRef.current!
    const r = new Renderer2D(el, game, { editor: true })
    rRef.current = r
    r.showGrid = overlays.grid
    r.showCollision = overlays.collision
    r.showCamera = overlays.camera
    // billboards over the world, under the ScreenGuis
    const billboards = new BillboardLayer(el, game, r)
    billboards.guiSource = game.getService('StarterGui')
    billboards.root.style.zIndex = '1'
    const gui = new GuiRenderer(el)
    gui.interactive = false
    gui.root.style.zIndex = '2'
    gui.setSource(game.getService('StarterGui'))
    const animator = new Animator2D()
    const dom = r.renderer.domElement

    r.onBeforeRender = (dt) => {
      billboards.selection = editor.selection
      r.view = { ...view2d }
      const zoomText = `${Math.round(view2d.zoom * 100)}%`
      if (zoomRef.current && zoomRef.current.textContent !== zoomText) zoomRef.current.textContent = zoomText
      r.gameSize = { w: editor.settings.width || 1280, h: editor.settings.height || 720 }
      // label the game camera's view (top-left of its outline)
      const label = camLabelRef.current
      if (label) {
        if (!r.showCamera || editor.playing) label.style.display = 'none'
        else {
          const c = r.cameraView()
          const p = r.worldToViewport(new Vector2(c.x - c.w / 2, c.y - c.h / 2))
          label.style.display = ''
          // above the frame's corner, kept clear of the viewport's top-left buttons (inside the frame if need be)
          let y = p.y - 22
          if (y < 36) y = Math.max(36, p.y + 6)
          label.style.transform = `translate(${Math.round(Math.max(4, p.x))}px, ${Math.round(y)}px)`
          const what = c.camera ? `${c.camera.name}${c.follow ? ` (follows ${c.follow.name})` : ''}` : 'Default view (no Camera2D)'
          const text = `${what} · ${r.gameSize.w}×${r.gameSize.h} at ${+c.zoom.toFixed(2)}×`
          if (label.textContent !== text) label.textContent = text
        }
      }
      r.gridSize = editor.snap > 1 ? editor.snap : (editor.selection[0] instanceof TileMap ? (editor.selection[0] as TileMap).get<Vector2>('TileSize').x : 16)
      r.setSelection(editor.selection)
      animator.update(dt, r.drawList.map((v) => v.inst), (inst, frame) => r.frameOverride.set(inst, frame))
    }
    r.start()

    let pan: { x: number; y: number } | null = null
    let space = false
    let drag: { start: Vector2; items: Array<[Instance, Vector2]>; active: boolean; sx: number; sy: number } | null = null
    let paint: { map: TileMap; erase: boolean; rectFrom?: Vector2; last?: string } | null = null
    let click: { x: number; y: number } | null = null

    const world = (e: MouseEvent) => r.screenToWorld(e.clientX, e.clientY)
    const snap = (v: number) => (editor.snap > 1 ? Math.round(v / editor.snap) * editor.snap : Math.round(v))
    const cellAt = (map: TileMap, p: Vector2) => {
      const c = map.classInfo.methods.get('WorldToCell')!(map, p) as Vector2
      return c
    }

    const paintAt = (e: MouseEvent) => {
      if (!paint) return
      const c = cellAt(paint.map, world(e))
      const key = `${c.x},${c.y}`
      if (paint.last === key) return
      paint.last = key
      if (paint.rectFrom) return
      const terrain = tileTool.terrain && paint.map.terrain(tileTool.terrain)
      if (terrain) paint.map.setCellTerrain(c.x, c.y, paint.erase ? null : terrain)
      else paint.map.setCell(c.x, c.y, paint.erase ? -1 : tileTool.tile)
    }

    const onDown = (e: MouseEvent) => {
      dom.focus()
      if (e.button === 1 || (e.button === 0 && space) || (e.button === 2 && !selectedMapNow())) { pan = { x: e.clientX, y: e.clientY }; e.preventDefault(); return }
      const map = selectedMapNow()
      if (map && (e.button === 0 || e.button === 2)) {
        editor.checkpoint()
        const erase = e.button === 2 || tileTool.mode === 'erase'
        paint = { map, erase }
        if (tileTool.mode === 'rect' || e.shiftKey) paint.rectFrom = cellAt(map, world(e))
        paintAt(e)
        return
      }
      if (e.button !== 0) return
      click = { x: e.clientX, y: e.clientY }
      const hit = selectable(r.pick(world(e)), e.altKey)
      if (hit && !e.ctrlKey && !e.shiftKey) {
        const sel = editor.selection.includes(hit) ? editor.selection : [hit]
        if (!editor.selection.includes(hit)) editor.select([hit])
        drag = { start: world(e), items: sel.filter(isNode2D).map((n) => [n, worldPosition(n)]), active: false, sx: e.clientX, sy: e.clientY }
      }
    }
    const onMove = (e: MouseEvent) => {
      if (pan) {
        view2d.x -= (e.clientX - pan.x) / view2d.zoom
        view2d.y -= (e.clientY - pan.y) / view2d.zoom
        pan = { x: e.clientX, y: e.clientY }
        return
      }
      if (paint) { paintAt(e); return }
      if (drag) {
        if (!drag.active && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 4) { drag.active = true; editor.checkpoint() }
        if (drag.active) {
          const p = world(e)
          const dx = p.x - drag.start.x, dy = p.y - drag.start.y
          for (const [n, start] of drag.items) setWorldPosition(n, new Vector2(snap(start.x + dx), snap(start.y + dy)))
        }
        return
      }
      if (e.target === dom) r.setHover(selectable(r.pick(world(e)), e.altKey))
    }
    const onUp = (e: MouseEvent) => {
      if (pan) { pan = null; return }
      if (paint) {
        if (paint.rectFrom) {
          const a = paint.rectFrom, b = cellAt(paint.map, world(e))
          const terrain = tileTool.terrain && paint.map.terrain(tileTool.terrain)
          for (let x = Math.min(a.x, b.x); x <= Math.max(a.x, b.x); x++) for (let y = Math.min(a.y, b.y); y <= Math.max(a.y, b.y); y++) {
            if (terrain) paint.map.setCellTerrain(x, y, paint.erase ? null : terrain, false)
            else paint.map.setCell(x, y, paint.erase ? -1 : tileTool.tile, false)
          }
          paint.map.changed('Cells')
        }
        paint = null
        editor.emit()
        return
      }
      if (drag?.active) { drag = null; editor.emit(); return }
      drag = null
      if (click && e.button === 0 && Math.hypot(e.clientX - click.x, e.clientY - click.y) < 5) {
        const hit = selectable(r.pick(world(e)), e.altKey)
        if (e.ctrlKey || e.shiftKey) {
          if (hit) editor.select(editor.selection.includes(hit) ? editor.selection.filter((s) => s !== hit) : [...editor.selection, hit])
        } else editor.select(hit ? [hit] : [])
      }
      click = null
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const before = world(e)
      view2d.zoom = Math.min(32, Math.max(0.1, view2d.zoom * (e.deltaY > 0 ? 1 / 1.15 : 1.15)))
      r.view = { ...view2d }
      const after = r.screenToWorld(e.clientX, e.clientY)
      view2d.x += before.x - after.x
      view2d.y += before.y - after.y
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' && (e.target === dom || e.target === document.body)) { space = e.type === 'keydown'; if (space) e.preventDefault() }
      if (e.type === 'keydown' && e.code === 'KeyF' && e.target === dom && editor.selection[0] && isNode2D(editor.selection[0])) {
        const p = worldPosition(editor.selection[0]); view2d.x = p.x; view2d.y = p.y
      }
    }
    // drop images/assets: images become Sprite2Ds
    const onDragOver = (e: DragEvent) => { if (e.dataTransfer && (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes(ASSET_DRAG_TYPE))) e.preventDefault() }
    const onDrop = async (e: DragEvent) => {
      if (!e.dataTransfer) return
      e.preventDefault()
      const at = world(e)
      const id = e.dataTransfer.getData(ASSET_DRAG_TYPE)
      const list = id ? [assets.get(id)!].filter(Boolean) : await importFiles([...e.dataTransfer.files])
      for (const a of list) {
        if (a.kind !== 'image') { editor.log('warn', `Only images can be placed in the 2D world (${a.name} is ${a.kind}).`); continue }
        const size = await imageSize(assets.url(contentRef(a))!)
        editor.mutate(() => {
          const s = createInstance('Sprite2D')
          s.name = a.name
          s.set('Image', contentRef(a))
          s.set('Size', new Vector2(size.w, size.h))
          s.set('Position', new Vector2(snap(at.x), snap(at.y)))
          s.setParent(editor.game.getService('World2D'))
          editor.selection = [s]
        })
      }
    }
    const selectedMapNow = () => (editor.selection.length === 1 && editor.selection[0] instanceof TileMap ? (editor.selection[0] as TileMap) : null)

    dom.addEventListener('mousedown', onDown)
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    dom.addEventListener('wheel', onWheel, { passive: false })
    dom.addEventListener('contextmenu', (e) => e.preventDefault())
    dom.addEventListener('mouseleave', () => r.setHover(null))
    dom.addEventListener('dragover', onDragOver)
    dom.addEventListener('drop', onDrop)
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    ;(window as any).__edit2d = r
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
      gui.dispose()
      billboards.dispose()
      r.dispose()
      rRef.current = null
    }
  }, [game])

  const toggle = (k: keyof typeof overlays) => {
    overlays[k] = !overlays[k]
    if (rRef.current) { rRef.current.showGrid = overlays.grid; rRef.current.showCollision = overlays.collision; rRef.current.showCamera = overlays.camera }
    force((x) => x + 1)
  }

  return (
    <div className="viewport">
      <div ref={hostRef} className="viewport-layer" />
      <div ref={camLabelRef} className="vp2d-camlabel" />
      <div className="vp2d-bar">
        <button className={overlays.grid ? 'on' : ''} onClick={() => toggle('grid')} title="Show grid"><Grid3x3 size={14} /></button>
        <button className={overlays.collision ? 'on' : ''} onClick={() => toggle('collision')} title="Show collision shapes"><Shapes size={14} /></button>
        <button className={overlays.camera ? 'on' : ''} onClick={() => toggle('camera')} title="Show what the game camera sees"><Video size={14} /></button>
        <span ref={zoomRef} className="vp2d-zoom">{Math.round(view2d.zoom * 100)}%</span>
      </div>
      {selectedMap && <TilePalette map={selectedMap} />}
      <div className="viewport-hint">
        {selectedMap
          ? 'Tile mode: LMB paint · RMB erase · Shift+drag rectangle · MMB/Space+drag pan · wheel zoom'
          : 'LMB select/drag · MMB, RMB or Space+drag pan · wheel zoom · F focus · Alt+click picks inside bodies · drop images to add sprites'}
      </div>
    </div>
  )
}

function imageSize(url: string): Promise<{ w: number; h: number }> {
  return new Promise((res) => {
    const img = new Image()
    img.onload = () => res({ w: img.naturalWidth || 32, h: img.naturalHeight || 32 })
    img.onerror = () => res({ w: 32, h: 32 })
    img.src = url
  })
}

/** Tileset palette for the selected TileMap. */
function TilePalette({ map }: { map: TileMap }) {
  useEditor()
  const [, force] = useState(0)
  const [img, setImg] = useState<{ url: string; w: number; h: number } | null>(null)
  const content = map.get<string>('TileSet')
  const ts = map.get<Vector2>('TileSize')
  useEffect(() => {
    const url = assets.url(content)
    if (!url) { setImg(null); return }
    void imageSize(url).then((s) => setImg({ url, ...s }))
  }, [content])
  const cols = img ? Math.max(1, Math.floor(img.w / ts.x)) : 8
  const rows = img ? Math.max(1, Math.floor(img.h / ts.y)) : 2
  const scale = Math.max(1, Math.floor(36 / Math.max(ts.x, ts.y)))
  const set = (p: Partial<typeof tileTool>) => { Object.assign(tileTool, p); force((x) => x + 1) }
  const terrains = map.terrains()
  if (tileTool.terrain && !terrains.some((t) => t.name === tileTool.terrain)) tileTool.terrain = null
  const active = tileTool.terrain ? map.terrain(tileTool.terrain) : null
  const activeTiles = new Set(active ? map.terrainTiles(active) : [])
  const [adding, setAdding] = useState(false)
  /** Create a terrain whose tile block starts at the selected palette tile. */
  const addTerrain = (mode: 'Block3x3' | 'Block3x3Inner' | 'Cardinal16') => {
    const s = tileTool.tile
    const at = (r: number, c: number) => s + r * cols + c
    let tiles: number[]
    if (mode === 'Cardinal16') tiles = Array.from({ length: 16 }, (_, i) => at(Math.floor(i / 4), i % 4))
    else {
      tiles = [at(0, 0), at(0, 1), at(0, 2), at(1, 0), at(1, 1), at(1, 2), at(2, 0), at(2, 1), at(2, 2)]
      if (mode === 'Block3x3Inner') tiles.push(at(0, 3), at(0, 4), at(1, 3), at(1, 4))
    }
    editor.mutate(() => {
      const t = createInstance('TileTerrain')
      t.name = `Terrain${terrains.length + 1}`
      t.set('Mode', enumItem('TerrainMode', mode))
      t.set('Tiles', tiles.join(', '))
      t.setParent(map)
      tileTool.terrain = t.name
    })
    setAdding(false)
  }
  const tileStyle = (i: number, size: number): React.CSSProperties => ({
    width: size, height: size,
    backgroundImage: img ? `url("${img.url}")` : undefined,
    backgroundColor: img ? undefined : `hsl(${(i * 0.13 % 1) * 360}, 55%, 55%)`,
    backgroundSize: img ? `${(img.w / ts.x) * size}px ${(img.h / ts.y) * size}px` : undefined,
    backgroundPosition: img ? `-${(i % cols) * size}px -${Math.floor(i / cols) * size}px` : undefined,
  })
  return (
    <div className="tile-palette">
      <div className="tp-head">
        <span>Tiles</span>
        <div className="seg">
          <button className={tileTool.mode === 'paint' ? 'on' : ''} onClick={() => set({ mode: 'paint' })} title="Paint"><Brush size={12} /></button>
          <button className={tileTool.mode === 'rect' ? 'on' : ''} onClick={() => set({ mode: 'rect' })} title="Rectangle fill"><SquareDashed size={12} /></button>
          <button className={tileTool.mode === 'erase' ? 'on' : ''} onClick={() => set({ mode: 'erase' })} title="Erase"><Eraser size={12} /></button>
        </div>
      </div>
      <div className="tp-section">
        <div className="tp-label">Brush</div>
        <div className="tp-terrains">
          <button className={`tp-terrain${!active ? ' on' : ''}`} onClick={() => set({ terrain: null })} title="Paint single tiles">
            <span className="tp-swatch" style={tileStyle(tileTool.tile, 18)} /> Single tile
          </button>
          {terrains.map((t) => {
            const tiles = map.terrainTiles(t)
            return (
              <button key={t.id} className={`tp-terrain${active === t ? ' on' : ''}`} onClick={() => set({ terrain: t.name, mode: tileTool.mode === 'erase' ? 'paint' : tileTool.mode })}
                onDoubleClick={() => editor.select([t])} title={`${t.name} (${t.get<EnumItem>('Mode')?.name}) — auto-tiles as you paint. Double-click to edit.`}>
                <span className="tp-swatch" style={tileStyle(tiles[Math.min(4, tiles.length - 1)] ?? 0, 18)} /> {t.name}
              </button>
            )
          })}
        </div>
        {adding ? (
          <div className="tp-add">
            <div className="muted small">New terrain from the selected tile ({tileTool.tile}) as the top-left of:</div>
            <button className="btn small" onClick={() => addTerrain('Block3x3')}>3×3 block (edges + corners)</button>
            <button className="btn small" onClick={() => addTerrain('Block3x3Inner')}>3×3 + inner corners (2×2 to its right)</button>
            <button className="btn small" onClick={() => addTerrain('Cardinal16')}>4×4 block (16-tile cardinal)</button>
            <button className="btn small" onClick={() => setAdding(false)}>Cancel</button>
          </div>
        ) : (
          <div className="row-inline">
            <button className="btn small" onClick={() => setAdding(true)} title="Make an auto-tiling terrain from a block of tiles">+ Terrain</button>
            {terrains.length > 0 && <button className="btn small" onClick={() => editor.mutate(() => map.updateTerrain())} title="Re-pick every terrain cell's tile">Re-tile map</button>}
          </div>
        )}
      </div>
      {!img && <div className="muted small pad">No TileSet image — set the TileMap's <b>TileSet</b> property (tiles are drawn as coloured squares until then).</div>}
      <div className="tp-grid" style={{ gridTemplateColumns: `repeat(${cols}, ${ts.x * scale}px)` }}>
        {Array.from({ length: cols * rows }, (_, i) => (
          <button
            key={i}
            className={`tp-tile${!active && tileTool.tile === i ? ' on' : ''}${activeTiles.has(i) ? ' terrain' : ''}`}
            title={`Tile ${i}`}
            onClick={() => set({ tile: i, terrain: adding ? tileTool.terrain : null, mode: tileTool.mode === 'erase' ? 'paint' : tileTool.mode })}
            style={{
              width: ts.x * scale, height: ts.y * scale,
              backgroundImage: img ? `url("${img.url}")` : undefined,
              backgroundColor: img ? undefined : `hsl(${(i * 0.13 % 1) * 360}, 55%, 55%)`,
              backgroundSize: img ? `${img.w * scale}px ${img.h * scale}px` : undefined,
              backgroundPosition: img ? `-${(i % cols) * ts.x * scale}px -${Math.floor(i / cols) * ts.y * scale}px` : undefined,
            }}
          />
        ))}
      </div>
      <div className="muted small pad">Solid tiles: <code>{map.get<string>('SolidTiles') || 'none'}</code></div>
    </div>
  )
}
