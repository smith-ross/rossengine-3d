// 2D platformer starter place. Its pixel-art assets are drawn procedurally (no files needed).
import { Color3, UDim, UDim2, Vector2, enumItem } from './datatypes'
import { Instance, createInstance } from './instance'
import { DataModel } from './classes'
import { TileMap } from './classes2d'
import { Asset, assets, contentRef } from './assets'
import { baseplatePlace } from './templates'

function make(cls: string, props: Record<string, unknown>, parent?: Instance) {
  const i = createInstance(cls)
  for (const [k, v] of Object.entries(props)) i.set(k, v)
  if (parent) i.setParent(parent)
  return i
}

// ---- pixel art -------------------------------------------------------------------------------------
type Ctx = CanvasRenderingContext2D
function canvas(w: number, h: number): [HTMLCanvasElement, Ctx] {
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  const ctx = c.getContext('2d')!
  ctx.imageSmoothingEnabled = false
  return [c, ctx]
}
const px = (ctx: Ctx, color: string, x: number, y: number, w = 1, h = 1) => { ctx.fillStyle = color; ctx.fillRect(x, y, w, h) }

function noise(ctx: Ctx, x0: number, y0: number, colors: string[], seed: number) {
  let s = seed
  const r = () => ((s = (s * 9301 + 49297) % 233280) / 233280)
  for (let i = 0; i < 26; i++) px(ctx, colors[Math.floor(r() * colors.length)], x0 + Math.floor(r() * 16), y0 + Math.floor(r() * 16))
}

/** 8 tiles (16px): 0 grass, 1 dirt, 2 stone, 3 plank, 4 crate, 5 spikes, 6 bush, 7 flower */
function drawTileset(): HTMLCanvasElement {
  const [c, ctx] = canvas(64, 32)
  // 0 grass top
  px(ctx, '#8a5a35', 0, 0, 16, 16); noise(ctx, 0, 4, ['#7a4c2c', '#9b6a42'], 1)
  px(ctx, '#4caf50', 0, 0, 16, 5); px(ctx, '#7bd36b', 0, 0, 16, 2)
  for (let x = 0; x < 16; x += 3) px(ctx, '#4caf50', x, 5, 2, 1)
  // 1 dirt
  px(ctx, '#8a5a35', 16, 0, 16, 16); noise(ctx, 16, 0, ['#7a4c2c', '#9b6a42', '#6d4325'], 2)
  // 2 stone bricks
  px(ctx, '#7d8597', 32, 0, 16, 16)
  for (const [x, y, w] of [[32, 0, 7], [40, 0, 8], [32, 5, 3], [36, 5, 8], [45, 5, 3], [32, 10, 7], [40, 10, 8]]) { px(ctx, '#9aa3b5', x, y, w, 4); px(ctx, '#5f6677', x, y + 4, w, 1) }
  // 3 wooden plank (one-way look)
  px(ctx, '#a0682f', 48, 0, 16, 6); px(ctx, '#c4874a', 48, 0, 16, 2); px(ctx, '#6e451d', 48, 5, 16, 1)
  for (const x of [52, 59]) px(ctx, '#6e451d', x, 1, 1, 4)
  // 4 crate
  px(ctx, '#b07a3a', 0, 16, 16, 16); px(ctx, '#6e451d', 0, 16, 16, 1); px(ctx, '#6e451d', 0, 31, 16, 1); px(ctx, '#6e451d', 0, 16, 1, 16); px(ctx, '#6e451d', 15, 16, 1, 16)
  for (let k = 0; k < 14; k++) { px(ctx, '#6e451d', 1 + k, 17 + k); px(ctx, '#6e451d', 14 - k, 17 + k) }
  // 5 spikes
  for (let k = 0; k < 4; k++) for (let y = 0; y < 8; y++) px(ctx, y < 2 ? '#e8eef6' : '#b7c0cf', 16 + k * 4 + Math.floor(y / 2.7), 24 + y - 0, Math.max(1, 4 - Math.floor(y / 2.7) * 2), 1)
  // 6 bush
  for (const [x, y, r] of [[37, 26, 5], [43, 25, 6], [40, 22, 5]]) { ctx.fillStyle = '#3f9b48'; ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill() }
  px(ctx, '#62c46b', 38, 21, 3, 1); px(ctx, '#62c46b', 43, 21, 3, 1)
  // 7 flower
  px(ctx, '#3f9b48', 55, 24, 1, 8); px(ctx, '#ff6b9a', 53, 21, 5, 3); px(ctx, '#ffd84a', 55, 22)
  return c
}

/** Player sheet: 8 frames of 16x16 — idle 0-1, run 2-5, jump 6, fall 7 */
function drawPlayer(): HTMLCanvasElement {
  const [c, ctx] = canvas(128, 16)
  const legs: Array<[number, number]> = [[0, 0], [0, 0], [-2, 2], [0, 1], [2, -2], [0, 1], [-1, -1], [1, 1]]
  for (let f = 0; f < 8; f++) {
    const x = f * 16
    const bob = f === 1 || f === 3 || f === 5 ? 1 : 0
    // legs
    const [l, r] = legs[f]
    px(ctx, '#2b3a67', x + 5 + l, 12, 2, 4 - (f === 6 ? 1 : 0)); px(ctx, '#2b3a67', x + 9 + r, 12, 2, 4 - (f === 7 ? 1 : 0))
    // body
    px(ctx, '#e8483f', x + 4, 6 + bob, 8, 7); px(ctx, '#ff6f61', x + 4, 6 + bob, 8, 2)
    // head
    px(ctx, '#ffd2a1', x + 4, 1 + bob, 8, 6); px(ctx, '#5a3825', x + 4, 1 + bob, 8, 2)
    px(ctx, '#1d1d28', x + 9, 3 + bob, 1, 2); px(ctx, '#1d1d28', x + 11, 3 + bob, 1, 2)
    // arms
    const armY = f === 6 ? 3 : 8
    px(ctx, '#ffd2a1', x + 3, armY + bob, 1, 3); px(ctx, '#ffd2a1', x + 12, armY + bob, 1, 3)
  }
  return c
}

/** Coin: 6 frames spinning */
function drawCoin(): HTMLCanvasElement {
  const [c, ctx] = canvas(72, 12)
  const widths = [10, 8, 4, 2, 4, 8]
  widths.forEach((w, f) => {
    const x = f * 12 + 6 - w / 2
    px(ctx, '#c98a12', x, 1, w, 10); px(ctx, '#ffd23f', x + (w > 2 ? 1 : 0), 2, Math.max(1, w - 2), 8)
    if (w >= 8) px(ctx, '#fff3a8', x + 2, 3, 1, 4)
  })
  return c
}

/** Distant hills for a parallax background layer */
function drawHills(): HTMLCanvasElement {
  const [c, ctx] = canvas(256, 64)
  ctx.fillStyle = '#9fd3a6'
  ctx.beginPath(); ctx.moveTo(0, 64)
  for (let x = 0; x <= 256; x += 4) ctx.lineTo(x, 34 - Math.sin(x / 26) * 12 - Math.sin(x / 9) * 3)
  ctx.lineTo(256, 64); ctx.fill()
  ctx.fillStyle = '#7cc488'
  ctx.beginPath(); ctx.moveTo(0, 64)
  for (let x = 0; x <= 256; x += 4) ctx.lineTo(x, 48 - Math.sin(x / 17 + 2) * 8)
  ctx.lineTo(256, 64); ctx.fill()
  return c
}

async function importCanvas(c: HTMLCanvasElement, name: string): Promise<Asset> {
  const blob: Blob = await new Promise((res) => c.toBlob((b) => res(b!), 'image/png'))
  return assets.importFile(new File([blob], name + '.png', { type: 'image/png' }))
}

// ---- scripts ----------------------------------------------------------------------------------------
const PLAYER_SCRIPT = `-- Platformer controller: CharacterBody2D + MoveAndSlide (gravity comes from World2D.Gravity)
local UserInputService = game:GetService("UserInputService")
local RunService = game:GetService("RunService")

local player = game.World2D.Player
local sprite = player.Sprite
local SPEED = 110
local JUMP = 300
local spawn = player.Position

local function down(...)
	for _, key in { ... } do
		if UserInputService:IsKeyDown(key) then
			return true
		end
	end
	return false
end

RunService.Heartbeat:Connect(function()
	local dir = 0
	if down(Enum.KeyCode.A, Enum.KeyCode.Left) then dir -= 1 end
	if down(Enum.KeyCode.D, Enum.KeyCode.Right) then dir += 1 end

	local velocity = Vector2.new(dir * SPEED, player.Velocity.Y)
	if player:IsOnFloor() and down(Enum.KeyCode.Space, Enum.KeyCode.W, Enum.KeyCode.Up) then
		velocity = Vector2.new(velocity.X, -JUMP)
	end
	player.Velocity = velocity
	player:MoveAndSlide()

	-- animation
	if dir ~= 0 then
		sprite.FlipX = dir < 0
	end
	if not player:IsOnFloor() then
		sprite.Animation = if player.Velocity.Y < 0 then "jump" else "fall"
	elseif dir ~= 0 then
		sprite.Animation = "run"
	else
		sprite.Animation = "idle"
	end

	-- fell off the world
	if player.Position.Y > 300 then
		player.Position = spawn
		player.Velocity = Vector2.new()
	end
end)
`

const COINS_SCRIPT = `-- Coins are Area2D triggers; the count is stored as an attribute the HUD listens to
local world = game.World2D
local coins = world.Coins
world:SetAttribute("Coins", 0)
world:SetAttribute("TotalCoins", #coins:GetChildren())

for _, coin in coins:GetChildren() do
	coin.BodyEntered:Connect(function(body)
		if body.Name == "Player" and coin.Parent then
			world:SetAttribute("Coins", world:GetAttribute("Coins") + 1)
			coin:Destroy()
		end
	end)
end
`

const HUD_SCRIPT = `local world = game.World2D
local label = script.Parent:WaitForChild("Counter")

local function update()
	local got, total = world:GetAttribute("Coins") or 0, world:GetAttribute("TotalCoins") or 0
	label.Text = "Coins: " .. got .. " / " .. total
	if total > 0 and got == total then
		label.Text ..= "  - you got them all!"
	end
end
world:GetAttributeChangedSignal("Coins"):Connect(update)
update()
`

// ---- level ------------------------------------------------------------------------------------------
const LEVEL = [
  '                                                                    ',
  '                                                     o o o          ',
  '                                  o o o             =====           ',
  '                                 =======                             ',
  '                       o o                    o                     ',
  '            o o       =====       f        ======        o o        ',
  '           =====                 ###                    ====      SS',
  '   b  f              f   b      #####      b    f    f        b  SSS',
  'GGGGGGGGGGGGGGGGGGGGGGGGGG    GGGGGGGGGGGGGGGGG   GGGGGGGGGGGGGGGGGGG',
  'DDDDDDDDDDDDDDDDDDDDDDDDDD    DDDDDDDDDDDDDDDDD   DDDDDDDDDDDDDDDDDDD',
  'DDDDDDDDDDDDDDDDDDDDDDDDDD^^^^DDDDDDDDDDDDDDDDD^^^DDDDDDDDDDDDDDDDDDD',
]
const TILE: Record<string, number> = { G: 0, D: 1, '#': 2, '=': 3, S: 4, '^': 5, b: 6, f: 7 }

export async function platformerPlace(): Promise<DataModel> {
  const game = baseplatePlace()
  game.name = 'Platformer 2D'
  const w2d = game.getService('World2D')
  w2d.set('Enabled', true)
  w2d.set('Gravity', new Vector2(0, 900))
  w2d.set('BackgroundColor', Color3.fromRGB(126, 196, 240))

  const [tiles, player, coin, hills] = await Promise.all([
    importCanvas(drawTileset(), 'Tileset'), importCanvas(drawPlayer(), 'Player'),
    importCanvas(drawCoin(), 'Coin'), importCanvas(drawHills(), 'Hills'),
  ])

  // parallax background
  for (let k = -1; k < 4; k++) {
    make('Sprite2D', {
      Name: 'Hills', Image: contentRef(hills), Size: new Vector2(256, 64), Pivot: new Vector2(0, 1),
      Position: new Vector2(k * 256, 128), ScrollFactor: new Vector2(0.5, 0.8), ZIndex: -10,
    }, w2d)
  }

  // tilemap ('#', 'G', 'D', '=', 'S' are solid; decorations and spikes are not)
  const map = make('TileMap', { Name: 'Level', TileSet: contentRef(tiles), TileSize: new Vector2(16, 16), SolidTiles: '0-4' }, w2d) as TileMap
  LEVEL.forEach((row, y) => [...row].forEach((ch, x) => { if (ch in TILE) map.setCell(x - 4, y - 8, TILE[ch]) }))

  // coins
  const coins = make('Folder', { Name: 'Coins' }, w2d)
  LEVEL.forEach((row, y) => [...row].forEach((ch, x) => {
    if (ch !== 'o') return
    const area = make('Area2D', { Name: 'Coin', Position: new Vector2((x - 4) * 16 + 8, (y - 8) * 16 + 8), CollisionSize: new Vector2(10, 10) }, coins)
    const s = make('AnimatedSprite2D', { Name: 'Sprite', Image: contentRef(coin), HFrames: 6, Size: new Vector2(12, 12), Animation: 'spin' }, area)
    make('SpriteAnimation', { Name: 'spin', Frames: '0-5', FPS: 10 }, s)
  }))

  // player
  const body = make('CharacterBody2D', { Name: 'Player', Position: new Vector2(-24, -20), CollisionSize: new Vector2(9, 14), CollisionOffset: new Vector2(0, 1), ZIndex: 5 }, w2d)
  const sprite = make('AnimatedSprite2D', { Name: 'Sprite', Image: contentRef(player), HFrames: 8, Size: new Vector2(16, 16), Animation: 'idle' }, body)
  make('SpriteAnimation', { Name: 'idle', Frames: '0-1', FPS: 3 }, sprite)
  make('SpriteAnimation', { Name: 'run', Frames: '2-5', FPS: 12 }, sprite)
  make('SpriteAnimation', { Name: 'jump', Frames: '6', FPS: 1, Loop: false }, sprite)
  make('SpriteAnimation', { Name: 'fall', Frames: '7', FPS: 1, Loop: false }, sprite)

  const cam = make('Camera2D', { Name: 'Camera', Follow: body, Zoom: 3, Smoothing: 0.85, Offset: new Vector2(0, -16), Position: new Vector2(-24, -36) }, w2d)
  w2d.set('CurrentCamera', cam)
  make('Text2D', { Name: 'Sign', Text: 'Arrow keys / WASD to move\nSpace to jump', TextSize: 8, Position: new Vector2(24, -56), ZIndex: 3 }, w2d)

  const ss = game.getService('ScriptService')
  make('Script', { Name: 'PlayerController', Source: PLAYER_SCRIPT }, ss)
  make('Script', { Name: 'Coins', Source: COINS_SCRIPT }, ss)

  const gui = make('ScreenGui', { Name: 'HUD' }, game.getService('StarterGui'))
  const label = make('TextLabel', {
    Name: 'Counter', Text: 'Coins: 0', Size: new UDim2(0, 320, 0, 44), Position: new UDim2(0, 16, 0, 16),
    BackgroundColor3: Color3.fromRGB(20, 22, 30), BackgroundTransparency: 0.3, TextColor3: Color3.fromRGB(255, 220, 80),
    TextSize: 24, Font: enumItem('Font', 'GothamBold'),
  }, gui)
  make('UICorner', { CornerRadius: new UDim(0, 10) }, label)
  make('Script', { Name: 'HudController', Source: HUD_SCRIPT }, gui)

  // the 3D baseplate isn't used by a 2D game
  game.workspace.findFirstChild('Baseplate')?.destroy()
  game.workspace.findFirstChild('SpawnLocation')?.destroy()
  return game
}

/** An empty 2D place: World2D enabled, a camera and a starter tilemap. */
export function empty2DPlace(): DataModel {
  const game = baseplatePlace()
  game.name = 'Untitled 2D'
  const w2d = game.getService('World2D')
  w2d.set('Enabled', true)
  const cam = make('Camera2D', { Name: 'Camera', Zoom: 2 }, w2d)
  w2d.set('CurrentCamera', cam)
  const map = make('TileMap', { Name: 'TileMap' }, w2d) as TileMap
  for (let x = -12; x <= 12; x++) map.setCell(x, 4, 0)
  game.workspace.findFirstChild('Baseplate')?.destroy()
  game.workspace.findFirstChild('SpawnLocation')?.destroy()
  return game
}
