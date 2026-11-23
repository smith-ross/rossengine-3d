// The default controller for a CharacterBody3D, in each scripting language. The editor offers it when
// a Script is inserted into (or next to) a CharacterBody3D; it's an ordinary script, so edit freely.
import type { ScriptLanguage } from './languages'

const LUAU = `-- Character controller for a CharacterBody3D. Edit anything here!
-- WASD / arrow keys move (relative to the camera), Shift sprints, Space jumps.
-- Hold the right mouse button to turn the camera, scroll to zoom.
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local UserInputService = game:GetService("UserInputService")

-- the body this script controls: its parent, or the first CharacterBody3D inside its parent
local body = script.Parent:IsA("CharacterBody3D") and script.Parent
	or script.Parent:FindFirstChildWhichIsA("CharacterBody3D", true)
local camera = workspace.CurrentCamera

local WALK_SPEED = 16    -- studs per second
local SPRINT_SPEED = 28
local JUMP_POWER = 50    -- upward speed when jumping
local ACCELERATION = 12  -- how quickly it speeds up and slows down (higher = snappier)
local TURN_SPEED = 12    -- how quickly it turns to face where it's going

-- this body is the player's character: no default character, and the camera follows it
Players.CharacterAutoLoads = false
local player = Players.LocalPlayer
if player and player.Character then player.Character:Destroy() end
-- the body is the player's Character (so scripts know it's yours: Players:GetPlayerFromCharacter, seats...);
-- scripts start before the player joins, so it may have to wait for them
local function claim(p) if p == Players.LocalPlayer then p.Character = body end end
if player then claim(player) else Players.PlayerAdded:Connect(claim) end
camera.CameraType = Enum.CameraType.Custom
camera.CameraSubject = body

-- optional animations: an AnimationPlayer inside the body with "Walk", "Idle" and/or "Jump"
local animator = body:FindFirstChildWhichIsA("AnimationPlayer", true)
local function play(name: string, speed: number?)
	if not animator then return end
	animator.Speed = speed or 1
	if animator:GetAnimation(name) then
		if not (animator.Playing and animator.CurrentAnimation == name) then animator:Play(name) end
	elseif animator.Playing then
		-- no animation with this name: settle into the first frame of the current one and stop
		animator:Seek(0)
		animator:Stop()
	end
end

local function down(...)
	for _, key in { ... } do
		if UserInputService:IsKeyDown(key) then return true end
	end
	return false
end

RunService.Heartbeat:Connect(function(dt)
	-- sitting in a seat (body.SeatPart, e.g. a car's): the seat carries the body
	if body.SeatPart then
		play("Sit")
		return
	end

	-- which way the keys point, flattened onto the ground and relative to the camera
	local look = camera.CFrame.LookVector
	local forward = Vector3.new(look.X, 0, look.Z)
	forward = if forward.Magnitude > 0.01 then forward.Unit else Vector3.new(0, 0, -1)
	local right = Vector3.new(-forward.Z, 0, forward.X)
	local input = Vector3.new()
	if down(Enum.KeyCode.W, Enum.KeyCode.Up) then input += forward end
	if down(Enum.KeyCode.S, Enum.KeyCode.Down) then input -= forward end
	if down(Enum.KeyCode.D, Enum.KeyCode.Right) then input += right end
	if down(Enum.KeyCode.A, Enum.KeyCode.Left) then input -= right end
	if input.Magnitude > 0 then input = input.Unit end

	-- ease towards the target speed instead of starting and stopping instantly
	local speed = if down(Enum.KeyCode.LeftShift) then SPRINT_SPEED else WALK_SPEED
	local velocity = body.Velocity
	local flat = Vector3.new(velocity.X, 0, velocity.Z):Lerp(input * speed, math.min(1, ACCELERATION * dt))
	local up = velocity.Y
	if body:IsOnFloor() and down(Enum.KeyCode.Space) then up = JUMP_POWER end
	body.Velocity = Vector3.new(flat.X, up, flat.Z)
	body:MoveAndSlide() -- moves by Velocity, sliding along walls and up steps; gravity is added for you

	-- turn to face the direction of travel
	if input.Magnitude > 0 then
		local pos = body.Position
		body.CFrame = body.CFrame:Lerp(CFrame.lookAt(pos, pos + input), math.min(1, TURN_SPEED * dt))
	end

	if not body:IsOnFloor() then
		play("Jump")
	elseif flat.Magnitude > 0.5 then
		play("Walk", flat.Magnitude / WALK_SPEED)
	else
		play("Idle")
	end
end)
`

const TYPESCRIPT = `// Character controller for a CharacterBody3D. Edit anything here!
// WASD / arrow keys move (relative to the camera), Shift sprints, Space jumps.
// Hold the right mouse button to turn the camera, scroll to zoom.
const Players = game.GetService("Players")
const RunService = game.GetService("RunService")
const UserInputService = game.GetService("UserInputService")

// the body this script controls: its parent, or the first CharacterBody3D inside its parent
const body = script.Parent.IsA("CharacterBody3D") ? script.Parent : script.Parent.FindFirstChildWhichIsA("CharacterBody3D", true)
const camera = workspace.CurrentCamera

const WALK_SPEED = 16    // studs per second
const SPRINT_SPEED = 28
const JUMP_POWER = 50    // upward speed when jumping
const ACCELERATION = 12  // how quickly it speeds up and slows down (higher = snappier)
const TURN_SPEED = 12    // how quickly it turns to face where it's going

// this body is the player's character: no default character, and the camera follows it
Players.CharacterAutoLoads = false
const player = Players.LocalPlayer
if (player && player.Character) player.Character.Destroy()
// the body is the player's Character (so scripts know it's yours: Players.GetPlayerFromCharacter, seats...);
// scripts start before the player joins, so it may have to wait for them
const claim = (p: Player) => { if (p === Players.LocalPlayer) p.Character = body }
if (player) claim(player)
else Players.PlayerAdded.Connect(claim)
camera.CameraType = Enum.CameraType.Custom
camera.CameraSubject = body

// optional animations: an AnimationPlayer inside the body with "Walk", "Idle" and/or "Jump"
const animator = body.FindFirstChildWhichIsA("AnimationPlayer", true)
function play(name: string, speed = 1) {
	if (!animator) return
	animator.Speed = speed
	if (animator.GetAnimation(name)) {
		if (!(animator.Playing && animator.CurrentAnimation === name)) animator.Play(name)
	} else if (animator.Playing) {
		// no animation with this name: settle into the first frame of the current one and stop
		animator.Seek(0)
		animator.Stop()
	}
}

const down = (...keys: any[]) => keys.some((key) => UserInputService.IsKeyDown(key))

RunService.Heartbeat.Connect((dt: number) => {
	// sitting in a seat (body.SeatPart, e.g. a car's): the seat carries the body
	if (body.SeatPart) {
		play('Sit')
		return
	}

	// which way the keys point, flattened onto the ground and relative to the camera
	const look = camera.CFrame.LookVector
	let forward = Vector3.new(look.X, 0, look.Z)
	forward = forward.Magnitude > 0.01 ? forward.Unit : Vector3.new(0, 0, -1)
	const right = Vector3.new(-forward.Z, 0, forward.X)
	let input = Vector3.new()
	if (down(Enum.KeyCode.W, Enum.KeyCode.Up)) input = input.add(forward)
	if (down(Enum.KeyCode.S, Enum.KeyCode.Down)) input = input.sub(forward)
	if (down(Enum.KeyCode.D, Enum.KeyCode.Right)) input = input.add(right)
	if (down(Enum.KeyCode.A, Enum.KeyCode.Left)) input = input.sub(right)
	if (input.Magnitude > 0) input = input.Unit

	// ease towards the target speed instead of starting and stopping instantly
	const speed = down(Enum.KeyCode.LeftShift) ? SPRINT_SPEED : WALK_SPEED
	const velocity = body.Velocity
	const flat = Vector3.new(velocity.X, 0, velocity.Z).Lerp(input.mul(speed), Math.min(1, ACCELERATION * dt))
	let up = velocity.Y
	if (body.IsOnFloor() && down(Enum.KeyCode.Space)) up = JUMP_POWER
	body.Velocity = Vector3.new(flat.X, up, flat.Z)
	body.MoveAndSlide() // moves by Velocity, sliding along walls and up steps; gravity is added for you

	// turn to face the direction of travel
	if (input.Magnitude > 0) {
		const pos = body.Position
		body.CFrame = body.CFrame.Lerp(CFrame.lookAt(pos, pos.add(input)), Math.min(1, TURN_SPEED * dt))
	}

	if (!body.IsOnFloor()) play("Jump")
	else if (flat.Magnitude > 0.5) play("Walk", flat.Magnitude / WALK_SPEED)
	else play("Idle")
})
`

const PYTHON = `# Character controller for a CharacterBody3D. Edit anything here!
# WASD / arrow keys move (relative to the camera), Shift sprints, Space jumps.
# Hold the right mouse button to turn the camera, scroll to zoom.
Players = game.GetService("Players")
RunService = game.GetService("RunService")
UserInputService = game.GetService("UserInputService")

# the body this script controls: its parent, or the first CharacterBody3D inside its parent
body = script.Parent if script.Parent.IsA("CharacterBody3D") else script.Parent.FindFirstChildWhichIsA("CharacterBody3D", True)
camera = workspace.CurrentCamera

WALK_SPEED = 16    # studs per second
SPRINT_SPEED = 28
JUMP_POWER = 50    # upward speed when jumping
ACCELERATION = 12  # how quickly it speeds up and slows down (higher = snappier)
TURN_SPEED = 12    # how quickly it turns to face where it's going

# this body is the player's character: no default character, and the camera follows it
Players.CharacterAutoLoads = False
player = Players.LocalPlayer
if player and player.Character:
    player.Character.Destroy()
# the body is the player's Character (so scripts know it's yours: Players.GetPlayerFromCharacter, seats...);
# scripts start before the player joins, so it may have to wait for them
def claim(p):
    if p == Players.LocalPlayer:
        p.Character = body
if player:
    claim(player)
else:
    Players.PlayerAdded.Connect(claim)
camera.CameraType = Enum.CameraType.Custom
camera.CameraSubject = body

# optional animations: an AnimationPlayer inside the body with "Walk", "Idle" and/or "Jump"
animator = body.FindFirstChildWhichIsA("AnimationPlayer", True)

def play(name, speed=1):
    if not animator:
        return
    animator.Speed = speed
    if animator.GetAnimation(name):
        if not (animator.Playing and animator.CurrentAnimation == name):
            animator.Play(name)
    elif animator.Playing:
        # no animation with this name: settle into the first frame of the current one and stop
        animator.Seek(0)
        animator.Stop()

def down(*keys):
    return any(UserInputService.IsKeyDown(key) for key in keys)

def update(dt):
    # sitting in a seat (body.SeatPart, e.g. a car's): the seat carries the body
    if body.SeatPart:
        play("Sit")
        return

    # which way the keys point, flattened onto the ground and relative to the camera
    look = camera.CFrame.LookVector
    forward = Vector3.new(look.X, 0, look.Z)
    forward = forward.Unit if forward.Magnitude > 0.01 else Vector3.new(0, 0, -1)
    right = Vector3.new(-forward.Z, 0, forward.X)
    move = Vector3.new()
    if down(Enum.KeyCode.W, Enum.KeyCode.Up):
        move = move.add(forward)
    if down(Enum.KeyCode.S, Enum.KeyCode.Down):
        move = move.sub(forward)
    if down(Enum.KeyCode.D, Enum.KeyCode.Right):
        move = move.add(right)
    if down(Enum.KeyCode.A, Enum.KeyCode.Left):
        move = move.sub(right)
    if move.Magnitude > 0:
        move = move.Unit

    # ease towards the target speed instead of starting and stopping instantly
    speed = SPRINT_SPEED if down(Enum.KeyCode.LeftShift) else WALK_SPEED
    velocity = body.Velocity
    flat = Vector3.new(velocity.X, 0, velocity.Z).Lerp(move.mul(speed), min(1, ACCELERATION * dt))
    up = velocity.Y
    if body.IsOnFloor() and down(Enum.KeyCode.Space):
        up = JUMP_POWER
    body.Velocity = Vector3.new(flat.X, up, flat.Z)
    body.MoveAndSlide()  # moves by Velocity, sliding along walls and up steps; gravity is added for you

    # turn to face the direction of travel
    if move.Magnitude > 0:
        pos = body.Position
        body.CFrame = body.CFrame.Lerp(CFrame.lookAt(pos, pos.add(move)), min(1, TURN_SPEED * dt))

    if not body.IsOnFloor():
        play("Jump")
    elif flat.Magnitude > 0.5:
        play("Walk", flat.Magnitude / WALK_SPEED)
    else:
        play("Idle")

RunService.Heartbeat.Connect(update)
`

export const CHARACTER_CONTROLLER: Record<ScriptLanguage, string> = { Luau: LUAU, TypeScript: TYPESCRIPT, Python: PYTHON }
