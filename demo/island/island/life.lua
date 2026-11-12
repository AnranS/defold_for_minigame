--- What moves on the island: islanders, boats, gulls, windmill sails, and the
-- see-through things in the air: smoke, clouds, rain, snow, fireflies, stars,
-- the rainbow. Pure Lua; it only produces triangles.

local world = require "island.world"
local catalog = require "island.catalog"
local build = require "island.build"

local M = {}

local S = build.shapes
local hash = build.hash
local sin, cos, floor, sqrt, max, min, pi = math.sin, math.cos, math.floor, math.sqrt, math.max, math.min, math.pi
local random = math.random

local SHIRTS = { { 0.93, 0.42, 0.38 }, { 0.36, 0.60, 0.86 }, { 0.98, 0.80, 0.34 }, { 0.46, 0.74, 0.52 },
                 { 0.76, 0.56, 0.86 }, { 0.98, 0.62, 0.40 }, { 0.94, 0.94, 0.92 } }
local HAIR = { { 0.26, 0.20, 0.18 }, { 0.50, 0.34, 0.22 }, { 0.86, 0.72, 0.42 }, { 0.72, 0.30, 0.24 }, { 0.92, 0.92, 0.9 } }
local SKIN = { 0.98, 0.84, 0.70 }
local LEGS = { 0.30, 0.34, 0.46 }
local HULL, SAIL, MAST = { 0.80, 0.42, 0.30 }, { 0.98, 0.97, 0.93 }, { 0.5, 0.36, 0.26 }
local GULL = { 0.97, 0.97, 0.98 }
local BLADE = { 0.95, 0.93, 0.86 }
local ROD = { 0.42, 0.30, 0.2 }
local NO_SNOW = 0.6

M.MAX_PEOPLE = 24
M.BRIDGE_TOP = 0.34

function M.new()
    local life = { people = {}, time = 0, boats = {}, gulls = {} }
    for i = 1, 2 do
        life.boats[i] = { angle = i * 2.4, radius = world.HALF + 3 + i * 3.5, speed = (i == 1 and 0.035 or -0.028) }
    end
    for i = 1, 5 do
        life.gulls[i] = { angle = i * 1.3, radius = 5 + i * 1.8, height = 4 + (i % 3) * 0.8, speed = 0.25 + i * 0.03,
                          cx = (i - 3) * 3, cz = (i % 2) * 6 - 3 }
    end
    return life
end

local function walkable(w, x, z)
    local cx, cz = world.cell_at(x, z)
    if not cx then return false end
    if world.has_road(w, cx, cz) then return true end
    return not world.is_wet(w, cx, cz) and world.get_obj(w, cx, cz) == 0
end

local function ground(w, x, z)
    local cx, cz = world.cell_at(x, z)
    if cx and world.has_road(w, cx, cz) and world.is_wet(w, cx, cz) then return M.BRIDGE_TOP end
    return world.height_at(w, x, z)
end

--- Where an islander goes next: mostly along roads, sometimes to the shore to fish.
local function choose_target(person, w, features)
    local roll = random()
    local list, then_do = nil, "idle"
    if roll < 0.55 and #features.roads > 0 then
        list = features.roads
    elseif roll < 0.75 and #features.shore > 0 then
        list, then_do = features.shore, "fish"
    end
    if list then
        -- A few tries for somewhere not too far away.
        for _ = 1, 6 do
            local spot = list[random(#list)]
            local x, z = world.cell_center(spot.cx, spot.cz)
            local dx, dz = x - person.x, z - person.z
            if dx * dx + dz * dz < 14 * 14 then
                person.tx, person.tz, person.then_do = x + (random() - 0.5) * 0.4, z + (random() - 0.5) * 0.4, then_do
                return
            end
        end
    end
    local a, d = random() * pi * 2, 1 + random() * 3
    person.tx, person.tz, person.then_do = person.x + cos(a) * d, person.z + sin(a) * d, "idle"
end

--- Brings the number of islanders to `target`: newcomers appear at a door.
function M.set_population(life, w, features, target)
    local people = life.people
    target = min(target, M.MAX_PEOPLE)
    while #people > target do people[#people] = nil end
    local tries = 0
    while #people < target and tries < 60 do
        tries = tries + 1
        local house = features.houses[random(#features.houses)]
        if house then
            local x, z = world.cell_center(house.cx + build.DX[house.door], house.cz + build.DZ[house.door])
            if walkable(w, x, z) then
                local n = #people + 1
                people[n] = {
                    x = x, z = z, y = ground(w, x, z), angle = random() * pi * 2, state = "idle", timer = random() * 2,
                    shirt = SHIRTS[1 + n % #SHIRTS], hair = HAIR[1 + (n * 3) % #HAIR], hair_style = 1 + n % 3,
                    hat = n % 4 == 0, phase = random() * 6,
                }
                choose_target(people[n], w, features)
            end
        end
    end
end

function M.update(life, w, features, dt)
    life.time = life.time + dt
    for _, boat in ipairs(life.boats) do boat.angle = boat.angle + boat.speed * dt end
    for _, gull in ipairs(life.gulls) do gull.angle = gull.angle + gull.speed * dt end

    for _, person in ipairs(life.people) do
        if not walkable(w, person.x, person.z) then
            -- The ground changed under their feet: back to a door.
            local house = features.houses[1 + floor(random() * #features.houses)]
            if house then
                person.x, person.z = world.cell_center(house.cx + build.DX[house.door], house.cz + build.DZ[house.door])
            end
            person.state, person.timer = "idle", 1
        end
        if person.state == "walk" then
            local dx, dz = person.tx - person.x, person.tz - person.z
            local d = sqrt(dx * dx + dz * dz)
            if d < 0.08 then
                person.state = person.then_do or "idle"
                person.timer = person.state == "fish" and (8 + random() * 10) or (3 + random() * 5)
                if person.state == "fish" then
                    -- Face the nearest water.
                    local cx, cz = world.cell_at(person.x, person.z)
                    for dir = 1, 4 do
                        if cx and world.is_wet(w, cx + build.DX[dir], cz + build.DZ[dir]) then
                            person.angle = math.atan2(build.DX[dir], build.DZ[dir])
                            break
                        end
                    end
                end
            else
                local step = min(d, 0.55 * dt)
                local nx, nz = person.x + dx / d * step, person.z + dz / d * step
                if walkable(w, nx, nz) then
                    person.x, person.z = nx, nz
                    person.angle = math.atan2(dx, dz)
                    person.phase = person.phase + dt * 9
                else
                    person.state, person.timer = "idle", 0.5 + random()
                end
            end
        else
            person.timer = person.timer - dt
            if person.timer <= 0 then
                person.state = "walk"
                choose_target(person, w, features)
            end
        end
        person.y = ground(w, person.x, person.z)
    end
end

--- What an islander says when tapped.
function M.line(person, sky_state)
    local pool
    local roll = random()
    if sky_state.weather == "rain" and roll < 0.6 then pool = catalog.lines.rain
    elseif sky_state.weather == "snow" and roll < 0.6 then pool = catalog.lines.snow
    elseif sky_state.night > 0.6 and roll < 0.6 then pool = catalog.lines.night
    elseif sky_state.season == 1 and roll < 0.25 then pool = catalog.lines.spring
    elseif sky_state.season == 3 and roll < 0.25 then pool = catalog.lines.autumn
    elseif person.state == "fish" then pool = catalog.lines.fish
    elseif person.state == "walk" then pool = catalog.lines.walk
    else pool = catalog.lines.idle end
    return pool[random(#pool)]
end

local models = build.models

--- The triangles of one islander, standing at the origin and facing +z.
-- The game gives every islander a mesh of their own and only moves it.
function M.person_geometry(person)
    S.begin()
    S.origin(0, 0, 0, 2)
    S.stamp(models.person, person.shirt, person.hair)
    S.stamp(models[({ "hair_a", "hair_b", "hair_c" })[person.hair_style or 1]], person.shirt, person.hair)
    for side = -1, 1, 2 do
        S.origin(side * 0.027, 0, 0, 2)
        S.stamp(models.leg, person.shirt, person.hair)
    end
    if person.hat then
        S.origin(0, 0.283, 0, 2)
        S.stamp(models.hat, person.shirt, person.hair)
    end
    return S.finish()
end

--- Where an islander's mesh goes this frame: x, y, z, the way they face, and how far they lean.
function M.person_pose(person)
    if person.state == "walk" then
        return person.x, person.y + math.abs(sin(person.phase)) * 0.014, person.z, person.angle, sin(person.phase) * 0.1
    end
    return person.x, person.y, person.z, person.angle, 0
end

--- The triangles of a sailing boat at the origin, bow towards +z.
function M.boat_geometry()
    S.begin()
    S.origin(0, 0, 0, 2)
    S.stamp(models.boat, SAIL, SAIL)
    return S.finish()
end

--- The triangles of a windmill's sails, around the axle they turn on.
function M.blades_geometry()
    S.begin()
    S.origin(0, 0, 0, 2)
    S.stamp(models.blades, SAIL, SAIL)
    return S.finish()
end

-- The angle that turns a model's front to each of the four directions.
local FACING = { pi / 2, 0, -pi / 2, pi }

--- Where the sails of a windmill are this frame: x, y, z, the way the mill faces, and how far they have turned.
function M.blades_pose(life, mill, wind)
    return mill[1], mill[2], mill[3], FACING[mill[4]], life.time * 0.9 * wind
end

--- Where boat `index` is this frame: x, y, z and its heading.
function M.boat_pose(life, index)
    local boat = life.boats[index]
    local heading = boat.angle + (boat.speed > 0 and 0 or pi)
    return cos(boat.angle) * boat.radius, sin(life.time * 1.3 + index) * 0.03 - 0.02, sin(boat.angle) * boat.radius, -heading
end

--- What still changes shape every frame, as one small mesh: fishing rods and gulls' wings.
function M.draw_actors(life, features, wind)
    S.begin()
    local t = life.time
    for _, person in ipairs(life.people) do
        if person.state == "fish" then
            local y = person.y
            S.origin_angle(person.x, y, person.z, person.angle)
            S.tri(0.062, 0.12, 0.02, 0.07, 0.12, 0.02, 0.066, 0.36, 0.5, 0, -1, 0, ROD, NO_SNOW)
            S.tri(0.066, 0.36, 0.5, 0.07, 0.36, 0.5, 0.068, -y + 0.02, 0.56, 0, -1, 5, { 0.9, 0.9, 0.9 }, NO_SNOW)
            S.blob(0.068, -y + 0.02, 0.56, 0.022, 0.022, 5, { 0.95, 0.3, 0.25 }, NO_SNOW)
        end
    end

    for index, gull in ipairs(life.gulls) do
        local x, z = gull.cx + cos(gull.angle) * gull.radius, gull.cz + sin(gull.angle) * gull.radius
        local flap = sin(t * 6 + index) * 0.09
        S.origin_angle(x, gull.height + sin(t * 0.7 + index) * 0.3, z, -gull.angle)
        S.tri(0, 0, -0.08, 0, 0, 0.1, 0.26, flap, 0, 0, -1, 0, GULL, NO_SNOW)
        S.tri(0, 0, -0.08, 0, 0, 0.1, -0.26, flap, 0, 0, -1, 0, GULL, NO_SNOW)
    end

    return S.finish()
end

-- ── see-through things ─────────────────────────────────────────

local fx = S.fx_vertex

local SOFT_COS, SOFT_SIN = {}, {}
for i = 0, 8 do
    SOFT_COS[i], SOFT_SIN[i] = cos(i / 8 * pi * 2), sin(i / 8 * pi * 2)
end

--- A round puff that faces the camera and fades out towards its edge.
local function soft(cam, x, y, z, size, r, g, b, a)
    local rx, ry, rz, ux, uy, uz = cam.rx * size, cam.ry * size, cam.rz * size, cam.ux * size, cam.uy * size, cam.uz * size
    for i = 0, 7 do
        local c0, s0, c1, s1 = SOFT_COS[i], SOFT_SIN[i], SOFT_COS[i + 1], SOFT_SIN[i + 1]
        fx(x, y, z, r, g, b, a)
        fx(x + rx * c0 + ux * s0, y + ry * c0 + uy * s0, z + rz * c0 + uz * s0, r, g, b, 0)
        fx(x + rx * c1 + ux * s1, y + ry * c1 + uy * s1, z + rz * c1 + uz * s1, r, g, b, 0)
    end
end

--- A diamond that faces the camera.
local function puff(cam, x, y, z, size, r, g, b, a)
    local rx, ry, rz, ux, uy, uz = cam.rx * size, cam.ry * size, cam.rz * size, cam.ux * size, cam.uy * size, cam.uz * size
    fx(x - rx, y - ry, z - rz, r, g, b, a) fx(x + ux, y + uy, z + uz, r, g, b, a) fx(x + rx, y + ry, z + rz, r, g, b, a)
    fx(x - rx, y - ry, z - rz, r, g, b, a) fx(x + rx, y + ry, z + rz, r, g, b, a) fx(x - ux, y - uy, z - uz, r, g, b, a)
end

local RAINBOW = { { 0.95, 0.30, 0.30 }, { 0.98, 0.62, 0.25 }, { 0.98, 0.90, 0.35 }, { 0.40, 0.82, 0.45 },
                  { 0.35, 0.62, 0.95 }, { 0.62, 0.45, 0.90 } }

--- Smoke, clouds, weather, fireflies, stars, the rainbow, and the brush ring.
-- cam: { rx, ry, rz, ux, uy, uz, tx, tz }: the camera's right and up, and what it looks at
-- brush: { x, z, radius } or nil
function M.draw_fx(life, w, features, sky_state, cam, brush)
    S.begin()
    local t = life.time
    local night = sky_state.night
    local grey = 0.95 - night * 0.45

    for index, chimney in ipairs(features.chimneys) do
        if index > 16 then break end
        for k = 0, 2 do
            local phase = (t * 0.22 + k / 3 + index * 0.37) % 1
            soft(cam, chimney[1] + phase * 0.35 * sky_state.wind, chimney[2] + phase * 1.2, chimney[3] + sin(phase * 5 + index) * 0.06,
                 0.1 + phase * 0.22, grey, grey, grey, (1 - phase) * 0.75)
        end
    end

    if sky_state.weather ~= "fog" then
        local dark = (sky_state.weather == "rain" or sky_state.weather == "snow") and 0.78 or 1
        local shade = (1 - night * 0.5) * dark
        -- Clouds: a few flat, faint shapes high above, each a ring of thin wedges so the edge is round.
        local opacity = sky_state.weather == "sunny" and 0.2 or 0.3
        for index = 1, 4 do
            local x = ((index * 19 + t * 0.3) % 80) - 40
            local z = (index * 23) % 56 - 28
            local y = 10 + (index % 3)
            for k = 0, 2 do
                local size = 2.4 - k * 0.5
                local cx, cz = x + (k - 1) * 2.1, z + (k % 2) * 0.8
                for seg = 0, 9 do
                    local a0, a1 = seg / 10 * pi * 2, (seg + 1) / 10 * pi * 2
                    fx(cx, y, cz, shade, shade, shade, opacity)
                    fx(cx + cos(a0) * size * 1.5, y, cz + sin(a0) * size, shade, shade, shade, 0)
                    fx(cx + cos(a1) * size * 1.5, y, cz + sin(a1) * size, shade, shade, shade, 0)
                end
            end
        end
    end

    if sky_state.weather == "rain" then
        for i = 1, 120 do
            local x = cam.tx + (hash(i, 1, 51) - 0.5) * 30
            local z = cam.tz + (hash(i, 2, 52) - 0.5) * 30
            local y = 12 - ((t * 14 + hash(i, 3, 53) * 12) % 12)
            fx(x - cam.rx * 0.015, y, z - cam.rz * 0.015, 0.82, 0.9, 1, 0.5)
            fx(x + cam.rx * 0.015, y, z + cam.rz * 0.015, 0.82, 0.9, 1, 0.5)
            fx(x + 0.06, y + 0.55, z, 0.82, 0.9, 1, 0.1)
        end
    elseif sky_state.weather == "snow" then
        for i = 1, 120 do
            local x = cam.tx + (hash(i, 1, 51) - 0.5) * 30 + sin(t * 0.8 + i) * 0.4
            local z = cam.tz + (hash(i, 2, 52) - 0.5) * 30
            local y = 12 - ((t * 1.6 + hash(i, 3, 53) * 12) % 12)
            puff(cam, x, y, z, 0.05, 1, 1, 1, 0.9)
        end
    elseif sky_state.weather == "rainbow" then
        local cx, cy, cz, radius = cam.tx, -1.5, cam.tz - 34, 27
        for band = 1, #RAINBOW do
            local col = RAINBOW[band]
            local r0, r1 = radius + band * 0.55, radius + band * 0.55 + 0.55
            for seg = 0, 19 do
                local a0, a1 = seg / 20 * pi, (seg + 1) / 20 * pi
                local c0, s0, c1, s1 = cos(a0), sin(a0), cos(a1), sin(a1)
                fx(cx + c0 * r0, cy + s0 * r0, cz, col[1], col[2], col[3], 0.38)
                fx(cx + c1 * r0, cy + s1 * r0, cz, col[1], col[2], col[3], 0.38)
                fx(cx + c1 * r1, cy + s1 * r1, cz, col[1], col[2], col[3], 0.38)
                fx(cx + c0 * r0, cy + s0 * r0, cz, col[1], col[2], col[3], 0.38)
                fx(cx + c1 * r1, cy + s1 * r1, cz, col[1], col[2], col[3], 0.38)
                fx(cx + c0 * r1, cy + s0 * r1, cz, col[1], col[2], col[3], 0.38)
            end
        end
    end

    if night > 0.5 then
        local glow = (night - 0.5) * 2
        for i = 1, 40 do
            local a, e = hash(i, 4, 61) * pi * 2, 0.25 + hash(i, 5, 62) * 0.9
            local twinkle = 0.6 + 0.4 * sin(t * 2 + i)
            puff(cam, cam.tx + cos(a) * cos(e) * 150, sin(e) * 150, cam.tz + sin(a) * cos(e) * 150, 0.9, 1, 1, 0.9, glow * twinkle)
        end
        local spots = features.tree_spots
        if #spots > 0 and sky_state.weather ~= "rain" and sky_state.weather ~= "snow" then
            for i = 1, 26 do
                local spot = spots[1 + (i * 7) % #spots]
                local x = spot[1] + sin(t * 0.6 + i * 1.7) * 1.2
                local z = spot[3] + cos(t * 0.5 + i * 2.3) * 1.2
                local y = spot[2] + 0.4 + sin(t * 0.9 + i) * 0.25
                soft(cam, x, y, z, 0.09, 0.85, 1, 0.45, glow * (0.5 + 0.5 * sin(t * 3 + i * 1.3)))
            end
        end
        for index, lamp in ipairs(features.lighthouses) do
            local a = t * 0.6 + index
            for side = 0, 1 do
                local c, s = cos(a + side * pi), sin(a + side * pi)
                fx(lamp[1], lamp[2], lamp[3], 1, 0.95, 0.7, 0.35 * glow)
                fx(lamp[1] + c * 14 - s * 1.6, lamp[2] - 0.6, lamp[3] + s * 14 + c * 1.6, 1, 0.95, 0.7, 0)
                fx(lamp[1] + c * 14 + s * 1.6, lamp[2] - 0.6, lamp[3] + s * 14 - c * 1.6, 1, 0.95, 0.7, 0)
            end
        end
    end

    if brush then
        local segments = 28
        for seg = 0, segments - 1 do
            local a0, a1 = seg / segments * pi * 2, (seg + 1) / segments * pi * 2
            local x0, z0 = brush.x + cos(a0) * brush.radius, brush.z + sin(a0) * brush.radius
            local x1, z1 = brush.x + cos(a1) * brush.radius, brush.z + sin(a1) * brush.radius
            local y0 = max(0, world.height_at(w, x0, z0)) + 0.08
            local y1 = max(0, world.height_at(w, x1, z1)) + 0.08
            local inner = 1 - 0.09 / brush.radius
            local ix0, iz0 = brush.x + cos(a0) * brush.radius * inner, brush.z + sin(a0) * brush.radius * inner
            local ix1, iz1 = brush.x + cos(a1) * brush.radius * inner, brush.z + sin(a1) * brush.radius * inner
            fx(x0, y0, z0, 1, 1, 1, 0.85) fx(x1, y1, z1, 1, 1, 1, 0.85) fx(ix1, y1, iz1, 1, 1, 1, 0.85)
            fx(x0, y0, z0, 1, 1, 1, 0.85) fx(ix1, y1, iz1, 1, 1, 1, 0.85) fx(ix0, y0, iz0, 1, 1, 1, 0.85)
        end
    end
    return S.finish()
end

return M
