--- The island itself: heights, ground cover, roads and the things placed on it.
-- Pure Lua, no engine calls, so the test suite can run it under LuaJIT.
--
-- The map is N x N cells. Heights live on the (N+1) x (N+1) corners; ground
-- cover, roads and objects live on the cells. Sea level is 0: a cell whose
-- corners average below it is water.

local M = {}

M.N = 66                    -- cells per side
M.V = M.N + 1               -- corners per side
M.CHUNK = 11                -- cells per chunk side
M.CHUNKS = M.N / M.CHUNK    -- chunks per side
M.HALF = M.N / 2
M.MIN_H, M.MAX_H = -2, 9
M.SEABED = -0.6             -- the sea is shallow, so land appears after one stroke
M.MARGIN = 2                -- cells along the border that stay sea
M.WET = -0.08               -- a cell below this is water

-- Ground cover.
M.GRASS, M.SAND, M.FLOWERS, M.WHEAT, M.SNOW, M.LAVENDER, M.PAVING = 1, 2, 3, 4, 5, 6, 7

local N, V = M.N, M.V
local floor, min, max, sqrt = math.floor, math.min, math.max, math.sqrt

local function vi(vx, vz) return vz * V + vx + 1 end
local function ci(cx, cz) return cz * N + cx + 1 end
M.vi, M.ci = vi, ci

function M.new()
    local w = { h = {}, surf = {}, road = {}, obj = {}, dirty = {}, revision = 0 }
    for i = 1, V * V do w.h[i] = M.SEABED end
    for i = 1, N * N do
        w.surf[i] = M.GRASS
        w.road[i] = 0
        w.obj[i] = 0
    end
    for c = 1, M.CHUNKS * M.CHUNKS do w.dirty[c] = true end
    return w
end

function M.inside(cx, cz)
    return cx >= 0 and cz >= 0 and cx < N and cz < N
end

--- Whether a world position is where the island may grow: inside the map and off its border.
function M.reachable(x, z)
    local limit = M.HALF - M.MARGIN - 0.5
    return x > -limit and x < limit and z > -limit and z < limit
end

--- The cell under a world position, or nil outside the map.
function M.cell_at(x, z)
    local cx, cz = floor(x + M.HALF), floor(z + M.HALF)
    if M.inside(cx, cz) then return cx, cz end
    return nil
end

--- World position of the middle of a cell.
function M.cell_center(cx, cz)
    return cx + 0.5 - M.HALF, cz + 0.5 - M.HALF
end

function M.corner(w, vx, vz)
    if vx < 0 or vz < 0 or vx > N or vz > N then return M.SEABED end
    return w.h[vi(vx, vz)]
end

--- Height of the ground at a world position (bilinear over the cell).
function M.height_at(w, x, z)
    local gx, gz = x + M.HALF, z + M.HALF
    local cx, cz = floor(gx), floor(gz)
    if cx < 0 or cz < 0 or cx >= N or cz >= N then return M.SEABED end
    local fx, fz = gx - cx, gz - cz
    local h = w.h
    local a, b = h[vi(cx, cz)], h[vi(cx + 1, cz)]
    local c, d = h[vi(cx, cz + 1)], h[vi(cx + 1, cz + 1)]
    return (a + (b - a) * fx) * (1 - fz) + (c + (d - c) * fx) * fz
end

--- Average, lowest and highest corner of a cell.
function M.cell_heights(w, cx, cz)
    if not M.inside(cx, cz) then return M.SEABED, M.SEABED, M.SEABED end
    local h = w.h
    local a, b = h[vi(cx, cz)], h[vi(cx + 1, cz)]
    local c, d = h[vi(cx, cz + 1)], h[vi(cx + 1, cz + 1)]
    return (a + b + c + d) * 0.25, min(a, b, c, d), max(a, b, c, d)
end

function M.is_wet(w, cx, cz)
    if not M.inside(cx, cz) then return true end
    local h = w.h
    return (h[vi(cx, cz)] + h[vi(cx + 1, cz)] + h[vi(cx, cz + 1)] + h[vi(cx + 1, cz + 1)]) * 0.25 < M.WET
end

function M.get_obj(w, cx, cz)
    if not M.inside(cx, cz) then return 0 end
    return w.obj[ci(cx, cz)]
end

function M.has_road(w, cx, cz)
    return M.inside(cx, cz) and w.road[ci(cx, cz)] == 1
end

-- ── change tracking ────────────────────────────────────────────

local function mark_chunk(w, cx, cz)
    if cx < 0 or cz < 0 or cx >= N or cz >= N then return end
    w.dirty[floor(cz / M.CHUNK) * M.CHUNKS + floor(cx / M.CHUNK) + 1] = true
end

--- A cell changed: its chunk has to be rebuilt, and so do the chunks of the
-- cells around it, because looks depend on neighbours (rows of houses,
-- road junctions, beaches).
function M.touch(w, cx, cz)
    w.revision = w.revision + 1
    mark_chunk(w, cx - 2, cz - 2)
    mark_chunk(w, cx + 2, cz - 2)
    mark_chunk(w, cx - 2, cz + 2)
    mark_chunk(w, cx + 2, cz + 2)
end

function M.touch_all(w)
    w.revision = w.revision + 1
    for c = 1, M.CHUNKS * M.CHUNKS do w.dirty[c] = true end
end

-- ── editing ────────────────────────────────────────────────────

local function editable(vx, vz)
    return vx > M.MARGIN and vz > M.MARGIN and vx < N - M.MARGIN and vz < N - M.MARGIN
end

--- Moves the ground under a round brush.
-- mode: "raise", "lower", "flatten" (towards `target`), "smooth", "dig" (towards a pond floor)
-- amount: how far the middle of the brush moves in this call
-- Returns true when something changed.
function M.sculpt(w, mode, x, z, radius, amount, target)
    local gx, gz = x + M.HALF, z + M.HALF
    local h = w.h
    local changed = false
    local r2 = radius * radius
    for vz = max(0, floor(gz - radius)), min(N, floor(gz + radius) + 1) do
        for vx = max(0, floor(gx - radius)), min(N, floor(gx + radius) + 1) do
            local dx, dz = vx - gx, vz - gz
            local d2 = dx * dx + dz * dz
            if d2 <= r2 and editable(vx, vz) then
                local f = 1 - sqrt(d2) / radius
                f = f * f * (3 - 2 * f)
                local i = vi(vx, vz)
                local old = h[i]
                local new = old
                if mode == "raise" then
                    new = old + amount * f * (old > 2 and max(0.3, 1 - (old - 2) / 5) or 1)
                elseif mode == "lower" then
                    new = old - amount * f
                elseif mode == "flatten" then
                    new = old + (target - old) * min(1, amount * 2.5 * max(f, 0.35))
                elseif mode == "dig" then
                    local floor_h = -0.45
                    if old > floor_h then new = max(floor_h, old - amount * 2 * max(f, 0.5)) end
                elseif mode == "smooth" then
                    local sum = M.corner(w, vx - 1, vz) + M.corner(w, vx + 1, vz)
                        + M.corner(w, vx, vz - 1) + M.corner(w, vx, vz + 1)
                    new = old + (sum * 0.25 - old) * min(1, amount * 2.5 * f)
                end
                new = max(M.MIN_H, min(M.MAX_H, new))
                if new ~= old then
                    h[i] = new
                    changed = true
                    M.touch(w, vx, vz)
                    M.touch(w, vx - 1, vz - 1)
                end
            end
        end
    end
    return changed
end

--- Snaps heights to the 1/8 steps a saved island keeps.
function M.quantize(w)
    local h = w.h
    for i = 1, V * V do
        h[i] = floor(h[i] * 8 + 0.5) / 8
    end
end

--- Paints ground cover under a round brush. Returns the number of cells that changed.
function M.paint(w, surface, x, z, radius)
    local gx, gz = x + M.HALF, z + M.HALF
    local count = 0
    for cz = max(0, floor(gz - radius)), min(N - 1, floor(gz + radius)) do
        for cx = max(0, floor(gx - radius)), min(N - 1, floor(gx + radius)) do
            local dx, dz = cx + 0.5 - gx, cz + 0.5 - gz
            if dx * dx + dz * dz <= radius * radius then
                local i = ci(cx, cz)
                if w.surf[i] ~= surface then
                    w.surf[i] = surface
                    count = count + 1
                    M.touch(w, cx, cz)
                end
            end
        end
    end
    return count
end

--- Whether something can stand on a cell: dry and not too steep.
function M.buildable(w, cx, cz)
    if not M.inside(cx, cz) then return false end
    if cx < M.MARGIN or cz < M.MARGIN or cx >= N - M.MARGIN or cz >= N - M.MARGIN then return false end
    local avg, low, high = M.cell_heights(w, cx, cz)
    return avg >= M.WET and high - low <= 1.6
end

--- Puts an object on a cell. Roads and objects exclude each other.
function M.place(w, cx, cz, item)
    if not M.buildable(w, cx, cz) then return false end
    local i = ci(cx, cz)
    if w.obj[i] == item then return false end
    w.obj[i] = item
    w.road[i] = 0
    M.touch(w, cx, cz)
    return true
end

--- Levels the ground under a cell so that a building sits flat.
function M.level_cell(w, cx, cz)
    local avg = M.cell_heights(w, cx, cz)
    avg = floor(avg * 8 + 0.5) / 8
    for dz = 0, 1 do
        for dx = 0, 1 do
            if editable(cx + dx, cz + dz) then w.h[vi(cx + dx, cz + dz)] = avg end
        end
    end
    M.touch(w, cx, cz)
    M.touch(w, cx - 1, cz - 1)
    M.touch(w, cx + 1, cz + 1)
end

--- Draws or removes road on a cell. A road may cross water: it becomes a bridge.
function M.set_road(w, cx, cz, on)
    if not M.inside(cx, cz) then return false end
    if cx < M.MARGIN or cz < M.MARGIN or cx >= N - M.MARGIN or cz >= N - M.MARGIN then return false end
    local i = ci(cx, cz)
    local value = on and 1 or 0
    if w.road[i] == value then return false end
    if on then
        local _, low, high = M.cell_heights(w, cx, cz)
        if high - low > 1.6 then return false end
        w.obj[i] = 0
    end
    w.road[i] = value
    M.touch(w, cx, cz)
    return true
end

--- Removes whatever is on a cell. Returns true when there was something.
function M.erase(w, cx, cz)
    if not M.inside(cx, cz) then return false end
    local i = ci(cx, cz)
    if w.obj[i] == 0 and w.road[i] == 0 then return false end
    w.obj[i] = 0
    w.road[i] = 0
    M.touch(w, cx, cz)
    return true
end

--- Tidies up: removes objects that ended up in water or on a cliff, and
-- levels the ground under buildings. `is_building(item)` says which objects
-- want flat ground. Returns how many cells were fixed.
function M.tidy(w, is_building)
    local fixed = 0
    for cz = 0, N - 1 do
        for cx = 0, N - 1 do
            local i = ci(cx, cz)
            local item = w.obj[i]
            if item ~= 0 then
                if not M.buildable(w, cx, cz) then
                    w.obj[i] = 0
                    fixed = fixed + 1
                    M.touch(w, cx, cz)
                elseif is_building(item) then
                    local _, low, high = M.cell_heights(w, cx, cz)
                    if high - low > 0.01 then
                        M.level_cell(w, cx, cz)
                        fixed = fixed + 1
                    end
                end
            end
        end
    end
    return fixed
end

-- ── counting, for tasks and the island level ───────────────────

function M.stats(w)
    local s = { land = 0, water_inland = 0, roads = 0, bridges = 0, objects = 0, by_item = {}, by_surface = {} }
    for cz = 0, N - 1 do
        for cx = 0, N - 1 do
            local i = ci(cx, cz)
            local wet = M.is_wet(w, cx, cz)
            if not wet then
                s.land = s.land + 1
                local surface = w.surf[i]
                s.by_surface[surface] = (s.by_surface[surface] or 0) + 1
            end
            if w.road[i] == 1 then
                s.roads = s.roads + 1
                if wet then s.bridges = s.bridges + 1 end
            end
            local item = w.obj[i]
            if item ~= 0 then
                s.objects = s.objects + 1
                s.by_item[item] = (s.by_item[item] or 0) + 1
            end
        end
    end
    return s
end

-- ── saving: bytes, and the island code people pass around ──────

local B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
local B64_INDEX = {}
for i = 1, #B64 do B64_INDEX[B64:byte(i)] = i - 1 end

local function b64_encode(data)
    local out, n = {}, 0
    for i = 1, #data, 3 do
        local a, b, c = data:byte(i, i + 2)
        local v = a * 65536 + (b or 0) * 256 + (c or 0)
        n = n + 1
        out[n] = B64:sub(floor(v / 262144) + 1, floor(v / 262144) + 1)
            .. B64:sub(floor(v / 4096) % 64 + 1, floor(v / 4096) % 64 + 1)
            .. (b and B64:sub(floor(v / 64) % 64 + 1, floor(v / 64) % 64 + 1) or "")
            .. (c and B64:sub(v % 64 + 1, v % 64 + 1) or "")
    end
    return table.concat(out)
end

local function b64_decode(text)
    local out, n = {}, 0
    local len = #text
    for i = 1, len, 4 do
        local a, b = B64_INDEX[text:byte(i)], B64_INDEX[text:byte(i + 1) or 0]
        local c, d = B64_INDEX[text:byte(i + 2) or 0], B64_INDEX[text:byte(i + 3) or 0]
        if not a or not b then return nil end
        if i + 2 <= len and not c then return nil end
        if i + 3 <= len and not d then return nil end
        local v = a * 262144 + b * 4096 + (c or 0) * 64 + (d or 0)
        n = n + 1
        out[n] = string.char(floor(v / 65536))
            .. (i + 2 <= len and string.char(floor(v / 256) % 256) or "")
            .. (i + 3 <= len and string.char(v % 256) or "")
    end
    return table.concat(out)
end

--- Run-length encoding: (count, value) pairs.
local function rle_encode(bytes, count)
    local out, n = {}, 0
    local i = 1
    while i <= count do
        local value = bytes[i]
        local run = 1
        while i + run <= count and run < 255 and bytes[i + run] == value do run = run + 1 end
        n = n + 1
        out[n] = string.char(run, value)
        i = i + run
    end
    return table.concat(out)
end

local function rle_decode(data, expected)
    local bytes, n = {}, 0
    for i = 1, #data - 1, 2 do
        local run, value = data:byte(i, i + 1)
        for _ = 1, run do
            n = n + 1
            bytes[n] = value
        end
    end
    if n ~= expected then return nil end
    return bytes
end

local function checksum(data)
    local a, b = 1, 0
    for i = 1, #data do
        a = (a + data:byte(i)) % 251
        b = (b + a) % 251
    end
    return string.char(a, b)
end

-- Version 1 islands were 44 cells wide; they are read into the middle of the map.
local VERSION = 2
local OLD_N = 44
M.CODE_PREFIX = "DAO1."

--- The island as bytes. Heights are stored as differences along each row,
-- so that a slope compresses as well as a plain does.
function M.encode(w)
    local bytes, n = {}, 0
    local h = w.h
    for vz = 0, N do
        local previous = 0
        for vx = 0, N do
            local q = floor((h[vi(vx, vz)] - M.MIN_H) * 8 + 0.5)
            n = n + 1
            bytes[n] = (q - previous) % 256
            previous = q
        end
    end
    for i = 1, N * N do
        n = n + 1
        bytes[n] = w.surf[i]
    end
    for i = 1, N * N do
        n = n + 1
        bytes[n] = w.obj[i] + w.road[i] * 128
    end
    local body = string.char(VERSION) .. rle_encode(bytes, n)
    return body .. checksum(body)
end

--- Reads bytes written by encode() into `w`. Returns true, or false and a reason.
function M.decode(w, data)
    if type(data) ~= "string" or #data < 4 then return false, "empty" end
    local body, sum = data:sub(1, -3), data:sub(-2)
    if checksum(body) ~= sum then return false, "damaged" end
    local version = body:byte(1)
    if version ~= VERSION and version ~= 1 then return false, "version" end
    -- `side` is the width the island was saved with, `shift` where it goes in this map.
    local side = version == 1 and OLD_N or N
    local shift = (N - side) / 2
    local bytes = rle_decode(body:sub(2), (side + 1) * (side + 1) + side * side * 2)
    if not bytes then return false, "damaged" end
    if side ~= N then
        for i = 1, V * V do w.h[i] = M.SEABED end
        for i = 1, N * N do w.surf[i], w.road[i], w.obj[i] = M.GRASS, 0, 0 end
    end
    local n = 0
    for vz = 0, side do
        local previous = 0
        for vx = 0, side do
            n = n + 1
            local q = (previous + bytes[n]) % 256
            previous = q
            w.h[vi(vx + shift, vz + shift)] = max(M.MIN_H, min(M.MAX_H, q / 8 + M.MIN_H))
        end
    end
    for cz = 0, side - 1 do
        for cx = 0, side - 1 do
            n = n + 1
            local surface = bytes[n]
            w.surf[ci(cx + shift, cz + shift)] = (surface >= 1 and surface <= 7) and surface or M.GRASS
        end
    end
    for cz = 0, side - 1 do
        for cx = 0, side - 1 do
            n = n + 1
            local value = bytes[n]
            local i = ci(cx + shift, cz + shift)
            w.road[i] = value >= 128 and 1 or 0
            w.obj[i] = value % 128
        end
    end
    M.touch_all(w)
    return true
end

--- The island as text that survives a chat message or a comment.
function M.to_code(w)
    return M.CODE_PREFIX .. b64_encode(M.encode(w))
end

--- Finds an island code inside any text and loads it. Returns true, or false and a reason.
function M.from_code(w, text)
    if type(text) ~= "string" then return false, "empty" end
    local code = text:match("DAO1%.([%w%-_]+)")
    if not code then return false, "no code" end
    local data = b64_decode(code)
    if not data then return false, "damaged" end
    return M.decode(w, data)
end

return M
