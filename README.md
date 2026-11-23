# RossEngine 3D

A Roblox-style 3D game engine that runs in the browser. Games are built in an in-browser editor and scripted in **Luau, TypeScript or Python 3**. Modules in any language can be imported from the others. Games can be exported as standalone desktop apps (Electron).

- **Engine:** TypeScript, with [three.js](https://threejs.org) for rendering and [Rapier](https://rapier.rs) for physics.
- **Scripting:** real Luau (compiled to WebAssembly through [`@luau-rs/luau`](https://github.com/luau-rs/luau)), TypeScript (transpiled with sucrase), and Python 3 ([Pyodide](https://pyodide.org)). All three use the same Roblox-like API.
- **Editor:** React UI with a Monaco script editor. Luau and TypeScript get type checking, autocomplete and hover, driven by definitions generated from the engine. Python gets syntax checking.
- **Player:** an Electron app that runs a saved place by itself.

## Quick start

```powershell
npm install
npm run dev          # editor at http://localhost:5173
```

The start screen offers a blank place (Baseplate for 3D, Empty 2D) or a small sample game to learn from (Coin Collector in 3D, Platformer in 2D). The editor autosaves to the browser (IndexedDB) and saves `.rbe` place files with **Ctrl+S**. Press **Play** (F5) to run it and **Stop** (Shift+F5) to return to editing. Press **Build** to export a desktop app. The app is written to `builds/<Name>-win32-x64/<Name>.exe`.

Other scripts:

| Command | What it does |
| --- | --- |
| `npm run build:player` | Packages the player template (the first **Build** in the editor does this for you) |
| `node tools/build-player.mjs my.rbe "My Game"` | Exports a saved place from the command line |
| `npm run editor` | Builds the editor and serves it, including the build API |
| `npm test` | Runs the Luau bridge, migration and cross-language tests |
| `npm run typecheck` | Runs the TypeScript checks |

**Desktop editor (RossEngine Studio):** `npm run build:studio` packages the editor as `studio-dist/RossEngine Studio-win32-x64/RossEngine Studio.exe` (~415 MB). It has native open/save dialogs and a File/Edit/Test menu, and builds games without Node: exports reuse Studio's own Electron runtime plus the bundled player, and land in `Documents/RossEngine Games` by default. `npm run studio` runs Studio against the dev server (`npm run dev`).

**Releases and Ross Launcher:** every push to `main` runs `.github/workflows/release-studio.yml`. It bumps the patch version, runs the tests, builds Studio and publishes `RossEngine-Studio-win32-x64.zip` (about 180 MB) as a GitHub release. Ross Launcher lists **RossEngine Studio**, installs it from the latest release, offers updates, and opens it.

Runtime test page without the editor: `http://localhost:5173/player.html?demo`.

## Editing

- **Move, Rotate and Scale tools** snap to the Move and Rotate step sizes in the toolbar.
- **Scale** resizes from the handle you drag: the opposite face stays where it is. Hold **Ctrl** to grow both sides evenly, or drag the centre handle to scale the whole part from its middle.
- **Camera:** hold the right mouse button to look around (the cursor stays in place), WASD/QE to fly, and the mouse wheel to zoom. **F** focuses the selection.

## Layout

```
src/engine/            the engine (shared by the editor's Play mode and the player)
  instance.ts          Instance tree, reflection (props/methods/events), serialization
  classes.ts           class library: Part, Model, Script, Humanoid, services, GUI, ...
  datatypes.ts         Vector3, CFrame, Color3, UDim2, Enum
  luau/prelude.luau    Roblox API written in Luau: Instance proxies, signals, task scheduler, datatypes
  luau/LuauRuntime.ts  Luau VM host and the JS <-> Luau bridge (incl. live cross-language proxies)
  scripting/           ScriptHost (JS API + module registry), TypeScript and Python runtimes
  physics/Physics.ts   Rapier world, Touched events, raycasts, welds
  render/              three.js scene mirror, materials, sky
  gui/GuiRenderer.ts   ScreenGui -> DOM overlay
  gui/BillboardLayer.ts BillboardGui: GUI over parts / 2D objects, placed each frame
  net/                 multiplayer: replication (Replicator), wire format, local and TCP connections
  game/                GameSession (game loop), characters, tweens, input
  assets.ts            place asset store (imported files, embedded in the place)
src/editor/            React editor (Explorer, Properties, Viewport, Monaco, Output, Assets, Build)
src/player/            standalone runtime entry (player.html)
electron/              player main process and preload (games never get Node access), TCP bridge for multiplayer
tools/                 player packaging and the editor's build-server plugin
```

## Scripting

Games are single-player by default and run entirely on the player's machine:

- **Script** runs when it is in Workspace, World2D (for example inside a sprite), ScriptService, or under Players (for example a copy in PlayerGui or a character).
- **LocalScript** runs in the same places. In a single-player game it is just like a Script; in a [multiplayer](#multiplayer) game it runs on each player's own machine, while Scripts run once, on the host.
- **ModuleScript** is loaded with `require`.
- **Storage** holds modules and templates. Scripts inside it do not run.
- **StarterGui** is copied into the player's PlayerGui, and **StarterCharacterScripts** into each character.

Roblox service names still work as aliases: `GetService("ReplicatedStorage")` returns Storage, and `ServerScriptService` maps to ScriptService.

Supported API includes:

- **Globals:** `game`, `workspace`, `script`, `Instance.new`, `task.*`, `wait`/`spawn`/`delay`.
- **Datatypes:** `Vector3`, `Vector2`, `CFrame`, `Color3`, `BrickColor`, `UDim`/`UDim2`, `TweenInfo`, `Ray`, `RaycastParams`, `Random`, `Enum`.
- **Instance API:** `FindFirstChild`, `WaitForChild`, `GetChildren`, `GetDescendants`, attributes, tags, `Changed`, `GetPropertyChangedSignal`, `ChildAdded`, and more.
- **Services:** Players, RunService (`Heartbeat`, `RenderStepped`, `BindToRenderStep`), UserInputService, ContextActionService, TweenService, Debris, HttpService (JSON), CollectionService, Lighting.
- **Parts:** physics and `Touched`, Humanoid characters (walking, jumping, sitting, death and respawn, `MoveTo`), ClickDetector, Sound, MeshPart, Decal, PointLight and SpotLight.
- **GUI:** ScreenGui with Frame, TextLabel, TextButton, TextBox, ImageLabel, UICorner, UIStroke and UIListLayout. BillboardGui shows the same elements over things in the world (see [Billboards](#billboards)).

Scripts in any language that loop without yielding are stopped after 8 seconds ("Script timeout").

## Custom 3D characters

`CharacterBody3D` is a character you move from a script, for any custom character in place of the default Humanoid one.
- **Shape:** a capsule sized by `Size`, kinematic, so physics never pushes it around. It slides along walls, steps up ledges up to `MaxStepHeight`, walks up slopes up to `MaxSlopeAngle`, and sticks to the ground going down.
- **Riders:** parts inside it, or welded to it, ride along rigidly. Put your character's MeshPart inside it, make the body transparent, and you're done.
- **Touching:** what it walks into fires `Touched` (on it and on the other part), and `TouchEnded` once it stops pushing against it. It stops just short of things, so without this it would never really touch them.
- **Sitting:** set its `SeatPart` (see Sitting under Joints).

```lua
body.Velocity = Vector3.new(x, body.Velocity.Y, z)  -- gravity (Workspace.Gravity) is added for you
body:MoveAndSlide()                                 -- moves by Velocity this frame
if body:IsOnFloor() then ... end                    -- also IsOnWall(), IsOnCeiling(), GetFloorNormal()
```

**A ready-made controller:** select a CharacterBody3D (or a model with one inside) and open **Script ▾**. Under **Character controller** you can insert a complete controller in Luau, TypeScript or Python. It's an ordinary script you can edit:
- WASD/arrow keys move relative to the camera, Shift sprints, and Space jumps;
- speeding up and slowing down are smoothed, and the body turns to face where it's going;
- the default camera follows it (hold the right mouse button to orbit, scroll to zoom);
- if the body has an AnimationPlayer with animations named `Walk`, `Idle`, `Jump` or `Sit`, it plays them;
- it makes the body the player's `Character`, so `Players.LocalPlayer.Character` and `Players:GetPlayerFromCharacter` find it (the car needs this to know who's driving);
- while the body is in a seat (`SeatPart`), it doesn't walk.

Inserting the controller also turns off `Players.CharacterAutoLoads`, since this body replaces the default character.

## Languages

Every Script and ModuleScript has a **Language** property: Luau, TypeScript or Python. Use **Script ▾** or **Module ▾** in the toolbar to create one in a given language. Modules written in any language can `require` (Luau/TypeScript) or `import` (Python) modules written in the others.

```ts
// TypeScript: same API; yielding uses await
const part = Instance.new("Part", workspace)
part.Position = new Vector3(0, 10, 0)
part.Touched.Connect((hit) => print("touched by", hit.Name))
await task.wait(1)
```

```python
# Python: same API; top-level await is allowed
part = Instance.new("Part")
part.Size = Vector3.new(4, 1, 2)
part.Parent = workspace
await task.wait(1)
```

**Modules across languages.** A ModuleScript in any language can be loaded from any other:

| From | Syntax |
| --- | --- |
| Luau | `require(game.Storage.Util)` or `require("Storage/Util")` |
| TypeScript | `import { add } from "Storage/Util"`, `import Util from "./Util"`, or `require(...)` |
| Python | `import Util`, `from Storage import Util`, or `require(script.Parent.Util)` |

- **Paths:** relative paths start from the script's parent. A bare name like `"Util"` is looked up in Storage, then ScriptService.
- **What gets shared:**
  - A Luau module shares the value it returns.
  - A TypeScript module shares its exports. If it only has `export default`, it shares that value.
  - A Python module shares its namespace.
- **Live values:** values pass between languages as live proxies, so tables, objects and functions (including callbacks) work across the boundary. Calling a foreign function from Luau works with either `.` or `:`.
- **Arrays:** JS arrays are 1-based when indexed from Luau.
- **Events:** `BindableEvent:Fire` reaches listeners in every language.

**Differences from Luau:**
- JS and Python have no operator overloading, so vector math uses methods: `a.add(b)`, `.sub`, `.mul`, `.div`, and `cf.Mul(other)` for `cf * other`.
- Yielding is `await` (`await task.wait()`, `await part.WaitForChild("x")`), and `Signal.Wait()` resolves with the first argument.
- Python modules can't be imported relatively (`from . import x`), and a module whose name matches a standard-library module has to be loaded with `require`.
- Python (Pyodide, about 14 MB) loads only when a place contains Python scripts. It is bundled into exported games, so they run offline.

## 2D games

Turn **World2D → Enabled** on (or start from **New 2D Place** / **2D Platformer**). The game then renders the 2D world instead of the 3D one, and no 3D avatar is spawned. The 2D world uses pixels, with y pointing down.

| Class | What it is |
| --- | --- |
| `Node2D` | Transform (Position, Rotation, Scale, ZIndex). Children inherit it. |
| `Sprite2D` | An image, or a sprite-sheet frame (`HFrames`/`VFrames`/`Frame`). Supports tint, flip, pivot, pixel-art filtering, and `ScrollFactor` for parallax. |
| `AnimatedSprite2D` + `SpriteAnimation` | Named animations (`Frames = "2-5"`, `FPS`, `Loop`). Use `Play(name)`, `Stop()`, and the `AnimationFinished`/`FrameChanged` events. |
| `TileMap` | A tileset image plus painted cells. `SolidTiles` sets which tiles collide. Has `SetCell`, `GetCell`, `WorldToCell`, `CellToWorld` and `GetUsedCells`. |
| `TileTerrain` | Auto-tiling rules, as a child of a TileMap. `Tiles` lists tileset indices in the order its `Mode` expects (below). Paint with `map:SetCellTerrain(x, y, "Ground")` (or `nil` to erase) and the cell and its neighbours pick the matching edge/corner tiles. `GetCellTerrain` and `UpdateTerrain` are also available. |
| `CharacterBody2D` | Platformer movement: set `Velocity`, call `MoveAndSlide()`, then check `IsOnFloor()`/`IsOnWall()`/`IsOnCeiling()`. Gravity comes from `World2D.Gravity`. |
| `RigidBody2D`, `StaticBody2D` | Physics bodies (Rapier 2D) with rectangle or circle shapes. Fire `Touched`/`TouchEnded`. |
| `Area2D` | A trigger. Fires `BodyEntered`/`BodyExited`. |
| `Camera2D` | Follows a target, with smoothing, zoom and offset. Has `ScreenToWorld`/`WorldToScreen`. |
| `Text2D` | Text in the world, with an outline. |
| `ParticleEmitter2D` | Streams particles (fire, smoke, sparks…) from its position. See [Particles](#particles). |

Terrain modes:
- `Block3x3`: 9 tiles in this order: top-left, top, top-right, left, centre, right, bottom-left, bottom, bottom-right.
- `Block3x3Inner`: the same 9, then 4 inner corners: top-left, top-right, bottom-left, bottom-right.
- `Cardinal16`: 16 tiles indexed by neighbour bits (up = 1, right = 2, down = 4, left = 8).

The Platformer template's ground is a `Block3x3Inner` terrain.

ScreenGui HUDs, Sounds, ClickDetectors, TweenService and every scripting language work in 2D as well.

**2D editing:**
- pan with the middle or right mouse button (or Space+drag) and zoom with the wheel;
- drag objects to move them (they snap to the Move snap, in pixels) and drop images in to create sprites;
- grid and collision-shape overlays can be toggled on;
- **camera frame:** an amber outline shows exactly what the game will see when it starts. It covers the current `Camera2D` (centred on what it follows, plus `Offset`, at its `Zoom`) over the game window size from the place settings, and everything outside it is dimmed. The label names the camera, and the camera button in the viewport's corner toggles the frame;
- sprite animations play live in the editor;
- select a **TileMap** to paint with the tile palette: left click paints, right click erases, Shift+drag fills a rectangle;
- **auto-tiling:** in the palette, click **+ Terrain** with the top-left tile of a block selected, then pick the terrain as the brush. Painting, erasing and rectangles then choose edge and corner tiles automatically. **Re-tile map** refreshes everything after you change a terrain's `Tiles`;
- the Properties panel shows a sprite's sheet: click frames to set `Frame`, or to build a `SpriteAnimation`'s frame list, and **Fit size to frame**.

## Joints

Joints connect parts so they move together in a particular way. Each one is a single object: no attachments to line up.

**Making one:** select the part that should move, then (optionally) the part it's attached to, and pick from **Joint** in the toolbar. With one part selected, it's attached to the world.
- Hinges, sliders and ball sockets go where the two parts meet. Springs and ropes run from the first part's centre to the second's (or to a point above it).
- If the moving part is Anchored, it's unanchored so it can move.
- Select a joint and use **Move** / **Rotate** to put its pivot exactly where you want it, or type its `Position` / `Orientation`.

| Joint | Moves like | Settings |
| --- | --- | --- |
| `HingeConstraint` | a door, wheel or lever: turns around the pivot's up axis | `Mode`, `Speed` (°/s), `MaxTorque`, `TargetAngle`, `LimitsEnabled`, `LowerAngle` / `UpperAngle`; reads `CurrentAngle` |
| `BallSocketConstraint` | a pendulum or ragdoll joint: turns any way around the pivot | |
| `SliderConstraint` | a lift, piston or drawer: slides along the pivot's up axis | `Mode`, `Speed` (studs/s), `MaxForce`, `TargetPosition`, `LimitsEnabled`, `LowerLimit` / `UpperLimit`; reads `CurrentPosition` |
| `SpringConstraint` | suspension, bouncy things: pulls its ends towards `FreeLength` apart | `Stiffness`, `Damping`, `End1`; reads `CurrentLength` |
| `RopeConstraint` | a swing, chain or tow rope: keeps its ends at most `Length` apart | `End1`; reads `CurrentLength` |

- **`Mode`** (hinges and sliders): `Free` swings freely; `Motor` keeps turning or sliding at `Speed`; `Servo` goes to `TargetAngle` / `TargetPosition` at up to `Speed` and holds it there. Positive values turn anticlockwise round the axis (seen from its tip) or slide towards it.
- **Angles and positions are measured from where things are when the game starts**, so 0 is how you built it. Limits use the same numbers.
- **`Part0`** is the part that moves, and **`Part1`** what it's attached to (empty: the world). The pivot is stored relative to `Part0`, so it moves with it while you build. The two parts don't collide with each other where a hinge, slider or ball socket joins them.
- **While editing** every joint is drawn. **In the game**, only ones with **`ShowInGame`** are: ropes and springs (as cords and coils, in `Color` and `Thickness`) unless you turn it off.
- Scripts can change any of it while the game runs, e.g. `door.HingeConstraint.TargetAngle = 90` to open a door, or `Enabled = false` to let go.

**2D:** the same joints for 2D bodies: `HingeConstraint2D`, `SliderConstraint2D`, `SpringConstraint2D` and `RopeConstraint2D`, from **Joint** while the place is 2D.
- A 2D joint is a 2D object. Put it inside the moving body (`Body0`, the default), and its position is the pivot. `Body1` is what it's attached to (empty: the world).
- A slider moves along the joint's up direction, which turns with the joint. Lengths are in pixels.
- Angles go clockwise, like `Rotation`.
- A spring's or rope's `End1` is a point in `Body1`'s space, or in the world.

### Cars and ragdolls

These are built from ordinary parts, joints and scripts, not special classes. They're under **Joint → Built from joints** (in 3D). Once added, you can take one apart, restyle it, or copy its scripts into your own things.

**Car:** a model with a chassis, a seat and four wheels.
- **Wheels:** each wheel turns on a `HingeConstraint` in `Motor` mode. It's attached to an invisible hub.
- **Suspension:** each hub slides up and down on a `SliderConstraint`, held up by a `SpringConstraint`.
- **Steering:** the front hubs turn on `Servo` hinges.
- **Getting in and out:** walk into the car to get in, then drive with **W/S** and steer with **A/D**. **Space** gets you out. This works for Humanoid characters and for `CharacterBody3D` ones.
- **Scripts:** the car's `Seat` Script seats whoever touches it. The `Drive` LocalScript sets the wheels' `Speed` / `MaxTorque` and the steering hinges' `TargetAngle` from the keys.
- **Tuning:** use the car model's attributes: `MaxSpeed`, `ReverseSpeed`, `Torque`, `BrakeTorque`, `SteerAngle` and `SteerSpeed`.
- **Multiplayer:** the driver's machine runs the car while they're in it. The `Seat` script uses `SetNetworkOwner` for this.

**Ragdoll script:** adds a `Ragdoll` Script to ScriptService. When any character dies (a player's or an NPC's), it joins the limbs to the torso. Legs and the head get limited hinges and the arms get ball sockets. The body then flops over instead of falling apart.

**Sitting:** any part can be a seat. Set a Humanoid's `SeatPart`, or call `humanoid:Sit(part)`. A `CharacterBody3D` has its own `SeatPart` too, so characters without a Humanoid can sit; see below.
- The character sits on top of the part and rides along with it. It doesn't push the part around.
- **Space** stands it up beside the seat: on its left, or wherever the seat's `ExitOffset` attribute (a Vector3 in the seat's own space) says.
- `Seated(active, seat)` fires both ways, and `humanoid:Sit(nil)` stands it up.
- **`CharacterBody3D`:** set `body.SeatPart` to sit it on top of the part, facing the same way. While seated:
  - it rides along, even if a script turns or moves it;
  - it pushes nothing;
  - `MoveAndSlide()` does nothing.

  Set `SeatPart` to nil to stand it up beside the seat, at the bottom of the body. It doesn't stand up on Space by itself, but the car's `Drive` script does that for its driver. In your controller script, skip walking while `body.SeatPart` is set, e.g. play a sitting animation and return.

## Shaders

There are two ways to make a shader:
- **Visual steps** (the default for new shaders): no shader knowledge needed.
- **GLSL code**: edited in the code editor with highlighting, completions and live error checking.

### Visual steps

A new Shader or ScreenShader opens as a list of plain-English steps that run from top to bottom. Each step is a sentence with controls inside it, for example:
- "Paint **[blue]** in **[stripes]**, size **[1]**, moving at speed **[0.5]** going **[up]**"
- "Glow **[cyan]** around the edges at strength **[2]**"
- "Wobble the surface by **[20%]** at speed **[2]**"

Using it:
- **Add steps** with **Add a step**: search or browse by what they do.
- **Rearrange** steps by dragging, switch one off with the eye, or delete it.
- **Live preview:** shows a ball (3D), the sprite itself (2D), or a sample picture (screen effects). The object in the scene updates too.

| Category | Steps |
| --- | --- |
| Colour | tint, paint a pattern, brighter/darker, contrast, more/less colourful, black and white, old photo, invert, rainbow, cartoon colours, pulse, flash |
| Light & glow | glow, edge glow (3D), shiny (3D), sprite outline (2D) |
| See-through | see-through, cut holes, dissolve (with a glowing edge; can animate itself) |
| Movement | wobble, wave like a flag (3D), sway, bob, grow and shrink, spin |
| Image | slide the image, wavy image |
| Screen effects | dark corners, old TV lines, film grain, blur, colour split, cinema bars, pixelate, shake |

Patterns are everywhere, stripes, waves, checkers, dots, clouds, sparkles, a fade, the edges, and the middle. They have a size, a speed and a direction.

Other details:
- **3D shaders** have a "Light it with the sun" switch.
- **Show the code** displays the generated GLSL, commented step by step.
- **Convert to code…** turns the shader into ordinary GLSL to keep editing by hand (Undo brings the steps back).

### GLSL code


- **Shader:** put it inside a 3D part (including MeshParts), or inside a Sprite2D, AnimatedSprite2D, TileMap or Text2D. It replaces that object's material.
- **ScreenShader:** post-processing for the whole screen. Put it in **Lighting** (3D) or **World2D** (2D). Several screen shaders run in order.

A shader is a function returning the colour of each pixel, plus an optional function that moves vertices:

```glsl
vec4 fragment() {
	float stripes = step(0.5, fract(WORLD_POSITION.y * 2.0 + TIME));
	return vec4(shade(mix(BASE.rgb, Tint, stripes)), BASE.a);
}

vec3 vertex() {   // optional: local position, before Size scaling
	return POSITION + NORMAL * sin(POSITION.y * 12.0 + TIME * 4.0) * Wobble;
}
```

- **Built-ins:**
  - `BASE`: what the object would normally draw;
  - `COLOR`, `TEXTURE` (with `sampleTexture(uv)`), `UV`;
  - `WORLD_POSITION`, `WORLD_NORMAL`, `LOCAL_POSITION`, `CAMERA_POSITION`;
  - `TIME`, `RESOLUTION`;
  - `shade(albedo)`: simple sun and ambient lighting in 3D;
  - in `vertex()`: `POSITION` and `NORMAL`.
  
  Screen shaders get `BASE` (the rendered image at `UV`) and `TEXTURE` (the whole frame).
- **Uniforms from attributes:** every attribute on the Shader becomes a uniform of the matching type: number → `float`, bool → `bool`, Vector2 → `vec2`, Vector3 or Color3 → `vec3`, and an image asset → `sampler2D`. Scripts can animate them with `shader:SetAttribute("Wobble", 0.2)`.
- **Errors:** compile errors appear as squiggles while you type, and in **Output** as `Workspace.Part.Shader:6: …` (click to jump to the line). A shader that doesn't compile falls back to the object's normal material.
- **Limitations:** custom shaders don't receive shadows, and skinned meshes draw in their rest pose.

## Animation

Animate any property of an object, or of anything inside a model: position, rotation, size, colour, transparency, light brightness, GUI positions, 2D sprites, and more.

### In the editor

1. **Create:** select a part, model or 2D object, then use **Insert → AnimationPlayer** (or **Animate "…"** in the **Animation** tab at the bottom). This creates an `AnimationPlayer` with one `Animation` inside, and opens the Animation editor.
2. **Record:** move the playhead, then change the object with the Move, Rotate or Scale tools, or in the Properties panel. While **Recording changes** is on, every change becomes a keyframe at the playhead. A property's first change also adds a key at 0 seconds with its starting value.
3. **Edit keyframes:**
   - drag keys to retime them;
   - Shift+click to select several, and Delete to remove them;
   - right-click a key to choose its easing (Linear, Constant, Sine, Quad, Cubic, Back, Bounce or Elastic, easing in, out or both);
   - double-click a track to add a key there;
   - use **Key all** to key every track at the playhead.
4. **Settings:** set the length, **Loop**, and **Play on start** (the AnimationPlayer's `Autoplay`). Add more animations (such as "Open" and "Close") from the animation list.

Other behaviour:
- **Preview** with the Play button or Space.
- **The starting pose is what gets saved:** the preview only shows while the Animation tab is open, so saving, Play and duplicating always use the objects' real values.
- **Editing the starting pose:** turn **Recording changes** off.

### Rigged models

Importing a rigged (skinned) model also imports its rig:
- **Skeleton:** a `Skeleton` inside the MeshPart, with a `Bone` for every bone of the model.
  - **Rest pose:** `CFrame` (also shown as `Position`/`Orientation`) and its size, `Scale`.
  - **Pose on top:** `Transform` (also shown as `PoseOffset`/`PoseRotation`) and `PoseScale`, a size multiplier where 1, 1, 1 is the rest size.
  - **Live:** the pose is drawn on the mesh in the editor and in games.
- **Clips:** any animation clips in the file (glTF/FBX) become Animations in an AnimationPlayer on the MeshPart, with position, rotation and scale. Each has `Transform` and `PoseScale` tracks per bone. Redundant keys, and channels that never leave the rest pose, are removed.
- **Posing:** select a Bone in the Explorer to see the skeleton, then use the **Move**, **Rotate** and **Scale** tools on it (scaling is along the bone's own axes). With the Animation tab open, every pose you make is recorded as a keyframe, like any other property.
- **Older imports:** a MeshPart imported before this (or with a changed MeshId) can get its rig by right-clicking it and choosing **Import rig from model**.
- **From scripts:** `bone.Transform = CFrame.Angles(0, 0, math.rad(30))`.

### At runtime

```lua
local door = workspace.Gate.AnimationPlayer
door:Play("Open")            -- or door:Play() for the current/first animation
door.Ended:Connect(function(name) print(name, "finished") end)
door:Pause()  door:Resume()  door:Seek(0.5)  door:Stop()
door.Speed = 2               -- door.Playing, door.CurrentAnimation, door.TimePosition
```

- **Relative positions:** part positions inside a model are stored relative to the model (its PrimaryPart, or its centre). A copy of an animated model animates wherever you put it.
- **2D:** positions are already relative to the parent node.
- **Events:** `Played`, `Stopped` and `Ended` (when a non-looping animation finishes).

## Particles

Particle effects work the same way in 3D and 2D:
- **3D:** put a `ParticleEmitter` inside a part (Insert → Object → Effects). It streams particles out of the part's volume, its surface, or its centre (`EmissionShape`). With no part selected, inserting one also makes an invisible part to hold it.
- **2D:** insert a `ParticleEmitter2D` from the **2D** menu. It is a 2D object, so you can move it, rotate it, give it a `ZIndex`, or put it inside a sprite to follow it. It emits from a point, a rectangle or a circle (`EmissionShape`, `EmissionSize`).

Emitters run live in the editor, so you can tune them without pressing Play. The **Particle presets** in the Properties panel set one up as sparkles, fire, smoke, snow, a burst or a magic swirl, and **Emit 20** fires a test burst.

| Property | What it does |
| --- | --- |
| `Rate`, `Lifetime`, `LifetimeVariation`, `MaxParticles` | How many particles come out each second, and how long each one lasts (in seconds). |
| `Speed`, `SpeedVariation`, `Direction`, `SpreadAngle` | Which way they fly. Direction is in the emitter's own space: up by default. SpreadAngle widens it into a cone, and 180 means every way. |
| `Acceleration`, `Drag` | A steady push (gravity, wind or rising heat) and slowing down. |
| `Color` → `ColorEnd`, `Size` → `SizeEnd`, `Transparency` → `TransparencyEnd` | How each particle changes over its life. Sizes are in studs in 3D and pixels in 2D. |
| `Texture`, `Spin`, `RandomRotation`, `Glow` | An image instead of the soft dot, turning, and glowing (light-adding) particles for fire, sparks and magic. |
| `LockedToEmitter` | Particles move along with the emitter instead of trailing behind it. |

Scripts can fire bursts with `Emit` and remove what's out with `Clear`:

```lua
local sparks = workspace.Chest.ParticleEmitter
sparks.Enabled = false      -- only bursts
sparks:Emit(40)             -- e.g. when the chest opens
```

## Billboards

A `BillboardGui` is GUI that floats over something in the world and always faces the camera: name tags, health bars, signs, "Press E" prompts. It holds the same elements as a ScreenGui (TextLabel, Frame, ImageLabel, buttons and so on).

- **Where it shows:** put it inside a part or model in Workspace, or inside a 2D object in World2D. It can also go in StarterGui with its `Adornee` set to what it should hover over.
- **Inserting one:** with a part (or 2D object) selected, use Insert → Object → BillboardGui, or **2D → Billboard label**. You get a label that reads "Hello!", just above the selection. With nothing selected, it comes on a new invisible holder.
- **`Size`:** scale is in studs (in 2D, world pixels), so `{4, 0}, {1, 0}` is 4 × 1 studs and gets smaller with distance. Offset alone, such as `{0, 200}, {0, 50}`, keeps it that many pixels on screen at any distance.
- **`StudsOffset`:** moves it relative to the camera, so `(0, 3, 0)` is always "above". `StudsOffsetWorldSpace` moves it in world directions instead. In 2D both are in world pixels, with y pointing down like `Position`.
- **`AlwaysOnTop`:** shows it through walls. By default it hides when something is between it and the camera.
- **`MaxDistance`:** hides it beyond this many studs (0 = no limit). `Enabled` and `ClipsDescendants` work as on a ScreenGui.

Scripts change billboards like any GUI:

```lua
local tag = workspace.Shopkeeper.BillboardGui.TextLabel
tag.Text = "Shop (open)"
```

## Multiplayer

Games are single-player unless you turn multiplayer on: **NetworkService → Enabled** (or **Players → Make the game multiplayer** in the toolbar). One player **hosts**: their machine runs the game for everyone. The others **join** and see the same world.

**Trying it in the editor:** use **Players → Test with 2 / 3 / 4 players**. You play as Player1 (the host) in the editor, and each other player gets a window of their own. Closing the game (Stop) closes them too.

**In a built game:** a multiplayer game starts with a Host / Join screen. **Host a game** shows the address others type to join (for example `192.168.1.20:47800`). **Join** connects to it, and **Play alone** is single-player. Players on the same network can join straight away. Over the internet, the host forwards the port (`NetworkService.Port`, 47800 by default) on their router. Windows may ask to let the game through its firewall the first time someone hosts.

**What runs where:**

| | Host | Each player |
| --- | --- | --- |
| `Script` | ✓ (once, for everyone) | — |
| `LocalScript` | ✓ (for the host's own player) | ✓ (their own) |
| Physics, NPCs, the world | ✓ | gets a copy, kept up to date ~30 times a second |
| Their own character | | ✓ moves it; everyone else sees it move |

- Changes made by the host's Scripts reach every player: new parts, colours, positions, attributes, sounds and so on.
- Changes a player's LocalScripts make to the world stay on their machine. The exceptions are their own character (`player.Character` and everything in it) and anything the host has handed to them (below): everyone sees those.
- Each machine has its own camera, mouse and GUI (PlayerGui).
- Players get Workspace, World2D, Players, Lighting, Storage, StarterGui, StarterPlayer, SoundService and the LocalScripts and modules in ScriptService. Scripts and SaveService stay on the host.
- 3D characters load automatically for everyone, and players spawn spread out over the SpawnLocations. In 2D, give each player their own body from a Script: `player.Character = body`. Their LocalScript then moves `Players.LocalPlayer.Character`.

**Handing an object to a player:** the host can give a player control of any object, and of everything inside it. That player's changes to it then reach the host and everyone else. Use it for a car they drive, a ball they carry, or a door only they can open.

```lua
-- Script (host)
workspace.Kart:SetNetworkOwner(player)   -- now that player's machine moves it
workspace.Kart:GetNetworkOwner()         --> player (nil when the host has it)
workspace.Kart:SetNetworkOwner(nil)      -- back to the host (SetNetworkOwnershipAuto() does the same)

-- LocalScript (that player)
if workspace.Kart:GetNetworkOwner() == game.Players.LocalPlayer then
	workspace.Kart.Body.Color = Color3.new(1, 0, 0)   -- everyone sees it
end
```

- The owner's property and attribute changes are sent, including positions.
- Unanchored parts are simulated by the owner's physics, and the other machines glide along with them.
- The host can still change an owned object (for example to teleport it), and the owner gets that.
- Creating or deleting objects is still done by the host; ask it with a RemoteEvent.
- Ownership ends when the player leaves, or when the host calls `SetNetworkOwner(nil)`.
- A player's character is theirs automatically.

**Talking between machines:** put a `RemoteEvent` or `RemoteFunction` in Storage (Insert → Object → Communication).

```lua
-- Script (host)
local rs = game:GetService("ReplicatedStorage")
rs.Coin.OnServerEvent:Connect(function(player, coin)
	player:SetAttribute("Coins", (player:GetAttribute("Coins") or 0) + 1)
	coin:Destroy()                       -- gone for everyone
	rs.Coin:FireAllClients(player.Name)  -- tell everyone who got it
end)
rs.GetScore.OnServerInvoke = function(player) return player:GetAttribute("Coins") or 0 end

-- LocalScript (each player)
rs.Coin:FireServer(workspace.Coin)
rs.Coin.OnClientEvent:Connect(function(name) print(name .. " got a coin") end)
print("my score", rs.GetScore:InvokeServer())
```

| | |
| --- | --- |
| `RemoteEvent:FireServer(...)` | player → host: `OnServerEvent(player, ...)` |
| `RemoteEvent:FireClient(player, ...)` / `FireAllClients(...)` | host → one player / everyone: `OnClientEvent(...)` |
| `RemoteFunction:InvokeServer(...)` | asks the host; waits for `OnServerInvoke(player, ...)` to return |
| `RemoteFunction:InvokeClient(player, ...)` | asks a player; waits for their `OnClientInvoke(...)` |
| `RunService:IsServer()` / `IsClient()` | true on the host (and in single-player) / everywhere |
| `NetworkService:IsHost()`, `IsClient()`, `IsMultiplayer()`, `GetHostAddress()` | this machine's part in the game, and the address to show others |

Arguments can be numbers, strings, booleans, tables, Vector3s, CFrames, Color3s, and other datatypes. Instances can be passed too, as long as the other machine has them. In TypeScript and Python, `InvokeServer` / `InvokeClient` are awaited. The callbacks (`OnServerInvoke`…) work in any language. `Players.PlayerAdded` / `PlayerRemoving` fire on the host as players come and go. A single-player game delivers everything straight away on the same machine, so the same scripts work either way.

## Saving data

`SaveService` keeps data on the player's machine between plays. There's no database to set up.

```lua
local Save = game:GetService("SaveService")

local coins = Save:Get("Coins", 0)         -- default if there's no saved value
Save:Set("Coins", coins + 10)              -- saved automatically, a moment later
Save:Increment("Deaths")                   -- +1 (or Save:Increment("Coins", 5))
Save:Update("Inventory", function(items)   -- read, change, write back
	items = items or {}
	table.insert(items, "Sword")
	return items
end)

Save:GetAttributeChangedSignal("Coins"):Connect(updateHud)   -- simple values are also attributes
```

- **What can be saved:** numbers, strings, booleans, `Vector3`/`Vector2`/`Color3`/`CFrame`/`UDim2`, and tables of those (nested lists and dictionaries). Saving something else (an Instance or a function) gives an error that names the key.
- **Starting values:** select **SaveService** in the Explorer and add attributes, e.g. `Coins = 0` or `Lives = 3`. A new save starts from these, and `Clear()` goes back to them.
- **Automatic saving:** changes are written about half a second after they happen, and again when the game closes. Turn off **AutoSave** to write only when you call `Save:Save()`, for "save points".
- **Slots:** use `Save:SetSlot("Slot 2")` to switch (the current one is saved first), plus `GetSlot()`, `ListSlots()`, `DeleteSlot(name)` and `HasSave()`, which suits a "Continue" button. The default slot is `Default`.
- **Other methods:** `Has(key)`, `Remove(key)`, `GetAll()` and `Clear()`. Events: `Changed(key, value)`, `Loaded(slot)` and `Saved(slot)`.
- **Where saves are stored:**
  - **Exported games:** readable JSON files in `%APPDATA%\RossEngine Games\<game name>\Saves\<slot>.json`, one folder per game.
  - **Editor Play mode:** the browser, per place. Use **File → Clear Save Data** to start fresh.
- **TypeScript and Python** get the same API. Tables come back as arrays and objects in TypeScript, and as real lists and dicts in Python.

## Assets

Sounds, images and 3D models are imported from files and saved inside the place file, so a game never needs an external ID or URL.

- **Import:** drop files onto the viewport or the **Assets** panel, use **Import** or **Insert → Model** in the toolbar, or pick **Import file…** in any asset property.
- **Formats:** models `.glb` `.gltf` `.obj` `.fbx` `.stl`, including Draco- and Meshopt-compressed glTF and rigged/skinned meshes; images `.png` `.jpg` `.webp` `.gif` `.svg`; audio `.mp3` `.ogg` `.wav` `.m4a`.
- **Multi-file models:** a `.gltf` with a separate `.bin` and textures, or an `.obj` with its `.mtl` and textures, needs all its files. Select them together, drop the folder's files, or import a `.zip` of the model. Missing files and load errors are reported in **Output**.
- **Placing:** a model becomes a **MeshPart**, stretched to its `Size`. Set `CollisionFidelity` to `Hull` for a convex-hull collider. An image becomes a **Decal** on the face you drop it on. Audio becomes a **Sound**.
- **From scripts:** asset properties hold `asset://<id>`, and scripts can use the asset's name instead, e.g. `sound.SoundId = "asset://Explosion"`.

## Player controls

| Input | Action |
| --- | --- |
| WASD | Move |
| Space | Jump |
| Right-mouse drag | Orbit the camera |
| Mouse wheel, or I / O | Zoom |
| F11 | Toggle fullscreen |
| F9 | Developer console |
