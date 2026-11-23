// Generates the TypeScript declarations (globals.d.ts) for scripts from the engine's reflection data.
import { Enums } from '../../engine/datatypes'
import { ClassInfo, PropType, allClasses } from '../../engine/instance'

const METHOD_SIGS: Record<string, string> = {
  'Instance.Destroy': '(): void',
  'Instance.Clone': '(): this',
  'Instance.FindFirstChild': '(name: string, recursive?: boolean): Instance | undefined',
  'Instance.FindFirstChildOfClass': '<K extends keyof Instances>(className: K): Instances[K] | undefined',
  'Instance.FindFirstChildWhichIsA': '(className: string, recursive?: boolean): Instance | undefined',
  'Instance.FindFirstAncestor': '(name: string): Instance | undefined',
  'Instance.FindFirstAncestorOfClass': '<K extends keyof Instances>(className: K): Instances[K] | undefined',
  'Instance.FindFirstDescendant': '(name: string): Instance | undefined',
  'Instance.WaitForChild': '(name: string, timeout?: number): Promise<Instance>',
  'Instance.GetChildren': '(): Instance[]',
  'Instance.GetDescendants': '(): Instance[]',
  'Instance.IsA': '<K extends keyof Instances>(className: K): this is Instances[K]',
  'Instance.IsDescendantOf': '(ancestor: Instance): boolean',
  'Instance.IsAncestorOf': '(descendant: Instance): boolean',
  'Instance.ClearAllChildren': '(): void',
  'Instance.GetFullName': '(): string',
  'Instance.GetAttribute': '(name: string): any',
  'Instance.SetAttribute': '(name: string, value: any): void',
  'Instance.GetAttributes': '(): Record<string, any>',
  'Instance.GetPropertyChangedSignal': '(property: string): RBXScriptSignal<[]>',
  'Instance.GetAttributeChangedSignal': '(attribute: string): RBXScriptSignal<[]>',
  'Instance.GetTags': '(): string[]',
  'Instance.HasTag': '(tag: string): boolean',
  'Instance.AddTag': '(tag: string): void',
  'Instance.RemoveTag': '(tag: string): void',
  'DataModel.GetService': '<K extends keyof Services>(name: K): Services[K]',
  'DataModel.FindService': '<K extends keyof Services>(name: K): Services[K] | undefined',
  'Model.GetPivot': '(): CFrame',
  'Model.PivotTo': '(cframe: CFrame): void',
  'Model.MoveTo': '(position: Vector3): void',
  'Model.GetBoundingBox': '(): [CFrame, Vector3]',
  'Model.GetExtentsSize': '(): Vector3',
  'BasePart.GetMass': '(): number',
  'BasePart.ApplyImpulse': '(impulse: Vector3): void',
  'BasePart.GetPivot': '(): CFrame',
  'BasePart.PivotTo': '(cframe: CFrame): void',
  'Workspace.Raycast': '(origin: Vector3, direction: Vector3, params?: RaycastParams): RaycastResult | undefined',
  'Camera.WorldToScreenPoint': '(point: Vector3): [Vector3, boolean]',
  'Camera.ScreenPointToRay': '(x: number, y: number): { Origin: Vector3; Direction: Vector3 }',
  'Players.GetPlayers': '(): Player[]',
  'Players.GetPlayerFromCharacter': '(character: Instance | undefined): Player | undefined',
  'Player.LoadCharacter': '(): void',
  'Player.Kick': '(message?: string): void',
  'Player.GetMouse': '(): Mouse',
  'Humanoid.TakeDamage': '(amount: number): void',
  'Humanoid.Move': '(direction: Vector3, relativeToCamera?: boolean): void',
  'Humanoid.MoveTo': '(position: Vector3): void',
  'RunService.BindToRenderStep': '(name: string, priority: number, fn: (deltaTime: number) => void): void',
  'RunService.UnbindFromRenderStep': '(name: string): void',
  'UserInputService.IsKeyDown': '(key: EnumItem): boolean',
  'UserInputService.IsMouseButtonPressed': '(button: EnumItem): boolean',
  'UserInputService.GetMouseLocation': '(): Vector2',
  'TweenService.Create': '(instance: Instance, info: TweenInfo, goals: Record<string, any>): Tween',
  'Tween.Play': '(): void',
  'Tween.Pause': '(): void',
  'Tween.Cancel': '(): void',
  'Debris.AddItem': '(item: Instance, lifetime?: number): void',
  'HttpService.JSONEncode': '(value: any): string',
  'HttpService.JSONDecode': '(json: string): any',
  'HttpService.GenerateGUID': '(wrapInBraces?: boolean): string',
  'CollectionService.GetTagged': '(tag: string): Instance[]',
  'Sound.Play': '(): void',
  'Sound.Stop': '(): void',
  'Sound.Pause': '(): void',
  'Sound.Resume': '(): void',
  'BindableEvent.Fire': '(...args: any[]): void',
  'Instance.SetNetworkOwner': '(player: Player | undefined): void',
  'Instance.GetNetworkOwner': '(): Player | undefined',
  'Instance.SetNetworkOwnershipAuto': '(): void',
  'RemoteEvent.FireServer': '(...args: any[]): void',
  'RemoteEvent.FireClient': '(player: Player, ...args: any[]): void',
  'RemoteEvent.FireAllClients': '(...args: any[]): void',
  'RunService.IsServer': '(): boolean',
  'RunService.IsClient': '(): boolean',
  'NetworkService.IsHost': '(): boolean',
  'NetworkService.IsClient': '(): boolean',
  'NetworkService.IsMultiplayer': '(): boolean',
  'NetworkService.GetHostAddress': '(): string',
}

const JS_METHODS: Record<string, string[]> = {
  Instance: ['WaitForChild', 'GetPropertyChangedSignal', 'GetAttributeChangedSignal'],
  BindableFunction: ['Invoke'],
  RemoteFunction: ['InvokeServer', 'InvokeClient'],
  RunService: ['BindToRenderStep', 'UnbindFromRenderStep'],
}
const EXTRA_SIGS: Record<string, string> = {
  'BindableFunction.Invoke': '(...args: any[]): any',
  'RemoteFunction.InvokeServer': '(...args: any[]): Promise<any>',
  'RemoteFunction.InvokeClient': '(player: Player, ...args: any[]): Promise<any>',
}

const EVENT_ARGS: Record<string, string> = {
  Touched: '[hit: BasePart]', TouchEnded: '[hit: BasePart]', ChildAdded: '[child: Instance]', ChildRemoved: '[child: Instance]',
  DescendantAdded: '[descendant: Instance]', DescendantRemoving: '[descendant: Instance]', Changed: '[property: string]',
  AttributeChanged: '[attribute: string]', Destroying: '[]', Heartbeat: '[deltaTime: number]', RenderStepped: '[deltaTime: number]',
  Stepped: '[time: number, deltaTime: number]', PreSimulation: '[deltaTime: number]', PostSimulation: '[deltaTime: number]',
  PlayerAdded: '[player: Player]', PlayerRemoving: '[player: Player]', CharacterAdded: '[character: Model]',
  CharacterRemoving: '[character: Model]', Died: '[]', HealthChanged: '[health: number]', Jumping: '[active: boolean]',
  Running: '[speed: number]', MoveToFinished: '[reached: boolean]', InputBegan: '[input: InputObject, gameProcessed: boolean]',
  InputEnded: '[input: InputObject, gameProcessed: boolean]', InputChanged: '[input: InputObject, gameProcessed: boolean]',
  MouseClick: '[player: Player]', RightMouseClick: '[player: Player]', MouseHoverEnter: '[player: Player]',
  MouseHoverLeave: '[player: Player]', MouseButton1Click: '[]', Activated: '[]', FocusLost: '[enterPressed: boolean]',
  Completed: '[state: any]', Ended: '[soundId: string]',
}

const PROP_TYPES: Record<string, string> = {
  'Players.LocalPlayer': 'Player', 'Workspace.CurrentCamera': 'Camera', 'Mouse.Target': 'BasePart | undefined',
}

function tsType(t: PropType, name: string): string {
  switch (t) {
    case 'string': case 'Content': return 'string'
    case 'number': case 'int': return 'number'
    case 'bool': return 'boolean'
    case 'Instance':
      if (name === 'PrimaryPart' || name === 'Part0' || name === 'Part1') return 'BasePart | undefined'
      if (name === 'Character') return 'Model | undefined'
      return 'Instance | undefined'
    case 'Vector3': case 'Vector2': case 'CFrame': case 'Color3': case 'UDim': case 'UDim2': return t
  }
  return 'EnumItem'
}

const DATATYPES = `
interface RBXScriptConnection { readonly Connected: boolean; Disconnect(): void }
interface RBXScriptSignal<T extends any[] = any[]> {
  Connect(callback: (...args: T) => any): RBXScriptConnection
  Once(callback: (...args: T) => any): RBXScriptConnection
  /** Resolves with the first argument the event fires with. */
  Wait(): Promise<T[0]>
}
interface EnumItem { readonly Name: string; readonly Value: number; readonly EnumType: string }
declare class Vector3 {
  constructor(x?: number, y?: number, z?: number)
  static new(x?: number, y?: number, z?: number): Vector3
  static readonly zero: Vector3; static readonly one: Vector3
  static readonly xAxis: Vector3; static readonly yAxis: Vector3; static readonly zAxis: Vector3
  readonly X: number; readonly Y: number; readonly Z: number
  readonly Magnitude: number; readonly Unit: Vector3
  add(v: Vector3): Vector3; sub(v: Vector3): Vector3; mul(v: Vector3 | number): Vector3; div(v: Vector3 | number): Vector3
  unm(): Vector3
  Dot(v: Vector3): number; Cross(v: Vector3): Vector3; Lerp(goal: Vector3, alpha: number): Vector3
  FuzzyEq(v: Vector3, epsilon?: number): boolean; Abs(): Vector3; Floor(): Vector3; Ceil(): Vector3
}
declare class Vector2 {
  constructor(x?: number, y?: number)
  static new(x?: number, y?: number): Vector2
  readonly X: number; readonly Y: number; readonly Magnitude: number
  add(v: Vector2): Vector2; sub(v: Vector2): Vector2; mul(v: Vector2 | number): Vector2
}
declare class CFrame {
  static new(): CFrame
  static new(x: number, y: number, z: number): CFrame
  static new(position: Vector3, lookAt?: Vector3): CFrame
  static new(x: number, y: number, z: number, qx: number, qy: number, qz: number, qw: number): CFrame
  static readonly identity: CFrame
  static Angles(rx: number, ry: number, rz: number): CFrame
  static fromEulerAnglesXYZ(rx: number, ry: number, rz: number): CFrame
  static fromEulerAnglesYXZ(rx: number, ry: number, rz: number): CFrame
  static fromAxisAngle(axis: Vector3, angle: number): CFrame
  static lookAt(at: Vector3, target: Vector3): CFrame
  readonly Position: Vector3; readonly X: number; readonly Y: number; readonly Z: number
  readonly LookVector: Vector3; readonly RightVector: Vector3; readonly UpVector: Vector3; readonly Rotation: CFrame
  /** cf * other: CFrame composition */
  mul(other: CFrame): CFrame
  /** cf * other: CFrame composition, or transform a point */
  Mul(other: CFrame): CFrame
  Mul(point: Vector3): Vector3
  add(offset: Vector3): CFrame; sub(offset: Vector3): CFrame
  Inverse(): CFrame; Lerp(goal: CFrame, alpha: number): CFrame
  ToWorldSpace(cf: CFrame): CFrame; ToObjectSpace(cf: CFrame): CFrame
  PointToWorldSpace(v: Vector3): Vector3; PointToObjectSpace(v: Vector3): Vector3
  VectorToWorldSpace(v: Vector3): Vector3; VectorToObjectSpace(v: Vector3): Vector3
  GetComponents(): number[]; ToEulerAnglesXYZ(): [number, number, number]; ToEulerAnglesYXZ(): [number, number, number]
}
declare class Color3 {
  constructor(r?: number, g?: number, b?: number)
  static new(r?: number, g?: number, b?: number): Color3
  static fromRGB(r: number, g: number, b: number): Color3
  static fromHSV(h: number, s: number, v: number): Color3
  static fromHex(hex: string): Color3
  readonly R: number; readonly G: number; readonly B: number
  Lerp(goal: Color3, alpha: number): Color3; ToHex(): string
}
declare class UDim { static new(scale?: number, offset?: number): UDim; readonly Scale: number; readonly Offset: number }
declare class UDim2 {
  static new(xScale?: number, xOffset?: number, yScale?: number, yOffset?: number): UDim2
  static fromScale(x?: number, y?: number): UDim2
  static fromOffset(x?: number, y?: number): UDim2
  readonly X: UDim; readonly Y: UDim
  add(other: UDim2): UDim2; Lerp(goal: UDim2, alpha: number): UDim2
}
declare class TweenInfo {
  static new(time?: number, easingStyle?: EnumItem, easingDirection?: EnumItem, repeatCount?: number, reverses?: boolean, delayTime?: number): TweenInfo
  readonly Time: number; readonly RepeatCount: number; readonly Reverses: boolean; readonly DelayTime: number
}
declare class RaycastParams {
  static new(): RaycastParams
  FilterDescendantsInstances: Instance[]; FilterType: EnumItem; RespectCanCollide: boolean
}
interface RaycastResult { Instance: BasePart; Position: Vector3; Normal: Vector3; Distance: number; Material: EnumItem }
declare const task: {
  /** Yields for the given seconds (await it). Resolves with the time actually waited. */
  wait(seconds?: number): Promise<number>
  spawn<A extends any[]>(fn: (...args: A) => any, ...args: A): void
  defer<A extends any[]>(fn: (...args: A) => any, ...args: A): void
  delay<A extends any[]>(seconds: number, fn: (...args: A) => any, ...args: A): { cancelled: boolean }
  cancel(handle: { cancelled: boolean }): void
}
declare function wait(seconds?: number): Promise<number>
declare function print(...args: any[]): void
declare function warn(...args: any[]): void
declare function tick(): number
declare function time(): number
/** Load a ModuleScript (any language): require(script.Parent.Util) or require("Storage/Util") */
declare function require(module: Instance | string): any
declare const game: DataModel
declare const workspace: Workspace
declare const script: LuaSourceContainer
`

export function generateTsDefinitions(): string {
  const out: string[] = [DATATYPES]
  // enums
  out.push('declare const Enum: {')
  for (const [name, items] of Object.entries(Enums)) {
    out.push(`  ${name}: { ${items.map((i) => `readonly ${i}: EnumItem`).join('; ')}; GetEnumItems(): EnumItem[] }`)
  }
  out.push('}')
  const classes = allClasses()
  const emit = (c: ClassInfo) => {
    const ext = c.superclass ? ` extends ${c.superclass.name}` : ''
    out.push(`interface ${c.name}${ext} {`)
    if (c.name === 'Instance') {
      out.push('  /** children can be accessed by name */')
      out.push('  [child: string]: any')
      out.push('  Name: string')
      out.push('  Parent: Instance | undefined')
      out.push('  readonly ClassName: string')
    }
    for (const [name, def] of Object.entries(c.ownProps)) {
      if (def.hidden && name !== 'Source' || ['Name', 'Parent', 'ClassName'].includes(name)) continue
      const type = PROP_TYPES[`${c.name}.${name}`] ?? tsType(def.type, name)
      out.push(`  ${def.readonly ? 'readonly ' : ''}${name}: ${type}`)
    }
    for (const e of c.ownEvents) if (!e.startsWith('__')) out.push(`  readonly ${e}: RBXScriptSignal<${EVENT_ARGS[e] ?? 'any[]'}>`)
    const methods = new Set([...Object.keys(c.ownMethods).filter((m) => !m.startsWith('__')), ...(JS_METHODS[c.name] ?? [])])
    for (const m of methods) {
      const sig = METHOD_SIGS[`${c.name}.${m}`] ?? EXTRA_SIGS[`${c.name}.${m}`] ?? '(...args: any[]): any'
      out.push(`  ${m}${sig}`)
    }
    if (c.name === 'BindableFunction') out.push('  OnInvoke: ((...args: any[]) => any) | undefined')
    if (c.name === 'RemoteFunction') {
      out.push('  OnServerInvoke: ((player: Player, ...args: any[]) => any) | undefined')
      out.push('  OnClientInvoke: ((...args: any[]) => any) | undefined')
    }
    if (c.name === 'Player') out.push('  readonly PlayerGui: PlayerGui')
    out.push('}')
  }
  for (const c of classes) emit(c)
  out.push('interface Instances {')
  for (const c of classes) out.push(`  ${c.name}: ${c.name}`)
  out.push('}')
  out.push('interface Services {')
  for (const c of classes.filter((x) => x.service)) out.push(`  ${c.name}: ${c.name}`)
  out.push('}')
  out.push('interface CreatableInstances {')
  for (const c of classes.filter((x) => x.creatable && !x.service)) out.push(`  ${c.name}: ${c.name}`)
  out.push('}')
  out.push('declare const Instance: { "new"<K extends keyof CreatableInstances>(className: K, parent?: Instance): CreatableInstances[K] }')
  return out.join('\n')
}
