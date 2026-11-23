// A running game: DataModel + Luau VM + physics + rendering + input + GUI.
// Used by the editor's Play mode and by the standalone (Electron) player.
import * as THREE from 'three'
import { CFrame, EnumItem, Vector2, Vector3, enumItem } from '../datatypes'
import { Instance, SerializedInstance, createInstance, deserialize, isA } from '../instance'
import { BasePart, DataModel, Humanoid, Model, NetRole, Runtime, TweenInfoData, isScriptRunnable, setActiveRuntime } from '../classes'
import { NetClient, NetHost, ownerOf } from '../net/Replicator'
import type { ClientLink, HostLink } from '../net/transport'
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
  /**
   * Multiplayer (NetworkService.Enabled): host the game for others, or play in someone's game. A
   * client's `data` is the host's snapshot from the welcome message, and `player` its Player's id there.
   */
  network?: { role: 'host'; link: HostLink; placeName?: string } | { role: 'client'; link: ClientLink; player: number }
  /** a client lost its host (or was kicked) */
  onDisconnect?: (reason: string) => void
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
  // ---- multiplayer
  netHost: NetHost | null = null
  netClient: NetClient | null = null
  /** a client: the host's instance ids -> this machine's copies (filled while loading the snapshot) */
  private netMap = new Map<number, Instance>()
  private nextUserId = 2
  private remoteRespawns = new Map<Instance, number>()
  private invokes = new Map<number, { done: boolean; ok: boolean; value: unknown }>()
  private answers = new Map<number, (ok: boolean, value: unknown) => void>()
  private nextRequest = 1

  private constructor(readonly container: HTMLElement, data: SerializedInstance, readonly opts: SessionOptions) {
    this.game = new DataModel()
    deserialize(data, this.game, this.netMap)
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
    if (this.opts.network) this.physics.isRemote = (p) => this.isRemote(p)
    this.mode2d = !!game.getService('World2D').get('Enabled')
    if (this.mode2d) {
      await initPhysics2D()
      this.renderer.renderer.domElement.style.display = 'none'
      this.r2d = new Renderer2D(this.wrapper, game)
      this.phys2d = new Physics2D(game)
      if (this.opts.network) this.phys2d.isRemote = (b) => this.isRemote(b)
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
        if (prop === 'Health' && inst instanceof Humanoid && this.netRole() === 'host') this.checkRemoteDeath(inst)
      },
    }))

    this.bindInput()

    // 0. save data, so scripts can read it straight away
    this.setupSave()
    // a player in someone else's game: this machine's player is already in the snapshot
    const net = this.opts.network
    if (net?.role === 'client') {
      this.player = this.netMap.get(net.player)!
      game.getService('Players').rawSet('LocalPlayer', this.player) // before any LocalScript starts
      // listening before the scripts start: what they change straight away (on things this player owns) goes to the host
      this.netClient = new NetClient({
        game, localPlayer: () => this.player ?? null,
        invokeHere: (r, e, a, answer) => this.invokeHere(r, e, a, answer),
        ownershipChanged: () => this.ownershipChanged(),
        disconnected: (reason) => this.disconnected(reason),
      }, net.link, this.netMap)
    }
    // 1. scripts (a client runs only LocalScripts; the host runs both)
    for (const d of game.getDescendants()) this.maybeRunScript(d)
    this.scripts.step(0)
    // 2. NPC humanoids already in the workspace
    for (const d of ws.getDescendants()) this.maybeControl(d)
    // 3. the local player joins
    if (net?.role === 'client') this.joinAsClient()
    else this.addPlayer()
    for (const d of game.getDescendants()) this.maybeRunScript(d) // the LocalScripts, now there is a LocalPlayer
    // 4. multiplayer: start hosting, or listening to the host
    if (net?.role === 'host') this.netHost = new NetHost(this.hostHooks(net.placeName ?? 'Game'), net.link)
    if (net?.role === 'client') this.netClient!.start() // and now what the host sent meanwhile
    // 4. AnimationPlayers set to Autoplay
    this.animations.autoplay(game.getDescendants().filter((d) => d.className === 'AnimationPlayer'))

    const loop = this.r2d ?? this.renderer
    loop.onBeforeRender = (dt) => this.frame(dt)
    loop.start()
    if (net) {
      // a hidden window gets no animation frames: keep the game (and everyone else's) going anyway
      const keepAlive = window.setInterval(() => {
        const now = performance.now()
        if (now - this.lastFrameAt < 250) return
        this.frame(Math.min(0.1, (now - this.lastFrameAt) / 1000))
      }, 50)
      this.cleanup.push(() => clearInterval(keepAlive))
    }
  }
  private lastFrameAt = performance.now()

  stop() {
    if (this.stopped) return
    this.save?.flush()
    this.stopped = true
    if (this.respawnTimer) clearTimeout(this.respawnTimer)
    for (const c of this.cleanup) c()
    for (const c of this.controllers.values()) c.dispose()
    for (const a of this.sounds.values()) a.pause()
    this.netHost?.dispose()
    this.netClient?.dispose()
    for (const t of this.remoteRespawns.values()) clearTimeout(t)
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
    if (s.className !== 'Script' && s.className !== 'LocalScript') return false
    // LocalScripts start once this machine's player exists (LocalPlayer is set), as in Roblox
    if (s.className === 'LocalScript' && !this.player) return false
    const role = this.netRole()
    // multiplayer: Scripts run on the host only
    if (s.className === 'Script' && role === 'client') return false
    const g = this.game
    if (!(s.isDescendantOf(g.workspace) || s.isDescendantOf(g.getService('World2D')) || s.isDescendantOf(g.getService('ScriptService')) || s.isDescendantOf(g.getService('Players')))) return false
    if (s.className === 'LocalScript' && role !== 'solo') {
      // LocalScripts belong to one player: inside another player's character or Player, they don't run here
      const owner = ownerOf(s, g)
      if (owner && owner !== this.player) return false
      for (let p = s.parent; p; p = p.parent) if (p.className === 'Player' && p !== this.player) return false
      if (!this.player && s.isDescendantOf(g.getService('Players'))) return false
    }
    return true
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
    // multiplayer: each machine moves only its own humanoids (the host: NPCs and its player; a player: their character)
    if (this.isRemote(found.model)) return
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
    // somewhere on the pad, not inside another player (multiplayer: everyone spawns on the same pads)
    const others = this.game.getService('Players').children
      .map((p) => p.get<Model | null>('Character')).filter((c): c is Model => !!c && c !== old && !c.destroyed)
      .map((c) => c.getPivot().position)
    const spot = () => {
      if (!spawn) return new Vector3(0, 10, 0)
      const top = spawn.cframe.position.add(new Vector3(0, spawn.size.y / 2 + 3.05, 0))
      if (!others.length) return top
      const rx = Math.max(0, spawn.size.x / 2 - 2), rz = Math.max(0, spawn.size.z / 2 - 2)
      return top.add(new Vector3((Math.random() * 2 - 1) * rx, 0, (Math.random() * 2 - 1) * rz))
    }
    let base = spot()
    for (let i = 0; i < 12 && others.some((o) => new Vector3(o.x - base.x, 0, o.z - base.z).magnitude < 3); i++) base = spot()
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
    if (player === this.player) this.camera().set('CameraSubject', hum)
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
    this.lastFrameAt = performance.now()
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
    // multiplayer: send this frame's changes (every TICK), glide what others move
    this.netHost?.update(dt)
    this.netClient?.update(dt)

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
        // (in someone else's game, the host brings the character back)
        if (this.player && this.player.get('Character') === model && this.netRole() !== 'client') this.scheduleRespawn()
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
  kick(player: Instance, message: string) {
    if (player !== this.player && this.netHost?.kick(player, message || 'You were removed from the game.')) return
    this.opts.output('warn', `Kicked: ${message || 'You have been kicked from the game'}`)
    this.stop()
  }

  // ------------------------------------------------------------------ multiplayer
  netRole(): NetRole { return this.opts.network?.role ?? 'solo' }

  /** Instance:SetNetworkOwner: hand an object (and what is inside it) to a player's machine, or back (null). */
  setNetworkOwner(inst: Instance, player: Instance | null) {
    if (this.netRole() === 'client') throw new Error('SetNetworkOwner can only be used on the host (from a Script)')
    if (player && (player.className !== 'Player' || player.parent !== this.game.getService('Players'))) {
      throw new Error('SetNetworkOwner: argument 1 must be a Player in the game (or nil to give it back to the host)')
    }
    if (inst instanceof DataModel || inst.parent === this.game) throw new Error(`SetNetworkOwner can't be used on ${inst.name}`)
    // the host owning it is the same as nobody owning it
    inst.set('NetworkOwner', player === this.player ? null : player)
  }

  networkOwner(inst: Instance): Instance | null { return ownerOf(inst, this.game) }
  hostAddress() { return this.netHost?.address ?? '' }

  /** Something another machine moves: another player's character, or (on a player's machine) the host's world. */
  private isRemote(inst: Instance): boolean {
    const role = this.netRole()
    if (role === 'solo') return false
    const owner = ownerOf(inst, this.game)
    return role === 'host' ? !!owner && owner !== this.player : owner !== this.player
  }

  /** A character changed hands (joined, respawned): physics, controls, camera and scripts follow. */
  private ownershipChanged() {
    queueMicrotask(() => {
      if (this.stopped) return
      this.physics.refreshRemote()
      // humanoids move on whichever machine controls them now
      for (const [model, ctl] of this.controllers) if (this.isRemote(model)) { ctl.dispose(); this.controllers.delete(model) }
      for (const d of this.game.workspace.getDescendants()) if (d instanceof Model) this.maybeControl(d)
      const ch = this.player?.get<Instance | null>('Character')
      if (ch && !ch.destroyed) {
        this.maybeControl(ch)
        if (this.netRole() === 'client') {
          const hum = ch.findFirstChildOfClass('Humanoid')
          if (hum) this.camera()?.set('CameraSubject', hum)
          // LocalScripts that arrived with the character before it was known to be ours
          for (const d of ch.getDescendants()) this.maybeRunScript(d)
        }
      }
    })
  }

  private hostHooks(placeName: string) {
    return {
      game: this.game, placeName,
      hostPlayer: () => this.player,
      addPlayer: (name: string) => this.addRemotePlayer(name),
      removePlayer: (p: Instance) => this.removeRemotePlayer(p),
      invokeHere: (r: Instance, e: '__ServerInvoke', a: unknown[], answer: (ok: boolean, value: unknown) => void) => this.invokeHere(r, e, a, answer),
      ownershipChanged: () => this.ownershipChanged(),
      output: (kind: 'info' | 'warn' | 'error', msg: string) => this.opts.output(kind, msg),
      assets: () => assets.serialize(),
    }
  }

  /** Host: a player joined over the network. */
  private addRemotePlayer(name: string): Instance | string {
    const players = this.game.getService('Players')
    const max = Math.max(1, this.game.getService('NetworkService').get<number>('MaxPlayers') ?? 8)
    const count = players.children.filter((c) => c.className === 'Player').length
    if (count >= max) return `The game is full (${max} players).`
    let unique = name, n = 2
    while (players.children.some((c) => c.className === 'Player' && c.name === unique)) unique = `${name}${n++}`
    const p = createInstance('Player')
    p.name = unique
    p.rawSet('UserId', this.nextUserId++)
    p.rawSet('DisplayName', unique)
    createInstance('PlayerGui').setParent(p) // stays on the host: that player's GUI lives on their machine
    p.setParent(players)
    players.fire('PlayerAdded', p)
    if (players.get('CharacterAutoLoads') && !this.mode2d) this.loadCharacter(p)
    return p
  }

  private removeRemotePlayer(p: Instance) {
    const players = this.game.getService('Players')
    players.fire('PlayerRemoving', p)
    const t = this.remoteRespawns.get(p)
    if (t) { clearTimeout(t); this.remoteRespawns.delete(p) }
    const ch = p.get<Instance | null>('Character')
    if (ch && !ch.destroyed) ch.destroy()
    p.destroy()
  }

  /** Host: another player's character died; bring them back like the host's own. */
  private checkRemoteDeath(h: Humanoid) {
    if ((h.get<number>('Health') ?? 1) > 0 || !h.parent) return
    const owner = ownerOf(h, this.game)
    if (!owner || owner === this.player || this.remoteRespawns.has(owner)) return
    this.remoteRespawns.set(owner, window.setTimeout(() => {
      this.remoteRespawns.delete(owner)
      if (!this.stopped && !owner.destroyed && this.game.getService('Players').get('CharacterAutoLoads') && !this.mode2d) this.loadCharacter(owner)
    }, 5000))
  }

  /** A player in someone else's game: GUI, mouse and character for the Player the host made for us. */
  private joinAsClient() {
    const players = this.game.getService('Players')
    const p = this.player
    const mouse = createInstance('Mouse'); mouse.name = '__Mouse'; mouse.setParent(p); this.mouseObj = mouse
    createInstance('PlayerGui').setParent(p)
    players.rawSet('LocalPlayer', p)
    const playerGui = p.findFirstChild('PlayerGui')!
    for (const g of this.game.getService('StarterGui').children) g.clone().setParent(playerGui)
    this.gui.setSource(playerGui)
    this.billboards.guiSource = playerGui
    for (const d of p.getDescendants()) this.maybeRunScript(d)
    this.ownershipChanged()
  }

  private disconnected(reason: string) {
    this.opts.output('warn', reason)
    const box = document.createElement('div')
    Object.assign(box.style, {
      position: 'absolute', inset: '0', zIndex: '50', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: 'rgba(10,12,16,0.72)', color: '#fff', font: '600 18px system-ui, sans-serif', textAlign: 'center', padding: '24px',
    })
    box.textContent = reason
    this.wrapper.appendChild(box)
    this.opts.onDisconnect?.(reason)
  }

  // ---- remotes
  remoteFire(remote: Instance, to: 'server' | 'all' | Instance, args: unknown[]) {
    const role = this.netRole()
    if (to === 'server') {
      if (role === 'client') this.netClient!.fireServer(remote, args)
      else remote.fire('OnServerEvent', this.player, ...args)
      return
    }
    if (role === 'client') throw new Error(`${to === 'all' ? 'FireAllClients' : 'FireClient'} can only be used on the host (from a Script)`)
    if (to === 'all') {
      this.netHost?.fireClients(remote, null, args)
      remote.fire('OnClientEvent', ...args) // the host is playing too
    } else if (to === this.player) remote.fire('OnClientEvent', ...args)
    else this.netHost?.fireClients(remote, to, args)
  }

  remoteInvoke(remote: Instance, to: 'server' | Instance, args: unknown[]): number {
    const id = this.nextRequest++
    const r = { done: false, ok: false, value: null as unknown }
    this.invokes.set(id, r)
    const finish = (ok: boolean, value: unknown) => { if (!r.done) Object.assign(r, { done: true, ok, value }) }
    const role = this.netRole()
    if (to === 'server') {
      if (role === 'client') this.netClient!.invokeServer(remote, args, finish)
      else this.invokeHere(remote, '__ServerInvoke', [this.player, ...args], finish)
    } else if (role === 'client') {
      this.invokes.delete(id)
      throw new Error('InvokeClient can only be used on the host (from a Script)')
    } else if (to === this.player) this.invokeHere(remote, '__ClientInvoke', args, finish)
    else if (this.netHost) this.netHost.invokeClient(remote, to, args, finish)
    else finish(false, `${to.name} is not in the game`)
    return id
  }

  remoteResult(id: number): [boolean, boolean, unknown] {
    const r = this.invokes.get(id)
    if (!r) return [true, false, 'Unknown request']
    if (r.done) this.invokes.delete(id)
    return [r.done, r.ok, r.value]
  }

  remoteRespond(id: number, ok: boolean, value: unknown) {
    const answer = this.answers.get(id)
    if (answer) { this.answers.delete(id); answer(ok, value) }
  }

  /** Ask this machine's OnServerInvoke / OnClientInvoke callback (whichever language set it answers). */
  private invokeHere(remote: Instance, event: '__ServerInvoke' | '__ClientInvoke', args: unknown[], answer: (ok: boolean, value: unknown) => void) {
    const id = this.nextRequest++
    this.answers.set(id, answer)
    remote.fire(event, id, ...args)
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
