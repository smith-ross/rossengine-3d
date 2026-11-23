// Engine value types. The same objects are exposed to TypeScript and Python scripts, so besides
// the engine's own lowercase members they carry the Roblox-style API (X, Magnitude, Vector3.new,
// CFrame.Angles, ...). JS and Python have no operator overloading, so arithmetic is .add/.sub/.mul/.div.
// The Luau side has its own pure-Luau implementations (see luau/prelude.luau).
import * as THREE from 'three'

export class Vector3 {
  constructor(public readonly x = 0, public readonly y = 0, public readonly z = 0) {}
  static readonly zero = new Vector3(0, 0, 0)
  static readonly one = new Vector3(1, 1, 1)
  add(o: Vector3) { return new Vector3(this.x + o.x, this.y + o.y, this.z + o.z) }
  sub(o: Vector3) { return new Vector3(this.x - o.x, this.y - o.y, this.z - o.z) }
  mul(s: number | Vector3) {
    return typeof s === 'number' ? new Vector3(this.x * s, this.y * s, this.z * s) : new Vector3(this.x * s.x, this.y * s.y, this.z * s.z)
  }
  div(s: number | Vector3) {
    return typeof s === 'number' ? new Vector3(this.x / s, this.y / s, this.z / s) : new Vector3(this.x / s.x, this.y / s.y, this.z / s.z)
  }
  get magnitude() { return Math.hypot(this.x, this.y, this.z) }
  // Roblox API
  static new(x = 0, y = 0, z = 0) { return new Vector3(x, y, z) }
  static readonly xAxis = new Vector3(1, 0, 0)
  static readonly yAxis = new Vector3(0, 1, 0)
  static readonly zAxis = new Vector3(0, 0, 1)
  get X() { return this.x }
  get Y() { return this.y }
  get Z() { return this.z }
  get Magnitude() { return this.magnitude }
  get Unit(): Vector3 { return this.magnitude === 0 ? this : this.unit }
  Dot(o: Vector3) { return this.dot(o) }
  Cross(o: Vector3) { return this.cross(o) }
  Lerp(o: Vector3, t: number) { return this.add(o.sub(this).mul(t)) }
  FuzzyEq(o: Vector3, eps = 1e-5) { return this.sub(o).magnitude <= eps }
  Abs() { return new Vector3(Math.abs(this.x), Math.abs(this.y), Math.abs(this.z)) }
  Floor() { return new Vector3(Math.floor(this.x), Math.floor(this.y), Math.floor(this.z)) }
  Ceil() { return new Vector3(Math.ceil(this.x), Math.ceil(this.y), Math.ceil(this.z)) }
  unm() { return new Vector3(-this.x, -this.y, -this.z) }
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
  // Roblox API ---------------------------------------------------------------
  /** CFrame.new(), (x,y,z), (pos), (pos, lookAt), (x,y,z,qx,qy,qz,qw) or 12 components */
  static new(...a: any[]): CFrame {
    if (a.length === 0) return CFrame.identity
    if (a[0] instanceof Vector3) return a[1] instanceof Vector3 ? CFrame.lookAt(a[0], a[1]) : CFrame.fromPosition(a[0])
    if (a.length === 7) return CFrame.fromPositionQuaternion({ x: a[0], y: a[1], z: a[2] }, { x: a[3], y: a[4], z: a[5], w: a[6] })
    if (a.length === 12) return CFrame.fromComponents(a)
    return new CFrame(a[0] ?? 0, a[1] ?? 0, a[2] ?? 0)
  }
  static Angles(rx = 0, ry = 0, rz = 0) { return CFrame.fromEuler(rx, ry, rz, 'XYZ') }
  static fromEulerAnglesXYZ(rx = 0, ry = 0, rz = 0) { return CFrame.fromEuler(rx, ry, rz, 'XYZ') }
  static fromEulerAnglesYXZ(rx = 0, ry = 0, rz = 0) { return CFrame.fromEuler(rx, ry, rz, 'YXZ') }
  static fromAxisAngle(axis: Vector3, angle: number) {
    const q = new THREE.Quaternion().setFromAxisAngle(axis.unit.toThree(), angle)
    return CFrame.fromPositionQuaternion({ x: 0, y: 0, z: 0 }, q)
  }
  private static fromEuler(rx: number, ry: number, rz: number, order: 'XYZ' | 'YXZ') {
    return CFrame.fromMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rx, ry, rz, order)))
  }
  get Position() { return this.position }
  get X() { return this.x }
  get Y() { return this.y }
  get Z() { return this.z }
  get LookVector() { return this.lookVector }
  get RightVector() { return this.rightVector }
  get UpVector() { return this.upVector }
  get Rotation() { return this.rotationOnly() }
  Inverse() { return this.inverse() }
  /** cf.mul(otherCFrame) -> CFrame, cf.mul(vector) -> Vector3 (like cf * x in Luau) */
  Mul(o: CFrame | Vector3): CFrame | Vector3 { return o instanceof Vector3 ? this.pointToWorld(o) : this.mul(o) }
  add(v: Vector3) { return this.withPosition(this.position.add(v)) }
  sub(v: Vector3) { return this.withPosition(this.position.sub(v)) }
  ToWorldSpace(o: CFrame) { return this.mul(o) }
  ToObjectSpace(o: CFrame) { return this.inverse().mul(o) }
  PointToWorldSpace(v: Vector3) { return this.pointToWorld(v) }
  PointToObjectSpace(v: Vector3) { return this.inverse().pointToWorld(v) }
  VectorToWorldSpace(v: Vector3) { return this.vectorToWorld(v) }
  VectorToObjectSpace(v: Vector3) { return this.inverse().vectorToWorld(v) }
  Lerp(o: CFrame, t: number) {
    const q = this.toQuaternion().slerp(o.toQuaternion(), t)
    const p = this.position.Lerp(o.position, t)
    return CFrame.fromPositionQuaternion(p, q)
  }
  GetComponents() { return this.components() }
  ToEulerAnglesXYZ() { const e = new THREE.Euler().setFromRotationMatrix(this.toMatrix4(), 'XYZ'); return [e.x, e.y, e.z] }
  ToEulerAnglesYXZ() { const e = new THREE.Euler().setFromRotationMatrix(this.toMatrix4(), 'YXZ'); return [e.x, e.y, e.z] }
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
  static new(r = 0, g = 0, b = 0) { return new Color3(r, g, b) }
  static fromHSV(h: number, s: number, v: number) {
    const i = Math.floor(h * 6), f = h * 6 - i, p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s)
    const [r, g, b] = [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][((i % 6) + 6) % 6]
    return new Color3(r, g, b)
  }
  get R() { return this.r }
  get G() { return this.g }
  get B() { return this.b }
  Lerp(o: Color3, t: number) { return new Color3(this.r + (o.r - this.r) * t, this.g + (o.g - this.g) * t, this.b + (o.b - this.b) * t) }
  ToHex() { return this.toHex().slice(1).toUpperCase() }
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
  static new(x = 0, y = 0) { return new Vector2(x, y) }
  get X() { return this.x }
  get Y() { return this.y }
  get Magnitude() { return Math.hypot(this.x, this.y) }
  add(o: Vector2) { return new Vector2(this.x + o.x, this.y + o.y) }
  sub(o: Vector2) { return new Vector2(this.x - o.x, this.y - o.y) }
  mul(s: number | Vector2) { return typeof s === 'number' ? new Vector2(this.x * s, this.y * s) : new Vector2(this.x * s.x, this.y * s.y) }
  toString() { return `${fmt(this.x)}, ${fmt(this.y)}` }
}

export class UDim {
  constructor(public readonly scale = 0, public readonly offset = 0) {}
  static new(scale = 0, offset = 0) { return new UDim(scale, offset) }
  get Scale() { return this.scale }
  get Offset() { return this.offset }
  toString() { return `${fmt(this.scale)}, ${fmt(this.offset)}` }
}

export class UDim2 {
  constructor(
    public readonly xs = 0, public readonly xo = 0,
    public readonly ys = 0, public readonly yo = 0,
  ) {}
  static new(xs = 0, xo = 0, ys = 0, yo = 0) { return new UDim2(xs, xo, ys, yo) }
  static fromScale(x = 0, y = 0) { return new UDim2(x, 0, y, 0) }
  static fromOffset(x = 0, y = 0) { return new UDim2(0, x, 0, y) }
  get X() { return new UDim(this.xs, this.xo) }
  get Y() { return new UDim(this.ys, this.yo) }
  add(o: UDim2) { return new UDim2(this.xs + o.xs, this.xo + o.xo, this.ys + o.ys, this.yo + o.yo) }
  Lerp(o: UDim2, t: number) { return new UDim2(this.xs + (o.xs - this.xs) * t, this.xo + (o.xo - this.xo) * t, this.ys + (o.ys - this.ys) * t, this.yo + (o.yo - this.yo) * t) }
  toString() { return `{${fmt(this.xs)}, ${fmt(this.xo)}}, {${fmt(this.ys)}, ${fmt(this.yo)}}` }
}

export class EnumItem {
  constructor(public readonly enumType: string, public readonly name: string, public readonly value: number) {}
  get Name() { return this.name }
  get Value() { return this.value }
  get EnumType() { return this.enumType }
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
  ScriptLanguage: ['Luau', 'TypeScript', 'Python'],
  CollisionFidelity: ['Box', 'Hull'],
  Shape2D: ['Rectangle', 'Circle'],
  TerrainMode: ['Block3x3', 'Block3x3Inner', 'Cardinal16'],
  RaycastFilterType: ['Exclude', 'Include', 'Blacklist', 'Whitelist'],
  NormalId: ['Top', 'Bottom', 'Front', 'Back', 'Left', 'Right'],
  ParticleShape: ['Volume', 'Surface', 'Point'],
  ParticleShape2D: ['Point', 'Rectangle', 'Circle'],
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
