// Generates a Luau definition file (like Roblox's globalTypes.d.luau) from the engine's reflection data,
// so the type checker and autocomplete know about every class, property, event, enum and datatype.
import { Enums } from '../../engine/datatypes'
import { ClassInfo, PropType, allClasses } from '../../engine/instance'

/** Typed signatures for methods (fallback is `(self, ...: any) -> ...any`). */
const SIGS: Record<string, string> = {
  'Instance.Destroy': '(self): ()',
  'Instance.Remove': '(self): ()',
  'Instance.Clone': '(self): Instance',
  'Instance.FindFirstChild': '(self, name: string, recursive: boolean?): Instance?',
  'Instance.FindFirstChildOfClass': '(self, className: string): Instance?',
  'Instance.FindFirstChildWhichIsA': '(self, className: string, recursive: boolean?): Instance?',
  'Instance.FindFirstDescendant': '(self, name: string): Instance?',
  'Instance.FindFirstAncestor': '(self, name: string): Instance?',
  'Instance.FindFirstAncestorOfClass': '(self, className: string): Instance?',
  'Instance.FindFirstAncestorWhichIsA': '(self, className: string): Instance?',
  'Instance.WaitForChild': '(self, name: string, timeout: number?): Instance',
  'Instance.GetChildren': '(self): { Instance }',
  'Instance.GetDescendants': '(self): { Instance }',
  'Instance.IsA': '(self, className: string): boolean',
  'Instance.IsDescendantOf': '(self, ancestor: Instance): boolean',
  'Instance.IsAncestorOf': '(self, descendant: Instance): boolean',
  'Instance.ClearAllChildren': '(self): ()',
  'Instance.GetFullName': '(self): string',
  'Instance.GetAttribute': '(self, attribute: string): any',
  'Instance.SetAttribute': '(self, attribute: string, value: any): ()',
  'Instance.GetAttributes': '(self): { [string]: any }',
  'Instance.GetPropertyChangedSignal': '(self, property: string): RBXScriptSignal',
  'Instance.GetAttributeChangedSignal': '(self, attribute: string): RBXScriptSignal',
  'Instance.GetTags': '(self): { string }',
  'Instance.HasTag': '(self, tag: string): boolean',
  'Instance.AddTag': '(self, tag: string): ()',
  'Instance.RemoveTag': '(self, tag: string): ()',
  'Model.GetPivot': '(self): CFrame',
  'Model.PivotTo': '(self, targetCFrame: CFrame): ()',
  'Model.SetPrimaryPartCFrame': '(self, cframe: CFrame): ()',
  'Model.GetPrimaryPartCFrame': '(self): CFrame',
  'Model.MoveTo': '(self, position: Vector3): ()',
  'Model.GetBoundingBox': '(self): (CFrame, Vector3)',
  'Model.GetExtentsSize': '(self): Vector3',
  'BasePart.GetMass': '(self): number',
  'BasePart.ApplyImpulse': '(self, impulse: Vector3): ()',
  'BasePart.GetPivot': '(self): CFrame',
  'BasePart.PivotTo': '(self, targetCFrame: CFrame): ()',
  'Workspace.Raycast': '(self, origin: Vector3, direction: Vector3, params: RaycastParams?): RaycastResult?',
  'Workspace.GetServerTimeNow': '(self): number',
  'Camera.WorldToScreenPoint': '(self, worldPoint: Vector3): (Vector3, boolean)',
  'Camera.WorldToViewportPoint': '(self, worldPoint: Vector3): (Vector3, boolean)',
  'Camera.ScreenPointToRay': '(self, x: number, y: number): Ray',
  'Camera.ViewportPointToRay': '(self, x: number, y: number): Ray',
  'Players.GetPlayers': '(self): { Player }',
  'Players.GetPlayerFromCharacter': '(self, character: Instance?): Player?',
  'Players.GetPlayerByUserId': '(self, userId: number): Player?',
  'Player.LoadCharacter': '(self): ()',
  'Player.Kick': '(self, message: string?): ()',
  'Player.GetMouse': '(self): Mouse',
  'Humanoid.TakeDamage': '(self, amount: number): ()',
  'Humanoid.Move': '(self, moveDirection: Vector3, relativeToCamera: boolean?): ()',
  'Humanoid.MoveTo': '(self, location: Vector3, part: BasePart?): ()',
  'Humanoid.GetState': '(self): EnumItem',
  'Lighting.GetMinutesAfterMidnight': '(self): number',
  'Lighting.SetMinutesAfterMidnight': '(self, minutes: number): ()',
  'RunService.IsClient': '(self): boolean',
  'RunService.IsServer': '(self): boolean',
  'RunService.IsStudio': '(self): boolean',
  'RunService.IsRunning': '(self): boolean',
  'RunService.BindToRenderStep': '(self, name: string, priority: number, fn: (deltaTime: number) -> ()): ()',
  'RunService.UnbindFromRenderStep': '(self, name: string): ()',
  'UserInputService.IsKeyDown': '(self, keyCode: EnumKeyCode): boolean',
  'UserInputService.IsMouseButtonPressed': '(self, mouseButton: EnumUserInputType): boolean',
  'UserInputService.GetMouseLocation': '(self): Vector2',
  'ContextActionService.BindAction': '(self, actionName: string, fn: (actionName: string, state: EnumUserInputState, input: InputObject) -> any, createTouchButton: boolean, ...: EnumKeyCode): ()',
  'ContextActionService.UnbindAction': '(self, actionName: string): ()',
  'TweenService.Create': '(self, instance: Instance, tweenInfo: TweenInfo, propertyTable: { [string]: any }): Tween',
  'Tween.Play': '(self): ()',
  'Tween.Pause': '(self): ()',
  'Tween.Cancel': '(self): ()',
  'Debris.AddItem': '(self, item: Instance, lifetime: number?): ()',
  'HttpService.GenerateGUID': '(self, wrapInCurlyBraces: boolean?): string',
  'HttpService.JSONEncode': '(self, input: any): string',
  'HttpService.JSONDecode': '(self, input: string): any',
  'CollectionService.AddTag': '(self, instance: Instance, tag: string): ()',
  'CollectionService.RemoveTag': '(self, instance: Instance, tag: string): ()',
  'CollectionService.HasTag': '(self, instance: Instance, tag: string): boolean',
  'CollectionService.GetTags': '(self, instance: Instance): { string }',
  'CollectionService.GetTagged': '(self, tag: string): { Instance }',
  'Sound.Play': '(self): ()',
  'Sound.Stop': '(self): ()',
  'Sound.Pause': '(self): ()',
  'Sound.Resume': '(self): ()',
  'BindableEvent.Fire': '(self, ...: any): ()',
  'BindableFunction.Invoke': '(self, ...: any): ...any',
  'RemoteEvent.FireServer': '(self, ...: any): ()',
  'RemoteEvent.FireClient': '(self, player: Player, ...: any): ()',
  'RemoteEvent.FireAllClients': '(self, ...: any): ()',
  'RemoteFunction.InvokeServer': '(self, ...: any): ...any',
  'RemoteFunction.InvokeClient': '(self, player: Player, ...: any): ...any',
  'DataModel.IsLoaded': '(self): boolean',
}

/** Methods implemented on the Luau side (not in the TS reflection data). */
const LUA_METHODS: Record<string, string[]> = {
  Instance: ['WaitForChild', 'GetPropertyChangedSignal', 'GetAttributeChangedSignal'],
  BindableEvent: ['Fire'],
  BindableFunction: ['Invoke'],
  RemoteEvent: ['FireServer', 'FireClient', 'FireAllClients'],
  UnreliableRemoteEvent: ['FireServer', 'FireClient', 'FireAllClients'],
  RemoteFunction: ['InvokeServer', 'InvokeClient'],
  RunService: ['BindToRenderStep', 'UnbindFromRenderStep'],
  ContextActionService: ['BindAction', 'UnbindAction'],
}
const LUA_PROPS: Record<string, string[]> = {
  BindableFunction: ['OnInvoke: ((...any) -> ...any)?'],
  RemoteFunction: ['OnServerInvoke: ((player: Player, ...any) -> ...any)?', 'OnClientInvoke: ((...any) -> ...any)?'],
}

/** More precise types for some properties and well-known children. */
const PROP_OVERRIDES: Record<string, string> = {
  'Players.LocalPlayer': 'Player',
  'Player.Character': 'Model?',
  'Player.PlayerGui': 'PlayerGui',
  'Player.Backpack': 'Backpack',
  'Player.PlayerScripts': 'PlayerScripts',
  'Workspace.CurrentCamera': 'Camera',
  'Model.PrimaryPart': 'BasePart?',
  'Humanoid.RootPart': 'BasePart?',
  'Mouse.Target': 'BasePart?',
  'Camera.CameraSubject': 'Instance?',
  'DataModel.Workspace': 'Workspace',
  'DataModel.Players': 'Players',
  'DataModel.Lighting': 'Lighting',
  'DataModel.ReplicatedStorage': 'ReplicatedStorage',
  'DataModel.ServerScriptService': 'ServerScriptService',
  'DataModel.ServerStorage': 'ServerStorage',
  'DataModel.StarterGui': 'StarterGui',
  'DataModel.StarterPlayer': 'StarterPlayer',
  'Instance.Parent': 'Instance?',
}

function luauType(t: PropType): string {
  switch (t) {
    case 'string': return 'string'
    case 'number': case 'int': return 'number'
    case 'bool': return 'boolean'
    case 'Instance': return 'Instance?'
    case 'Vector3': case 'Vector2': case 'CFrame': case 'Color3': case 'UDim': case 'UDim2': return t
  }
  if (t.startsWith('Enum.')) return 'Enum' + t.slice(5)
  return 'any'
}

const BASE_TYPES = `
declare extern type RBXScriptConnection with
    Connected: boolean
    function Disconnect(self): ()
end

declare extern type RBXScriptSignal with
    function Connect(self, callback: (...any) -> ()): RBXScriptConnection
    function Once(self, callback: (...any) -> ()): RBXScriptConnection
    function ConnectParallel(self, callback: (...any) -> ()): RBXScriptConnection
    function Wait(self): ...any
end

declare extern type EnumItem with
    Name: string
    Value: number
    EnumType: Enum
    function IsA(self, enumName: string): boolean
end

declare extern type Enum with
    function GetEnumItems(self): { EnumItem }
end
`

const DATATYPES = `
declare extern type Vector3 with
    X: number
    Y: number
    Z: number
    x: number
    y: number
    z: number
    Magnitude: number
    Unit: Vector3
    function Dot(self, other: Vector3): number
    function Cross(self, other: Vector3): Vector3
    function Lerp(self, goal: Vector3, alpha: number): Vector3
    function Abs(self): Vector3
    function Floor(self): Vector3
    function Ceil(self): Vector3
    function Sign(self): Vector3
    function Min(self, ...: Vector3): Vector3
    function Max(self, ...: Vector3): Vector3
    function Angle(self, other: Vector3, axis: Vector3?): number
    function FuzzyEq(self, other: Vector3, epsilon: number?): boolean
    function __add(self, other: Vector3): Vector3
    function __sub(self, other: Vector3): Vector3
    function __mul(self, other: Vector3 | number): Vector3
    function __div(self, other: Vector3 | number): Vector3
    function __idiv(self, other: Vector3 | number): Vector3
    function __unm(self): Vector3
end

declare extern type Vector2 with
    X: number
    Y: number
    Magnitude: number
    Unit: Vector2
    function Dot(self, other: Vector2): number
    function Cross(self, other: Vector2): number
    function Lerp(self, goal: Vector2, alpha: number): Vector2
    function __add(self, other: Vector2): Vector2
    function __sub(self, other: Vector2): Vector2
    function __mul(self, other: Vector2 | number): Vector2
    function __div(self, other: Vector2 | number): Vector2
    function __unm(self): Vector2
end

declare extern type CFrame with
    Position: Vector3
    p: Vector3
    X: number
    Y: number
    Z: number
    LookVector: Vector3
    RightVector: Vector3
    UpVector: Vector3
    XVector: Vector3
    YVector: Vector3
    ZVector: Vector3
    Rotation: CFrame
    function Inverse(self): CFrame
    function Lerp(self, goal: CFrame, alpha: number): CFrame
    function Orthonormalize(self): CFrame
    function ToWorldSpace(self, cf: CFrame): CFrame
    function ToObjectSpace(self, cf: CFrame): CFrame
    function PointToWorldSpace(self, v: Vector3): Vector3
    function PointToObjectSpace(self, v: Vector3): Vector3
    function VectorToWorldSpace(self, v: Vector3): Vector3
    function VectorToObjectSpace(self, v: Vector3): Vector3
    function GetComponents(self): (number, number, number, number, number, number, number, number, number, number, number, number)
    function ToEulerAnglesXYZ(self): (number, number, number)
    function ToEulerAnglesYXZ(self): (number, number, number)
    function ToOrientation(self): (number, number, number)
    function ToAxisAngle(self): (Vector3, number)
    function FuzzyEq(self, other: CFrame, epsilon: number?): boolean
    function __mul(self, other: CFrame): CFrame
    function __mul(self, other: Vector3): Vector3
    function __add(self, other: Vector3): CFrame
    function __sub(self, other: Vector3): CFrame
end

declare extern type Color3 with
    R: number
    G: number
    B: number
    function Lerp(self, goal: Color3, alpha: number): Color3
    function ToHSV(self): (number, number, number)
    function ToHex(self): string
end

declare extern type BrickColor with
    Name: string
    Color: Color3
end

declare extern type UDim with
    Scale: number
    Offset: number
    function __add(self, other: UDim): UDim
    function __sub(self, other: UDim): UDim
end

declare extern type UDim2 with
    X: UDim
    Y: UDim
    Width: UDim
    Height: UDim
    function Lerp(self, goal: UDim2, alpha: number): UDim2
    function __add(self, other: UDim2): UDim2
    function __sub(self, other: UDim2): UDim2
end

declare extern type TweenInfo with
    Time: number
    EasingStyle: EnumEasingStyle
    EasingDirection: EnumEasingDirection
    RepeatCount: number
    Reverses: boolean
    DelayTime: number
end

declare extern type Ray with
    Origin: Vector3
    Direction: Vector3
    Unit: Ray
    function ClosestPoint(self, point: Vector3): Vector3
    function Distance(self, point: Vector3): number
end

declare extern type RaycastParams with
    FilterDescendantsInstances: { Instance }
    FilterType: EnumRaycastFilterType
    IgnoreWater: boolean
    CollisionGroup: string
    RespectCanCollide: boolean
end

declare extern type RaycastResult with
    Instance: BasePart
    Position: Vector3
    Normal: Vector3
    Distance: number
    Material: EnumMaterial
end

declare extern type Random with
    function NextNumber(self, min: number?, max: number?): number
    function NextInteger(self, min: number, max: number): number
    function NextUnitVector(self): Vector3
    function Clone(self): Random
end

declare Vector3: {
    new: (x: number?, y: number?, z: number?) -> Vector3,
    zero: Vector3, one: Vector3, xAxis: Vector3, yAxis: Vector3, zAxis: Vector3,
}
declare Vector2: { new: (x: number?, y: number?) -> Vector2, zero: Vector2, one: Vector2, xAxis: Vector2, yAxis: Vector2 }
declare CFrame: {
    new: ((x: number?, y: number?, z: number?) -> CFrame)
        & ((pos: Vector3) -> CFrame)
        & ((pos: Vector3, lookAt: Vector3) -> CFrame)
        & ((x: number, y: number, z: number, qX: number, qY: number, qZ: number, qW: number) -> CFrame)
        & ((x: number, y: number, z: number, R00: number, R01: number, R02: number, R10: number, R11: number, R12: number, R20: number, R21: number, R22: number) -> CFrame),
    lookAt: (at: Vector3, lookAt: Vector3, up: Vector3?) -> CFrame,
    Angles: (rx: number, ry: number, rz: number) -> CFrame,
    fromEulerAnglesXYZ: (rx: number, ry: number, rz: number) -> CFrame,
    fromEulerAnglesYXZ: (rx: number, ry: number, rz: number) -> CFrame,
    fromOrientation: (rx: number, ry: number, rz: number) -> CFrame,
    fromAxisAngle: (axis: Vector3, angle: number) -> CFrame,
    fromMatrix: (pos: Vector3, vX: Vector3, vY: Vector3, vZ: Vector3?) -> CFrame,
    identity: CFrame,
}
declare Color3: {
    new: (r: number?, g: number?, b: number?) -> Color3,
    fromRGB: (r: number?, g: number?, b: number?) -> Color3,
    fromHSV: (h: number, s: number, v: number) -> Color3,
    fromHex: (hex: string) -> Color3,
    toHSV: (color: Color3) -> (number, number, number),
}
declare BrickColor: {
    new: (name: string) -> BrickColor, random: () -> BrickColor, White: () -> BrickColor, Black: () -> BrickColor,
    Red: () -> BrickColor, Blue: () -> BrickColor, Green: () -> BrickColor, Yellow: () -> BrickColor, Gray: () -> BrickColor,
}
declare UDim: { new: (scale: number?, offset: number?) -> UDim }
declare UDim2: {
    new: ((xScale: number?, xOffset: number?, yScale: number?, yOffset: number?) -> UDim2) & ((x: UDim, y: UDim) -> UDim2),
    fromScale: (x: number?, y: number?) -> UDim2,
    fromOffset: (x: number?, y: number?) -> UDim2,
}
declare TweenInfo: {
    new: (time: number?, easingStyle: EnumEasingStyle?, easingDirection: EnumEasingDirection?, repeatCount: number?, reverses: boolean?, delayTime: number?) -> TweenInfo,
}
declare Ray: { new: (origin: Vector3, direction: Vector3) -> Ray }
declare RaycastParams: { new: () -> RaycastParams }
declare Random: { new: (seed: number?) -> Random }

declare task: {
    wait: (duration: number?) -> number,
    spawn: <A...>(f: ((A...) -> ...any) | thread, A...) -> thread,
    defer: <A...>(f: ((A...) -> ...any) | thread, A...) -> thread,
    delay: <A...>(duration: number?, f: ((A...) -> ...any) | thread, A...) -> thread,
    cancel: (thread: thread) -> (),
    synchronize: () -> (),
    desynchronize: () -> (),
}
declare function wait(seconds: number?): (number, number)
declare function delay(delayTime: number?, callback: () -> ()): ()
declare function spawn(callback: () -> ()): ()
declare function tick(): number
declare function time(): number
declare function elapsedTime(): number
declare function warn(...: any): ()
declare function version(): string
declare shared: { [any]: any }
`

export function generateDefinitions(): string {
  const out: string[] = [BASE_TYPES]
  // enums
  for (const [name, items] of Object.entries(Enums)) {
    out.push(`declare extern type Enum${name} extends EnumItem with end`)
    out.push(`declare extern type Enum${name}_INTERNAL extends Enum with`)
    for (const it of items) out.push(`    ${it}: Enum${name}`)
    out.push('end')
  }
  out.push('type ENUM_LIST = {')
  for (const name of Object.keys(Enums)) out.push(`    ${name}: Enum${name}_INTERNAL,`)
  out.push('}')
  out.push('declare Enum: ENUM_LIST')
  out.push(DATATYPES)

  // classes, parents first
  const classes = allClasses()
  const emitted = new Set<string>()
  const emit = (c: ClassInfo) => {
    if (emitted.has(c.name)) return
    if (c.superclass) emit(c.superclass)
    emitted.add(c.name)
    out.push(`declare extern type ${c.name}${c.superclass ? ' extends ' + c.superclass.name : ''} with`)
    const members = new Map<string, string>()
    for (const [name, def] of Object.entries(c.ownProps)) members.set(name, luauType(def.type))
    for (const p of LUA_PROPS[c.name] ?? []) { const i = p.indexOf(':'); members.set(p.slice(0, i), p.slice(i + 1).trim()) }
    for (const e of c.ownEvents) members.set(e, 'RBXScriptSignal')
    for (const [k, v] of Object.entries(PROP_OVERRIDES)) {
      const [cls, name] = k.split('.')
      if (cls === c.name) members.set(name, v)
    }
    for (const [name, type] of members) out.push(`    ${name}: ${type}`)
    const methods = new Set([...Object.keys(c.ownMethods), ...(LUA_METHODS[c.name] ?? [])])
    for (const m of methods) {
      if (c.name === 'DataModel' && (m === 'GetService' || m === 'FindService')) continue
      out.push(`    function ${m}${SIGS[`${c.name}.${m}`] ?? '(self, ...: any): ...any'}`)
    }
    if (c.name === 'DataModel') {
      for (const s of classes.filter((x) => x.service)) {
        out.push(`    function GetService(self, service: "${s.name}"): ${s.name}`)
        out.push(`    function FindService(self, service: "${s.name}"): ${s.name}?`)
      }
      out.push('    function GetService(self, service: string): Instance')
    }
    out.push('end')
  }
  for (const c of classes) emit(c)

  // Note: an intersection of singleton-string overloads is "too complex" for the checker, so Instance.new returns any.
  out.push('declare Instance: { new: (className: string, parent: Instance?) -> any }')
  out.push('declare game: DataModel')
  out.push('declare Game: DataModel')
  out.push('declare workspace: Workspace')
  out.push('declare Workspace: Workspace')
  out.push('declare script: LuaSourceContainer')
  return out.join('\n')
}

/** Names of Instance classes; used to suppress "unknown member" errors (children are accessed by name). */
export function instanceClassNames(): Set<string> {
  return new Set(allClasses().map((c) => c.name))
}
