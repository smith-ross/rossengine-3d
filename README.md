# RossEngine 3D

A Roblox-style 3D game engine that runs in the browser. Games are built in an in-browser editor and scripted **only in Luau**. They can be exported as standalone desktop apps (Electron).

- **Engine:** TypeScript, with [three.js](https://threejs.org) for rendering and [Rapier](https://rapier.rs) for physics.
- **Scripting:** real Luau (compiled to WebAssembly through [`@luau-rs/luau`](https://github.com/luau-rs/luau)), with a Roblox-like API.
- **Editor:** React UI with a Monaco script editor. The editor does Luau type checking, autocomplete and hover, driven by definitions generated from the engine.
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
| `npm test` | Runs the Luau bridge and migration tests |
| `npm run typecheck` | Runs the TypeScript checks |

Runtime test page without the editor: `http://localhost:5173/player.html?demo`.

## Layout

```
src/engine/            the engine (shared by the editor's Play mode and the player)
  instance.ts          Instance tree, reflection (props/methods/events), serialization
  classes.ts           class library: Part, Model, Script, Humanoid, services, GUI, ...
  datatypes.ts         Vector3, CFrame, Color3, UDim2, Enum
  luau/prelude.luau    Roblox API written in Luau: Instance proxies, signals, task scheduler, datatypes
  luau/LuauRuntime.ts  Luau VM host and the JS <-> Luau bridge
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

Scripts that loop without yielding are stopped after 8 seconds ("Script timeout").

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
