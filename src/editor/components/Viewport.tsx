// 3D edit viewport: Studio-style fly camera, click selection and transform gizmos.
import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { CFrame, Vector3 } from '../../engine/datatypes'
import { Instance } from '../../engine/instance'
import { BasePart, Model, partsOf } from '../../engine/classes'
import { SceneRenderer } from '../../engine/render/SceneRenderer'
import { GuiRenderer } from '../../engine/gui/GuiRenderer'
import { editor, useEditor } from '../store'
import { insertHint, selectionPivot } from '../ops'
import { assets } from '../../engine/assets'
import { importFiles, insertAsset } from '../assetOps'
import { ASSET_DRAG_TYPE } from './AssetsPanel'
import { Viewport2D } from './Viewport2D'

// camera state survives renderer rebuilds (undo, open file...)
const cam = { pos: new THREE.Vector3(30, 25, 40), yaw: 0.65, pitch: -0.45 }
;(window as any).__editCam = cam

export function Viewport() {
  const ed = useEditor()
  const editRef = useRef<HTMLDivElement>(null)
  const playRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<SceneRenderer | null>(null)
  const game = ed.game

  useEffect(() => {
    editor.playContainer = playRef.current
  }, [])

  // build an edit renderer for the current edit DataModel
  useEffect(() => {
    const el = editRef.current!
    const r = new SceneRenderer(el, game)
    rendererRef.current = r
    const gui = new GuiRenderer(el)
    gui.interactive = false
    gui.setSource(game.getService('StarterGui'))

    const dom = r.renderer.domElement
    const keys = new Set<string>()
    let rmb: { x: number; y: number } | null = null
    let mmb: { x: number; y: number } | null = null
    let lmbDown: { x: number; y: number } | null = null

    // gizmo
    const tc = new TransformControls(r.camera, dom)
    const pivotObj = new THREE.Object3D()
    r.scene.add(pivotObj)
    tc.attach(pivotObj)
    const helper = tc.getHelper()
    r.scene.add(helper)
    tc.setSize(0.9)
    let dragStart: { pivot: CFrame; parts: Map<BasePart, CFrame>; sizes: Map<BasePart, Vector3> } | null = null

    const syncGizmo = () => {
      const sel = editor.selection.filter((s) => s instanceof BasePart || s instanceof Model)
      const pivot = editor.playing ? null : selectionPivot(sel)
      const tool = editor.tool
      const visible = !!pivot && tool !== 'select' && !(tool === 'scale' && !(sel.length === 1 && sel[0] instanceof BasePart))
      helper.visible = visible
      tc.enabled = visible
      if (!pivot || dragStart) return
      pivot.toMatrix4(pivotObj.matrix)
      pivotObj.matrix.decompose(pivotObj.position, pivotObj.quaternion, pivotObj.scale)
      pivotObj.scale.set(1, 1, 1)
      tc.setMode(tool === 'rotate' ? 'rotate' : tool === 'scale' ? 'scale' : 'translate')
      tc.setSpace(tool === 'move' && sel.length === 1 ? 'local' : 'local')
      tc.setTranslationSnap(editor.snap || null)
      tc.setRotationSnap(editor.rotateSnap ? THREE.MathUtils.degToRad(editor.rotateSnap) : null)
      tc.setScaleSnap(null)
    }

    tc.addEventListener('dragging-changed', (e: any) => {
      if (e.value) {
        const sel = editor.selection.filter((s) => s instanceof BasePart || s instanceof Model)
        const parts = new Map<BasePart, CFrame>()
        const sizes = new Map<BasePart, Vector3>()
        for (const s of sel) for (const p of partsOf(s)) { parts.set(p, p.cframe); sizes.set(p, p.size) }
        const pivot = selectionPivot(sel)
        if (!pivot) return
        editor.checkpoint()
        dragStart = { pivot, parts, sizes }
      } else {
        dragStart = null
        syncGizmo()
      }
    })
    tc.addEventListener('objectChange', () => {
      if (!dragStart) return
      const m = new THREE.Matrix4().compose(pivotObj.position, pivotObj.quaternion, new THREE.Vector3(1, 1, 1))
      const now = CFrame.fromMatrix4(m)
      if (tc.mode === 'scale') {
        const [p] = [...dragStart.parts.keys()]
        const start = dragStart.sizes.get(p)!
        const snap = editor.snap || 0
        const q = (v: number) => (snap ? Math.max(snap, Math.round(v / snap) * snap) : Math.max(0.05, v))
        const s = pivotObj.scale
        p.set('Size', new Vector3(q(start.x * s.x), q(start.y * s.y), q(start.z * s.z)))
        return
      }
      const delta = now.mul(dragStart.pivot.inverse())
      for (const [p, cf] of dragStart.parts) p.set('CFrame', delta.mul(cf))
    })

    const unsub = editor.subscribe(() => {
      r.setSelection(editor.playing ? [] : editor.selection)
      syncGizmo()
    })
    r.setSelection(editor.selection)
    syncGizmo()

    // camera
    const applyCam = () => {
      r.camera.position.copy(cam.pos)
      r.camera.quaternion.setFromEuler(new THREE.Euler(cam.pitch, cam.yaw, 0, 'YXZ'))
      r.camera.updateMatrixWorld()
    }
    applyCam()
    r.onBeforeRender = (dt) => {
      if (editor.playing) return
      const typing = document.activeElement && document.activeElement !== dom && document.activeElement !== document.body
      if (!typing && keys.size) {
        const speed = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 12 : 48) * dt
        const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(r.camera.quaternion)
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(r.camera.quaternion)
        if (keys.has('KeyW')) cam.pos.addScaledVector(fwd, speed)
        if (keys.has('KeyS')) cam.pos.addScaledVector(fwd, -speed)
        if (keys.has('KeyD')) cam.pos.addScaledVector(right, speed)
        if (keys.has('KeyA')) cam.pos.addScaledVector(right, -speed)
        if (keys.has('KeyE')) cam.pos.y += speed
        if (keys.has('KeyQ')) cam.pos.y -= speed
      }
      applyCam()
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(r.camera.quaternion)
      const p = cam.pos.clone().addScaledVector(fwd, 20)
      insertHint.position = new Vector3(p.x, Math.max(p.y, 0), p.z)
    }
    r.start()

    const onKeyDown = (e: KeyboardEvent) => {
      if (editor.playing || e.ctrlKey || e.metaKey || e.altKey) return
      const t = e.target as HTMLElement
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable || t.closest('.monaco-editor'))) return
      if (!el.contains(document.activeElement) && document.activeElement !== document.body) return
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight'].includes(e.code)) keys.add(e.code)
      if (e.code === 'KeyF') focusSelection()
    }
    const onKeyUp = (e: KeyboardEvent) => keys.delete(e.code)
    const focusSelection = () => {
      const sel = editor.selection[0]
      if (!sel) return
      const box = r.boundsOf(sel)
      if (box.isEmpty()) return
      const center = box.getCenter(new THREE.Vector3())
      const size = box.getSize(new THREE.Vector3()).length()
      const back = new THREE.Vector3(0, 0, 1).applyQuaternion(r.camera.quaternion)
      cam.pos.copy(center).addScaledVector(back, Math.max(8, size * 1.4))
    }
    const selectable = (hit: Instance | null, alt: boolean): Instance | null => {
      let target = hit
      if (target && !alt) for (let p = target.parent; p && p.className !== 'Workspace'; p = p.parent) if (p instanceof Model) target = p
      return target
    }
    // Studio-style dragging: grab a part and slide it along the surfaces under the mouse
    let drag: {
      startX: number; startY: number; active: boolean; target: Instance; grabOffset: THREE.Vector3; pivot: CFrame
      parts: Map<BasePart, CFrame>; half: THREE.Vector3; centerOffset: THREE.Vector3; dragged: Set<Instance>
    } | null = null
    const beginDragCandidate = (e: MouseEvent) => {
      const hit = r.pick(e.clientX, e.clientY, (i) => i.get<boolean>('Locked'))
      const target = selectable(hit?.inst ?? null, e.altKey)
      if (!hit || !target || e.ctrlKey || e.shiftKey) return
      const sel = editor.selection.includes(target) ? editor.selection : [target]
      const parts = new Map<BasePart, CFrame>()
      for (const s of sel) for (const p of partsOf(s)) parts.set(p, p.cframe)
      const pivot = selectionPivot(sel)
      if (!pivot || !parts.size) return
      const box = new THREE.Box3()
      for (const s of sel) box.union(r.boundsOf(s))
      const center = box.getCenter(new THREE.Vector3())
      drag = {
        startX: e.clientX, startY: e.clientY, active: false, target,
        grabOffset: new THREE.Vector3(center.x - hit.point.x, 0, center.z - hit.point.z),
        pivot, parts, half: box.getSize(new THREE.Vector3()).multiplyScalar(0.5),
        centerOffset: new THREE.Vector3(pivot.x - center.x, pivot.y - center.y, pivot.z - center.z),
        dragged: new Set<Instance>([...parts.keys()]),
      }
    }
    const updateDrag = (e: MouseEvent) => {
      if (!drag) return
      if (!drag.active) {
        if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 5) return
        drag.active = true
        if (!editor.selection.includes(drag.target)) editor.select([drag.target])
        editor.checkpoint()
        dom.style.cursor = 'grabbing'
      }
      const d = drag
      const hit = r.pick(e.clientX, e.clientY, (i) => d.dragged.has(i))
      let center: THREE.Vector3
      if (hit) {
        const n = hit.normal
        const ext = Math.abs(n.x) * d.half.x + Math.abs(n.y) * d.half.y + Math.abs(n.z) * d.half.z
        center = hit.point.clone().addScaledVector(n, ext)
        if (Math.abs(n.y) > 0.7) center.add(d.grabOffset)
      } else {
        // nothing under the mouse: slide on the horizontal plane at the current height
        const ray = r.ray(e.clientX, e.clientY).ray
        const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -(d.pivot.y - d.centerOffset.y))
        const p = ray.intersectPlane(plane, new THREE.Vector3())
        if (!p) return
        center = p.add(d.grabOffset)
      }
      const snap = editor.snap
      if (snap) { center.x = Math.round(center.x / snap) * snap; center.z = Math.round(center.z / snap) * snap }
      const newPivot = new Vector3(center.x + d.centerOffset.x, center.y + d.centerOffset.y, center.z + d.centerOffset.z)
      const delta = new CFrame(newPivot.x - d.pivot.x, newPivot.y - d.pivot.y, newPivot.z - d.pivot.z)
      for (const [p, cf] of d.parts) p.set('CFrame', delta.mul(cf))
    }

    const onMouseDown = (e: MouseEvent) => {
      dom.focus()
      if (e.button === 2) rmb = { x: e.clientX, y: e.clientY }
      if (e.button === 1) { mmb = { x: e.clientX, y: e.clientY }; e.preventDefault() }
      if (e.button === 0 && !tc.dragging && (tc.axis === null || !helper.visible)) {
        lmbDown = { x: e.clientX, y: e.clientY }
        if (!editor.playing) beginDragCandidate(e)
      }
    }
    let hoverQueued = false
    const onMouseMove = (e: MouseEvent) => {
      if (drag) { updateDrag(e); return }
      if (!rmb && !mmb && !tc.dragging && e.target === dom && !hoverQueued) {
        hoverQueued = true
        requestAnimationFrame(() => {
          hoverQueued = false
          if (editor.playing || tc.axis) { r.setHover(null); return }
          const hit = r.pick(e.clientX, e.clientY, (i) => i.get<boolean>('Locked'))
          r.setHover(selectable(hit?.inst ?? null, e.altKey))
        })
      }
      if (rmb) {
        cam.yaw -= (e.clientX - rmb.x) * 0.005
        cam.pitch = Math.max(-1.55, Math.min(1.55, cam.pitch - (e.clientY - rmb.y) * 0.005))
        rmb = { x: e.clientX, y: e.clientY }
      }
      if (mmb) {
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(r.camera.quaternion)
        const up = new THREE.Vector3(0, 1, 0).applyQuaternion(r.camera.quaternion)
        cam.pos.addScaledVector(right, -(e.clientX - mmb.x) * 0.08).addScaledVector(up, (e.clientY - mmb.y) * 0.08)
        mmb = { x: e.clientX, y: e.clientY }
      }
    }
    const onMouseUp = (e: MouseEvent) => {
      if (e.button === 2) rmb = null
      if (e.button === 1) mmb = null
      if (e.button === 0 && drag) {
        const wasActive = drag.active
        drag = null
        dom.style.cursor = ''
        if (wasActive) { lmbDown = null; editor.emit(); return }
      }
      if (e.button === 0 && lmbDown) {
        const moved = Math.hypot(e.clientX - lmbDown.x, e.clientY - lmbDown.y) > 4
        lmbDown = null
        if (moved || tc.dragging || editor.playing) return
        const hit = r.pick(e.clientX, e.clientY, (i) => i.get<boolean>('Locked'))
        const target = selectable(hit?.inst ?? null, e.altKey)
        if (e.ctrlKey || e.shiftKey) {
          if (!target) return
          const s = editor.selection
          editor.select(s.includes(target) ? s.filter((x) => x !== target) : [...s, target])
        } else editor.select(target ? [target] : [])
      }
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(r.camera.quaternion)
      cam.pos.addScaledVector(fwd, -Math.sign(e.deltaY) * 4)
    }
    const onContext = (e: Event) => e.preventDefault()
    const onLeave = () => r.setHover(null)
    // drop files (import) or assets from the Assets panel into the world
    const onDragOver = (e: DragEvent) => {
      if (editor.playing || !e.dataTransfer) return
      if (e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes(ASSET_DRAG_TYPE)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }
    }
    const onDrop = async (e: DragEvent) => {
      if (editor.playing || !e.dataTransfer) return
      e.preventDefault()
      const hit = r.pick(e.clientX, e.clientY)
      const at = hit
        ? { part: hit.inst, point: new Vector3(hit.point.x, hit.point.y, hit.point.z), normal: new Vector3(hit.normal.x, hit.normal.y, hit.normal.z) }
        : {}
      const id = e.dataTransfer.getData(ASSET_DRAG_TYPE)
      const list = id ? [assets.get(id)].filter((a) => !!a) : await importFiles([...e.dataTransfer.files])
      for (const a of list) await insertAsset(a!, a!.kind === 'mesh' ? { point: at.point } : at)
    }
    dom.addEventListener('dragover', onDragOver)
    dom.addEventListener('drop', onDrop)
    dom.addEventListener('mouseleave', onLeave)
    dom.addEventListener('mousedown', onMouseDown)
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
    dom.addEventListener('wheel', onWheel, { passive: false })
    dom.addEventListener('contextmenu', onContext)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    ;(window as any).__editRenderer = r

    return () => {
      unsub()
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      tc.detach()
      tc.dispose()
      gui.dispose()
      r.dispose()
      rendererRef.current = null
    }
  }, [game])

  const is2D = !!game.getService('World2D').get('Enabled')
  // pause the 3D edit renderer while playing or while editing a 2D place
  useEffect(() => {
    const r = rendererRef.current
    if (!r) return
    if (ed.playing || is2D) r.stop()
    else r.start()
  }, [ed.playing, is2D])

  return (
    <div className="viewport">
      <div ref={editRef} className="viewport-layer" style={{ visibility: ed.playing || is2D ? 'hidden' : 'visible' }} />
      {is2D && !ed.playing && <div className="viewport-layer"><Viewport2D /></div>}
      <div ref={playRef} className="viewport-layer" style={{ visibility: ed.playing ? 'visible' : 'hidden' }} />
      {ed.starting && <div className="viewport-overlay">Starting…</div>}
      {!ed.playing && !is2D && (
        <div className="viewport-hint">RMB look · WASD/QE fly · F focus · drag parts to move · Alt+click selects inside models · drop files to import</div>
      )}
    </div>
  )
}
