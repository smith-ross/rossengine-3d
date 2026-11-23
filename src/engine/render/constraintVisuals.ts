// Drawing 3D constraints: gizmos while editing (hinge axis, ball, slider track) and, when ShowInGame is on,
// ropes and springs as real cords and coils (in the editor and in games).
import * as THREE from 'three'
import { Color3, Vector3 } from '../datatypes'
import { Instance } from '../instance'
import { end1Of, pivotOf } from '../constraintClasses'

interface View { group: THREE.Group; kind: string; mat: THREE.MeshBasicMaterial | THREE.MeshStandardMaterial; overlay: boolean; mesh?: THREE.Mesh; springKey?: string }

const CYL = new THREE.CylinderGeometry(1, 1, 1, 16) // unit: radius 1, height 1 along Y, centred
const SPHERE = new THREE.SphereGeometry(1, 20, 14)
const BOX = new THREE.BoxGeometry(1, 1, 1)
const RING = new THREE.TorusGeometry(1, 0.08, 8, 32).rotateX(Math.PI / 2) // around Y
const Y = new THREE.Vector3(0, 1, 0)
const v3 = (v: Vector3) => new THREE.Vector3(v.x, v.y, v.z)

export class ConstraintVisuals {
  private views = new Map<Instance, View>()
  constructor(private scene: THREE.Scene) {}

  remove(c: Instance) {
    const v = this.views.get(c)
    if (!v) return
    this.scene.remove(v.group)
    v.mat.dispose()
    if (v.mesh && v.kind === 'SpringConstraint') v.mesh.geometry.dispose()
    this.views.delete(c)
  }

  dispose() { for (const c of [...this.views.keys()]) this.remove(c) }

  /** `editing`: draw every joint (gizmos); otherwise only the ShowInGame ones. */
  update(constraints: Iterable<Instance>, editing: boolean, selection: Instance[]) {
    for (const c of constraints) {
      const kind = c.className
      const cord = kind === 'SpringConstraint' || kind === 'RopeConstraint'
      const show = !c.destroyed && (editing || !!c.get('ShowInGame'))
      // ropes and springs are real things (lit, behind walls); the other joints are gizmos on top while editing
      const overlay = editing && !cord
      let v = this.views.get(c)
      if (!show) { if (v) v.group.visible = false; continue }
      if (!v || v.overlay !== overlay) {
        if (v) this.remove(c)
        v = this.make(c, kind, overlay)
      }
      const col = c.get<Color3>('Color') ?? new Color3(1, 0.7, 0.25)
      v.mat.color.setRGB(col.r, col.g, col.b, THREE.SRGBColorSpace)
      if (overlay) (v.mat as THREE.MeshBasicMaterial).opacity = selection.includes(c) ? 1 : 0.55
      v.group.visible = true
      const pivot = pivotOf(c)
      const thick = Math.max(0.02, c.get<number>('Thickness') ?? 0.2)
      if (cord) {
        const a = v3(pivot.position), b = v3(end1Of(c))
        const len = Math.max(0.001, a.distanceTo(b))
        v.group.position.copy(a)
        v.group.quaternion.setFromUnitVectors(Y, b.clone().sub(a).normalize())
        v.group.scale.set(1, 1, 1)
        if (kind === 'RopeConstraint') {
          v.mesh!.scale.set(thick / 2, len, thick / 2)
          v.mesh!.position.set(0, len / 2, 0)
        } else this.coil(v, len, thick)
      } else {
        const m = new THREE.Matrix4()
        pivot.toMatrix4(m)
        m.decompose(v.group.position, v.group.quaternion, v.group.scale)
        v.group.scale.set(1, 1, 1)
      }
    }
  }

  private make(c: Instance, kind: string, overlay: boolean): View {
    const mat = overlay
      ? new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.55, depthTest: false, depthWrite: false })
      : new THREE.MeshStandardMaterial({ roughness: 0.8 })
    const group = new THREE.Group()
    const add = (geo: THREE.BufferGeometry, s: [number, number, number], p: [number, number, number] = [0, 0, 0]) => {
      const mesh = new THREE.Mesh(geo, mat)
      mesh.scale.set(...s)
      mesh.position.set(...p)
      mesh.raycast = () => {} // not clickable in the world (select joints in the Explorer)
      if (overlay) mesh.renderOrder = 997
      group.add(mesh)
      return mesh
    }
    let mesh: THREE.Mesh | undefined
    switch (kind) {
      case 'HingeConstraint': add(CYL, [0.1, 2.4, 0.1]); add(RING, [0.5, 0.5, 0.5]); break
      case 'BallSocketConstraint': add(SPHERE, [0.35, 0.35, 0.35]); break
      case 'SliderConstraint': add(CYL, [0.05, 6, 0.05]); add(BOX, [0.4, 0.4, 0.4]); break
      case 'RopeConstraint': mesh = add(CYL, [0.1, 1, 0.1]); break
      case 'SpringConstraint': mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat); mesh.raycast = () => {}; group.add(mesh); break
    }
    group.traverse((o) => { if ((o as THREE.Mesh).isMesh) { (o as THREE.Mesh).castShadow = !overlay } })
    this.scene.add(group)
    const v: View = { group, kind, mat, overlay, mesh }
    this.views.set(c, v)
    return v
  }

  /** a coil from 0 to `len` along Y (rebuilt only when its length changes noticeably) */
  private coil(v: View, len: number, thick: number) {
    const key = `${len.toFixed(2)}|${thick.toFixed(2)}`
    if (v.springKey === key) return
    v.springKey = key
    const turns = 8, radius = Math.max(0.25, thick * 2)
    const pts: THREE.Vector3[] = []
    for (let i = 0; i <= turns * 16; i++) {
      const t = i / (turns * 16), a = t * turns * Math.PI * 2
      pts.push(new THREE.Vector3(Math.cos(a) * radius, t * len, Math.sin(a) * radius))
    }
    v.mesh!.geometry.dispose()
    v.mesh!.geometry = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), turns * 16, thick / 2, 6, false)
  }
}
