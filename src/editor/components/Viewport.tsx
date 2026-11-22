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

// camera state survives renderer rebuilds (undo, open file...)
const cam = { pos: new THREE.Vector3(30, 25, 40), yaw: 0.65, pitch: -0.45 }

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
    const onMouseDown = (e: MouseEvent) => {
      dom.focus()
      if (e.button === 2) rmb = { x: e.clientX, y: e.clientY }
      if (e.button === 1) { mmb = { x: e.clientX, y: e.clientY }; e.preventDefault() }
      if (e.button === 0 && !tc.dragging && (tc.axis === null || !helper.visible)) lmbDown = { x: e.clientX, y: e.clientY }
    }
    const onMouseMove = (e: MouseEvent) => {
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
      if (e.button === 0 && lmbDown) {
        const moved = Math.hypot(e.clientX - lmbDown.x, e.clientY - lmbDown.y) > 4
        lmbDown = null
        if (moved || tc.dragging || editor.playing) return
        const hit = r.pick(e.clientX, e.clientY, (i) => i.get<boolean>('Locked'))
        let target: Instance | null = hit?.inst ?? null
        if (target && !e.altKey) {
          // select the top-level model (like Studio)
          for (let p = target.parent; p && p.className !== 'Workspace'; p = p.parent) if (p instanceof Model) target = p
        }
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

  // pause the edit renderer while playing
  useEffect(() => {
    const r = rendererRef.current
    if (!r) return
    if (ed.playing) r.stop()
    else r.start()
  }, [ed.playing])

  return (
    <div className="viewport">
      <div ref={editRef} className="viewport-layer" style={{ visibility: ed.playing ? 'hidden' : 'visible' }} />
      <div ref={playRef} className="viewport-layer" style={{ visibility: ed.playing ? 'visible' : 'hidden' }} />
      {ed.starting && <div className="viewport-overlay">Starting…</div>}
      {!ed.playing && (
        <div className="viewport-hint">RMB look · WASD/QE fly · Shift slow · F focus · Alt+click selects inside models</div>
      )}
    </div>
  )
}
