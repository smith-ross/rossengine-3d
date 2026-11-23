// A running game: DataModel + Luau VM + physics + rendering + input + GUI.
// Used by the editor's Play mode and by the standalone (Electron) player.
import * as THREE from 'three'
import { CFrame, EnumItem, Vector2, Vector3, enumItem } from '../datatypes'
import { Instance, SerializedInstance, createInstance, deserialize, isA } from '../instance'
import { BasePart, DataModel, Humanoid, Model, Runtime, TweenInfoData, isScriptRunnable, setActiveRuntime } from '../classes'
import { LuauRuntime, OutputSink } from '../luau/LuauRuntime'
import { Physics, initPhysics } from '../physics/Physics'
import { SceneRenderer } from '../render/SceneRenderer'
import { GuiRenderer } from '../gui/GuiRenderer'
import { BillboardLayer } from '../gui/BillboardLayer'
import { CharacterController, buildDefaultCharacter, findHumanoidModel } from './Character'
import { TweenManager } from './Tweens'
import { DragLook, keyCodeName } from './Input'
import { ScriptHost } from '../scripting/ScriptHost'
import { TypeScriptRuntime } from '../scripting/TypeScriptRuntime'
import { PythonRuntime } from '../scripting/PythonRuntime'
import { languageOf } from '../scripting/languages'
import { Renderer2D } from '../render/Renderer2D'
import { Physics2D, initPhysics2D } from '../physics/Physics2D'
import { Animator2D } from './Animator2D'
import { AnimationRunner } from '../animation'
import { DEFAULT_SLOT, SaveBackend, SaveStore, attributeFriendly } from '../save'
import { Runtime2D, isNode2D, setWorldPosition, worldPosition } from '../classes2d'
import { assets } from '../assets'

export interface SessionOptions {
  output: OutputSink
  playerName?: string
  /** where Pyodide's files are served (defaults to ./pyodide/ next to the page) */
  pythonIndexURL?: string
  /** where SaveService keeps its slots (none: saves last only while the game runs) */
  saveBackend?: SaveBackend | null
}

export class GameSession implements Runtime, Runtime2D {
  readonly game: DataModel
  renderer!: SceneRenderer
  physics!: Physics
  luau!: LuauRuntime
  /** 2D mode (World2D.Enabled): sprites/tilemaps instead of the 3D world and avatar */
  mode2d = false
  r2d: Renderer2D | null = null
  phys2d: Physics2D | null = null
  private animator = new Animator2D()
  private animations = new AnimationRunner((inst, event, ...args) => inst.fire(event, ...args))
  private save!: SaveStore
  /** this frame's dt (CharacterBody3D:MoveAndSlide moves by Velocity * frameDt) */
  private frameDt = 1 / 60
  private syncingSave = false
  scripts!: ScriptHost
  gui!: GuiRenderer
  billboards!: BillboardLayer
  private tweens = new TweenManager()
  private controllers = new Map<Model, CharacterController>()
  private keys = new Set<string>()
  private mouseButtons = new Set<number>()
  private mouse = new Vector2(0, 0)
  private gameTime = 0
  private debris: Array<{ inst: Instance; at: number }> = []
  private running = new Set<Instance>()
  private sounds = new Map<Instance, HTMLAudioElement>()
  private player!: Instance
  private mouseObj!: Instance
  private camYaw = 0
  private camPitch = -0.35
  private camZoom = 14
  private rmbDrag: { moved: number } | null = null
  private lmbDown: { x: number; y: number } | null = null
  private hovered: Instance | null = null
  private cleanup: Array<() => void> = []
  private respawnTimer: number | null = null
  private wrapper: HTMLDivElement
  stopped = false

  private constructor(readonly container: HTMLElement, data: SerializedInstance, readonly opts: SessionOptions) {
    this.game = new DataModel()
    deserialize(data, this.game)
    this.game.initServices()
    this.game.runtime = this
    setActiveRuntime(this)
    this.wrapper = document.createElement('div')
    Object.assign(this.wrapper.style, { position: 'absolute', inset: '0', overflow: 'hidden' })
    container.appendChild(this.wrapper)
  }

  static async start(container: HTMLElement, data: SerializedInstance, opts: SessionOptions) {
    await initPhysics()
    const s = new GameSession(container, data, opts)
    await s.init()
    return s
  }

  private async init() {
    const { game } = this
    const ws = game.workspace
    // camera
    let cam = ws.children.find((c) => c.className === 'Camera')
    if (!cam) { cam = createInstance('Camera'); cam.setParent(ws) }
    ws.rawSet('CurrentCamera', cam)
    cam.name = 'Camera'

    this.renderer = new SceneRenderer(this.wrapper, game)
    this.physics = new Physics(game)
    this.mode2d = !!game.getService('World2D').get('Enabled')
    if (this.mode2d) {
      await initPhysics2D()
      this.renderer.renderer.domElement.style.display = 'none'
      this.r2d = new Renderer2D(this.wrapper, game)
      this.phys2d = new Physics2D(game)
      ;(game as any).runtime2d = this
    }
    // billboards sit over the game, under the ScreenGuis
    this.billboards = new BillboardLayer(this.wrapper, game, this.r2d ?? this.renderer)
    this.billboards.interactive = true
    this.billboards.root.style.zIndex = '4'
    this.gui = new GuiRenderer(this.wrapper)
    this.gui.root.style.zIndex = '5'
    this.luau = await LuauRuntime.create(game, this.opts.output)
    // TypeScript and Python run on the shared JS scripting host (Python only loads if the place uses it)
    this.scripts = new ScriptHost(game, this.opts.output, this.luau)
    new TypeScriptRuntime(this.scripts)
    if (game.getDescendants().some((d) => d.isA('LuaSourceContainer') && languageOf(d) === 'Python')) {
      try {
        await PythonRuntime.create(this.scripts, this.opts.pythonIndexURL)
      } catch (e) {
        this.opts.output('error', `Python failed to load: ${(e as Error)?.message ?? e}`)
      }
    }

    // script lifecycle: run scripts when they appear in a runnable location
    this.cleanup.push(game.observe({
      added: (inst) => { for (const i of [inst, ...inst.getDescendants()]) this.onAdded(i) },
      removing: (inst) => { for (const i of [inst, ...inst.getDescendants()]) this.onRemoving(i) },
      reparented: (inst) => { for (const i of [inst, ...inst.getDescendants()]) { this.onRemoving(i); this.onAdded(i) } },
      changed: (inst, prop) => {
        if (prop === 'Enabled' && isA(inst.classInfo, 'BaseScript')) {
          if (inst.get('Enabled')) this.maybeRunScript(inst)
          else if (this.running.has(inst)) { this.running.delete(inst); this.scripts.kill(inst) }
        }
        if (inst.className === 'Sound') this.soundChanged(inst, prop)
        if (inst.className === 'SaveService' && prop === 'AutoSave') this.save.autoSave = inst.get<boolean>('AutoSave') !== false
      },
    }))

    this.bindInput()

    // 0. save data, so scripts can read it straight away
    this.setupSave()
    // 1. server scripts
    for (const d of game.getDescendants()) this.maybeRunScript(d)
    this.scripts.step(0)
    // 2. NPC humanoids already in the workspace
    for (const d of ws.getDescendants()) this.maybeControl(d)
    // 3. the local player joins
    this.addPlayer()
    // 4. AnimationPlayers set to Autoplay
    this.animations.autoplay(game.getDescendants().filter((d) => d.className === 'AnimationPlayer'))

    const loop = this.r2d ?? this.renderer
    loop.onBeforeRender = (dt) => this.frame(dt)
    loop.start()
  }

  stop() {
    if (this.stopped) return
    this.save?.flush()
    this.stopped = true
    if (this.respawnTimer) clearTimeout(this.respawnTimer)
    for (const c of this.cleanup) c()
    for (const c of this.controllers.values()) c.dispose()
    for (const a of this.sounds.values()) a.pause()
    this.scripts.destroy()
    this.luau.destroy()
    this.renderer.dispose()
    this.physics.dispose()
    this.r2d?.dispose()
    this.phys2d?.dispose()
    ;(this.game as any).runtime2d = null
    this.gui.dispose()
    this.billboards?.dispose()
    this.wrapper.remove()
    this.game.runtime = null
    setActiveRuntime(null)
  }

  // ------------------------------------------------------------------ scripts
  /**
   * Scripts run in the Workspace, World2D (inside 2D objects, like scripts in parts), ScriptService and
   * under Players (GUIs, characters). Storage, StarterGui etc. hold templates.
   */
  private scriptLocationOk(s: Instance) {
    if (s.className !== 'Script') return false
    const g = this.game
    return s.isDescendantOf(g.workspace) || s.isDescendantOf(g.getService('World2D')) || s.isDescendantOf(g.getService('ScriptService')) || s.isDescendantOf(g.getService('Players'))
  }

  private maybeRunScript(s: Instance) {
    if (this.running.has(s) || !isScriptRunnable(s) || !this.scriptLocationOk(s)) return
    this.running.add(s)
    this.scripts.runScript(s)
  }

  private onAdded(i: Instance) {
    if (isA(i.classInfo, 'BaseScript')) this.maybeRunScript(i)
    if (i instanceof Model && i.isDescendantOf(this.game.workspace)) queueMicrotask(() => this.maybeControl(i))
  }

  private onRemoving(i: Instance) {
    if (this.running.has(i)) { this.running.delete(i); this.scripts.kill(i) }
    if (i instanceof Model) {
      const c = this.controllers.get(i)
      if (c) { c.dispose(); this.controllers.delete(i) }
    }
    const snd = this.sounds.get(i)
    if (snd) {
      if (i.get('PlayOnRemove')) { snd.currentTime = 0; void snd.play().catch(() => {}) } else snd.pause()
      this.sounds.delete(i)
    }
  }

  // ------------------------------------------------------------------ characters
  private maybeControl(inst: Instance) {
    if (this.controllers.has(inst as Model) || inst.destroyed || !inst.isDescendantOf(this.game.workspace)) return
    const found = findHumanoidModel(inst)
    if (!found) return
    const ctl = new CharacterController(found.model, found.humanoid, this.physics, () => this.gameTime)
    this.controllers.set(found.model, ctl)
  }

  private addPlayer() {
    const players = this.game.getService('Players')
    const p = createInstance('Player')
    p.name = this.opts.playerName ?? 'Player1'
    p.rawSet('UserId', 1)
    p.rawSet('DisplayName', p.name)
    const mouse = createInstance('Mouse'); mouse.name = '__Mouse'; mouse.setParent(p); this.mouseObj = mouse
    createInstance('PlayerGui').setParent(p)
    this.player = p
    players.rawSet('LocalPlayer', p)
    p.setParent(players)
    players.fire('PlayerAdded', p)
    // GUI + player scripts
    const playerGui = p.findFirstChild('PlayerGui')!
    for (const g of this.game.getService('StarterGui').children) g.clone().setParent(playerGui)
    this.gui.setSource(playerGui)
    this.billboards.guiSource = playerGui
    if (players.get('CharacterAutoLoads') && !this.mode2d) this.loadCharacter(p)
  }

  private scheduleRespawn() {
    if (this.respawnTimer) return
    this.respawnTimer = window.setTimeout(() => {
      this.respawnTimer = null
      if (!this.stopped && this.game.getService('Players').get('CharacterAutoLoads')) this.loadCharacter(this.player)
    }, 5000)
  }

  loadCharacter(player: Instance) {
    const old = player.get<Instance | null>('Character')
    if (old) { player.fire('CharacterRemoving', old); old.destroy() }
    const sp = this.game.getService('StarterPlayer')
    const custom = sp.findFirstChild('StarterCharacter')
    const ch = (custom instanceof Model ? custom.clone() : buildDefaultCharacter(player.name)) as Model
    ch.name = player.name
    const hum = ch.findFirstChildOfClass('Humanoid') as Humanoid
    if (hum) {
      hum.rawSet('WalkSpeed', sp.get('CharacterWalkSpeed'))
      hum.rawSet('JumpPower', sp.get('CharacterJumpPower'))
    }
    // spawn location
    const spawns = this.game.workspace.getDescendants().filter((d) => d.className === 'SpawnLocation' && d.get('Enabled')) as BasePart[]
    const spawn = spawns.length ? spawns[Math.floor(Math.random() * spawns.length)] : null
    const base = spawn ? spawn.cframe.position.add(new Vector3(0, spawn.size.y / 2 + 3.05, 0)) : new Vector3(0, 10, 0)
    ch.pivotTo(CFrame.fromPosition(base))
    const scs = sp.findFirstChild('StarterCharacterScripts')
    if (scs) for (const s of scs.children) s.clone().setParent(ch)
    player.set('Character', ch)
    // reset GUIs that ResetOnSpawn
    if (old) {
      const pg = player.findFirstChild('PlayerGui')!
      for (const g of [...pg.children]) if (g.get('ResetOnSpawn')) g.destroy()
      for (const g of this.game.getService('StarterGui').children) if (g.get('ResetOnSpawn')) g.clone().setParent(pg)
    }
    ch.setParent(this.game.workspace)
    this.maybeControl(ch)
    const cam = this.camera()
    cam.set('CameraSubject', hum)
    player.fire('CharacterAdded', ch)
  }

  private localController(): CharacterController | null {
    const ch = this.player?.get<Model | null>('Character')
    return ch ? this.controllers.get(ch) ?? null : null
  }

  // ------------------------------------------------------------------ frame
  private camera() { return this.game.workspace.get<Instance>('CurrentCamera') }

  private frame(dt: number) {
    if (this.stopped) return
    this.frameDt = dt
    this.gameTime += dt
    const rs = this.game.getService('RunService')
    this.scripts.fireFrame(rs, 'Stepped', [this.gameTime, dt])
    this.scripts.fireFrame(rs, 'PreSimulation', [dt])

    // player movement from keyboard (camera relative)
    const ctl = this.localController()
    if (ctl) {
      const typing = !!(this.gui.focused || this.billboards.focused)
      const f = typing ? 0 : (this.keys.has('W') || this.keys.has('Up') ? 1 : 0) - (this.keys.has('S') || this.keys.has('Down') ? 1 : 0)
      const r = typing ? 0 : (this.keys.has('D') ? 1 : 0) - (this.keys.has('A') ? 1 : 0)
      const fwd = new Vector3(-Math.sin(this.camYaw), 0, -Math.cos(this.camYaw))
      const right = new Vector3(Math.cos(this.camYaw), 0, -Math.sin(this.camYaw))
      let move = fwd.mul(f).add(right.mul(r))
      if (move.magnitude > 0) move = move.unit
      ctl.inputMove = move
      if (!typing && this.keys.has('Space')) ctl.jump()
    }

    if (this.mode2d) {
      this.phys2d!.step(dt)
      this.animator.update(dt, this.r2d!.drawList.map((v) => v.inst),
        (inst, frame) => { inst.set('Frame', frame); inst.fire('FrameChanged', frame) },
        (inst, name) => { inst.set('Playing', false); inst.fire('AnimationFinished', name) })
    } else {
      this.physics.step(dt, (sdt) => { for (const c of this.controllers.values()) c.update(sdt) })
    }
    this.checkDeaths()
    this.tweens.update(dt)
    this.animations.update(dt)
    // debris
    if (this.debris.length) {
      const due = this.debris.filter((d) => d.at <= this.gameTime)
      this.debris = this.debris.filter((d) => d.at > this.gameTime)
      for (const d of due) d.inst.destroy()
    }
    this.scripts.step(this.gameTime)
    this.scripts.fireFrame(rs, 'PostSimulation', [dt])
    this.scripts.fireFrame(rs, 'Heartbeat', [dt])

    if (this.mode2d) {
      this.scripts.renderStep(dt)
      this.scripts.fireFrame(rs, 'RenderStepped', [dt])
      this.updateCamera2D(dt)
      this.updateMouse2D()
      return
    }
    this.updateCamera(dt)
    this.scripts.renderStep(dt)
    this.scripts.fireFrame(rs, 'RenderStepped', [dt])
    const cam = this.camera()
    if (cam) this.renderer.setCameraCFrame(cam.get<CFrame>('CFrame'), cam.get<number>('FieldOfView'))
    this.updateMouse()
  }

  // ------------------------------------------------------------------ 2D
  private camera2D(): Instance | null {
    const w2d = this.game.getService('World2D')
    const cur = w2d.get<Instance | null>('CurrentCamera')
    if (cur && !cur.destroyed) return cur
    return w2d.getDescendants().find((d) => d.className === 'Camera2D') ?? null
  }

  private updateCamera2D(dt: number) {
    const r = this.r2d!
    const cam = this.camera2D()
    if (!cam) { r.view = { x: 0, y: 0, zoom: 1 }; return }
    const follow = cam.get<Instance | null>('Follow')
    if (follow && !follow.destroyed && isNode2D(follow)) {
      const target = worldPosition(follow).add(cam.get<Vector2>('Offset'))
      const cur = worldPosition(cam)
      const sm = Math.min(0.99, Math.max(0, cam.get<number>('Smoothing') ?? 0))
      const k = sm <= 0 ? 1 : 1 - Math.pow(sm, dt * 60)
      setWorldPosition(cam, new Vector2(cur.x + (target.x - cur.x) * k, cur.y + (target.y - cur.y) * k))
    }
    const p = worldPosition(cam)
    r.view = { x: p.x, y: p.y, zoom: Math.max(0.05, cam.get<number>('Zoom') ?? 1) }
  }

  private updateMouse2D() {
    const m = this.mouseObj
    if (!m) return
    m.rawSet('X', this.mouse.x)
    m.rawSet('Y', this.mouse.y)
    const target = this.r2d!.pick(this.r2d!.viewportToWorld(this.mouse.x, this.mouse.y))
    const cd = target ? clickDetectorFor(target) : null
    if (cd !== this.hovered) {
      this.hovered?.fire('MouseHoverLeave', this.player)
      cd?.fire('MouseHoverEnter', this.player)
      this.hovered = cd
      this.r2d!.renderer.domElement.style.cursor = cd ? 'pointer' : 'default'
    }
  }

  // Runtime2D
  moveAndSlide(body: Instance) { return this.phys2d ? this.phys2d.moveAndSlide(body) : body.get<Vector2>('Velocity') }
  bodyState(body: Instance) { return this.phys2d!.bodyState(body) }
  applyImpulse2D(body: Instance, v: Vector2) { this.phys2d?.applyImpulse(body, v) }
  screenToWorld2D(p: Vector2) { return this.r2d ? this.r2d.viewportToWorld(p.x, p.y) : p }
  worldToScreen2D(p: Vector2) { return this.r2d ? this.r2d.worldToViewport(p) : p }
  raycast2D(origin: Vector2, direction: Vector2, exclude: Instance[]) { return this.phys2d ? this.phys2d.raycast(origin, direction, exclude) : null }

  private deadSeen = new Set<Humanoid>()
  private checkDeaths() {
    for (const [model, ctl] of this.controllers) {
      if (ctl.humanoid.dead && !this.deadSeen.has(ctl.humanoid)) {
        this.deadSeen.add(ctl.humanoid)
        ctl.die()
        this.controllers.delete(model)
        if (this.player && this.player.get('Character') === model) this.scheduleRespawn()
        // character debris cleanup
        if (this.player?.get('Character') !== model) this.addDebris(model, 8)
      }
    }
  }

  private updateCamera(_dt: number) {
    const cam = this.camera()
    if (!cam) return
    const type = cam.get<EnumItem>('CameraType')?.name
    if (type !== 'Custom') return
    const subject = cam.get<Instance | null>('CameraSubject')
    let focus: Vector3 | null = null
    let ignore: Instance | null = null
    if (subject instanceof Humanoid && subject.parent) {
      const head = subject.parent.findFirstChild('Head') ?? subject.parent.findFirstChild('HumanoidRootPart')
      if (head instanceof BasePart) focus = head.cframe.position.add(new Vector3(0, head.name === 'Head' ? 0.5 : 1.5, 0))
      ignore = subject.parent
    } else if (subject instanceof BasePart) {
      // a CharacterBody3D: look at its upper body; the ray that keeps the camera out of walls skips it
      focus = subject.className === 'CharacterBody3D' ? subject.cframe.position.add(new Vector3(0, subject.size.y * 0.35, 0)) : subject.cframe.position
      ignore = subject
    }
    if (!focus) return
    const sp = this.game.getService('StarterPlayer')
    this.camZoom = Math.min(Math.max(this.camZoom, sp.get<number>('CameraMinZoomDistance')), sp.get<number>('CameraMaxZoomDistance'))
    const rot = CFrame.fromOrientation(Vector3.zero, new Vector3((this.camPitch * 180) / Math.PI, (this.camYaw * 180) / Math.PI, 0))
    const back = rot.vectorToWorld(new Vector3(0, 0, 1))
    let dist = this.camZoom
    // pull camera in front of walls
    const hit = this.physics.raycast(focus, back.mul(dist), ignore ? new Map<string, unknown>([['FilterDescendantsInstances', new Map([[1, ignore]])]]) : null)
    if (hit) dist = Math.max(0.5, (hit.get('Distance') as number) - 0.5)
    const pos = focus.add(back.mul(dist))
    cam.set('CFrame', rot.withPosition(pos))
    cam.rawSet('Focus', CFrame.fromPosition(focus))
    // first person: hide own character
    if (ignore) {
      const first = this.camZoom <= 1
      for (const d of ignore.getDescendants()) if (d instanceof BasePart) this.renderer.setLocalTransparency(d, first ? 1 : null)
    }
  }

  private updateMouse() {
    const m = this.mouseObj
    if (!m) return
    const rect = this.renderer.renderer.domElement.getBoundingClientRect()
    const hit = this.renderer.pick(this.mouse.x + rect.left, this.mouse.y + rect.top, (i) => (i.get<number>('Transparency') ?? 0) >= 1)
    const target = hit?.inst ?? null
    const hitPos = hit ? new Vector3(hit.point.x, hit.point.y, hit.point.z) : this.screenPointToRay(this.mouse.x, this.mouse.y).reduce((o, d) => o.add(d.mul(1000)))
    const camPos = this.renderer.camera.position
    m.rawSet('Hit', CFrame.lookAt(new Vector3(camPos.x, camPos.y, camPos.z), hitPos).withPosition(hitPos))
    m.rawSet('Target', target)
    m.rawSet('X', this.mouse.x)
    m.rawSet('Y', this.mouse.y)
    // ClickDetector hover
    const cd = target ? clickDetectorFor(target) : null
    if (cd !== this.hovered) {
      this.hovered?.fire('MouseHoverLeave', this.player)
      cd?.fire('MouseHoverEnter', this.player)
      this.hovered = cd
      this.renderer.renderer.domElement.style.cursor = cd ? 'pointer' : 'default'
    }
  }

  // ------------------------------------------------------------------ input
  private bindInput() {
    const el = (this.r2d ?? this.renderer).renderer.domElement
    const uis = () => this.game.getService('UserInputService')
    const makeInput = (type: string, state: string, key = 'Unknown', pos = Vector3.zero, delta = Vector3.zero) => {
      const io = createInstance('InputObject')
      io.rawSet('UserInputType', enumItem('UserInputType', type))
      io.rawSet('UserInputState', enumItem('UserInputState', state))
      io.rawSet('KeyCode', enumItem('KeyCode', key))
      io.rawSet('Position', pos)
      io.rawSet('Delta', delta)
      return io
    }
    const on = <K extends keyof WindowEventMap>(target: Window | HTMLElement, ev: K, fn: (e: WindowEventMap[K]) => void, opts?: AddEventListenerOptions) => {
      target.addEventListener(ev, fn as EventListener, opts)
      this.cleanup.push(() => target.removeEventListener(ev, fn as EventListener, opts))
    }
    // right-drag turns the default camera; the cursor stays put while the button is held
    const look = new DragLook(el)
    this.cleanup.push(() => look.dispose())
    on(window, 'keydown', (e) => {
      if (this.stopped || e.repeat) return
      const t = e.target as HTMLElement
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) && !this.wrapper.contains(t)) return
      const key = keyCodeName(e.code)
      const processed = !!(this.gui.focused || this.billboards.focused)
      if (!processed && ['Space', 'Up', 'Down', 'Tab'].includes(key)) e.preventDefault()
      if (!processed) this.keys.add(key)
      const io = makeInput('Keyboard', 'Begin', key)
      uis().fire('InputBegan', io, processed)
      if (!processed) {
        this.luau.contextAction(key, 'Begin', io)
        if (key === 'Space') uis().fire('JumpRequest')
        this.mouseObj?.fire('KeyDown', e.key.toLowerCase())
        if (key === 'I' || key === 'O') this.camZoom *= key === 'I' ? 0.8 : 1.25
      }
    })
    on(window, 'keyup', (e) => {
      if (this.stopped) return
      const key = keyCodeName(e.code)
      this.keys.delete(key)
      const io = makeInput('Keyboard', 'End', key)
      uis().fire('InputEnded', io, !!(this.gui.focused || this.billboards.focused))
      this.luau.contextAction(key, 'End', io)
      this.mouseObj?.fire('KeyUp', e.key.toLowerCase())
    })
    on(window, 'blur', () => this.keys.clear())
    on(el, 'contextmenu', (e) => e.preventDefault())
    on(el, 'mousedown', (e) => {
      el.focus()
      const rect = el.getBoundingClientRect()
      const pos = new Vector3(e.clientX - rect.left, e.clientY - rect.top, 0)
      this.mouseButtons.add(e.button)
      const type = e.button === 0 ? 'MouseButton1' : e.button === 2 ? 'MouseButton2' : 'MouseButton3'
      uis().fire('InputBegan', makeInput(type, 'Begin', 'Unknown', pos), false)
      if (e.button === 2) {
        this.rmbDrag = { moved: 0 }
        // only the default 3D camera turns with right-drag; elsewhere the cursor stays free
        if (!this.mode2d && this.camera()?.get<EnumItem>('CameraType')?.name === 'Custom') look.begin(e)
      }
      if (e.button === 0) { this.lmbDown = { x: e.clientX, y: e.clientY }; this.mouseObj?.fire('Button1Down') }
      if (e.button === 2) this.mouseObj?.fire('Button2Down')
    })
    on(window, 'mouseup', (e) => {
      if (!this.mouseButtons.has(e.button)) return
      this.mouseButtons.delete(e.button)
      const rect = el.getBoundingClientRect()
      const pos = new Vector3(e.clientX - rect.left, e.clientY - rect.top, 0)
      const type = e.button === 0 ? 'MouseButton1' : e.button === 2 ? 'MouseButton2' : 'MouseButton3'
      uis().fire('InputEnded', makeInput(type, 'End', 'Unknown', pos), false)
      if (e.button === 2) {
        const r = this.rmbDrag
        this.rmbDrag = null
        look.end()
        if (r && r.moved <= 2) this.click(true)
        this.mouseObj?.fire('Button2Up')
      }
      if (e.button === 0) {
        this.mouseObj?.fire('Button1Up')
        const d = this.lmbDown
        this.lmbDown = null
        if (d && Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) this.click(false)
      }
    })
    on(window, 'mousemove', (e) => {
      const rect = el.getBoundingClientRect()
      // while the cursor is locked its position doesn't change, so Mouse.X/Y stay where the drag began
      this.mouse = new Vector2(e.clientX - rect.left, e.clientY - rect.top)
      const d = this.rmbDrag && look.move(e)
      if (this.rmbDrag && !look.dragging) this.rmbDrag.moved += Math.abs(e.movementX) + Math.abs(e.movementY)
      if (this.rmbDrag && d) {
        this.rmbDrag.moved += Math.abs(d.dx) + Math.abs(d.dy)
        this.camYaw -= d.dx * 0.008
        this.camPitch = Math.min(1.4, Math.max(-1.4, this.camPitch - d.dy * 0.008))
      }
      if (this.scripts.isListening(uis(), 'InputChanged')) {
        uis().fire('InputChanged', makeInput('MouseMovement', 'Change', 'Unknown', new Vector3(this.mouse.x, this.mouse.y, 0), new Vector3(e.movementX, e.movementY, 0)), false)
      }
      if (this.mouseObj && this.scripts.isListening(this.mouseObj, 'Move')) this.mouseObj.fire('Move')
    })
    on(el, 'wheel', (e) => {
      e.preventDefault()
      this.camZoom *= e.deltaY > 0 ? 1.15 : 1 / 1.15
      if (this.mouseObj) this.mouseObj.fire(e.deltaY > 0 ? 'WheelBackward' : 'WheelForward')
    }, { passive: false })
  }

  private click(right: boolean) {
    const target = this.mode2d
      ? this.r2d!.pick(this.r2d!.viewportToWorld(this.mouse.x, this.mouse.y))
      : this.mouseObj?.get<Instance | null>('Target')
    if (!target) return
    const cd = clickDetectorFor(target)
    if (!cd) return
    const ch = this.player.get<Model | null>('Character')
    const root = ch?.findFirstChild('HumanoidRootPart') as BasePart | null
    if (root && target instanceof BasePart) {
      const dist = root.cframe.position.sub(target.cframe.position).magnitude
      if (dist > cd.get<number>('MaxActivationDistance')) return
    }
    cd.fire(right ? 'RightMouseClick' : 'MouseClick', this.player)
  }

  // ------------------------------------------------------------------ Runtime interface
  raycast(origin: Vector3, direction: Vector3, params: Map<string, unknown> | null) {
    return this.physics.raycast(origin, direction, params)
  }
  isKeyDown(key: EnumItem) { return this.keys.has(key.name) }
  isMouseButtonPressed(t: EnumItem) {
    return this.mouseButtons.has(t.name === 'MouseButton1' ? 0 : t.name === 'MouseButton2' ? 2 : 1)
  }
  mouseLocation() { return this.mouse }
  viewportSize() {
    const el = (this.r2d ?? this.renderer)?.renderer.domElement
    return new Vector2(el?.clientWidth ?? 0, el?.clientHeight ?? 0)
  }
  worldToScreen(p: Vector3): [Vector3, boolean] {
    const v = new THREE.Vector3(p.x, p.y, p.z)
    const cam = this.renderer.camera
    const inFront = v.clone().applyMatrix4(cam.matrixWorldInverse).z < 0
    v.project(cam)
    const size = this.viewportSize()
    return [new Vector3((v.x + 1) / 2 * size.x, (1 - v.y) / 2 * size.y, v.z), inFront && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1]
  }
  screenPointToRay(x: number, y: number): [Vector3, Vector3] {
    const size = this.viewportSize()
    const ray = new THREE.Raycaster()
    ray.setFromCamera(new THREE.Vector2((x / size.x) * 2 - 1, -(y / size.y) * 2 + 1), this.renderer.camera)
    return [Vector3.fromThree(ray.ray.origin), Vector3.fromThree(ray.ray.direction)]
  }
  applyImpulse(part: Instance, v: Vector3) { this.physics.applyImpulse(part as BasePart, v) }
  getMass(part: Instance) { return this.physics.getMass(part as BasePart) }
  createTween(inst: Instance, info: TweenInfoData, goals: Map<string, unknown>) { return this.tweens.create(inst, info, goals) }
  tweenControl(tween: Instance, action: 'Play' | 'Pause' | 'Cancel') { this.tweens.control(tween, action) }
  addDebris(inst: Instance, lifetime: number) { this.debris.push({ inst, at: this.gameTime + lifetime }) }
  humanoidMove(h: Instance, dir: Vector3) {
    const c = h.parent ? this.controllers.get(h.parent as Model) : null
    c?.move(dir)
  }
  humanoidMoveTo(h: Instance, pos: Vector3) {
    const c = h.parent ? this.controllers.get(h.parent as Model) : null
    c?.moveTo(pos)
  }
  humanoidJump(h: Instance) {
    const c = h.parent ? this.controllers.get(h.parent as Model) : null
    c?.jump()
  }
  kick(_player: Instance, message: string) {
    this.opts.output('warn', `Kicked: ${message || 'You have been kicked from the game'}`)
    this.stop()
  }
  time() { return this.gameTime }

  // ------------------------------------------------------------------ save data
  private setupSave() {
    const svc = this.game.getService('SaveService')
    // SaveService's attributes in the editor are the starting values for a new save
    const defaults = new Map(svc.attributes)
    const mirror = (key: string, value: unknown) => {
      // simple values also live as attributes, so GetAttribute / GetAttributeChangedSignal work
      this.syncingSave = true
      try {
        if (value != null && attributeFriendly(value)) svc.attributes.set(key, value)
        else svc.attributes.delete(key)
        svc.fire('AttributeChanged', key)
        svc.fire('AttributeChanged:' + key)
      } finally { this.syncingSave = false }
    }
    this.save = new SaveStore(this.opts.saveBackend ?? null, defaults, {
      changed: (key, value) => { mirror(key, value); svc.fire('Changed', key, value); this.game.notifyChanged(svc, 'Attributes') },
      loaded: (slot) => {
        svc.set('Slot', slot)
        for (const k of new Set([...svc.attributes.keys(), ...this.save.all().keys()])) mirror(k, this.save.get(k))
        this.game.notifyChanged(svc, 'Attributes')
        svc.fire('Loaded', slot)
      },
      saved: (slot) => svc.fire('Saved', slot),
      warn: (message) => this.opts.output('warn', message, 'SaveService'),
    })
    this.save.autoSave = svc.get<boolean>('AutoSave') !== false
    this.save.load(DEFAULT_SLOT)
    // closing the window / tab: write anything not saved yet
    const flush = () => this.save.flush()
    window.addEventListener('pagehide', flush)
    window.addEventListener('beforeunload', flush)
    this.cleanup.push(() => { window.removeEventListener('pagehide', flush); window.removeEventListener('beforeunload', flush) })
  }

  saveStore() { return this.save }

  moveAndSlide3D(body: Instance) { return this.physics.moveAndSlide(body as BasePart, this.frameDt) }
  bodyState3D(body: Instance) { return this.physics.characterState(body as BasePart) }
  saveAttributeSet(key: string, value: unknown) {
    if (this.syncingSave) return
    this.syncingSave = true
    try { this.save.set(key, value) } finally { this.syncingSave = false }
  }

  animationControl(player: Instance, action: 'Play' | 'Stop' | 'Pause' | 'Resume' | 'Seek', arg?: unknown) {
    switch (action) {
      case 'Play': this.animations.play(player, arg as string | null); break
      case 'Stop': this.animations.stop(player); break
      case 'Pause': this.animations.pause(player); break
      case 'Resume': this.animations.resume(player); break
      case 'Seek': this.animations.seek(player, Number(arg) || 0); break
    }
  }

  soundControl(sound: Instance, action: 'Play' | 'Stop' | 'Pause' | 'Resume') {
    let a = this.sounds.get(sound)
    const id = sound.get<string>('SoundId')
    if (!a) {
      a = new Audio()
      a.addEventListener('ended', () => { sound.rawSet('Playing', false); sound.fire('Ended', id) })
      this.sounds.set(sound, a)
    }
    const url = assets.url(id)
    if (!url) {
      if (action === 'Play') this.opts.output('warn', id ? `Sound "${sound.getFullName()}": asset "${id}" was not found` : `Sound "${sound.getFullName()}" has no SoundId — import an audio file in the Assets panel`)
      return
    }
    if (a.src !== url) a.src = url
    a.volume = Math.min(1, Math.max(0, sound.get<number>('Volume')))
    a.loop = !!sound.get('Looped')
    a.playbackRate = sound.get<number>('PlaybackSpeed') || 1
    if (action === 'Play') { a.currentTime = 0; void a.play().catch(() => {}); sound.rawSet('Playing', true); sound.fire('Played', id) }
    if (action === 'Resume') { void a.play().catch(() => {}); sound.rawSet('Playing', true) }
    if (action === 'Pause') { a.pause(); sound.rawSet('Playing', false) }
    if (action === 'Stop') { a.pause(); a.currentTime = 0; sound.rawSet('Playing', false) }
  }

  private soundChanged(sound: Instance, prop: string) {
    const a = this.sounds.get(sound)
    if (prop === 'Playing') {
      const playing = sound.get('Playing')
      if (playing && (!a || a.paused)) this.soundControl(sound, 'Play')
      if (!playing && a && !a.paused) this.soundControl(sound, 'Pause')
      return
    }
    if (!a) return
    if (prop === 'Volume') a.volume = Math.min(1, Math.max(0, sound.get<number>('Volume')))
    if (prop === 'Looped') a.loop = !!sound.get('Looped')
    if (prop === 'PlaybackSpeed') a.playbackRate = sound.get<number>('PlaybackSpeed') || 1
  }
}

function clickDetectorFor(part: Instance): Instance | null {
  for (let p: Instance | null = part; p && p.className !== 'Workspace'; p = p.parent) {
    const cd = p.findFirstChildOfClass('ClickDetector')
    if (cd) return cd
  }
  return null
}
