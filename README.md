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

The start screen offers a blank Baseplate or the Coin Collector demo. The editor autosaves to the browser (IndexedDB) and saves `.rbe` place files with **Ctrl+S**. Press **Play** (F5) to run it and **Stop** (Shift+F5) to return to editing. Press **Build** to export a desktop app. The app is written to `builds/<Name>-win32-x64/<Name>.exe`.

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
  game/                GameSession (game loop), characters, tweens, input
  assets.ts            place asset store (imported files, embedded in the place)
src/editor/            React editor (Explorer, Properties, Viewport, Monaco, Output, Assets, Build)
src/player/            standalone runtime entry (player.html)
electron/              player main process and preload (games never get Node access)
tools/                 player packaging and the editor's build-server plugin
```

## Scripting

Games run entirely on the player's machine, so there is no server/client split:

- **Script** runs when it is in Workspace, ScriptService, or under Players (for example a copy in PlayerGui or a character).
- **ModuleScript** is loaded with `require`.
- **Storage** holds modules and templates. Scripts inside it do not run.
- **StarterGui** is copied into the player's PlayerGui, and **StarterCharacterScripts** into each character.

Roblox service names still work as aliases: `GetService("ReplicatedStorage")` returns Storage, and `ServerScriptService` maps to ScriptService. Places saved with `LocalScript`s are converted to `Script`s when opened.

Supported API includes:

- **Globals:** `game`, `workspace`, `script`, `Instance.new`, `task.*`, `wait`/`spawn`/`delay`.
- **Datatypes:** `Vector3`, `Vector2`, `CFrame`, `Color3`, `BrickColor`, `UDim`/`UDim2`, `TweenInfo`, `Ray`, `RaycastParams`, `Random`, `Enum`.
- **Instance API:** `FindFirstChild`, `WaitForChild`, `GetChildren`, `GetDescendants`, attributes, tags, `Changed`, `GetPropertyChangedSignal`, `ChildAdded`, and more.
- **Services:** Players, RunService (`Heartbeat`, `RenderStepped`, `BindToRenderStep`), UserInputService, ContextActionService, TweenService, Debris, HttpService (JSON), CollectionService, Lighting.
- **Parts:** physics and `Touched`, Humanoid characters (walking, jumping, death and respawn, `MoveTo`), ClickDetector, Sound, MeshPart, Decal, PointLight and SpotLight.
- **GUI:** ScreenGui with Frame, TextLabel, TextButton, TextBox, ImageLabel, UICorner, UIStroke and UIListLayout.

Scripts in any language that loop without yielding are stopped after 8 seconds ("Script timeout").

## Languages

Every Script and ModuleScript has a **Language** property: Luau, TypeScript or Python. Use **Script ▾** or **Module ▾** in the toolbar to create one in a given language. The **Languages Demo** template shows all three working together.

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
- sprite animations play live in the editor;
- select a **TileMap** to paint with the tile palette: left click paints, right click erases, Shift+drag fills a rectangle;
- **auto-tiling:** in the palette, click **+ Terrain** with the top-left tile of a block selected, then pick the terrain as the brush. Painting, erasing and rectangles then choose edge and corner tiles automatically. **Re-tile map** refreshes everything after you change a terrain's `Tiles`;
- the Properties panel shows a sprite's sheet: click frames to set `Frame`, or to build a `SpriteAnimation`'s frame list, and **Fit size to frame**.

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
- **Skeleton:** a `Skeleton` inside the MeshPart, with a `Bone` for every bone of the model. Each Bone has its rest pose (`CFrame`, also shown as `Position`/`Orientation`) and a `Transform` on top of it (also shown as `PoseOffset`/`PoseRotation`). The pose is drawn on the mesh live, in the editor and in games.
- **Clips:** any animation clips in the file (glTF/FBX) become Animations in an AnimationPlayer on the MeshPart. Each has one `Transform` track per bone, with redundant keys removed.
- **Posing:** select a Bone in the Explorer to see the skeleton, then use the **Move** and **Rotate** tools on it. With the Animation tab open, every pose you make is recorded as a keyframe, like any other property.
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
