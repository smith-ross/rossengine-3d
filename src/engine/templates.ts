// Starter places for new projects.
import { CFrame, Color3, UDim, UDim2, Vector2, Vector3, enumItem } from './datatypes'
import { Instance, createInstance } from './instance'
import { DataModel } from './classes'

function make(cls: string, props: Record<string, unknown>, parent?: Instance) {
  const i = createInstance(cls)
  for (const [k, v] of Object.entries(props)) i.set(k, v)
  if (parent) i.setParent(parent)
  return i
}

export function baseplatePlace(): DataModel {
  const game = new DataModel().initServices()
  game.name = 'Baseplate'
  const ws = game.workspace
  make('Camera', { Name: 'Camera' }, ws)
  make('Part', {
    Name: 'Baseplate', Anchored: true, Locked: true,
    Size: new Vector3(512, 16, 512), CFrame: CFrame.fromPosition(new Vector3(0, -8, 0)),
    Color: Color3.fromRGB(110, 114, 124), Material: enumItem('Material', 'Concrete'),
  }, ws)
  make('SpawnLocation', {
    Name: 'SpawnLocation', Anchored: true, Size: new Vector3(12, 1, 12),
    CFrame: CFrame.fromPosition(new Vector3(0, 0.5, 0)), Color: Color3.fromRGB(163, 162, 165),
    Material: enumItem('Material', 'SmoothPlastic'),
  }, ws)
  return game
}

const COIN_SERVER = `--!strict
-- Spawns spinning coins. Touch them to collect!
local Players = game:GetService("Players")
local TweenService = game:GetService("TweenService")

local coins = Instance.new("Folder")
coins.Name = "Coins"
coins.Parent = workspace

Players.PlayerAdded:Connect(function(player)
	player:SetAttribute("Coins", 0)
end)

local function spawnCoin(position: Vector3)
	local coin = Instance.new("Part")
	coin.Name = "Coin"
	coin.Shape = Enum.PartType.Cylinder
	coin.Size = Vector3.new(0.4, 3, 3)
	coin.Color = Color3.fromRGB(255, 200, 40)
	coin.Material = Enum.Material.Neon
	coin.Anchored = true
	coin.CanCollide = false
	coin.CFrame = CFrame.new(position)
	coin.Parent = coins

	local taken = false
	coin.Touched:Connect(function(hit)
		if taken then return end
		local character = hit.Parent
		local player = character and Players:GetPlayerFromCharacter(character)
		if player then
			taken = true
			player:SetAttribute("Coins", (player:GetAttribute("Coins") or 0) + 1)
			local tween = TweenService:Create(coin, TweenInfo.new(0.3), { Size = Vector3.new(0.1, 0.1, 0.1), Transparency = 1 })
			tween:Play()
			tween.Completed:Wait()
			coin:Destroy()
			task.wait(3)
			spawnCoin(position)
		end
	end)
end

for i = 1, 12 do
	local angle = (i / 12) * math.pi * 2
	spawnCoin(Vector3.new(math.cos(angle) * 30, 3, math.sin(angle) * 30))
end

-- spin all coins
game:GetService("RunService").Heartbeat:Connect(function(dt)
	for _, coin in coins:GetChildren() do
		coin.CFrame = coin.CFrame * CFrame.Angles(0, dt * 3, 0)
	end
end)
`

const KILL_BRICK = `-- Classic kill brick
script.Parent.Touched:Connect(function(hit)
	local humanoid = hit.Parent:FindFirstChildOfClass("Humanoid")
	if humanoid then
		humanoid.Health = 0
	end
end)
`

const HUD_CLIENT = `-- Updates the coin counter for the local player
local player = game:GetService("Players").LocalPlayer
local label = script.Parent:WaitForChild("Counter")

local function update()
	label.Text = "Coins: " .. tostring(player:GetAttribute("Coins") or 0)
end
player:GetAttributeChangedSignal("Coins"):Connect(update)
update()
`

const SPINNER = `-- A spinning platform made with TweenService
local TweenService = game:GetService("TweenService")
local part = script.Parent
local info = TweenInfo.new(4, Enum.EasingStyle.Linear, Enum.EasingDirection.InOut, -1)
local goal = { CFrame = part.CFrame * CFrame.Angles(0, math.pi, 0) }
TweenService:Create(part, info, goal):Play()
`

export function demoPlace(): DataModel {
  const game = baseplatePlace()
  game.name = 'Coin Collector'
  const ws = game.workspace
  const sss = game.getService('ScriptService')
  make('Script', { Name: 'CoinSpawner', Source: COIN_SERVER }, sss)

  // stairs + platform
  const model = make('Model', { Name: 'Tower' }, ws)
  for (let i = 0; i < 8; i++) {
    make('Part', {
      Name: 'Step', Anchored: true, Size: new Vector3(6, 1, 4),
      CFrame: CFrame.fromPosition(new Vector3(-20, 0.5 + i * 1.5, 10 - i * 4)),
      Color: Color3.fromRGB(80 + i * 20, 120, 220 - i * 15),
      Material: enumItem('Material', 'SmoothPlastic'),
    }, model)
  }
  const top = make('Part', {
    Name: 'Spinner', Anchored: true, Size: new Vector3(14, 1, 14),
    CFrame: CFrame.fromPosition(new Vector3(-20, 12.5, -24)), Color: Color3.fromRGB(240, 240, 240),
    Material: enumItem('Material', 'Wood'),
  }, model)
  make('Script', { Name: 'Spin', Source: SPINNER }, top)

  const lava = make('Part', {
    Name: 'KillBrick', Anchored: true, Size: new Vector3(10, 1, 10),
    CFrame: CFrame.fromPosition(new Vector3(20, 0.5, 15)), Color: Color3.fromRGB(255, 60, 20),
    Material: enumItem('Material', 'Neon'),
  }, ws)
  make('Script', { Name: 'Kill', Source: KILL_BRICK }, lava)

  // a few loose physics boxes
  for (let i = 0; i < 6; i++) {
    make('Part', {
      Name: 'Crate', Size: new Vector3(3, 3, 3),
      CFrame: CFrame.fromPosition(new Vector3(12 + (i % 3) * 3.2, 1.5 + Math.floor(i / 3) * 3.2, -12)),
      Color: Color3.fromRGB(170, 120, 70), Material: enumItem('Material', 'Wood'),
    }, ws)
  }
  const lampPost = make('Part', {
    Name: 'Lamp', Anchored: true, Size: new Vector3(1, 1, 1), CFrame: CFrame.fromPosition(new Vector3(0, 8, -10)),
    Color: Color3.fromRGB(255, 240, 200), Material: enumItem('Material', 'Neon'),
  }, ws)
  make('PointLight', { Range: 30, Brightness: 2, Color: Color3.fromRGB(255, 220, 160) }, lampPost)

  // HUD
  const gui = make('ScreenGui', { Name: 'HUD' }, game.getService('StarterGui'))
  const label = make('TextLabel', {
    Name: 'Counter', Text: 'Coins: 0', Size: new UDim2(0, 200, 0, 50), Position: new UDim2(0, 16, 0, 16),
    BackgroundColor3: Color3.fromRGB(20, 20, 30), BackgroundTransparency: 0.3, TextColor3: Color3.fromRGB(255, 220, 80),
    TextSize: 28, Font: enumItem('Font', 'GothamBold'), AnchorPoint: new Vector2(0, 0),
  }, gui)
  make('UICorner', { CornerRadius: new UDim(0, 10) }, label)
  make('Script', { Name: 'HudController', Source: HUD_CLIENT }, gui)
  return game
}

// ---- Multi-language sample ---------------------------------------------------------------
const POLY_MAIN_LUAU = `-- Luau script that uses a TypeScript module and a Python module
local Builder = require(game.Storage.Builder) -- TypeScript
local Waves = require("Storage/Waves")        -- Python

local columns = {}
for i = 1, 8 do
	local angle = i / 8 * math.pi * 2
	local position = Vector3.new(math.cos(angle) * 18, 0, math.sin(angle) * 18)
	table.insert(columns, Builder.column(position, Color3.fromHSV(i / 8, 0.7, 1)))
end
print(Builder.greeting, "-", #columns, "columns")

game:GetService("RunService").Heartbeat:Connect(function()
	local t = time()
	for i, part in columns do
		local p = part.Position
		part.Position = Vector3.new(p.X, 3 + Waves.height(t, i), p.Z)
	end
end)
`

const POLY_BUILDER_TS = `// TypeScript ModuleScript, used from Luau (Main) and Python (Hud)
export const greeting = "Built with TypeScript"

export function column(position: Vector3, color: Color3): Part {
	const part = Instance.new("Part")
	part.Name = "Column"
	part.Size = new Vector3(3, 6, 3)
	part.Position = position.add(new Vector3(0, 3, 0))
	part.Color = color
	part.Material = Enum.Material.Neon
	part.Anchored = true
	part.Parent = workspace
	return part
}
`

const POLY_WAVES_PY = `# Python ModuleScript, used from Luau (Main)
import math

def height(t, i):
    return math.sin(t * 2 + i * 0.8) * 2
`

const POLY_BUTTON_TS = `// TypeScript script: a clickable button that fires a BindableEvent
const button = Instance.new("Part")
button.Name = "Button"
button.Size = new Vector3(4, 1, 4)
button.Position = new Vector3(0, 0.5, -10)
button.Color = Color3.fromRGB(255, 80, 80)
button.Anchored = true
button.Parent = workspace

const detector = Instance.new("ClickDetector", button)
const clicked = game.Storage.Clicked as BindableEvent
let count = 0

detector.MouseClick.Connect(async () => {
	count++
	clicked.Fire(count)
	button.Size = new Vector3(4, 0.4, 4)
	await task.wait(0.15)
	button.Size = new Vector3(4, 1, 4)
})
`

const POLY_HUD_PY = `# Python script: a GUI that reacts to the TypeScript button
from Storage import Builder   # TypeScript module, imported from Python

players = game.GetService("Players")
player = players.LocalPlayer or await players.PlayerAdded.Wait()

gui = Instance.new("ScreenGui")
label = Instance.new("TextLabel")
label.Size = UDim2.new(0, 440, 0, 44)
label.Position = UDim2.new(0, 16, 0, 16)
label.BackgroundColor3 = Color3.fromRGB(20, 22, 30)
label.BackgroundTransparency = 0.25
label.TextColor3 = Color3.fromRGB(255, 255, 255)
label.TextSize = 20
label.Text = f"{Builder.greeting} - click the red button!"
label.Parent = gui
gui.Parent = await player.WaitForChild("PlayerGui")

def on_clicked(count):
    label.Text = f"Button clicked {count} time{'' if count == 1 else 's'}"

game.Storage.Clicked.Event.Connect(on_clicked)
`

export function languagesPlace(): DataModel {
  const game = baseplatePlace()
  game.name = 'Languages Demo'
  const storage = game.getService('Storage')
  const ss = game.getService('ScriptService')
  const script = (cls: string, name: string, lang: string, source: string, parent: Instance) =>
    make(cls, { Name: name, Language: enumItem('ScriptLanguage', lang), Source: source }, parent)
  script('ModuleScript', 'Builder', 'TypeScript', POLY_BUILDER_TS, storage)
  script('ModuleScript', 'Waves', 'Python', POLY_WAVES_PY, storage)
  make('BindableEvent', { Name: 'Clicked' }, storage)
  script('Script', 'Main', 'Luau', POLY_MAIN_LUAU, ss)
  script('Script', 'Button', 'TypeScript', POLY_BUTTON_TS, ss)
  script('Script', 'Hud', 'Python', POLY_HUD_PY, ss)
  return game
}
