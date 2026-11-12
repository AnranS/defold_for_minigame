--- Turns the island into triangles, and decides how things look next to each
-- other: houses in a row share a roof, doors face the road, a house by the
-- water grows a dock, a road across water becomes a bridge, the shore gets a
-- beach and rocks. Pure Lua; the engine only uploads what comes out.

local world = require "island.world"
local catalog = require "island.catalog"

local M = {}

local N, HALF, CHUNK = world.N, world.HALF, world.CHUNK
local floor, min, max, abs, sqrt, sin, cos = math.floor, math.min, math.max, math.abs, math.sqrt, math.sin, math.cos
local vi, ci = world.vi, world.ci

-- Directions: 1 east (+x), 2 south (+z), 3 west (-x), 4 north (-z).
local DX, DZ = { 1, 0, -1, 0 }, { 0, 1, 0, -1 }
local TURN_COS, TURN_SIN = { 0, 1, 0, -1 }, { -1, 0, 1, 0 }   -- local +z faces this direction
local RIGHT_OF = { 4, 1, 2, 3 }                                -- where local +x points
local OPPOSITE = { 3, 4, 1, 2 }
M.DX, M.DZ = DX, DZ

--- A number in [0, 1) that is always the same for the same cell and salt.
local function hash(cx, cz, salt)
    local v = sin(cx * 12.9898 + cz * 78.233 + (salt or 0) * 37.719) * 43758.5453
    return v - floor(v)
end
M.hash = hash

-- ── the triangle buffer ────────────────────────────────────────
-- One set of scratch arrays, reused for every mesh that is built.

local P, NRM, COL = {}, {}, {}
local count = 0
local ox, oy, oz, rc, rs = 0, 0, 0, 1, 0

local function begin()
    count = 0
    ox, oy, oz, rc, rs = 0, 0, 0, 1, 0
end

local function finish()
    return { p = P, n = NRM, c = COL, count = count }
end

--- Where the next shapes go: a point, and which way their front faces.
local function origin(x, y, z, dir)
    ox, oy, oz = x, y, z
    rc, rs = TURN_COS[dir or 2], TURN_SIN[dir or 2]
end

--- The same, turned by any angle: local +z points along (sin, cos) of it.
local function origin_angle(x, y, z, angle)
    ox, oy, oz = x, y, z
    rc, rs = cos(angle), -sin(angle)
end

--- One vertex of something unlit and see-through; the colour carries its opacity.
local function fx_vertex(x, y, z, r, g, b, a)
    local i = count * 3
    P[i + 1], P[i + 2], P[i + 3] = x, y, z
    NRM[i + 1], NRM[i + 2], NRM[i + 3] = 0, 1, 0
    local j = count * 4
    COL[j + 1], COL[j + 2], COL[j + 3], COL[j + 4] = r, g, b, a
    count = count + 1
end

local function vert(x, y, z, nx, ny, nz, col, kind, shade)
    local i = count * 3
    P[i + 1], P[i + 2], P[i + 3] = ox + x * rc - z * rs, oy + y, oz + x * rs + z * rc
    NRM[i + 1], NRM[i + 2], NRM[i + 3] = nx * rc - nz * rs, ny, nx * rs + nz * rc
    local j = count * 4
    COL[j + 1], COL[j + 2], COL[j + 3], COL[j + 4] = col[1] * shade, col[2] * shade, col[3] * shade, kind
    count = count + 1
end

--- A triangle whose normal points away from (hx, hy, hz).
local function tri(ax, ay, az, bx, by, bz, cx, cy, cz, hx, hy, hz, col, kind, shade)
    local ux, uy, uz = bx - ax, by - ay, bz - az
    local vx, vy, vz = cx - ax, cy - ay, cz - az
    local nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
    local len = sqrt(nx * nx + ny * ny + nz * nz)
    if len < 1e-9 then return end
    nx, ny, nz = nx / len, ny / len, nz / len
    if nx * (ax - hx) + ny * (ay - hy) + nz * (az - hz) < 0 then nx, ny, nz = -nx, -ny, -nz end
    kind, shade = kind or 0, shade or 1
    vert(ax, ay, az, nx, ny, nz, col, kind, shade)
    vert(bx, by, bz, nx, ny, nz, col, kind, shade)
    vert(cx, cy, cz, nx, ny, nz, col, kind, shade)
end

--- A flat four-sided face with a known normal. Corners in order around the face.
local function quad(ax, ay, az, bx, by, bz, cx, cy, cz, dx, dy, dz, nx, ny, nz, col, kind, shade)
    kind, shade = kind or 0, shade or 1
    vert(ax, ay, az, nx, ny, nz, col, kind, shade)
    vert(bx, by, bz, nx, ny, nz, col, kind, shade)
    vert(cx, cy, cz, nx, ny, nz, col, kind, shade)
    vert(ax, ay, az, nx, ny, nz, col, kind, shade)
    vert(cx, cy, cz, nx, ny, nz, col, kind, shade)
    vert(dx, dy, dz, nx, ny, nz, col, kind, shade)
end

--- A box without a bottom. `top` may be another colour.
local function box(x0, y0, z0, x1, y1, z1, col, kind, top)
    quad(x0, y1, z0, x1, y1, z0, x1, y1, z1, x0, y1, z1, 0, 1, 0, top or col, kind, 1)
    quad(x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1, 0, 0, 1, col, kind, 1)
    quad(x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, 0, 0, -1, col, kind, 1)
    quad(x1, y0, z0, x1, y0, z1, x1, y1, z1, x1, y1, z0, 1, 0, 0, col, kind, 1)
    quad(x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0, -1, 0, 0, col, kind, 1)
end

--- A gable roof over a rectangle; the ridge runs along x or along z.
local function gable(x0, z0, x1, z1, y, height, along_x, col, wall)
    local mx, my, mz = (x0 + x1) * 0.5, y, (z0 + z1) * 0.5
    if along_x then
        tri(x0, y, z0, x1, y, z0, x1, y + height, mz, mx, my, mz, col)
        tri(x0, y, z0, x1, y + height, mz, x0, y + height, mz, mx, my, mz, col)
        tri(x0, y, z1, x1, y, z1, x1, y + height, mz, mx, my, mz, col, 0, 0.92)
        tri(x0, y, z1, x1, y + height, mz, x0, y + height, mz, mx, my, mz, col, 0, 0.92)
        tri(x0, y, z0, x0, y, z1, x0, y + height, mz, mx, my, mz, wall)
        tri(x1, y, z0, x1, y, z1, x1, y + height, mz, mx, my, mz, wall)
    else
        tri(x0, y, z0, x0, y, z1, mx, y + height, z1, mx, my, mz, col)
        tri(x0, y, z0, mx, y + height, z1, mx, y + height, z0, mx, my, mz, col)
        tri(x1, y, z0, x1, y, z1, mx, y + height, z1, mx, my, mz, col, 0, 0.92)
        tri(x1, y, z0, mx, y + height, z1, mx, y + height, z0, mx, my, mz, col, 0, 0.92)
        tri(x0, y, z0, x1, y, z0, mx, y + height, z0, mx, my, mz, wall)
        tri(x0, y, z1, x1, y, z1, mx, y + height, z1, mx, my, mz, wall)
    end
end

local function pyramid(x0, z0, x1, z1, y, height, col, kind)
    local mx, mz = (x0 + x1) * 0.5, (z0 + z1) * 0.5
    tri(x0, y, z0, x1, y, z0, mx, y + height, mz, mx, y, mz, col, kind)
    tri(x1, y, z0, x1, y, z1, mx, y + height, mz, mx, y, mz, col, kind, 0.92)
    tri(x1, y, z1, x0, y, z1, mx, y + height, mz, mx, y, mz, col, kind)
    tri(x0, y, z1, x0, y, z0, mx, y + height, mz, mx, y, mz, col, kind, 0.92)
end

local RING = {}
local function ring(sides)
    local r = RING[sides]
    if not r then
        r = {}
        for i = 0, sides do
            local a = i / sides * math.pi * 2 + 0.4
            r[i * 2 + 1], r[i * 2 + 2] = cos(a), sin(a)
        end
        RING[sides] = r
    end
    return r
end

--- A cylinder or, with two radii, a tapered tower or a cone. Shaded round.
-- No bottom; a top when r1 > 0.
local function tube(x, y, z, r0, r1, height, sides, col, kind, top)
    local r = ring(sides)
    kind = kind or 0
    local slope = (r0 - r1) / height
    local inv = 1 / sqrt(1 + slope * slope)
    local ny = slope * inv
    for i = 0, sides - 1 do
        local c0, s0, c1, s1 = r[i * 2 + 1], r[i * 2 + 2], r[i * 2 + 3], r[i * 2 + 4]
        vert(x + c0 * r0, y, z + s0 * r0, c0 * inv, ny, s0 * inv, col, kind, 1)
        vert(x + c1 * r0, y, z + s1 * r0, c1 * inv, ny, s1 * inv, col, kind, 1)
        vert(x + c1 * r1, y + height, z + s1 * r1, c1 * inv, ny, s1 * inv, col, kind, 1)
        if r1 > 0 then
            vert(x + c0 * r0, y, z + s0 * r0, c0 * inv, ny, s0 * inv, col, kind, 1)
            vert(x + c1 * r1, y + height, z + s1 * r1, c1 * inv, ny, s1 * inv, col, kind, 1)
            vert(x + c0 * r1, y + height, z + s0 * r1, c0 * inv, ny, s0 * inv, col, kind, 1)
            vert(x, y + height, z, 0, 1, 0, top or col, kind, 1)
            vert(x + c0 * r1, y + height, z + s0 * r1, 0, 1, 0, top or col, kind, 1)
            vert(x + c1 * r1, y + height, z + s1 * r1, 0, 1, 0, top or col, kind, 1)
        end
    end
end

-- Latitudes of a ball, from the bottom up: sine and cosine.
local STACK_SIN = { -1, -0.62, 0.1, 0.72, 1 }
local STACK_COS = { 0, 0.785, 0.995, 0.694, 0 }

--- A ball, shaded round and a little darker underneath.
local function blob(x, y, z, rx, ry, sides, col, kind)
    local r = ring(sides)
    kind = kind or 0
    for band = 1, 4 do
        local sa, ca, sb, cb = STACK_SIN[band], STACK_COS[band], STACK_SIN[band + 1], STACK_COS[band + 1]
        local shade_a, shade_b = 0.8 + 0.2 * (sa * 0.5 + 0.5), 0.8 + 0.2 * (sb * 0.5 + 0.5)
        for i = 0, sides - 1 do
            local c0, s0, c1, s1 = r[i * 2 + 1], r[i * 2 + 2], r[i * 2 + 3], r[i * 2 + 4]
            if band > 1 then
                vert(x + c0 * ca * rx, y + sa * ry, z + s0 * ca * rx, c0 * ca, sa, s0 * ca, col, kind, shade_a)
                vert(x + c1 * ca * rx, y + sa * ry, z + s1 * ca * rx, c1 * ca, sa, s1 * ca, col, kind, shade_a)
                vert(x + c1 * cb * rx, y + sb * ry, z + s1 * cb * rx, c1 * cb, sb, s1 * cb, col, kind, shade_b)
            end
            if band < 4 then
                vert(x + c0 * ca * rx, y + sa * ry, z + s0 * ca * rx, c0 * ca, sa, s0 * ca, col, kind, shade_a)
                vert(x + c1 * cb * rx, y + sb * ry, z + s1 * cb * rx, c1 * cb, sb, s1 * cb, col, kind, shade_b)
                vert(x + c0 * cb * rx, y + sb * ry, z + s0 * cb * rx, c0 * cb, sb, s0 * cb, col, kind, shade_b)
            end
        end
    end
end

local models = require "island.models"

--- Copies a model made in Blender to the place set with origin().
-- wall and roof colour its tinted parts; mirror flips it left to right.
local function stamp(model, wall, roof, mirror, scale)
    local p, q, c, k, m = model.p, model.q, model.c, model.k, model.m
    scale = scale or 1
    local sx = mirror and -scale or scale
    local flip = mirror and -1 or 1
    for v = 0, model.n - 1 do
        local a = v * 3
        local x, z = p[a + 1] * sx, p[a + 3] * scale
        local nx, nz = q[a + 1] * flip, q[a + 3]
        local i = count * 3
        P[i + 1], P[i + 2], P[i + 3] = ox + x * rc - z * rs, oy + p[a + 2] * scale, oz + x * rs + z * rc
        NRM[i + 1], NRM[i + 2], NRM[i + 3] = nx * rc - nz * rs, q[a + 2], nx * rs + nz * rc
        local r, g, b = c[a + 1], c[a + 2], c[a + 3]
        local material = m[v + 1]
        if material == 1 then
            r, g, b = r * wall[1], g * wall[2], b * wall[3]
        elseif material == 2 then
            r, g, b = r * roof[1], g * roof[2], b * roof[3]
        end
        local j = count * 4
        COL[j + 1], COL[j + 2], COL[j + 3], COL[j + 4] = r, g, b, k[v + 1]
        count = count + 1
    end
end

--- Moves the origin by an offset given in its own turned frame.
local function shift(dx, dy, dz)
    ox, oy, oz = ox + dx * rc - dz * rs, oy + dy, oz + dx * rs + dz * rc
end

M.models = models
M.shapes = { stamp = stamp, shift = shift, begin = begin, finish = finish, origin = origin, origin_angle = origin_angle, tri = tri,
             quad = quad, box = box, pyramid = pyramid, tube = tube, blob = blob, gable = gable,
             fx_vertex = fx_vertex }

-- ── colours ────────────────────────────────────────────────────
-- Seasons: 1 spring, 2 summer, 3 autumn, 4 winter.

local GRASS = { { 0.50, 0.78, 0.40 }, { 0.42, 0.72, 0.34 }, { 0.68, 0.70, 0.36 }, { 0.62, 0.72, 0.58 } }
local LEAF = { { 0.46, 0.76, 0.38 }, { 0.30, 0.62, 0.30 }, { 0.92, 0.58, 0.22 }, { 0.58, 0.64, 0.54 } }
local SAKURA = { { 0.99, 0.74, 0.83 }, { 0.42, 0.70, 0.40 }, { 0.88, 0.64, 0.32 }, { 0.76, 0.68, 0.66 } }
local MAPLE = { { 0.58, 0.78, 0.36 }, { 0.38, 0.66, 0.30 }, { 0.90, 0.30, 0.18 }, { 0.62, 0.54, 0.48 } }
local WHEAT = { { 0.74, 0.80, 0.40 }, { 0.90, 0.78, 0.34 }, { 0.86, 0.68, 0.30 }, { 0.80, 0.76, 0.60 } }
local PINE = { 0.20, 0.46, 0.33 }
local PALM = { 0.36, 0.70, 0.36 }
local SAND = { 0.94, 0.87, 0.64 }
local SEABED = { 0.86, 0.82, 0.62 }
local DEEP = { 0.34, 0.52, 0.56 }
local ROCK = { 0.64, 0.64, 0.67 }
local SNOW = { 0.96, 0.97, 1.0 }
local PAVING = { 0.80, 0.78, 0.74 }
local LAVENDER_GROUND = { 0.50, 0.66, 0.42 }
local LAVENDER = { 0.66, 0.50, 0.88 }
local TRUNK = { 0.52, 0.38, 0.28 }
local WOOD = { 0.72, 0.54, 0.36 }
local WOOD_DARK = { 0.52, 0.38, 0.26 }
local STONE = { 0.74, 0.74, 0.76 }
local ROAD = { 0.86, 0.80, 0.69 }
local ROAD_EDGE = { 0.76, 0.69, 0.58 }
local WINDOW = { 1.0, 0.86, 0.48 }
local DOOR = { 0.50, 0.33, 0.24 }
local WHITE = { 0.97, 0.96, 0.93 }
local RED = { 0.88, 0.32, 0.28 }
local DARK = { 0.25, 0.24, 0.26 }
local STRAW = { 0.92, 0.80, 0.42 }
local FLAME = { 1.0, 0.62, 0.18 }
local WALLS = { { 0.98, 0.93, 0.82 }, { 0.98, 0.84, 0.80 }, { 0.84, 0.90, 0.96 }, { 0.99, 0.90, 0.66 }, { 0.84, 0.94, 0.86 } }
local ROOFS = { { 0.86, 0.42, 0.32 }, { 0.36, 0.50, 0.66 }, { 0.70, 0.30, 0.34 }, { 0.30, 0.58, 0.56 }, { 0.90, 0.60, 0.30 } }
local PETALS = { { 1.0, 1.0, 1.0 }, { 1.0, 0.70, 0.78 }, { 1.0, 0.86, 0.36 }, { 0.96, 0.42, 0.40 }, { 0.72, 0.60, 0.96 } }

local scratch = { 0, 0, 0 }
local function mix(a, b, t, vary)
    scratch[1] = (a[1] + (b[1] - a[1]) * t) * vary
    scratch[2] = (a[2] + (b[2] - a[2]) * t) * vary
    scratch[3] = (a[3] + (b[3] - a[3]) * t) * vary
    return scratch
end

-- ── rules: how neighbours change each other ────────────────────

local function is_house(w, cx, cz)
    return world.get_obj(w, cx, cz) == catalog.HOUSE
end

--- A cell that has water right next to it (or diagonally).
local function near_water(w, cx, cz)
    for dz = -1, 1 do
        for dx = -1, 1 do
            if (dx ~= 0 or dz ~= 0) and world.is_wet(w, cx + dx, cz + dz) then return true end
        end
    end
    return false
end

--- Everything a house needs to know about its surroundings.
-- Returns: joined[dir] (a house on that side), along_x (ridge direction),
-- door (direction), dock (direction or nil), chimney (bool), root_x, root_z
local function house_info(w, cx, cz)
    local joined = {}
    for dir = 1, 4 do joined[dir] = is_house(w, cx + DX[dir], cz + DZ[dir]) end
    local along_x
    if joined[1] or joined[3] then
        along_x = true
    elseif joined[2] or joined[4] then
        along_x = false
    end

    -- The door looks at a road if there is one, otherwise at open ground.
    -- In a row it looks out of the row, never along it.
    local sides = { 2, 1, 3, 4 }
    if joined[1] or joined[3] then sides = { 2, 4 } elseif joined[2] or joined[4] then sides = { 1, 3 } end
    local door, fallback
    for _, dir in ipairs(sides) do
        if not joined[dir] then
            local nx, nz = cx + DX[dir], cz + DZ[dir]
            if world.has_road(w, nx, nz) then
                door = door or dir
            elseif not world.is_wet(w, nx, nz) and world.get_obj(w, nx, nz) == 0 then
                fallback = fallback or dir
            end
        end
    end
    door = door or fallback or sides[1]
    if along_x == nil then along_x = (door == 2 or door == 4) end

    local dock
    for _, dir in ipairs({ 2, 1, 3, 4 }) do
        local nx, nz = cx + DX[dir], cz + DZ[dir]
        if not joined[dir] and world.is_wet(w, nx, nz) and not world.has_road(w, nx, nz) and world.inside(nx, nz) then
            dock = dir
            break
        end
    end

    -- A row shares one roof colour: take it from the first house of the row.
    local root_x, root_z = cx, cz
    for _ = 1, N do
        if is_house(w, root_x - 1, root_z) then
            root_x = root_x - 1
        elseif is_house(w, root_x, root_z - 1) then
            root_z = root_z - 1
        else
            break
        end
    end
    local in_row = joined[1] or joined[2] or joined[3] or joined[4]
    local chimney = hash(cx, cz, 3) < 0.75 and (not in_row or (cx + cz) % 2 == 0)
    return joined, along_x, door, dock, chimney, root_x, root_z
end
M.house_info = house_info

--- Which sides of a road cell continue as road.
local function road_links(w, cx, cz)
    local links, n = {}, 0
    for dir = 1, 4 do
        links[dir] = world.has_road(w, cx + DX[dir], cz + DZ[dir])
        if links[dir] then n = n + 1 end
    end
    return links, n
end

--- The side of a road cell where a street lamp stands, or nil.
local function street_lamp(w, cx, cz, links)
    if hash(cx, cz, 5) > 0.2 or world.is_wet(w, cx, cz) then return nil end
    for dir = 1, 4 do
        local nx, nz = cx + DX[dir], cz + DZ[dir]
        if not links[dir] and not world.is_wet(w, nx, nz) and world.get_obj(w, nx, nz) == 0 then return dir end
    end
    return nil
end

local function is_reef(w, cx, cz)
    if not world.is_wet(w, cx, cz) or world.has_road(w, cx, cz) or hash(cx, cz, 7) > 0.09 then return false end
    for dir = 1, 4 do
        if not world.is_wet(w, cx + DX[dir], cz + DZ[dir]) then return true end
    end
    return false
end

-- ── models ─────────────────────────────────────────────────────
-- Each draws one object at the origin that was set; y = 0 is the ground.

local function draw_house(w, cx, cz, base)
    local joined, _, door, dock, chimney, root_x, root_z = house_info(w, cx, cz)
    local wall = WALLS[1 + floor(hash(cx, cz, 1) * #WALLS)]
    local roof = ROOFS[1 + floor(hash(root_x, root_z, 2) * #ROOFS)]
    local wx, wz = world.cell_center(cx, cz)
    local right, left = joined[RIGHT_OF[door]], joined[OPPOSITE[RIGHT_OF[door]]]
    origin(wx, base, wz, door)
    if right and left then
        stamp(models.house_mid, wall, roof)
    elseif right then
        stamp(models.house_end, wall, roof)
    elseif left then
        stamp(models.house_end, wall, roof, true)
    else
        stamp(models.house_single, wall, roof)
    end
    if chimney then
        shift(0.17, 0.56, -0.17)
        stamp(models.chimney, wall, roof)
    end
    if dock then
        origin(wx, 0, wz, dock)
        stamp(models.dock, wall, roof)
    end
end

local function draw_shop(w, cx, cz, base)
    local _, _, door = house_info(w, cx, cz)
    local wx, wz = world.cell_center(cx, cz)
    origin(wx, base, wz, door)
    stamp(models.shop, WALLS[1 + floor(hash(cx, cz, 1) * #WALLS)], ROOFS[1 + floor(hash(cx, cz, 2) * #ROOFS)])
end

local function draw_pavilion(wx, wz, base)
    origin(wx, base, wz, 2)
    stamp(models.pavilion, WHITE, ROOFS[1])
end

local function draw_tower(wx, wz, base)
    origin(wx, base, wz, 2)
    stamp(models.tower, WALLS[1], ROOFS[2])
end

local function draw_windmill(w, cx, cz, base)
    local _, _, door = house_info(w, cx, cz)
    local wx, wz = world.cell_center(cx, cz)
    origin(wx, base, wz, door)
    stamp(models.windmill, WALLS[1], ROOFS[1])
end

local function draw_lighthouse(wx, wz, base)
    origin(wx, base, wz, 2)
    stamp(models.lighthouse, WHITE, RED)
end

--- A plant: one of the Blender models, turned and sized a little differently in every cell.
local function draw_plant(model, cx, cz, wx, wz, base, tint, second)
    local jx, jz = (hash(cx, cz, 12) - 0.5) * 0.22, (hash(cx, cz, 13) - 0.5) * 0.22
    origin_angle(wx + jx, base - 0.03, wz + jz, hash(cx, cz, 14) * math.pi * 2)
    stamp(model, tint, second or tint, false, 0.85 + hash(cx, cz, 11) * 0.35)
end

-- What a bush carries, by season: blossoms, small white flowers, berries, nothing much.
local BUSH_DOTS = { { 1.0, 0.72, 0.80 }, { 0.98, 0.98, 0.94 }, { 0.90, 0.30, 0.28 }, { 0.62, 0.70, 0.58 } }

local function draw_bench(w, cx, cz, wx, wz, base)
    local _, _, door = house_info(w, cx, cz)
    origin(wx, base, wz, door)
    stamp(models.bench, WHITE, WHITE)
end

local function draw_lamp(wx, wz, base)
    origin(wx, base, wz, 2)
    stamp(models.lamp, WHITE, WHITE)
end

--- A fence post with rails to every neighbouring fence; alone, a short piece of fence.
local function draw_fence(w, cx, cz, wx, wz, base)
    origin(wx, base, wz, 2)
    stamp(models.fence_post, WHITE, WHITE)
    local any = false
    for dir = 1, 4 do
        if world.get_obj(w, cx + DX[dir], cz + DZ[dir]) == catalog.FENCE then
            any = true
            origin(wx, base, wz, dir)
            stamp(models.fence_rail, WHITE, WHITE)
        end
    end
    if not any then
        local dir = 1 + floor(hash(cx, cz, 14) * 2)
        origin(wx, base, wz, dir)
        stamp(models.fence_rail, WHITE, WHITE)
        origin(wx, base, wz, OPPOSITE[dir])
        stamp(models.fence_rail, WHITE, WHITE)
    end
end

local function draw_rock(cx, cz, wx, wz, base, scale)
    origin_angle(wx + (hash(cx, cz, 12) - 0.5) * 0.2, base, wz + (hash(cx, cz, 13) - 0.5) * 0.2, hash(cx, cz, 14) * math.pi * 2)
    stamp(hash(cx, cz, 15) < 0.5 and models.rock_a or models.rock_b, WHITE, WHITE, false, scale * (0.85 + hash(cx, cz, 11) * 0.3))
end

--- An object that is one model, facing where a door would face.
local function draw_prop(model, w, cx, cz, wx, wz, base, second)
    local _, _, door = house_info(w, cx, cz)
    origin(wx, base, wz, door)
    stamp(model, WHITE, second or WHITE)
end

local function draw_object(w, cx, cz, item, season)
    local wx, wz = world.cell_center(cx, cz)
    local base = M.centre_height(w, cx, cz) - 0.04
    if item == catalog.HOUSE then draw_house(w, cx, cz, base)
    elseif item == catalog.SHOP then draw_shop(w, cx, cz, base)
    elseif item == catalog.PAVILION then draw_pavilion(wx, wz, base)
    elseif item == catalog.TOWER then draw_tower(wx, wz, base)
    elseif item == catalog.WINDMILL then draw_windmill(w, cx, cz, base)
    elseif item == catalog.LIGHTHOUSE then draw_lighthouse(wx, wz, base)
    elseif item == catalog.TREE then draw_plant(models.tree_round, cx, cz, wx, wz, base, LEAF[season])
    elseif item == catalog.PINE then draw_plant(models.tree_pine, cx, cz, wx, wz, base, PINE)
    elseif item == catalog.SAKURA then draw_plant(models.tree_blossom, cx, cz, wx, wz, base, SAKURA[season])
    elseif item == catalog.MAPLE then draw_plant(models.tree_blossom, cx, cz, wx, wz, base, MAPLE[season])
    elseif item == catalog.PALM then draw_plant(models.palm, cx, cz, wx, wz, base, PALM)
    elseif item == catalog.BUSH then draw_plant(models.bush, cx, cz, wx, wz, base, LEAF[season], BUSH_DOTS[season])
    elseif item == catalog.BENCH then draw_bench(w, cx, cz, wx, wz, base)
    elseif item == catalog.LAMP then draw_lamp(wx, wz, base)
    elseif item == catalog.FENCE then draw_fence(w, cx, cz, wx, wz, base)
    elseif item == catalog.ROCK then draw_rock(cx, cz, wx, wz, base, 1)
    elseif item == catalog.WELL then draw_prop(models.well, w, cx, cz, wx, wz, base)
    elseif item == catalog.MAILBOX then draw_prop(models.mailbox, w, cx, cz, wx, wz, base)
    elseif item == catalog.FLAG then draw_prop(models.flag, w, cx, cz, wx, wz, base, ROOFS[1 + floor(hash(cx, cz, 2) * #ROOFS)])
    elseif item == catalog.CAMPFIRE then draw_prop(models.campfire, w, cx, cz, wx, wz, base)
    elseif item == catalog.SCARECROW then draw_prop(models.scarecrow, w, cx, cz, wx, wz, base)
    elseif item == catalog.HAYSTACK then draw_prop(models.haystack, w, cx, cz, wx, wz, base)
    elseif item == catalog.SNOWMAN then draw_prop(models.snowman, w, cx, cz, wx, wz, base)
    end
end

-- ── ground, plants on it, roads ────────────────────────────────

-- Ground colours per season, mixed once.
local function blend(a, b, t)
    return { a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t }
end
local SURFACE = {}
for season = 1, 4 do
    SURFACE[season] = {
        [world.GRASS] = GRASS[season], [world.SAND] = SAND, [world.SNOW] = SNOW, [world.PAVING] = PAVING,
        [world.FLOWERS] = blend(GRASS[season], SAND, 0.08), [world.WHEAT] = blend(WHEAT[season], GRASS[season], 0.35),
        [world.LAVENDER] = blend(LAVENDER_GROUND, GRASS[season], 0.3),
    }
end

local V = world.V

local function corner(w, vx, vz)
    if vx < 0 then vx = 0 elseif vx > N then vx = N end
    if vz < 0 then vz = 0 elseif vz > N then vz = N end
    return w.h[vz * V + vx + 1]
end

local function spline_row(w, x0, z)
    return (9 * (corner(w, x0, z) + corner(w, x0 + 1, z)) - corner(w, x0 - 1, z) - corner(w, x0 + 2, z)) * 0.0625
end

--- Height of the fine ground: two steps per cell, with the points in
-- between rounded by a spline, so that hills are curves and not facets.
-- fx, fz count half cells from the map's corner.
local function fine_height(w, fx, fz)
    local x0, z0 = floor(fx / 2), floor(fz / 2)
    local odd_x, odd_z = fx % 2 == 1, fz % 2 == 1
    if not odd_x and not odd_z then return corner(w, x0, z0) end
    if odd_x and not odd_z then return spline_row(w, x0, z0) end
    if not odd_x then
        return (9 * (corner(w, x0, z0) + corner(w, x0, z0 + 1)) - corner(w, x0, z0 - 1) - corner(w, x0, z0 + 2)) * 0.0625
    end
    return (9 * (spline_row(w, x0, z0) + spline_row(w, x0, z0 + 1)) - spline_row(w, x0, z0 - 1) - spline_row(w, x0, z0 + 2)) * 0.0625
end
M.fine_height = fine_height

--- Height of the drawn ground in the middle of a cell.
function M.centre_height(w, cx, cz)
    return fine_height(w, cx * 2 + 1, cz * 2 + 1)
end

-- The fine heights of the chunk being built, with a margin of one step.
local FH, FINE_SIDE, fine_x0, fine_z0 = {}, CHUNK * 2 + 3, 0, 0

--- Height of the drawn ground at a world position inside the chunk being built.
local function surface(x, z)
    local gx, gz = (x + HALF) * 2 - fine_x0 + 1, (z + HALF) * 2 - fine_z0 + 1
    local ix, iz = floor(gx), floor(gz)
    if ix < 0 then ix = 0 elseif ix > FINE_SIDE - 2 then ix = FINE_SIDE - 2 end
    if iz < 0 then iz = 0 elseif iz > FINE_SIDE - 2 then iz = FINE_SIDE - 2 end
    local tx, tz = gx - ix, gz - iz
    local i = iz * FINE_SIDE + ix + 1
    local a, b, c, d = FH[i], FH[i + 1], FH[i + FINE_SIDE], FH[i + FINE_SIDE + 1]
    return (a + (b - a) * tx) * (1 - tz) + (c + (d - c) * tx) * tz
end

local function surface_colour(w, cx, cz, season)
    if cx < 0 or cz < 0 or cx >= N or cz >= N then return GRASS[season] end
    return SURFACE[season][w.surf[ci(cx, cz)]] or GRASS[season]
end

local function dry_road(w, cx, cz)
    return world.has_road(w, cx, cz) and not world.is_wet(w, cx, cz)
end

local vr, vg, vb = 0, 0, 0

--- Colour of one point of the fine ground, into vr, vg, vb.
-- Ground cover blends across cell borders, low ground turns to sand, steep
-- ground to rock, and paths are painted where two road cells meet.
local function vertex_colour(w, fx, fz, height, ny, season)
    local x0, z0 = floor(fx / 2), floor(fz / 2)
    local odd_x, odd_z = fx % 2 == 1, fz % 2 == 1
    local r, g, b
    local path, shadow = false, 1
    if odd_x and odd_z then
        local c = surface_colour(w, x0, z0, season)
        r, g, b = c[1], c[2], c[3]
        path = dry_road(w, x0, z0)
        local item = world.get_obj(w, x0, z0)
        if item ~= 0 then shadow = catalog.is_building(item) and 0.7 or 0.8 end
    elseif odd_x then
        local c, d = surface_colour(w, x0, z0 - 1, season), surface_colour(w, x0, z0, season)
        r, g, b = (c[1] + d[1]) * 0.5, (c[2] + d[2]) * 0.5, (c[3] + d[3]) * 0.5
        path = dry_road(w, x0, z0 - 1) and dry_road(w, x0, z0)
    elseif odd_z then
        local c, d = surface_colour(w, x0 - 1, z0, season), surface_colour(w, x0, z0, season)
        r, g, b = (c[1] + d[1]) * 0.5, (c[2] + d[2]) * 0.5, (c[3] + d[3]) * 0.5
        path = dry_road(w, x0 - 1, z0) and dry_road(w, x0, z0)
    else
        local c, d = surface_colour(w, x0 - 1, z0 - 1, season), surface_colour(w, x0, z0 - 1, season)
        local e, f = surface_colour(w, x0 - 1, z0, season), surface_colour(w, x0, z0, season)
        r, g, b = (c[1] + d[1] + e[1] + f[1]) * 0.25, (c[2] + d[2] + e[2] + f[2]) * 0.25, (c[3] + d[3] + e[3] + f[3]) * 0.25
    end

    if path then
        r, g, b = ROAD[1], ROAD[2], ROAD[3]
    elseif height < 0.5 then
        local t = max(0, (height - 0.1) / 0.4)
        t = t * t * (3 - 2 * t)
        r, g, b = SAND[1] + (r - SAND[1]) * t, SAND[2] + (g - SAND[2]) * t, SAND[3] + (b - SAND[3]) * t
    end
    local steep = 1 - ny
    if steep > 0.24 and not path then
        local t = min(1, (steep - 0.24) / 0.14)
        r, g, b = r + (ROCK[1] - r) * t, g + (ROCK[2] - g) * t, b + (ROCK[3] - b) * t
    end
    if height < 0 then
        local t = min(1, -height / 1.3)
        r, g, b = SEABED[1] + (DEEP[1] - SEABED[1]) * t, SEABED[2] + (DEEP[2] - SEABED[2]) * t, SEABED[3] + (DEEP[3] - SEABED[3]) * t
    end
    -- Slow, soft variation, so that a meadow is not one flat colour.
    local vary = shadow
    if height >= 0 then vary = (0.95 + 0.05 * sin(fx * 0.37 + fz * 0.23) + 0.04 * sin(fx * 0.11 - fz * 0.31 + 1.7)) * shadow end
    vr, vg, vb = r * vary, g * vary, b * vary
end

--- Small plants that grow out of a painted cell.
local function draw_cover(w, cx, cz, surface_kind, season)
    local wx, wz = world.cell_center(cx, cz)
    local function tuft(k, model, tint, scale)
        local x = wx + (hash(cx, cz, 20 + k) - 0.5) * 0.9
        local z = wz + (hash(cx, cz, 30 + k) - 0.5) * 0.9
        origin_angle(x, surface(x, z), z, hash(cx, cz, 50 + k) * math.pi * 2)
        stamp(model, tint, tint, false, scale * (0.85 + 0.3 * hash(cx, cz, 60 + k)))
    end
    if surface_kind == world.FLOWERS then
        for k = 1, (season == 4 and 1 or (season == 1 and 5 or 4)) do
            tuft(k, models.flower, PETALS[1 + floor(hash(cx, cz, 40 + k) * #PETALS)], 1)
        end
    elseif surface_kind == world.WHEAT then
        local size = season == 1 and 0.6 or (season == 4 and 0.4 or 1)
        for k = 1, (season == 4 and 2 or 3) do tuft(k, models.wheat, WHEAT[season], size * 1.15) end
    elseif surface_kind == world.LAVENDER then
        for k = 1, (season == 4 and 2 or 3) do tuft(k, models.lavender, season == 4 and LAVENDER_GROUND or LAVENDER, 1.15) end
    elseif surface_kind == world.GRASS and hash(cx, cz, 9) < 0.35 then
        tuft(1, models.grass, GRASS[season], 1)
        if hash(cx, cz, 10) < 0.5 then tuft(2, models.grass, GRASS[season], 0.8) end
    end
end

--- What a road cell adds to the painted path: a bridge over water, the step
-- up to a bridge, a street lamp.
local function draw_road(w, cx, cz)
    local links = road_links(w, cx, cz)
    local wx, wz = world.cell_center(cx, cz)
    if world.is_wet(w, cx, cz) then
        local along_x = links[1] or links[3]
        local along_z = links[2] or links[4]
        if not along_x and not along_z then along_x = true end
        if along_x and along_z then
            -- Where two bridges cross there are no rails in the way.
            origin(wx, 0, wz, 1)
            stamp(models.bridge_deck, WHITE, WHITE)
            origin(wx, 0, wz, 2)
            stamp(models.bridge_deck, WHITE, WHITE)
        else
            origin(wx, 0, wz, along_x and 1 or 2)
            stamp(models.bridge, WHITE, WHITE)
        end
        return
    end
    for dir = 1, 4 do
        if links[dir] and world.is_wet(w, cx + DX[dir], cz + DZ[dir]) then
            origin(wx, 0, wz, dir)
            stamp(models.bridge_ramp, WHITE, WHITE)
        end
    end
    local lamp = street_lamp(w, cx, cz, links)
    if lamp then
        local x, z = wx + DX[lamp] * 0.4, wz + DZ[lamp] * 0.4
        draw_lamp(x, z, surface(x, z))
    end
end

local VN, VC = {}, {}

--- Works out the fine heights of a chunk; ground and props both stand on them.
local function prepare(w, chunk_x, chunk_z)
    fine_x0, fine_z0 = chunk_x * CHUNK * 2, chunk_z * CHUNK * 2
    local side = FINE_SIDE
    for j = 0, side - 1 do
        for i = 0, side - 1 do
            FH[j * side + i + 1] = fine_height(w, fine_x0 + i - 1, fine_z0 + j - 1)
        end
    end
end

--- The ground of one chunk. This is what changes under a sculpting finger,
-- so it is a mesh of its own and quick to rebuild.
function M.ground_chunk(w, chunk_x, chunk_z, season)
    begin()
    prepare(w, chunk_x, chunk_z)
    local side = FINE_SIDE
    -- Normals and colours of the fine points (the margin only feeds the normals).
    local steps = CHUNK * 2
    for j = 0, steps do
        for i = 0, steps do
            local at = (j + 1) * side + (i + 1) + 1
            local nx, nz = FH[at - 1] - FH[at + 1], FH[at - side] - FH[at + side]
            local len = sqrt(nx * nx + 1 + nz * nz)
            local k = (j * (steps + 1) + i) * 3
            VN[k + 1], VN[k + 2], VN[k + 3] = nx / len, 1 / len, nz / len
            vertex_colour(w, fine_x0 + i, fine_z0 + j, FH[at], 1 / len, season)
            VC[k + 1], VC[k + 2], VC[k + 3] = vr, vg, vb
        end
    end
    local row = steps + 1
    local function point(i, j)
        local k = (j * row + i) * 3
        local n = count * 3
        P[n + 1], P[n + 2], P[n + 3] = (fine_x0 + i) * 0.5 - HALF, FH[(j + 1) * side + (i + 1) + 1], (fine_z0 + j) * 0.5 - HALF
        NRM[n + 1], NRM[n + 2], NRM[n + 3] = VN[k + 1], VN[k + 2], VN[k + 3]
        local c = count * 4
        COL[c + 1], COL[c + 2], COL[c + 3], COL[c + 4] = VC[k + 1], VC[k + 2], VC[k + 3], 0
        count = count + 1
    end
    for j = 0, steps - 1 do
        for i = 0, steps - 1 do
            if (i + j) % 2 == 0 then
                point(i, j) point(i + 1, j) point(i + 1, j + 1)
                point(i, j) point(i + 1, j + 1) point(i, j + 1)
            else
                point(i, j) point(i + 1, j) point(i, j + 1)
                point(i + 1, j) point(i + 1, j + 1) point(i, j + 1)
            end
        end
    end
    return finish()
end

--- What stands on the ground of one chunk: plants, roads' bridges and lamps, objects.
function M.props_chunk(w, chunk_x, chunk_z, season)
    begin()
    prepare(w, chunk_x, chunk_z)
    for cz = chunk_z * CHUNK, chunk_z * CHUNK + CHUNK - 1 do
        for cx = chunk_x * CHUNK, chunk_x * CHUNK + CHUNK - 1 do
            local avg, low, high = world.cell_heights(w, cx, cz)
            local i = ci(cx, cz)
            local item = w.obj[i]
            if w.road[i] == 1 then
                draw_road(w, cx, cz)
            elseif item ~= 0 then
                if avg >= world.WET then draw_object(w, cx, cz, item, season) end
            elseif avg >= world.WET and high - low <= 1.3 then
                if avg > 0.3 then draw_cover(w, cx, cz, w.surf[i], season) end
            elseif is_reef(w, cx, cz) then
                local wx, wz = world.cell_center(cx, cz)
                draw_rock(cx, cz, wx, wz, -0.12, 1.5)
            end
        end
    end
    return finish()
end

local SHALLOW, OCEAN = { 0.42, 0.84, 0.86 }, { 0.16, 0.52, 0.80 }

--- One point of the sea. `still` keeps it from moving with the waves.
local function water_vertex(x, z, ground, still)
    local shore = max(0, min(1, 1 + ground * 1.7))
    local depth = max(0, min(1, -ground / 1.3))
    local i = count * 3
    P[i + 1], P[i + 2], P[i + 3] = x, 0, z
    -- Waves die down towards the map's border, where the open sea lies still.
    local wave = still and 0 or max(0, min(1, (HALF - max(abs(x), abs(z))) / 3))
    NRM[i + 1], NRM[i + 2], NRM[i + 3] = wave, 1, 0
    local j = count * 4
    COL[j + 1] = SHALLOW[1] + (OCEAN[1] - SHALLOW[1]) * depth
    COL[j + 2] = SHALLOW[2] + (OCEAN[2] - SHALLOW[2]) * depth
    COL[j + 3] = SHALLOW[3] + (OCEAN[3] - SHALLOW[3]) * depth
    COL[j + 4] = shore
    count = count + 1
end

--- The water surface over the wet cells of one chunk.
function M.water_chunk(w, chunk_x, chunk_z)
    begin()
    local h = w.h
    for cz = chunk_z * CHUNK, chunk_z * CHUNK + CHUNK - 1 do
        for cx = chunk_x * CHUNK, chunk_x * CHUNK + CHUNK - 1 do
            local a, b = h[vi(cx, cz)], h[vi(cx + 1, cz)]
            local c, d = h[vi(cx, cz + 1)], h[vi(cx + 1, cz + 1)]
            if min(a, b, c, d) < 0.02 then
                local x0, z0 = cx - HALF, cz - HALF
                water_vertex(x0, z0, a) water_vertex(x0 + 1, z0, b) water_vertex(x0 + 1, z0 + 1, d)
                water_vertex(x0, z0, a) water_vertex(x0 + 1, z0 + 1, d) water_vertex(x0, z0 + 1, c)
            end
        end
    end
    return finish()
end

--- The four sheets that surround the map out to `reach`, as corner lists.
local function around(reach)
    local e = HALF
    return {
        { -reach, -reach, reach, -e }, { -reach, e, reach, reach }, { -reach, -e, -e, e }, { e, -e, reach, e },
    }
end

--- The open sea around the map, out to the horizon. It has the depth of the
-- map's own border, so there is no seam where the map ends.
function M.ocean(reach)
    begin()
    for _, s in ipairs(around(reach)) do
        local x0, z0, x1, z1 = s[1], s[2], s[3], s[4]
        water_vertex(x0, z0, world.SEABED, true) water_vertex(x1, z0, world.SEABED, true) water_vertex(x1, z1, world.SEABED, true)
        water_vertex(x0, z0, world.SEABED, true) water_vertex(x1, z1, world.SEABED, true) water_vertex(x0, z1, world.SEABED, true)
    end
    return finish()
end

--- The sea floor under that open sea, in the colour of the map's own border.
function M.sea_floor(reach)
    begin()
    origin(0, 0, 0, 2)
    local col = mix(SEABED, DEEP, min(1, -world.SEABED / 1.3), 1)
    local y = world.SEABED
    for _, s in ipairs(around(reach)) do
        quad(s[1], y, s[2], s[3], y, s[2], s[3], y, s[4], s[1], y, s[4], 0, 1, 0, { col[1], col[2], col[3] })
    end
    return finish()
end

-- ── what is on the island, for the things that move and for tasks ──

--- Scans the island once. Returns lists of places and a few counts.
function M.features(w)
    local f = {
        chimneys = {}, windmills = {}, lighthouses = {}, campfires = {}, houses = {},
        shore = {}, benches = {}, roads = {}, tree_spots = {}, connected = 0,
        docks = 0, longest_row = 0, junctions = 0, street_lamps = 0,
        beach = false, reef = false, trees = 0, glow = 0,
    }
    for cz = 0, N - 1 do
        for cx = 0, N - 1 do
            local item = w.obj[ci(cx, cz)]
            local wet = world.is_wet(w, cx, cz)
            local wx, wz = world.cell_center(cx, cz)
            if item ~= 0 and not wet then
                local base = world.cell_heights(w, cx, cz)
                if item == catalog.HOUSE then
                    local joined, _, door, dock, chimney = house_info(w, cx, cz)
                    local by_road = false
                    for dir = 1, 4 do by_road = by_road or world.has_road(w, cx + DX[dir], cz + DZ[dir]) end
                    f.houses[#f.houses + 1] = { cx = cx, cz = cz, door = door, by_road = by_road }
                    if by_road then f.connected = f.connected + 1 end
                    f.glow = f.glow + 1
                    if dock then f.docks = f.docks + 1 end
                    if chimney then
                        local c, sn = TURN_COS[door], TURN_SIN[door]
                        f.chimneys[#f.chimneys + 1] = { wx + 0.17 * c + 0.17 * sn, base + 0.98, wz + 0.17 * sn - 0.17 * c }
                    end
                    if not joined[3] then
                        local len = 1
                        while is_house(w, cx + len, cz) do len = len + 1 end
                        f.longest_row = max(f.longest_row, len)
                    end
                    if not joined[4] then
                        local len = 1
                        while is_house(w, cx, cz + len) do len = len + 1 end
                        f.longest_row = max(f.longest_row, len)
                    end
                elseif item == catalog.WINDMILL then
                    local _, _, door = house_info(w, cx, cz)
                    -- Where the sails turn: on the axle that sticks out of the front.
                    f.windmills[#f.windmills + 1] = { wx + DX[door] * 0.37, base + 0.84, wz + DZ[door] * 0.37, door }
                elseif item == catalog.LIGHTHOUSE then
                    f.lighthouses[#f.lighthouses + 1] = { wx, base + 1.65, wz }
                    f.glow = f.glow + 1
                elseif item == catalog.CAMPFIRE then
                    f.campfires[#f.campfires + 1] = { wx, base + 0.3, wz }
                    f.chimneys[#f.chimneys + 1] = { wx, base + 0.35, wz }
                elseif item == catalog.BENCH then
                    f.benches[#f.benches + 1] = { cx = cx, cz = cz }
                elseif item == catalog.SHOP or item == catalog.TOWER or item == catalog.LAMP then
                    f.glow = f.glow + 1
                end
                if catalog.is_tree(item) then
                    f.trees = f.trees + 1
                    f.tree_spots[#f.tree_spots + 1] = { wx, base, wz }
                end
            end
            if w.road[ci(cx, cz)] == 1 then f.roads[#f.roads + 1] = { cx = cx, cz = cz } end
            if w.road[ci(cx, cz)] == 1 and not wet then
                local links, n = road_links(w, cx, cz)
                if n >= 3 then f.junctions = f.junctions + 1 end
                if street_lamp(w, cx, cz, links) then
                    f.street_lamps = f.street_lamps + 1
                    f.glow = f.glow + 1
                end
            end
            if not wet then
                local avg = world.cell_heights(w, cx, cz)
                if avg < 0.5 and near_water(w, cx, cz) then
                    f.beach = true
                    if item == 0 and w.road[ci(cx, cz)] == 0 and hash(cx, cz, 17) < 0.5 then
                        f.shore[#f.shore + 1] = { cx = cx, cz = cz }
                    end
                end
            elseif is_reef(w, cx, cz) then
                f.reef = true
            end
        end
    end
    return f
end

return M
