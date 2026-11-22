// Engine-side (TypeScript) value types. The Luau side has its own pure-Luau
// implementations of these (see luau/prelude.luau); values are marshalled
// across the bridge as flat number lists.
import * as THREE from 'three'

export class Vector3 {
  constructor(public readonly x = 0, public readonly y = 0, public readonly z = 0) {}
  static readonly zero = new Vector3(0, 0, 0)
  static readonly one = new Vector3(1, 1, 1)
  add(o: Vector3) { return new Vector3(this.x + o.x, this.y + o.y, this.z + o.z) }
  sub(o: Vector3) { return new Vector3(this.x - o.x, this.y - o.y, this.z - o.z) }
  mul(s: number) { return new Vector3(this.x * s, this.y * s, this.z * s) }
  get magnitude() { return Math.hypot(this.x, this.y, this.z) }
  get unit() { const m = this.magnitude || 1; return this.mul(1 / m) }
  dot(o: Vector3) { return this.x * o.x + this.y * o.y + this.z * o.z }
  cross(o: Vector3) {
    return new Vector3(this.y * o.z - this.z * o.y, this.z * o.x - this.x * o.z, this.x * o.y - this.y * o.x)
  }
  toThree() { return new THREE.Vector3(this.x, this.y, this.z) }
  static fromThree(v: THREE.Vector3) { return new Vector3(v.x, v.y, v.z) }
  equals(o: Vector3) { return this.x === o.x && this.y === o.y && this.z === o.z }
  toString() { return `${fmt(this.x)}, ${fmt(this.y)}, ${fmt(this.z)}` }
}

/** Coordinate frame: position + 3x3 rotation matrix (row major, like Roblox). */
export class CFrame {
  constructor(
    public readonly x = 0, public readonly y = 0, public readonly z = 0,
    public readonly r00 = 1, public readonly r01 = 0, public readonly r02 = 0,
    public readonly r10 = 0, public readonly r11 = 1, public readonly r12 = 0,
    public readonly r20 = 0, public readonly r21 = 0, public readonly r22 = 1,
  ) {}
  static readonly identity = new CFrame()
  static fromPosition(p: Vector3) { return new CFrame(p.x, p.y, p.z) }
  get position() { return new Vector3(this.x, this.y, this.z) }
  components(): number[] {
    return [this.x, this.y, this.z, this.r00, this.r01, this.r02, this.r10, this.r11, this.r12, this.r20, this.r21, this.r22]
  }
  static fromComponents(c: number[]) {
    return new CFrame(c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7], c[8], c[9], c[10], c[11])
  }
  get rightVector() { return new Vector3(this.r00, this.r10, this.r20) }
  get upVector() { return new Vector3(this.r01, this.r11, this.r21) }
  get lookVector() { return new Vector3(-this.r02, -this.r12, -this.r22) }
  mul(o: CFrame): CFrame {
    const a = this
    return new CFrame(
      a.r00 * o.x + a.r01 * o.y + a.r02 * o.z + a.x,
      a.r10 * o.x + a.r11 * o.y + a.r12 * o.z + a.y,
      a.r20 * o.x + a.r21 * o.y + a.r22 * o.z + a.z,
      a.r00 * o.r00 + a.r01 * o.r10 + a.r02 * o.r20, a.r00 * o.r01 + a.r01 * o.r11 + a.r02 * o.r21, a.r00 * o.r02 + a.r01 * o.r12 + a.r02 * o.r22,
      a.r10 * o.r00 + a.r11 * o.r10 + a.r12 * o.r20, a.r10 * o.r01 + a.r11 * o.r11 + a.r12 * o.r21, a.r10 * o.r02 + a.r11 * o.r12 + a.r12 * o.r22,
      a.r20 * o.r00 + a.r21 * o.r10 + a.r22 * o.r20, a.r20 * o.r01 + a.r21 * o.r11 + a.r22 * o.r21, a.r20 * o.r02 + a.r21 * o.r12 + a.r22 * o.r22,
    )
  }
  pointToWorld(v: Vector3) {
    return new Vector3(
      this.r00 * v.x + this.r01 * v.y + this.r02 * v.z + this.x,
      this.r10 * v.x + this.r11 * v.y + this.r12 * v.z + this.y,
      this.r20 * v.x + this.r21 * v.y + this.r22 * v.z + this.z,
    )
  }
  vectorToWorld(v: Vector3) {
    return new Vector3(
      this.r00 * v.x + this.r01 * v.y + this.r02 * v.z,
      this.r10 * v.x + this.r11 * v.y + this.r12 * v.z,
      this.r20 * v.x + this.r21 * v.y + this.r22 * v.z,
    )
  }
  inverse(): CFrame {
    // transpose rotation, -R^T p
    const { x, y, z } = this
    return new CFrame(
      -(this.r00 * x + this.r10 * y + this.r20 * z),
      -(this.r01 * x + this.r11 * y + this.r21 * z),
      -(this.r02 * x + this.r12 * y + this.r22 * z),
      this.r00, this.r10, this.r20,
      this.r01, this.r11, this.r21,
      this.r02, this.r12, this.r22,
    )
  }
  rotationOnly() {
    return new CFrame(0, 0, 0, this.r00, this.r01, this.r02, this.r10, this.r11, this.r12, this.r20, this.r21, this.r22)
  }
  withPosition(p: Vector3) {
    return new CFrame(p.x, p.y, p.z, this.r00, this.r01, this.r02, this.r10, this.r11, this.r12, this.r20, this.r21, this.r22)
  }
  toMatrix4(target = new THREE.Matrix4()) {
    return target.set(
      this.r00, this.r01, this.r02, this.x,
      this.r10, this.r11, this.r12, this.y,
      this.r20, this.r21, this.r22, this.z,
      0, 0, 0, 1,
    )
  }
  toQuaternion() {
    return new THREE.Quaternion().setFromRotationMatrix(this.toMatrix4())
  }
  static fromMatrix4(m: THREE.Matrix4) {
    const e = m.elements // column major
    return new CFrame(e[12], e[13], e[14], e[0], e[4], e[8], e[1], e[5], e[9], e[2], e[6], e[10])
  }
  static fromPositionQuaternion(p: { x: number; y: number; z: number }, q: { x: number; y: number; z: number; w: number }) {
    const m = new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w))
    m.setPosition(p.x, p.y, p.z)
    return CFrame.fromMatrix4(m)
  }
  /** Roblox Orientation: degrees, applied in Y, X, Z order. */
  static fromOrientation(p: Vector3, deg: Vector3) {
    const d = Math.PI / 180
    const e = new THREE.Euler(deg.x * d, deg.y * d, deg.z * d, 'YXZ')
    const m = new THREE.Matrix4().makeRotationFromEuler(e)
    m.setPosition(p.x, p.y, p.z)
    return CFrame.fromMatrix4(m)
  }
  toOrientation(): Vector3 {
    const e = new THREE.Euler().setFromRotationMatrix(this.toMatrix4(), 'YXZ')
    const d = 180 / Math.PI
    return new Vector3(round(e.x * d), round(e.y * d), round(e.z * d))
  }
  static lookAt(at: Vector3, target: Vector3) {
    const m = new THREE.Matrix4().lookAt(at.toThree(), target.toThree(), new THREE.Vector3(0, 1, 0))
    m.setPosition(at.x, at.y, at.z)
    return CFrame.fromMatrix4(m)
  }
  toString() { return this.components().map(fmt).join(', ') }
}

export class Color3 {
  constructor(public readonly r = 0, public readonly g = 0, public readonly b = 0) {}
  static fromRGB(r: number, g: number, b: number) { return new Color3(r / 255, g / 255, b / 255) }
  static fromHex(hex: string) {
    const h = hex.replace('#', '')
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16)
    return Color3.fromRGB((n >> 16) & 255, (n >> 8) & 255, n & 255)
  }
  toHex() {
    const c = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')
    return `#${c(this.r)}${c(this.g)}${c(this.b)}`
  }
  toThree() { return new THREE.Color(this.r, this.g, this.b) }
  toString() { return `${Math.round(this.r * 255)}, ${Math.round(this.g * 255)}, ${Math.round(this.b * 255)}` }
}

export class Vector2 {
  constructor(public readonly x = 0, public readonly y = 0) {}
  static readonly zero = new Vector2(0, 0)
  toString() { return `${fmt(this.x)}, ${fmt(this.y)}` }
}

export class UDim {
  constructor(public readonly scale = 0, public readonly offset = 0) {}
  toString() { return `${fmt(this.scale)}, ${fmt(this.offset)}` }
}

export class UDim2 {
  constructor(
    public readonly xs = 0, public readonly xo = 0,
    public readonly ys = 0, public readonly yo = 0,
  ) {}
  toString() { return `{${fmt(this.xs)}, ${fmt(this.xo)}}, {${fmt(this.ys)}, ${fmt(this.yo)}}` }
}

export class EnumItem {
  constructor(public readonly enumType: string, public readonly name: string, public readonly value: number) {}
  toString() { return `Enum.${this.enumType}.${this.name}` }
}

export const Enums: Record<string, string[]> = {
  Material: ['Plastic', 'SmoothPlastic', 'Neon', 'Wood', 'Metal', 'Glass', 'Grass', 'Concrete', 'Brick', 'Sand', 'Ice', 'Slate', 'Marble', 'Fabric'],
  PartType: ['Ball', 'Block', 'Cylinder', 'Wedge'],
  KeyCode: [
    'Unknown', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z',
    'Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
    'Space', 'Return', 'Escape', 'Tab', 'Backspace', 'LeftShift', 'RightShift', 'LeftControl', 'RightControl', 'LeftAlt', 'RightAlt',
    'Up', 'Down', 'Left', 'Right', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  ],
  UserInputType: ['MouseButton1', 'MouseButton2', 'MouseButton3', 'MouseWheel', 'MouseMovement', 'Keyboard', 'Touch', 'None'],
  UserInputState: ['Begin', 'Change', 'End', 'Cancel', 'None'],
  EasingStyle: ['Linear', 'Sine', 'Quad', 'Cubic', 'Quart', 'Quint', 'Exponential', 'Back', 'Bounce', 'Elastic', 'Circular'],
  EasingDirection: ['In', 'Out', 'InOut'],
  HumanoidStateType: ['Running', 'Jumping', 'Freefall', 'Landed', 'Dead', 'None'],
  TextXAlignment: ['Left', 'Center', 'Right'],
  TextYAlignment: ['Top', 'Center', 'Bottom'],
  Font: ['SourceSans', 'SourceSansBold', 'Gotham', 'GothamBold', 'Arial', 'ArialBold', 'Code', 'Cartoon'],
  CameraType: ['Custom', 'Scriptable', 'Fixed'],
  FillDirection: ['Horizontal', 'Vertical'],
  CollisionFidelity: ['Box', 'Hull'],
  RaycastFilterType: ['Exclude', 'Include', 'Blacklist', 'Whitelist'],
  NormalId: ['Top', 'Bottom', 'Front', 'Back', 'Left', 'Right'],
}

const enumCache = new Map<string, EnumItem>()
export function enumItem(enumType: string, name: string): EnumItem {
  const key = enumType + '.' + name
  let item = enumCache.get(key)
  if (!item) {
    const list = Enums[enumType]
    if (!list) throw new Error(`Unknown enum type ${enumType}`)
    const idx = list.indexOf(name)
    if (idx < 0) throw new Error(`${name} is not a valid member of Enum.${enumType}`)
    item = new EnumItem(enumType, name, idx)
    enumCache.set(key, item)
  }
  return item
}

function round(v: number) { return Math.round(v * 1000) / 1000 }
function fmt(v: number) { return String(round(v)) }
