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

Runtime test page without the editor: `http://localhost:5173/player.html?demo`.

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
| `CharacterBody2D` | Platformer movement: set `Velocity`, call `MoveAndSlide()`, then check `IsOnFloor()`/`IsOnWall()`/`IsOnCeiling()`. Gravity comes from `World2D.Gravity`. |
| `RigidBody2D`, `StaticBody2D` | Physics bodies (Rapier 2D) with rectangle or circle shapes. Fire `Touched`/`TouchEnded`. |
| `Area2D` | A trigger. Fires `BodyEntered`/`BodyExited`. |
| `Camera2D` | Follows a target, with smoothing, zoom and offset. Has `ScreenToWorld`/`WorldToScreen`. |
| `Text2D` | Text in the world, with an outline. |

ScreenGui HUDs, Sounds, ClickDetectors, TweenService and every scripting language work in 2D as well.

**2D editing:**
- pan with the middle or right mouse button (or Space+drag) and zoom with the wheel;
- drag objects to move them (they snap to the Move snap, in pixels) and drop images in to create sprites;
- grid and collision-shape overlays can be toggled on;
- sprite animations play live in the editor;
- select a **TileMap** to paint with the tile palette: left click paints, right click erases, Shift+drag fills a rectangle;
- the Properties panel shows a sprite's sheet: click frames to set `Frame`, or to build a `SpriteAnimation`'s frame list, and **Fit size to frame**.

## Assets

Sounds, images and 3D models are imported from files and saved inside the place file, so a game never needs an external ID or URL.

- **Import:** drop files onto the viewport or the **Assets** panel, use **Import** or **Insert → Model** in the toolbar, or pick **Import file…** in any asset property.
- **Formats:** models `.glb` `.gltf` (embedded buffers) `.obj` `.fbx` `.stl`; images `.png` `.jpg` `.webp` `.gif` `.svg`; audio `.mp3` `.ogg` `.wav` `.m4a`.
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
