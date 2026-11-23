// Ready-made things built from ordinary parts, joints and scripts: nothing here is a special class.
// The editor inserts them; everything they make can be edited, taken apart or copied like anything else.
//
//   buildCar     a drivable car: wheels on motor hinges, springy sliders for suspension, servo hinges
//                to steer, a seat (Humanoid:Sit), a Script that seats whoever touches it and a
//                LocalScript that drives with WASD.
//   RAGDOLL_SOURCE  a Script that turns characters (players and NPCs) into ragdolls when they die,
//                joining their limbs to the torso with ball sockets and hinges.
import { CFrame, Color3, Vector3, enumItem } from './datatypes'
import { Instance, createInstance } from './instance'
import { setEnd1 } from './constraintClasses'

const at = (x: number, y: number, z: number) => new CFrame(x, y, z)
/** a pivot whose up axis points along the car's X (left/right): what wheels turn around */
const SIDEWAYS = CFrame.fromAxisAngle(new Vector3(0, 0, 1), -Math.PI / 2)

export interface CarOptions { name?: string; color?: Color3 }

/** A car standing on the ground at `origin` (its bottom centre), facing origin's look direction. */
export function buildCar(origin: CFrame, opts: CarOptions = {}): Instance {
  const car = createInstance('Model')
  car.name = opts.name ?? 'Car'
  // tuning, read by the scripts (change them in the Properties panel under Attributes)
  car.attributes.set('MaxSpeed', 60) // studs per second
  car.attributes.set('ReverseSpeed', 25)
  car.attributes.set('Torque', 1500) // per wheel
  car.attributes.set('BrakeTorque', 3000)
  car.attributes.set('SteerAngle', 30) // degrees
  car.attributes.set('SteerSpeed', 150) // degrees per second

  const part = (name: string, size: Vector3, local: CFrame, props: Record<string, unknown> = {}) => {
    const p = createInstance('Part')
    p.name = name
    p.set('Size', size)
    p.set('CFrame', origin.mul(local))
    for (const [k, v] of Object.entries(props)) p.set(k, v)
    p.setParent(car)
    return p
  }
  const joint = (cls: string, name: string, p0: Instance, p1: Instance, pivot: CFrame, props: Record<string, unknown> = {}) => {
    const c = createInstance(cls)
    c.name = name
    c.set('Part0', p0)
    c.set('Part1', p1)
    c.setParent(p0)
    c.set('Pivot', origin.mul(pivot))
    for (const [k, v] of Object.entries(props)) c.set(k, v)
    return c
  }

  const R = 1.25 // wheel radius
  const HUB = R * 1.9 // (invisible, inside the wheel: heavy enough to keep the joints between wheel and chassis firm)
  const W = 0.9 // wheel width
  const halfTrack = 3.15 // wheel centre, left/right
  const halfBase = 3.3 // wheel centre, front/back
  const chassisY = R + 0.7
  const invisible = { Transparency: 1, CanCollide: false, CanTouch: false, CanQuery: false }

  const chassis = part('Chassis', new Vector3(5, 0.8, 9), at(0, chassisY, 0), { Color: opts.color ?? Color3.fromRGB(196, 40, 28) })
  car.set('PrimaryPart', chassis)
  const seat = part('DriverSeat', new Vector3(2, 0.6, 2), at(0, chassisY + 0.7, 1.2), { Color: Color3.fromRGB(40, 40, 44) })
  seat.attributes.set('ExitOffset', new Vector3(-5, 1, 0)) // where you stand when you get out: clear of the car's left side
  const back = part('SeatBack', new Vector3(2, 1.8, 0.4), at(0, chassisY + 1.3, 2.4), { Color: Color3.fromRGB(40, 40, 44) })
  const hood = part('Hood', new Vector3(4.6, 0.8, 3), at(0, chassisY + 0.8, -2.8), { Color: opts.color ?? Color3.fromRGB(196, 40, 28) })
  for (const p of [seat, back, hood]) {
    const w = createInstance('WeldConstraint')
    w.set('Part0', chassis)
    w.set('Part1', p)
    w.setParent(chassis)
  }

  for (const [side, x] of [['Left', -halfTrack], ['Right', halfTrack]] as const) {
    for (const [end, z] of [['Front', -halfBase], ['Rear', halfBase]] as const) {
      const n = `${end}${side}`
      const centre = at(x, R, z)
      const wheel = part(`${n}Wheel`, new Vector3(W, R * 2, R * 2), centre, {
        Shape: enumItem('PartType', 'Cylinder'), Color: Color3.fromRGB(30, 30, 32), Material: enumItem('Material', 'SmoothPlastic'),
      })
      // what the wheel turns on; in front it also turns to steer
      const hub = part(`${n}Hub`, new Vector3(W * 0.8, HUB, HUB), centre, invisible)
      // suspension: the strut slides up and down on the chassis, held up by a spring
      const strut = end === 'Front' ? part(`${n}Strut`, new Vector3(W * 0.8, HUB, HUB), centre, invisible) : hub
      joint('SliderConstraint', `${n}Suspension`, strut, chassis, centre, { LimitsEnabled: true, LowerLimit: -0.6, UpperLimit: 0.5 })
      const spring = joint('SpringConstraint', `${n}Spring`, strut, chassis, centre, { FreeLength: 2.6, Stiffness: 4000, Damping: 220, Thickness: 0.12, ShowInGame: false })
      setEnd1(spring, origin.mul(at(x, R + 2, z)).position) // from the wheel centre up into the chassis
      if (end === 'Front') {
        joint('HingeConstraint', `${n}Steering`, hub, strut, centre, {
          Mode: enumItem('JointMode', 'Servo'), Speed: 150, MaxTorque: 100000, TargetAngle: 0,
          LimitsEnabled: true, LowerAngle: -40, UpperAngle: 40,
        })
      }
      joint('HingeConstraint', `${n}Axle`, wheel, hub, centre.mul(SIDEWAYS), { Mode: enumItem('JointMode', 'Motor'), Speed: 0, MaxTorque: 3000 })
    }
  }

  const seater = createInstance('Script')
  seater.name = 'Seat'
  seater.set('Source', CAR_SEAT_SOURCE)
  seater.setParent(car)
  const driver = createInstance('LocalScript')
  driver.name = 'Drive'
  driver.set('Source', CAR_DRIVE_SOURCE)
  driver.setParent(car)
  return car
}

/** Host side: whoever touches the seat sits down, and the driver's machine gets to run the car. */
export const CAR_SEAT_SOURCE = `-- Walk into the car to get in (you sit in the DriverSeat); press Space to get out.
-- Works for Humanoid characters and for CharacterBody3D ones (both have a SeatPart).
-- You get out where the seat's ExitOffset attribute says (in the seat's own space).
-- In multiplayer the driver's machine runs the car, so it reacts to them straight away.
local Players = game:GetService("Players")
local car = script.Parent
local seat = car:WaitForChild("DriverSeat")

local driver = nil -- the Humanoid or CharacterBody3D in the seat
local justLeft = {} -- [driver] = time, so getting out doesn't sit you straight back down

-- what sits down when this part touches the car: a Humanoid, or a CharacterBody3D (or nothing)
local function sitterOf(hit)
	local body = if hit:IsA("CharacterBody3D") then hit else hit:FindFirstAncestorWhichIsA("CharacterBody3D")
	if body then return body, body end
	local humanoid = hit.Parent and hit.Parent:FindFirstChildOfClass("Humanoid")
	if humanoid and humanoid.Health > 0 then return humanoid, humanoid.Parent end
	return nil
end

local function getOut()
	if not driver then return end
	justLeft[driver] = os.clock()
	driver = nil
	car:SetNetworkOwner(nil)
end

local function touched(hit)
	if driver then return end
	local sitter, character = sitterOf(hit)
	if not sitter or sitter.SeatPart then return end
	if justLeft[sitter] and os.clock() - justLeft[sitter] < 1.5 then return end
	driver = sitter
	sitter.SeatPart = seat
	local player = Players:GetPlayerFromCharacter(character)
	if player then car:SetNetworkOwner(player) end

	local seated
	seated = sitter.Seated:Connect(function(active, part)
		if not active and part == seat then
			seated:Disconnect()
			if driver == sitter then getOut() end
		end
	end)
end

-- touching any visible part of the car counts
for _, part in car:GetChildren() do
	if part:IsA("BasePart") and part.CanTouch then part.Touched:Connect(touched) end
end
`

/** Driver side: WASD drives the wheel motors and steers the front wheels. */
export const CAR_DRIVE_SOURCE = `-- Drives the car when this machine's player sits in its DriverSeat: W/S to go, A/D to steer.
-- The wheels are HingeConstraints in Motor mode and the front ones turn on Servo hinges.
-- Tune it with the car's attributes: MaxSpeed, ReverseSpeed, Torque, BrakeTorque, SteerAngle, SteerSpeed.
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")
local UserInputService = game:GetService("UserInputService")

local car = script.Parent
local seat = car:WaitForChild("DriverSeat")
local chassis = car:WaitForChild("Chassis")

local wheels, steering = {}, {}
for _, d in car:GetDescendants() do
	if d:IsA("HingeConstraint") then
		if d.Name:match("Axle$") then
			table.insert(wheels, d)
		elseif d.Name:match("Steering$") then
			table.insert(steering, d)
		end
	end
end
-- the wheels' axles point to the car's right: spinning them "backwards" rolls the car forwards
local radius = wheels[1] and wheels[1].Part0.Size.Y / 2 or 1.25

local function key(k) return UserInputService:IsKeyDown(k) end
local wasDriving = false

RunService.Heartbeat:Connect(function()
	-- whoever sits in the seat: a Humanoid, or the character itself if it's a CharacterBody3D
	local character = Players.LocalPlayer and Players.LocalPlayer.Character
	local sitter = character and (if character:IsA("CharacterBody3D") then character else character:FindFirstChildOfClass("Humanoid"))
	local driving = sitter ~= nil and sitter.SeatPart == seat
	if not driving and not wasDriving then return end -- someone else's car, or parked
	wasDriving = driving
	-- a Humanoid gets up by itself on Space; a CharacterBody3D is up to us
	if driving and sitter:IsA("CharacterBody3D") and key(Enum.KeyCode.Space) then
		sitter.SeatPart = nil
		driving = false
	end

	local throttle, steer = 0, 0
	if driving then
		throttle = ((key(Enum.KeyCode.W) or key(Enum.KeyCode.Up)) and 1 or 0) - ((key(Enum.KeyCode.S) or key(Enum.KeyCode.Down)) and 1 or 0)
		steer = ((key(Enum.KeyCode.D) or key(Enum.KeyCode.Right)) and 1 or 0) - ((key(Enum.KeyCode.A) or key(Enum.KeyCode.Left)) and 1 or 0)
	end

	-- how fast we're going along the car's facing (positive: forwards)
	local forward = chassis.AssemblyLinearVelocity:Dot(chassis.CFrame.LookVector)
	local target = 0
	local torque = car:GetAttribute("BrakeTorque") or 3000
	if throttle > 0 then
		if forward < -2 then target = 0 else target = car:GetAttribute("MaxSpeed") or 60; torque = car:GetAttribute("Torque") or 1500 end
	elseif throttle < 0 then
		if forward > 2 then target = 0 else target = -(car:GetAttribute("ReverseSpeed") or 25); torque = car:GetAttribute("Torque") or 1500 end
	elseif driving then
		torque = 40 -- rolling along
	end
	local spin = math.deg(target / radius) -- degrees per second
	for _, w in wheels do
		w.Speed = -spin
		w.MaxTorque = torque
	end

	local angle = -steer * (car:GetAttribute("SteerAngle") or 30)
	for _, s in steering do
		s.TargetAngle = angle
		s.Speed = car:GetAttribute("SteerSpeed") or 150
	end
end)
`

/** A Script (for ScriptService) that ragdolls every character when it dies. */
export const RAGDOLL_SOURCE = `-- Ragdolls: when a character dies (a player's or an NPC's), its limbs stay joined to the torso and
-- flop around instead of falling apart. Legs and the head swing on hinges (with limits), arms and
-- anything else on ball sockets.
local function nearestPoint(part, to)
	-- the point of a box nearest another point
	local l = part.CFrame:PointToObjectSpace(to)
	local h = part.Size / 2
	return part.CFrame:PointToWorldSpace(Vector3.new(
		math.clamp(l.X, -h.X, h.X), math.clamp(l.Y, -h.Y, h.Y), math.clamp(l.Z, -h.Z, h.Z)))
end

local function ragdoll(character)
	local torso = character:FindFirstChild("Torso") or character:FindFirstChild("UpperTorso")
	if not torso then return end
	for _, part in character:GetChildren() do
		if part:IsA("BasePart") and part ~= torso then
			if part.Name == "HumanoidRootPart" then
				-- the invisible root stays with the torso, so the camera follows the body
				local weld = Instance.new("WeldConstraint")
				weld.Part0 = part
				weld.Part1 = torso
				weld.Parent = part
			else
				-- where the limb meets the torso
				local a = nearestPoint(part, torso.Position)
				local b = nearestPoint(torso, a)
				local at = a:Lerp(b, 0.5)
				local joint
				local leg, head = part.Name:match("Leg") ~= nil, part.Name == "Head"
				if leg or head then
					-- legs and the head swing forwards and back (a hinge around the torso's left-right axis)
					joint = Instance.new("HingeConstraint")
					joint.LimitsEnabled = true
					joint.LowerAngle = if leg then -100 else -40
					joint.UpperAngle = if leg then 30 else 40
					joint.Part0 = part
					joint.Part1 = torso
					joint.Pivot = torso.CFrame * CFrame.new(torso.CFrame:PointToObjectSpace(at)) * CFrame.Angles(0, 0, math.rad(-90))
				else
					joint = Instance.new("BallSocketConstraint")
					joint.Part0 = part
					joint.Part1 = torso
					joint.Position = at
				end
				joint.Name = "Ragdoll"
				joint.Parent = part
			end
		end
	end
	-- a little shove backwards, so it doesn't stay balanced on its legs
	task.defer(function()
		torso.AssemblyLinearVelocity += torso.CFrame.LookVector * -6
		torso.AssemblyAngularVelocity += torso.CFrame.RightVector * 3
	end)
end

local function watch(humanoid)
	humanoid.Died:Connect(function()
		if humanoid.Parent then ragdoll(humanoid.Parent) end
	end)
end

for _, d in workspace:GetDescendants() do
	if d:IsA("Humanoid") then watch(d) end
end
workspace.DescendantAdded:Connect(function(d)
	if d:IsA("Humanoid") then watch(d) end
end)
`
