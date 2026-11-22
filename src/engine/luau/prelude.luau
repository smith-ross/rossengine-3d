--!nocheck
-- RossEngine prelude. Builds the Roblox-style scripting API on top of the host
-- bridge `H` (implemented in TypeScript, see LuauRuntime.ts).
--
-- Values cross the bridge as flat, tagged sequences:
--   0 nil | 1 primitive (number/string/bool/vector) | 2 Instance (id, class)
--   4 Vector2 (x,y) | 5 CFrame (12) | 6 Color3 (r,g,b) | 7 UDim2 (4) | 8 UDim (2)
--   9 EnumItem (type, name) | 10 TweenInfo (6) | 11 table (count, k/v pairs...)
--   12 raw value (function, thread)
local H = ...

local rawtypeof = typeof
local freeze = table.freeze
local tpack, tunpack = table.pack, table.unpack
local cresume, crunning, cyield, ccreate, cstatus = coroutine.resume, coroutine.running, coroutine.yield, coroutine.create, coroutine.status

local G = {} -- the global environment that user scripts see (frozen at the end)
local idOf = setmetatable({}, { __mode = "k" }) -- Instance proxy -> id
local jsRefOf = setmetatable({}, { __mode = "k" }) -- foreign (JS/Python) value proxy -> ref id

------------------------------------------------------------------------------
-- typeof
------------------------------------------------------------------------------
local function typeof(v)
	local t = rawtypeof(v)
	if t == "vector" then
		return "Vector3"
	elseif t == "userdata" then
		if idOf[v] then
			return "Instance"
		elseif jsRefOf[v] then
			return "Foreign"
		end
	elseif t == "table" then
		local mt = getmetatable(v)
		if type(mt) == "table" then
			local ty = rawget(mt, "__type")
			if ty then
				return ty
			end
		end
	end
	return t
end

local function kindOf(v)
	local mt = getmetatable(v)
	return type(mt) == "table" and rawget(mt, "__kind") or nil
end

------------------------------------------------------------------------------
-- Vector3 (native Luau vector with a type metatable)
------------------------------------------------------------------------------
local vcreate, vmag, vnorm, vdot, vcross = vector.create, vector.magnitude, vector.normalize, vector.dot, vector.cross
local vabs, vfloor, vceil, vmin, vmax, vangle = vector.abs, vector.floor, vector.ceil, vector.min, vector.max, vector.angle

local V3methods = {
	Dot = vdot,
	Cross = vcross,
	Lerp = function(a, b, t)
		return a + (b - a) * t
	end,
	Abs = vabs,
	Floor = vfloor,
	Ceil = vceil,
	Min = vmin,
	Max = vmax,
	Sign = vector.sign,
	Angle = function(a, b, axis)
		return vangle(a, b, axis)
	end,
	FuzzyEq = function(a, b, eps)
		eps = eps or 1e-5
		return vmag(a - b) <= eps
	end,
}
local V3mt = {
	__index = function(v, k)
		if k == "X" then
			return v.x
		elseif k == "Y" then
			return v.y
		elseif k == "Z" then
			return v.z
		elseif k == "Magnitude" then
			return vmag(v)
		elseif k == "Unit" then
			if vmag(v) == 0 then
				return v
			end
			return vnorm(v)
		end
		local m = V3methods[k]
		if m then
			return m
		end
		error(tostring(k) .. " is not a valid member of Vector3", 2)
	end,
}
H.setVectorMetatable(V3mt)

local Vector3 = {
	new = function(x, y, z)
		return vcreate(x or 0, y or 0, z or 0)
	end,
	zero = vcreate(0, 0, 0),
	one = vcreate(1, 1, 1),
	xAxis = vcreate(1, 0, 0),
	yAxis = vcreate(0, 1, 0),
	zAxis = vcreate(0, 0, 1),
	FromNormalId = nil,
}
G.Vector3 = freeze(Vector3)

------------------------------------------------------------------------------
-- Vector2
------------------------------------------------------------------------------
local V2mt = { __type = "Vector2", __kind = "V2" }
local function V2(x, y)
	return freeze(setmetatable({ X = x, Y = y }, V2mt))
end
local V2methods = {
	Dot = function(a, b)
		return a.X * b.X + a.Y * b.Y
	end,
	Cross = function(a, b)
		return a.X * b.Y - a.Y * b.X
	end,
	Lerp = function(a, b, t)
		return V2(a.X + (b.X - a.X) * t, a.Y + (b.Y - a.Y) * t)
	end,
}
V2mt.__index = function(v, k)
	if k == "Magnitude" then
		return math.sqrt(v.X * v.X + v.Y * v.Y)
	elseif k == "Unit" then
		local m = math.sqrt(v.X * v.X + v.Y * v.Y)
		if m == 0 then
			return v
		end
		return V2(v.X / m, v.Y / m)
	elseif k == "x" then
		return v.X
	elseif k == "y" then
		return v.Y
	end
	local m = V2methods[k]
	if m then
		return m
	end
	error(tostring(k) .. " is not a valid member of Vector2", 2)
end
local function v2val(v)
	if type(v) == "number" then
		return v, v
	end
	return v.X, v.Y
end
V2mt.__add = function(a, b)
	return V2(a.X + b.X, a.Y + b.Y)
end
V2mt.__sub = function(a, b)
	return V2(a.X - b.X, a.Y - b.Y)
end
V2mt.__mul = function(a, b)
	if type(a) == "number" then
		a, b = b, a
	end
	local bx, by = v2val(b)
	return V2(a.X * bx, a.Y * by)
end
V2mt.__div = function(a, b)
	local bx, by = v2val(b)
	return V2(a.X / bx, a.Y / by)
end
V2mt.__unm = function(a)
	return V2(-a.X, -a.Y)
end
V2mt.__eq = function(a, b)
	return a.X == b.X and a.Y == b.Y
end
V2mt.__tostring = function(a)
	return a.X .. ", " .. a.Y
end
G.Vector2 = freeze({
	new = function(x, y)
		return V2(x or 0, y or 0)
	end,
	zero = V2(0, 0),
	one = V2(1, 1),
	xAxis = V2(1, 0),
	yAxis = V2(0, 1),
})

------------------------------------------------------------------------------
-- CFrame
------------------------------------------------------------------------------
local CFmt = { __type = "CFrame", __kind = "CF" }
local function CF(x, y, z, r00, r01, r02, r10, r11, r12, r20, r21, r22)
	return freeze(setmetatable({
		x, y, z, r00, r01, r02, r10, r11, r12, r20, r21, r22,
	}, CFmt))
end
local function cfmul(a, b)
	local ax, ay, az, a00, a01, a02, a10, a11, a12, a20, a21, a22 = tunpack(a)
	local bx, by, bz, b00, b01, b02, b10, b11, b12, b20, b21, b22 = tunpack(b)
	return CF(
		a00 * bx + a01 * by + a02 * bz + ax,
		a10 * bx + a11 * by + a12 * bz + ay,
		a20 * bx + a21 * by + a22 * bz + az,
		a00 * b00 + a01 * b10 + a02 * b20, a00 * b01 + a01 * b11 + a02 * b21, a00 * b02 + a01 * b12 + a02 * b22,
		a10 * b00 + a11 * b10 + a12 * b20, a10 * b01 + a11 * b11 + a12 * b21, a10 * b02 + a11 * b12 + a12 * b22,
		a20 * b00 + a21 * b10 + a22 * b20, a20 * b01 + a21 * b11 + a22 * b21, a20 * b02 + a21 * b12 + a22 * b22
	)
end
local function cfinv(c)
	local x, y, z, r00, r01, r02, r10, r11, r12, r20, r21, r22 = tunpack(c)
	return CF(
		-(r00 * x + r10 * y + r20 * z),
		-(r01 * x + r11 * y + r21 * z),
		-(r02 * x + r12 * y + r22 * z),
		r00, r10, r20, r01, r11, r21, r02, r12, r22
	)
end
local function cfpoint(c, v)
	local x, y, z, r00, r01, r02, r10, r11, r12, r20, r21, r22 = tunpack(c)
	local vx, vy, vz = v.x, v.y, v.z
	return vcreate(r00 * vx + r01 * vy + r02 * vz + x, r10 * vx + r11 * vy + r12 * vz + y, r20 * vx + r21 * vy + r22 * vz + z)
end
local function cfvec(c, v)
	local _, _, _, r00, r01, r02, r10, r11, r12, r20, r21, r22 = tunpack(c)
	local vx, vy, vz = v.x, v.y, v.z
	return vcreate(r00 * vx + r01 * vy + r02 * vz, r10 * vx + r11 * vy + r12 * vz, r20 * vx + r21 * vy + r22 * vz)
end
local function rotX(a)
	local c, s = math.cos(a), math.sin(a)
	return CF(0, 0, 0, 1, 0, 0, 0, c, -s, 0, s, c)
end
local function rotY(a)
	local c, s = math.cos(a), math.sin(a)
	return CF(0, 0, 0, c, 0, s, 0, 1, 0, -s, 0, c)
end
local function rotZ(a)
	local c, s = math.cos(a), math.sin(a)
	return CF(0, 0, 0, c, -s, 0, s, c, 0, 0, 0, 1)
end
local function fromMatrix(pos, vx, vy, vz)
	if not vz then
		vz = vcross(vx, vy)
	end
	return CF(pos.x, pos.y, pos.z, vx.x, vy.x, vz.x, vx.y, vy.y, vz.y, vx.z, vy.z, vz.z)
end
local function lookAt(at, target, up)
	up = up or vcreate(0, 1, 0)
	local look = target - at
	if vmag(look) < 1e-9 then
		return CF(at.x, at.y, at.z, 1, 0, 0, 0, 1, 0, 0, 0, 1)
	end
	local zAxis = vnorm(-look) -- back vector
	local xAxis = vcross(up, zAxis)
	if vmag(xAxis) < 1e-6 then
		xAxis = vcross(vcreate(0, 0, 1), zAxis)
		if vmag(xAxis) < 1e-6 then
			xAxis = vcross(vcreate(1, 0, 0), zAxis)
		end
	end
	xAxis = vnorm(xAxis)
	local yAxis = vcross(zAxis, xAxis)
	return fromMatrix(at, xAxis, yAxis, zAxis)
end
local function toQuat(c)
	local _, _, _, m00, m01, m02, m10, m11, m12, m20, m21, m22 = tunpack(c)
	local tr = m00 + m11 + m22
	local qw, qx, qy, qz
	if tr > 0 then
		local s = math.sqrt(tr + 1) * 2
		qw, qx, qy, qz = 0.25 * s, (m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s
	elseif m00 > m11 and m00 > m22 then
		local s = math.sqrt(1 + m00 - m11 - m22) * 2
		qw, qx, qy, qz = (m21 - m12) / s, 0.25 * s, (m01 + m10) / s, (m02 + m20) / s
	elseif m11 > m22 then
		local s = math.sqrt(1 + m11 - m00 - m22) * 2
		qw, qx, qy, qz = (m02 - m20) / s, (m01 + m10) / s, 0.25 * s, (m12 + m21) / s
	else
		local s = math.sqrt(1 + m22 - m00 - m11) * 2
		qw, qx, qy, qz = (m10 - m01) / s, (m02 + m20) / s, (m12 + m21) / s, 0.25 * s
	end
	return qx, qy, qz, qw
end
local function fromQuat(x, y, z, qx, qy, qz, qw)
	local m = math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw)
	if m == 0 then
		return CF(x, y, z, 1, 0, 0, 0, 1, 0, 0, 0, 1)
	end
	qx, qy, qz, qw = qx / m, qy / m, qz / m, qw / m
	return CF(
		x, y, z,
		1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy - qz * qw), 2 * (qx * qz + qy * qw),
		2 * (qx * qy + qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz - qx * qw),
		2 * (qx * qz - qy * qw), 2 * (qy * qz + qx * qw), 1 - 2 * (qx * qx + qy * qy)
	)
end
local function fromAxisAngle(axis, angle)
	axis = vnorm(axis)
	local s = math.sin(angle / 2)
	return fromQuat(0, 0, 0, axis.x * s, axis.y * s, axis.z * s, math.cos(angle / 2))
end
local function toEulerXYZ(c)
	local _, _, _, r00, r01, r02, _, r11, r12, _, _, r22 = tunpack(c)
	local ry = math.asin(math.clamp(r02, -1, 1))
	local rx, rz
	if math.abs(r02) < 0.9999999 then
		rx = math.atan2(-r12, r22)
		rz = math.atan2(-r01, r00)
	else
		rx = math.atan2(c[11], r11)
		rz = 0
	end
	return rx, ry, rz
end
local function toEulerYXZ(c)
	local _, _, _, r00, r01, r02, r10, r11, r12, r20, _, r22 = tunpack(c)
	local rx = math.asin(-math.clamp(r12, -1, 1))
	local ry, rz
	if math.abs(r12) < 0.9999999 then
		ry = math.atan2(r02, r22)
		rz = math.atan2(r10, r11)
	else
		ry = math.atan2(-r20, r00)
		rz = 0
	end
	return rx, ry, rz
end

local CFmethods = {}
function CFmethods.Inverse(c)
	return cfinv(c)
end
function CFmethods.ToWorldSpace(c, o)
	return cfmul(c, o)
end
function CFmethods.ToObjectSpace(c, o)
	return cfmul(cfinv(c), o)
end
function CFmethods.PointToWorldSpace(c, v)
	return cfpoint(c, v)
end
function CFmethods.PointToObjectSpace(c, v)
	return cfpoint(cfinv(c), v)
end
function CFmethods.VectorToWorldSpace(c, v)
	return cfvec(c, v)
end
function CFmethods.VectorToObjectSpace(c, v)
	return cfvec(cfinv(c), v)
end
function CFmethods.GetComponents(c)
	return tunpack(c)
end
CFmethods.components = CFmethods.GetComponents
function CFmethods.ToEulerAnglesXYZ(c)
	return toEulerXYZ(c)
end
function CFmethods.ToEulerAnglesYXZ(c)
	return toEulerYXZ(c)
end
CFmethods.ToOrientation = CFmethods.ToEulerAnglesYXZ
function CFmethods.ToAxisAngle(c)
	local qx, qy, qz, qw = toQuat(c)
	local angle = 2 * math.acos(math.clamp(qw, -1, 1))
	local s = math.sqrt(1 - qw * qw)
	if s < 1e-6 then
		return vcreate(1, 0, 0), 0
	end
	return vcreate(qx / s, qy / s, qz / s), angle
end
function CFmethods.Lerp(a, b, t)
	local ax, ay, az, aw = toQuat(a)
	local bx, by, bz, bw = toQuat(b)
	local d = ax * bx + ay * by + az * bz + aw * bw
	if d < 0 then
		bx, by, bz, bw, d = -bx, -by, -bz, -bw, -d
	end
	local s0, s1
	if d > 0.9995 then
		s0, s1 = 1 - t, t
	else
		local th = math.acos(d)
		local sn = math.sin(th)
		s0, s1 = math.sin((1 - t) * th) / sn, math.sin(t * th) / sn
	end
	return fromQuat(
		a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t,
		ax * s0 + bx * s1, ay * s0 + by * s1, az * s0 + bz * s1, aw * s0 + bw * s1
	)
end
function CFmethods.Orthonormalize(c)
	local qx, qy, qz, qw = toQuat(c)
	return fromQuat(c[1], c[2], c[3], qx, qy, qz, qw)
end
function CFmethods.FuzzyEq(a, b, eps)
	eps = eps or 1e-5
	for i = 1, 12 do
		if math.abs(a[i] - b[i]) > eps then
			return false
		end
	end
	return true
end

CFmt.__index = function(c, k)
	if k == "Position" or k == "p" then
		return vcreate(c[1], c[2], c[3])
	elseif k == "X" then
		return c[1]
	elseif k == "Y" then
		return c[2]
	elseif k == "Z" then
		return c[3]
	elseif k == "LookVector" then
		return vcreate(-c[6], -c[9], -c[12])
	elseif k == "RightVector" or k == "XVector" then
		return vcreate(c[4], c[7], c[10])
	elseif k == "UpVector" or k == "YVector" then
		return vcreate(c[5], c[8], c[11])
	elseif k == "ZVector" then
		return vcreate(c[6], c[9], c[12])
	elseif k == "Rotation" then
		return CF(0, 0, 0, select(4, tunpack(c)))
	end
	local m = CFmethods[k]
	if m then
		return m
	end
	error(tostring(k) .. " is not a valid member of CFrame", 2)
end
CFmt.__mul = function(a, b)
	if rawtypeof(b) == "vector" then
		return cfpoint(a, b)
	end
	if kindOf(b) ~= "CF" then
		error("invalid argument #2 to '*' (CFrame or Vector3 expected)", 2)
	end
	return cfmul(a, b)
end
CFmt.__add = function(a, b)
	if rawtypeof(b) ~= "vector" then
		error("invalid argument #2 to '+' (Vector3 expected)", 2)
	end
	return CF(a[1] + b.x, a[2] + b.y, a[3] + b.z, select(4, tunpack(a)))
end
CFmt.__sub = function(a, b)
	if rawtypeof(b) ~= "vector" then
		error("invalid argument #2 to '-' (Vector3 expected)", 2)
	end
	return CF(a[1] - b.x, a[2] - b.y, a[3] - b.z, select(4, tunpack(a)))
end
CFmt.__eq = function(a, b)
	for i = 1, 12 do
		if a[i] ~= b[i] then
			return false
		end
	end
	return true
end
CFmt.__tostring = function(c)
	return table.concat({ tunpack(c) }, ", ")
end

local identity = CF(0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1)
local function anglesXYZ(rx, ry, rz)
	return cfmul(cfmul(rotX(rx or 0), rotY(ry or 0)), rotZ(rz or 0))
end
local function anglesYXZ(rx, ry, rz)
	return cfmul(cfmul(rotY(ry or 0), rotX(rx or 0)), rotZ(rz or 0))
end
G.CFrame = freeze({
	new = function(...)
		local n = select("#", ...)
		if n == 0 then
			return identity
		end
		local a, b = ...
		if rawtypeof(a) == "vector" then
			if rawtypeof(b) == "vector" then
				return lookAt(a, b)
			end
			return CF(a.x, a.y, a.z, 1, 0, 0, 0, 1, 0, 0, 0, 1)
		end
		if n == 3 then
			local x, y, z = ...
			return CF(x, y, z, 1, 0, 0, 0, 1, 0, 0, 0, 1)
		elseif n == 7 then
			local x, y, z, qx, qy, qz, qw = ...
			return fromQuat(x, y, z, qx, qy, qz, qw)
		elseif n == 12 then
			return CF(...)
		end
		error("Invalid number of arguments: " .. n, 2)
	end,
	lookAt = lookAt,
	Angles = anglesXYZ,
	fromEulerAnglesXYZ = anglesXYZ,
	fromEulerAnglesYXZ = anglesYXZ,
	fromOrientation = anglesYXZ,
	fromAxisAngle = fromAxisAngle,
	fromMatrix = fromMatrix,
	identity = identity,
})

------------------------------------------------------------------------------
-- Color3
------------------------------------------------------------------------------
local C3mt = { __type = "Color3", __kind = "C3" }
local function C3(r, g, b)
	return freeze(setmetatable({ R = r, G = g, B = b }, C3mt))
end
local function toHSV(c)
	local r, g, b = c.R, c.G, c.B
	local mx, mn = math.max(r, g, b), math.min(r, g, b)
	local d = mx - mn
	local h = 0
	if d > 0 then
		if mx == r then
			h = ((g - b) / d) % 6
		elseif mx == g then
			h = (b - r) / d + 2
		else
			h = (r - g) / d + 4
		end
		h = h / 6
	end
	return h, mx == 0 and 0 or d / mx, mx
end
local C3methods = {
	Lerp = function(a, b, t)
		return C3(a.R + (b.R - a.R) * t, a.G + (b.G - a.G) * t, a.B + (b.B - a.B) * t)
	end,
	ToHSV = toHSV,
	ToHex = function(c)
		return string.format("%02X%02X%02X", math.round(c.R * 255), math.round(c.G * 255), math.round(c.B * 255))
	end,
}
C3mt.__index = function(_, k)
	local m = C3methods[k]
	if m then
		return m
	end
	error(tostring(k) .. " is not a valid member of Color3", 2)
end
C3mt.__eq = function(a, b)
	return a.R == b.R and a.G == b.G and a.B == b.B
end
C3mt.__tostring = function(c)
	return c.R .. ", " .. c.G .. ", " .. c.B
end
local function fromHSV(h, s, v)
	local i = math.floor(h * 6)
	local f = h * 6 - i
	local p, q, t = v * (1 - s), v * (1 - f * s), v * (1 - (1 - f) * s)
	i = i % 6
	if i == 0 then
		return C3(v, t, p)
	elseif i == 1 then
		return C3(q, v, p)
	elseif i == 2 then
		return C3(p, v, t)
	elseif i == 3 then
		return C3(p, q, v)
	elseif i == 4 then
		return C3(t, p, v)
	end
	return C3(v, p, q)
end
G.Color3 = freeze({
	new = function(r, g, b)
		return C3(r or 0, g or 0, b or 0)
	end,
	fromRGB = function(r, g, b)
		return C3((r or 0) / 255, (g or 0) / 255, (b or 0) / 255)
	end,
	fromHSV = fromHSV,
	toHSV = toHSV,
	fromHex = function(hex)
		hex = hex:gsub("#", "")
		local n = tonumber(hex, 16) or 0
		return C3(bit32.extract(n, 16, 8) / 255, bit32.extract(n, 8, 8) / 255, bit32.extract(n, 0, 8) / 255)
	end,
})

-- BrickColor: a small palette mapped to Color3 so classic code works.
local brickPalette = {
	["White"] = { 242, 243, 243 }, ["Medium stone grey"] = { 163, 162, 165 }, ["Dark stone grey"] = { 99, 95, 98 },
	["Black"] = { 27, 42, 53 }, ["Bright red"] = { 196, 40, 28 }, ["Bright blue"] = { 13, 105, 172 },
	["Bright green"] = { 75, 151, 75 }, ["Bright yellow"] = { 245, 205, 48 }, ["Bright orange"] = { 218, 133, 65 },
	["Bright violet"] = { 107, 50, 124 }, ["Really red"] = { 255, 0, 0 }, ["Really blue"] = { 0, 0, 255 },
	["Lime green"] = { 0, 255, 0 }, ["New Yeller"] = { 255, 255, 0 }, ["Institutional white"] = { 248, 248, 248 },
	["Really black"] = { 17, 17, 17 }, ["Reddish brown"] = { 105, 64, 40 }, ["Cyan"] = { 4, 175, 236 },
	["Hot pink"] = { 255, 0, 191 }, ["Toothpaste"] = { 0, 255, 255 }, ["Earth green"] = { 39, 70, 45 },
}
local BCmt = { __type = "BrickColor", __kind = "BC" }
BCmt.__tostring = function(b)
	return b.Name
end
local function BC(name)
	local rgb = brickPalette[name] or brickPalette["Medium stone grey"]
	return freeze(setmetatable({ Name = name, Color = C3(rgb[1] / 255, rgb[2] / 255, rgb[3] / 255), r = rgb[1] / 255, g = rgb[2] / 255, b = rgb[3] / 255 }, BCmt))
end
local brickNames = {}
for k in brickPalette do
	table.insert(brickNames, k)
end
table.sort(brickNames)
G.BrickColor = freeze({
	new = function(name)
		return BC(name)
	end,
	random = function()
		return BC(brickNames[math.random(1, #brickNames)])
	end,
	White = function()
		return BC("White")
	end,
	Black = function()
		return BC("Black")
	end,
	Red = function()
		return BC("Bright red")
	end,
	Blue = function()
		return BC("Bright blue")
	end,
	Green = function()
		return BC("Bright green")
	end,
	Yellow = function()
		return BC("Bright yellow")
	end,
	Gray = function()
		return BC("Medium stone grey")
	end,
})

------------------------------------------------------------------------------
-- UDim / UDim2
------------------------------------------------------------------------------
local U1mt = { __type = "UDim", __kind = "U1" }
local function U1(s, o)
	return freeze(setmetatable({ Scale = s, Offset = o }, U1mt))
end
U1mt.__add = function(a, b)
	return U1(a.Scale + b.Scale, a.Offset + b.Offset)
end
U1mt.__sub = function(a, b)
	return U1(a.Scale - b.Scale, a.Offset - b.Offset)
end
U1mt.__eq = function(a, b)
	return a.Scale == b.Scale and a.Offset == b.Offset
end
U1mt.__tostring = function(a)
	return a.Scale .. ", " .. a.Offset
end
G.UDim = freeze({
	new = function(s, o)
		return U1(s or 0, o or 0)
	end,
})

local U2mt = { __type = "UDim2", __kind = "U2" }
local function U2(xs, xo, ys, yo)
	return freeze(setmetatable({ X = U1(xs, xo), Y = U1(ys, yo) }, U2mt))
end
U2mt.__index = function(u, k)
	if k == "Width" then
		return u.X
	elseif k == "Height" then
		return u.Y
	elseif k == "Lerp" then
		return function(a, b, t)
			return U2(
				a.X.Scale + (b.X.Scale - a.X.Scale) * t, a.X.Offset + (b.X.Offset - a.X.Offset) * t,
				a.Y.Scale + (b.Y.Scale - a.Y.Scale) * t, a.Y.Offset + (b.Y.Offset - a.Y.Offset) * t
			)
		end
	end
	error(tostring(k) .. " is not a valid member of UDim2", 2)
end
U2mt.__add = function(a, b)
	return U2(a.X.Scale + b.X.Scale, a.X.Offset + b.X.Offset, a.Y.Scale + b.Y.Scale, a.Y.Offset + b.Y.Offset)
end
U2mt.__sub = function(a, b)
	return U2(a.X.Scale - b.X.Scale, a.X.Offset - b.X.Offset, a.Y.Scale - b.Y.Scale, a.Y.Offset - b.Y.Offset)
end
U2mt.__eq = function(a, b)
	return a.X == b.X and a.Y == b.Y
end
U2mt.__tostring = function(a)
	return "{" .. tostring(a.X) .. "}, {" .. tostring(a.Y) .. "}"
end
G.UDim2 = freeze({
	new = function(xs, xo, ys, yo)
		if type(xs) == "table" then
			return U2(xs.Scale, xs.Offset, xo.Scale, xo.Offset)
		end
		return U2(xs or 0, xo or 0, ys or 0, yo or 0)
	end,
	fromScale = function(x, y)
		return U2(x or 0, 0, y or 0, 0)
	end,
	fromOffset = function(x, y)
		return U2(0, x or 0, 0, y or 0)
	end,
})

------------------------------------------------------------------------------
-- Enum
------------------------------------------------------------------------------
local EImt = { __type = "EnumItem", __kind = "E" }
EImt.__tostring = function(e)
	return "Enum." .. e.EnumType.Name .. "." .. e.Name
end
EImt.__index = function(e, k)
	if k == "IsA" then
		return function(self, name)
			return self.EnumType.Name == name
		end
	end
	error(tostring(k) .. " is not a valid member of EnumItem", 2)
end
local ETmt = { __type = "Enum" }
ETmt.__tostring = function(t)
	return t.Name
end
local enumTypes = {}
local function getEnum(name)
	local et = enumTypes[name]
	if et then
		return et
	end
	local names = H.enumItems(name)
	if not names then
		return nil
	end
	local items = {}
	local list = {}
	local etObj = { Name = name }
	for i, itemName in ipairs(names) do
		local item = freeze(setmetatable({ Name = itemName, Value = i - 1, EnumType = etObj }, EImt))
		items[itemName] = item
		table.insert(list, item)
	end
	etObj.GetEnumItems = function()
		return table.clone(list)
	end
	ETmt.__index = function(t, k)
		local items_ = rawget(t, "__items")
		local v = items_ and items_[k]
		if v then
			return v
		end
		error(tostring(k) .. " is not a valid member of \"Enum." .. tostring(rawget(t, "Name")) .. "\"", 2)
	end
	etObj.__items = items
	setmetatable(etObj, ETmt)
	freeze(etObj)
	enumTypes[name] = etObj
	return etObj
end
local function enumItem(typeName, itemName)
	local et = getEnum(typeName)
	return et and et.__items[itemName]
end
G.Enum = freeze(setmetatable({}, {
	__index = function(_, k)
		local et = getEnum(k)
		if not et then
			error(tostring(k) .. " is not a valid member of \"Enums\"", 2)
		end
		return et
	end,
	__tostring = function()
		return "Enums"
	end,
}))

------------------------------------------------------------------------------
-- TweenInfo, Ray, RaycastParams, Random
------------------------------------------------------------------------------
local TImt = { __type = "TweenInfo", __kind = "TI" }
G.TweenInfo = freeze({
	new = function(time, style, direction, repeatCount, reverses, delayTime)
		return freeze(setmetatable({
			Time = time or 1,
			EasingStyle = style or enumItem("EasingStyle", "Quad"),
			EasingDirection = direction or enumItem("EasingDirection", "Out"),
			RepeatCount = repeatCount or 0,
			Reverses = reverses or false,
			DelayTime = delayTime or 0,
		}, TImt))
	end,
})

local Raymt = { __type = "Ray", __kind = "RAY" }
local function makeRay(o, d)
	return freeze(setmetatable({ Origin = o, Direction = d, Unit = nil }, Raymt))
end
Raymt.__index = function(r, k)
	if k == "Unit" then
		return makeRay(r.Origin, vnorm(r.Direction))
	elseif k == "ClosestPoint" then
		return function(self, p)
			local d = vnorm(self.Direction)
			local t = math.max(0, vdot(p - self.Origin, d))
			return self.Origin + d * t
		end
	elseif k == "Distance" then
		return function(self, p)
			return vmag(p - self:ClosestPoint(p))
		end
	end
	error(tostring(k) .. " is not a valid member of Ray", 2)
end
G.Ray = freeze({ new = makeRay })

local RPmt = { __type = "RaycastParams" }
G.RaycastParams = freeze({
	new = function()
		return setmetatable({
			FilterDescendantsInstances = {},
			FilterType = enumItem("RaycastFilterType", "Exclude"),
			IgnoreWater = false,
			CollisionGroup = "Default",
			RespectCanCollide = false,
		}, RPmt)
	end,
})

local Randommt = { __type = "Random" }
Randommt.__index = Randommt
local function rngNext(self)
	-- mulberry32
	local s = bit32.bor(self._s + 0x6D2B79F5, 0)
	self._s = s
	local t = bit32.bxor(s, bit32.rshift(s, 15))
	t = (t * bit32.bor(t, 1)) % 4294967296
	t = bit32.bxor(t, t + ((bit32.bxor(t, bit32.rshift(t, 7)) * bit32.bor(t, 61)) % 4294967296))
	t = bit32.bxor(t, bit32.rshift(t, 14))
	return (t % 4294967296) / 4294967296
end
function Randommt:NextNumber(min, max)
	min, max = min or 0, max or 1
	return min + (max - min) * rngNext(self)
end
function Randommt:NextInteger(min, max)
	return math.floor(min + (max - min + 1) * rngNext(self))
end
function Randommt:NextUnitVector()
	local z = self:NextNumber(-1, 1)
	local a = self:NextNumber(0, math.pi * 2)
	local r = math.sqrt(1 - z * z)
	return vcreate(r * math.cos(a), r * math.sin(a), z)
end
function Randommt:Clone()
	return setmetatable({ _s = self._s }, Randommt)
end
G.Random = freeze({
	new = function(seed)
		return setmetatable({ _s = bit32.bor(math.floor(seed or (os.clock() * 1e6)), 0) }, Randommt)
	end,
})

------------------------------------------------------------------------------
-- Scheduler (task library)
------------------------------------------------------------------------------
local now = 0 -- game time in seconds, set by step()
local waiting = {} -- { thread, resumeAt, startedAt }
local deferred = {} -- { thread or fn, args }
local cancelled = setmetatable({}, { __mode = "k" })
local threadScript = setmetatable({}, { __mode = "k" }) -- thread -> script id
local deadScripts = {}
local currentScript = nil

local function reportError(co, err)
	local msg = tostring(err)
	local tb = debug.traceback(co)
	H.scriptError(msg, tb or "", currentScript or 0)
end

local function resume(co, ...)
	if cancelled[co] then
		return
	end
	local sid = threadScript[co]
	if sid and deadScripts[sid] then
		return
	end
	if cstatus(co) ~= "suspended" then
		return
	end
	local prev = currentScript
	currentScript = sid
	local ok, err = cresume(co, ...)
	if not ok then
		reportError(co, err)
	end
	currentScript = prev
end

local function newThread(fn)
	local co = ccreate(fn)
	threadScript[co] = currentScript
	return co
end

local function spawnFn(fn, ...)
	local co = type(fn) == "thread" and fn or newThread(fn)
	resume(co, ...)
	return co
end

local task = {}
function task.spawn(fn, ...)
	if type(fn) ~= "function" and type(fn) ~= "thread" then
		error("invalid argument #1 to 'spawn' (function or thread expected)", 2)
	end
	return spawnFn(fn, ...)
end
function task.defer(fn, ...)
	local co = type(fn) == "thread" and fn or newThread(fn)
	table.insert(deferred, { co, tpack(...) })
	return co
end
function task.delay(t, fn, ...)
	local co = type(fn) == "thread" and fn or newThread(fn)
	table.insert(waiting, { co, now + (t or 0), now, tpack(...) })
	return co
end
function task.wait(t)
	t = tonumber(t) or 0
	local co = crunning()
	if not coroutine.isyieldable() then
		error("attempt to yield across metamethod/C-call boundary", 2)
	end
	table.insert(waiting, { co, now + t, now })
	return cyield()
end
function task.cancel(co)
	cancelled[co] = true
	pcall(coroutine.close, co)
end
function task.synchronize() end
function task.desynchronize() end
G.task = freeze(task)

G.wait = function(t)
	local dt = task.wait(t or 0.03)
	return dt, now
end
G.delay = function(t, fn)
	task.delay(t, fn)
end
G.spawn = function(fn)
	task.defer(fn)
end
G.Wait = G.wait
G.Spawn = G.spawn
G.Delay = G.delay

local function step(t)
	now = t
	-- resume due threads (collect first; resumed threads may add more)
	if #waiting > 0 then
		local due = {}
		local keep = {}
		for _, w in ipairs(waiting) do
			if w[2] <= t then
				table.insert(due, w)
			else
				table.insert(keep, w)
			end
		end
		waiting = keep
		table.sort(due, function(a, b)
			return a[2] < b[2]
		end)
		for _, w in ipairs(due) do
			if w[4] then
				resume(w[1], tunpack(w[4], 1, w[4].n))
			else
				resume(w[1], t - w[3])
			end
		end
	end
	local guard = 0
	while #deferred > 0 and guard < 100 do
		guard += 1
		local list = deferred
		deferred = {}
		for _, d in ipairs(list) do
			resume(d[1], tunpack(d[2], 1, d[2].n))
		end
	end
end

------------------------------------------------------------------------------
-- Signals
------------------------------------------------------------------------------
local Connection = { __type = "RBXScriptConnection" }
Connection.__index = Connection
function Connection:Disconnect()
	if self.Connected then
		self.Connected = false
		local list = self._signal._conns
		local i = table.find(list, self)
		if i then
			table.remove(list, i)
		end
	end
end
Connection.disconnect = Connection.Disconnect

local Signal = { __type = "RBXScriptSignal" }
Signal.__index = Signal
Signal.__tostring = function(s)
	return "Signal " .. (s._name or "")
end
local function newSignal(name, onFirstUse)
	return setmetatable({ _conns = {}, _waiters = {}, _listen = onFirstUse, _name = name }, Signal)
end
function Signal:Connect(fn)
	if type(fn) ~= "function" then
		error("Attempt to connect failed: Passed value is not a function", 2)
	end
	if self._listen then
		self._listen()
		self._listen = nil
	end
	local c = setmetatable({ Connected = true, _fn = fn, _signal = self, _script = currentScript }, Connection)
	table.insert(self._conns, c)
	return c
end
Signal.connect = Signal.Connect
function Signal:Once(fn)
	local c
	c = self:Connect(function(...)
		c:Disconnect()
		fn(...)
	end)
	return c
end
function Signal:ConnectParallel(fn)
	return self:Connect(fn)
end
function Signal:Wait()
	if self._listen then
		self._listen()
		self._listen = nil
	end
	local co = crunning()
	table.insert(self._waiters, co)
	return cyield()
end
Signal.wait = Signal.Wait
function Signal:_fire(...)
	local conns = self._conns
	if #conns > 0 then
		for _, c in ipairs(table.clone(conns)) do
			if c.Connected and not (c._script and deadScripts[c._script]) then
				local co = ccreate(c._fn)
				threadScript[co] = c._script
				resume(co, ...)
			end
		end
	end
	local w = self._waiters
	if #w > 0 then
		self._waiters = {}
		for _, co in ipairs(w) do
			resume(co, ...)
		end
	end
end

------------------------------------------------------------------------------
-- Instances
------------------------------------------------------------------------------
local wrappers = {} -- id -> proxy
local classOf = {} -- id -> class name
local signals = {} -- id -> { name -> Signal }
local luaProps = {} -- id -> { name -> value } (Luau-only properties like OnInvoke)
local memberCache = {} -- class -> { name -> kind }
local luaMethods = {} -- class -> { name -> fn } (Luau-implemented methods)
local luaPropNames = {} -- class -> { name -> true }
local methodCache = {} -- name -> fn

local wrap -- forward

-- Call into the host, re-raising errors at the user's call site (level 3) without the JS traceback.
local function cleanErr(e)
	local msg = tostring(e)
	local i = string.find(msg, "\nstack traceback:", 1, true)
	if i then
		msg = string.sub(msg, 1, i - 1)
	end
	return msg
end
local function hostCall(f, ...)
	local r = tpack(pcall(f, ...))
	if not r[1] then
		error(cleanErr(r[2]), 3)
	end
	return tunpack(r, 2, r.n)
end

-- encoding ------------------------------------------------------------------
local function enc(buf, n, v)
	local t = rawtypeof(v)
	if v == nil then
		buf[n + 1] = 0
		return n + 1
	elseif t == "number" or t == "string" or t == "boolean" or t == "vector" then
		buf[n + 1] = 1
		buf[n + 2] = v
		return n + 2
	elseif t == "userdata" then
		local id = idOf[v]
		if id then
			buf[n + 1] = 2
			buf[n + 2] = id
			return n + 2
		end
		local ref = jsRefOf[v]
		if ref then
			buf[n + 1] = 13
			buf[n + 2] = ref
			return n + 2
		end
		buf[n + 1] = 1
		buf[n + 2] = tostring(v)
		return n + 2
	elseif t == "table" then
		local k = kindOf(v)
		if k == "CF" then
			buf[n + 1] = 5
			for i = 1, 12 do
				buf[n + 1 + i] = v[i]
			end
			return n + 13
		elseif k == "C3" then
			buf[n + 1], buf[n + 2], buf[n + 3], buf[n + 4] = 6, v.R, v.G, v.B
			return n + 4
		elseif k == "V2" then
			buf[n + 1], buf[n + 2], buf[n + 3] = 4, v.X, v.Y
			return n + 3
		elseif k == "U2" then
			buf[n + 1], buf[n + 2], buf[n + 3], buf[n + 4], buf[n + 5] = 7, v.X.Scale, v.X.Offset, v.Y.Scale, v.Y.Offset
			return n + 5
		elseif k == "U1" then
			buf[n + 1], buf[n + 2], buf[n + 3] = 8, v.Scale, v.Offset
			return n + 3
		elseif k == "E" then
			buf[n + 1], buf[n + 2], buf[n + 3] = 9, v.EnumType.Name, v.Name
			return n + 3
		elseif k == "BC" then
			return enc(buf, n, v.Color)
		elseif k == "TI" then
			buf[n + 1] = 10
			buf[n + 2] = v.Time
			buf[n + 3] = v.EasingStyle.Name
			buf[n + 4] = v.EasingDirection.Name
			buf[n + 5] = v.RepeatCount
			buf[n + 6] = v.Reverses
			buf[n + 7] = v.DelayTime
			return n + 7
		elseif k == "RAY" then
			buf[n + 1] = 11
			buf[n + 2] = 2
			n = enc(buf, n + 2, "Origin")
			n = enc(buf, n, v.Origin)
			n = enc(buf, n, "Direction")
			return enc(buf, n, v.Direction)
		end
		-- plain table -> dictionary
		buf[n + 1] = 11
		local countIdx = n + 2
		n = n + 2
		local count = 0
		for key, val in pairs(v) do
			count += 1
			n = enc(buf, n, key)
			n = enc(buf, n, val)
		end
		buf[countIdx] = count
		return n
	else
		buf[n + 1] = 12
		buf[n + 2] = v
		return n + 2
	end
end

local function encAll(...)
	local buf = {}
	local n = 0
	for i = 1, select("#", ...) do
		n = enc(buf, n, (select(i, ...)))
	end
	return buf, n
end

-- decoding ------------------------------------------------------------------
local jsProxy -- forward
local decodeAt
decodeAt = function(a, i)
	local tag = a[i]
	if tag == 0 then
		return nil, i + 1
	elseif tag == 1 then
		return a[i + 1], i + 2
	elseif tag == 2 then
		return wrap(a[i + 1], a[i + 2]), i + 3
	elseif tag == 4 then
		return V2(a[i + 1], a[i + 2]), i + 3
	elseif tag == 5 then
		return CF(a[i + 1], a[i + 2], a[i + 3], a[i + 4], a[i + 5], a[i + 6], a[i + 7], a[i + 8], a[i + 9], a[i + 10], a[i + 11], a[i + 12]), i + 13
	elseif tag == 6 then
		return C3(a[i + 1], a[i + 2], a[i + 3]), i + 4
	elseif tag == 7 then
		return U2(a[i + 1], a[i + 2], a[i + 3], a[i + 4]), i + 5
	elseif tag == 8 then
		return U1(a[i + 1], a[i + 2]), i + 3
	elseif tag == 9 then
		return enumItem(a[i + 1], a[i + 2]), i + 3
	elseif tag == 11 then
		local count = a[i + 1]
		local t = {}
		i = i + 2
		for _ = 1, count do
			local k, v
			k, i = decodeAt(a, i)
			v, i = decodeAt(a, i)
			if k ~= nil then
				t[k] = v
			end
		end
		return t, i
	elseif tag == 12 then
		return a[i + 1], i + 2
	elseif tag == 13 then
		return jsProxy(a[i + 1]), i + 2
	end
	error("bad bridge value tag " .. tostring(tag))
end

local function decodeAll(...)
	local a = tpack(...)
	local out = {}
	local n = 0
	local i = 1
	while i <= a.n do
		n += 1
		out[n], i = decodeAt(a, i)
	end
	return tunpack(out, 1, n)
end

local function decode1(...)
	local a = tpack(...)
	if a.n == 0 then
		return nil
	end
	local v = decodeAt(a, 1)
	return v
end

-- members -------------------------------------------------------------------
local function getMembers(cls)
	local m = memberCache[cls]
	if m then
		return m
	end
	m = {}
	local list = H.members(cls) -- { name, kind, name, kind, ... , "@ancestry", cls1, cls2 ... }
	local i = 1
	local ancestry = {}
	while i <= #list do
		local name = list[i]
		if name == "@ancestry" then
			for j = i + 1, #list do
				table.insert(ancestry, list[j])
			end
			break
		end
		m[name] = list[i + 1]
		i += 2
	end
	-- Luau-side members, most-derived first
	for _, c in ipairs(ancestry) do
		local lm = luaMethods[c]
		if lm then
			for name, fn in lm do
				if m[name] == nil or m[name] == "M" then
					m[name] = fn
				end
			end
		end
		local lp = luaPropNames[c]
		if lp then
			for name in lp do
				m[name] = "L"
			end
		end
	end
	memberCache[cls] = m
	return m
end

local function signalFor(id, name, hostBacked)
	local s = signals[id]
	if not s then
		s = {}
		signals[id] = s
	end
	local sig = s[name]
	if not sig then
		sig = newSignal(name, hostBacked and function()
			H.listen(id, name)
		end or nil)
		s[name] = sig
	end
	return sig
end

local function hostMethod(name)
	local f = methodCache[name]
	if f then
		return f
	end
	f = function(self, ...)
		local id = idOf[self]
		if not id then
			error("Expected ':' not '.' calling member function " .. name, 2)
		end
		local buf, n = encAll(...)
		return decodeAll(hostCall(H.call, id, name, tunpack(buf, 1, n)))
	end
	methodCache[name] = f
	return f
end

local function instIndex(self, key)
	local id = idOf[self]
	local cls = classOf[id]
	local m = getMembers(cls)
	local kind = m[key]
	if kind == "P" or kind == "R" then
		return decode1(hostCall(H.get, id, key))
	elseif kind == "M" then
		return hostMethod(key)
	elseif kind == "E" then
		return signalFor(id, key, true)
	elseif kind == "L" then
		local p = luaProps[id]
		return p and p[key]
	elseif type(kind) == "function" then
		return kind
	end
	if type(key) == "string" then
		local child = decode1(H.child(id, key))
		if child ~= nil then
			return child
		end
	end
	error(tostring(key) .. " is not a valid member of " .. cls .. ' "' .. H.fullName(id) .. '"', 2)
end

local function instNewIndex(self, key, value)
	local id = idOf[self]
	local cls = classOf[id]
	local kind = getMembers(cls)[key]
	if kind == "P" then
		local buf, n = encAll(value)
		hostCall(H.set, id, key, tunpack(buf, 1, n))
		return
	elseif kind == "L" then
		local p = luaProps[id]
		if not p then
			p = {}
			luaProps[id] = p
		end
		p[key] = value
		return
	elseif kind == "R" then
		error("Unable to assign property " .. tostring(key) .. ". Property is read only", 2)
	end
	error(tostring(key) .. " is not a valid member of " .. cls .. ' "' .. H.fullName(id) .. '"', 2)
end

local function instToString(self)
	return decode1(H.get(idOf[self], "Name"))
end

wrap = function(id, cls)
	local w = wrappers[id]
	if w then
		return w
	end
	w = newproxy(true)
	local mt = getmetatable(w)
	mt.__index = instIndex
	mt.__newindex = instNewIndex
	mt.__tostring = instToString
	mt.__type = "Instance"
	mt.__metatable = "The metatable is locked"
	wrappers[id] = w
	idOf[w] = id
	classOf[id] = cls
	return w
end

local function defineLua(cls, methods)
	luaMethods[cls] = luaMethods[cls] or {}
	for k, v in methods do
		luaMethods[cls][k] = v
	end
end
local function defineLuaProps(cls, names)
	luaPropNames[cls] = luaPropNames[cls] or {}
	for _, n in names do
		luaPropNames[cls][n] = true
	end
end

-- Luau-implemented members ----------------------------------------------------
defineLua("Instance", {
	WaitForChild = function(self, name, timeout)
		local child = self:FindFirstChild(name)
		if child then
			return child
		end
		local start = now
		local warned = false
		while true do
			task.wait()
			child = self:FindFirstChild(name)
			if child then
				return child
			end
			if timeout and now - start >= timeout then
				return nil
			end
			if not timeout and not warned and now - start > 5 then
				warned = true
				H.print(1, "Infinite yield possible on '" .. self:GetFullName() .. ":WaitForChild(\"" .. tostring(name) .. "\")'")
			end
		end
	end,
	GetPropertyChangedSignal = function(self, prop)
		local id = idOf[self]
		local kind = getMembers(classOf[id])[prop]
		if kind ~= "P" and kind ~= "R" then
			error(tostring(prop) .. " is not a valid property name.", 2)
		end
		return signalFor(id, "Changed:" .. prop, true)
	end,
	GetAttributeChangedSignal = function(self, attr)
		return signalFor(idOf[self], "AttributeChanged:" .. tostring(attr), true)
	end,
})
G.Instance = freeze({
	new = function(className, parent)
		if type(className) ~= "string" then
			error("invalid argument #1 to 'new' (string expected)", 2)
		end
		local inst = decode1(hostCall(H.new, className))
		if parent ~= nil then
			inst.Parent = parent
		end
		return inst
	end,
})

defineLuaProps("BindableFunction", { "OnInvoke" })
defineLua("BindableFunction", {
	Invoke = function(self, ...)
		local cb = luaProps[idOf[self]] and luaProps[idOf[self]].OnInvoke
		while not cb do
			task.wait()
			cb = luaProps[idOf[self]] and luaProps[idOf[self]].OnInvoke
		end
		return cb(...)
	end,
})
-- RunService:BindToRenderStep
local renderBindings = {}
defineLua("RunService", {
	BindToRenderStep = function(self, name, priority, fn)
		renderBindings[name] = { priority = priority, fn = fn, script = currentScript }
		self.RenderStepped:Connect(function() end) -- make sure the host fires RenderStepped
	end,
	UnbindFromRenderStep = function(_, name)
		renderBindings[name] = nil
	end,
})

-- ContextActionService (keyboard bindings only)
local actions = {}
defineLua("ContextActionService", {
	BindAction = function(_, name, fn, _createButton, ...)
		actions[name] = { fn = fn, inputs = { ... }, script = currentScript }
	end,
	UnbindAction = function(_, name)
		actions[name] = nil
	end,
})

------------------------------------------------------------------------------
-- require
------------------------------------------------------------------------------
------------------------------------------------------------------------------
-- Foreign values (TypeScript / Python objects and functions) seen from Luau
------------------------------------------------------------------------------
local jsProxies = setmetatable({}, { __mode = "v" })
jsProxy = function(ref)
	local p = jsProxies[ref]
	if p then
		return p
	end
	p = newproxy(true)
	local mt = getmetatable(p)
	mt.__index = function(_, k)
		local buf, n = encAll(k)
		return decode1(hostCall(H.jsget, ref, tunpack(buf, 1, n)))
	end
	mt.__newindex = function(_, k, v)
		local buf, n = encAll(k, v)
		hostCall(H.jsset, ref, tunpack(buf, 1, n))
	end
	mt.__call = function(_, ...)
		local buf, n = encAll(...)
		return decodeAll(hostCall(H.jscall, ref, tunpack(buf, 1, n)))
	end
	mt.__len = function()
		return H.jslen(ref)
	end
	mt.__tostring = function()
		return H.jsstr(ref)
	end
	mt.__iter = function(self)
		local keys = H.jskeys(ref)
		local i = 0
		return function()
			i += 1
			local k = keys[i]
			if k == nil then
				return nil
			end
			return k, self[k]
		end
	end
	mt.__type = "Foreign"
	jsProxies[ref] = p
	jsRefOf[p] = ref
	return p
end

local moduleCache = {}
local function require_(m, fromScriptId)
	if type(m) == "string" then
		m = decode1(hostCall(H.resolve, fromScriptId or 0, m))
	end
	local id = idOf[m]
	if id and classOf[id] == "ModuleScript" and H.isForeign(id) then
		-- TypeScript / Python module: loaded by the host, returned as a live proxy
		local c = moduleCache[id]
		if c then
			return c.value
		end
		local v = decode1(hostCall(H.requireForeign, id))
		moduleCache[id] = { value = v }
		return v
	end
	if not id or classOf[id] ~= "ModuleScript" then
		error("Attempted to call require with invalid argument(s).", 2)
	end
	local c = moduleCache[id]
	if c then
		while c.loading do
			task.wait()
		end
		if c.failed then
			error("Requested module experienced an error while loading", 2)
		end
		return c.value
	end
	c = { loading = true }
	moduleCache[id] = c
	local fn = H.loadModule(id)
	if type(fn) == "string" then
		c.loading = false
		c.failed = true
		error(fn, 2)
	end
	local results = tpack(pcall(fn))
	c.loading = false
	if not results[1] then
		c.failed = true
		H.scriptError(tostring(results[2]), "", id)
		error("Requested module experienced an error while loading", 2)
	end
	if results.n ~= 2 then
		c.failed = true
		error("Module code did not return exactly one value", 2)
	end
	c.value = results[2]
	return c.value
end

------------------------------------------------------------------------------
-- Globals
------------------------------------------------------------------------------
local function joinArgs(...)
	local n = select("#", ...)
	local parts = table.create(n)
	for i = 1, n do
		parts[i] = tostring((select(i, ...)))
	end
	return table.concat(parts, " ")
end

for _, k in
	{
		"assert", "error", "getmetatable", "ipairs", "next", "pairs", "pcall", "rawequal", "rawget", "rawset", "rawlen",
		"select", "setmetatable", "tonumber", "tostring", "type", "unpack", "xpcall", "newproxy", "gcinfo",
	}
do
	G[k] = _G[k]
end
for _, lib in { "string", "table", "math", "coroutine", "bit32", "utf8", "buffer", "vector" } do
	if _G[lib] then
		G[lib] = _G[lib]
	end
end
G.os = freeze({ clock = os.clock, time = os.time, date = os.date, difftime = os.difftime })
G.debug = freeze({
	traceback = debug.traceback,
	info = debug.info,
	profilebegin = function() end,
	profileend = function() end,
	setmemorycategory = function() end,
	resetmemorycategory = function() end,
})
G.typeof = typeof
G.print = function(...)
	H.print(0, joinArgs(...))
end
G.warn = function(...)
	H.print(1, joinArgs(...))
end
G.require = require_
G.tick = function()
	return H.clock()
end
G.time = function()
	return now
end
G.elapsedTime = G.time
G.version = function()
	return "RossEngine 0.1"
end
G._G = {}
G.shared = G._G
G._VERSION = "Luau"

local game = decode1(H.game())
G.game = game
G.Game = game
G.workspace = game:GetService("Workspace")
G.Workspace = G.workspace
G.script = nil

freeze(G)

------------------------------------------------------------------------------
-- Internals exposed to the host
------------------------------------------------------------------------------
local internals = {}

function internals.makeEnv(id, cls)
	local env = setmetatable({}, { __index = G })
	env.script = wrap(id, cls)
	env.require = function(m)
		return require_(m, id)
	end
	return env
end

function internals.runScript(fn, scriptId)
	local prev = currentScript
	currentScript = scriptId
	local co = newThread(fn)
	currentScript = prev
	resume(co)
end

function internals.killScript(scriptId)
	deadScripts[scriptId] = true
	moduleCache[scriptId] = nil
end

function internals.reviveScript(scriptId)
	deadScripts[scriptId] = nil
end

function internals.step(t)
	step(t)
end

function internals.dispatch(id, name, ...)
	local s = signals[id]
	if not s then
		return
	end
	local sig = s[name]
	if not sig then
		return
	end
	sig:_fire(decodeAll(...))
end

function internals.renderStep(dt)
	local list = {}
	for name, b in renderBindings do
		table.insert(list, b)
	end
	table.sort(list, function(a, b)
		return a.priority < b.priority
	end)
	for _, b in ipairs(list) do
		if not (b.script and deadScripts[b.script]) then
			local co = ccreate(b.fn)
			threadScript[co] = b.script
			resume(co, dt)
		end
	end
end

function internals.action(keyName, state, inputId, inputCls)
	for name, a in actions do
		for _, input in ipairs(a.inputs) do
			if typeof(input) == "EnumItem" and input.Name == keyName then
				local co = ccreate(a.fn)
				threadScript[co] = a.script
				resume(co, name, enumItem("UserInputState", state), wrap(inputId, inputCls))
			end
		end
	end
end

-- Live encoding: plain tables and functions go by reference (tag 12) so other languages
-- see the real table/function, not a copy.
local function encLive(buf, n, v)
	local t = rawtypeof(v)
	if (t == "table" and not kindOf(v)) or t == "function" or t == "thread" then
		buf[n + 1] = 12
		buf[n + 2] = v
		return n + 2
	end
	return enc(buf, n, v)
end
local function encLiveAll(...)
	local buf, n = {}, 0
	for i = 1, select("#", ...) do
		n = encLive(buf, n, (select(i, ...)))
	end
	return tunpack(buf, 1, n)
end
function internals.getLive(t, ...)
	return encLiveAll(t[decode1(...)])
end
function internals.setLive(t, ...)
	local k, v = decodeAll(...)
	t[k] = v
end
function internals.keysLive(t)
	local out = {}
	for k in pairs(t) do
		local kt = type(k)
		if kt == "string" or kt == "number" then
			table.insert(out, k)
		end
	end
	return tunpack(out)
end
function internals.callLive(fn, ...)
	return encLiveAll(fn(decodeAll(...)))
end
function internals.requireLive(id, cls)
	return encLiveAll(require_(wrap(id, cls)))
end

function internals.forget(id)
	signals[id] = nil
	luaProps[id] = nil
end

return internals
