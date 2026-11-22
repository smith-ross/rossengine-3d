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

In the editor, use **File → New from Demo** to load a sample game. Press **Play** (F5) to run it and **Stop** (Shift+F5) to return to editing. Press **Build** to export a desktop app. The app is written to `builds/<Name>-win32-x64/<Name>.exe`.

Other scripts:

| Command | What it does |
| --- | --- |
| `npm run build:player` | Packages the player template (the first **Build** in the editor does this for you) |
| `node tools/build-player.mjs my.rbe "My Game"` | Exports a saved place from the command line |
| `npm run editor` | Builds the editor and serves it, including the build API |
| `npm test` | Runs the Luau bridge tests |
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
src/editor/            React editor (Explorer, Properties, Viewport, Monaco, Output, Build)
src/player/            standalone runtime entry (player.html)
electron/              player main process and preload (games never get Node access)
tools/                 player packaging and the editor's build-server plugin
```

## Scripting

Scripts are Luau and follow Roblox semantics:

- **Script** runs in Workspace or ServerScriptService.
- **LocalScript** runs in PlayerGui, PlayerScripts or the character.
- **ModuleScript** is loaded with `require`.

Client and server share one VM. RemoteEvent and RemoteFunction loop back locally.

Supported API includes:

- **Globals:** `game`, `workspace`, `script`, `Instance.new`, `task.*`, `wait`/`spawn`/`delay`.
- **Datatypes:** `Vector3`, `Vector2`, `CFrame`, `Color3`, `BrickColor`, `UDim`/`UDim2`, `TweenInfo`, `Ray`, `RaycastParams`, `Random`, `Enum`.
- **Instance API:** `FindFirstChild`, `WaitForChild`, `GetChildren`, `GetDescendants`, attributes, tags, `Changed`, `GetPropertyChangedSignal`, `ChildAdded`, and more.
- **Services:** Players, RunService (`Heartbeat`, `RenderStepped`, `BindToRenderStep`), UserInputService, ContextActionService, TweenService, Debris, HttpService (JSON), CollectionService, Lighting.
- **Parts:** physics and `Touched`, Humanoid characters (walking, jumping, death and respawn, `MoveTo`), ClickDetector, Sound (URL sources), PointLight and SpotLight.
- **GUI:** ScreenGui with Frame, TextLabel, TextButton, TextBox, ImageLabel, UICorner, UIStroke and UIListLayout.

Scripts that loop without yielding are stopped after 8 seconds ("Script timeout").

## Player controls

| Input | Action |
| --- | --- |
| WASD | Move |
| Space | Jump |
| Right-mouse drag | Orbit the camera |
| Mouse wheel, or I / O | Zoom |
| F11 | Toggle fullscreen |
| F9 | Developer console |
