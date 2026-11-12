-- Run from the project root: luajit test/run.lua
package.path = "./?.lua;" .. package.path

local world = require "island.world"
local catalog = require "island.catalog"
local build = require "island.build"
local demo = require "island.demo"

local passed, failed = 0, 0
local function check(name, ok, detail)
    if ok then
        passed = passed + 1
    else
        failed = failed + 1
        print("FAIL " .. name .. (detail and (": " .. tostring(detail)) or ""))
    end
end

-- A new island is all sea.
local w = world.new()
local stats = world.stats(w)
check("a new island has no land", stats.land == 0, stats.land)
check("the collection has 57 entries", #catalog.collection == 57, #catalog.collection)
check("there are 15 tasks", #catalog.tasks == 15, #catalog.tasks)
local keys = {}
for _, tool in ipairs(catalog.tools) do
    check("tool key " .. tool.key .. " is used once", not keys[tool.key])
    keys[tool.key] = true
end
for index, task in ipairs(catalog.tasks) do
    for _, reward in ipairs(task.reward) do
        check(("task %d rewards a known tool: %s"):format(index, reward), catalog.tool_by_key[reward] ~= nil)
    end
end
-- Every tool is either there from the start or the reward of some task.
for _, tool in ipairs(catalog.tools) do
    local rewarded = false
    for _, task in ipairs(catalog.tasks) do
        for _, reward in ipairs(task.reward) do rewarded = rewarded or reward == tool.key end
    end
    check("tool " .. tool.key .. " can be had", tool.start or rewarded)
    check("tool " .. tool.key .. " is not both", not (tool.start and rewarded))
end

-- Raising makes land; the border stays sea.
world.sculpt(w, "raise", 0, 0, 6, 2)
stats = world.stats(w)
check("raising makes land", stats.land > 40, stats.land)
world.sculpt(w, "raise", -world.HALF, -world.HALF, 6, 5)
check("the border stays sea", world.is_wet(w, 0, 0) and world.is_wet(w, 1, 1))
check("height_at reads the raised ground", world.height_at(w, 0, 0) > 0)

-- Objects need dry, gentle ground; roads may cross water.
local cx, cz = world.cell_at(0.5, 0.5)
check("a house stands on land", world.place(w, cx, cz, catalog.HOUSE))
check("nothing stands in the sea", not world.place(w, 3, 3, catalog.HOUSE))
check("a road replaces the object", world.set_road(w, cx, cz, true) and world.get_obj(w, cx, cz) == 0)
check("a road may cross water", world.set_road(w, 5, 5, true) and world.is_wet(w, 5, 5))
check("erase removes it", world.erase(w, 5, 5) and not world.has_road(w, 5, 5))

-- The whole demo island.
w = world.new()
demo.build(w)
stats = world.stats(w)
local f = build.features(w)
check("the demo island has land", stats.land > 300, stats.land)
check("the demo island has houses", (stats.by_item[catalog.HOUSE] or 0) >= 6, stats.by_item[catalog.HOUSE])
check("houses stand in a row", f.longest_row >= 4, f.longest_row)
check("a house by the river has a dock", f.docks >= 1, f.docks)
check("the road crosses the river on a bridge", stats.bridges >= 1, stats.bridges)
check("roads meet at junctions", f.junctions >= 2, f.junctions)
check("the shore is a beach", f.beach)
check("there are chimneys for smoke", #f.chimneys >= 2, #f.chimneys)
check("there are trees", f.trees >= 6, f.trees)

-- Every chunk builds, in every season, with finite numbers.
local total, most = 0, 0
for season = 1, 4 do
    for chunk_z = 0, world.CHUNKS - 1 do
        for chunk_x = 0, world.CHUNKS - 1 do
            local ground = build.ground_chunk(w, chunk_x, chunk_z, season)
            check("the ground of a chunk is a fine grid", ground.count == world.CHUNK * world.CHUNK * 24, ground.count)
            local ground_count = ground.count
            local g = build.props_chunk(w, chunk_x, chunk_z, season)
            check("props are whole triangles", g.count % 3 == 0, g.count)
            g.count = g.count          -- the numbers checked below are those of the props, the last mesh built
            if season == 1 then total = total + ground_count end
            local bad = 0
            for i = 1, g.count * 3 do
                local v = g.p[i]
                if v ~= v or v > 1e4 or v < -1e4 then bad = bad + 1 end
                local n = g.n[i]
                if n ~= n then bad = bad + 1 end
            end
            for i = 1, g.count * 4 do
                local v = g.c[i]
                if v ~= v or v < 0 or v > 1.6 then bad = bad + 1 end
            end
            check("chunk numbers are sane", bad == 0, bad)
            if season == 1 then
                total = total + g.count
                most = math.max(most, g.count)
            end
        end
    end
end
local water = 0
for chunk_z = 0, world.CHUNKS - 1 do
    for chunk_x = 0, world.CHUNKS - 1 do
        water = water + build.water_chunk(w, chunk_x, chunk_z).count
    end
end
check("the sea is drawn", water > 3000 and build.ocean(200).count == 24 and build.sea_floor(200).count == 24, water)
print(("demo island: %d land cells, %d solid vertices (largest chunk %d), %d water vertices"):format(stats.land, total, most, water))

-- Saving: bytes and the island code give the same island back.
local data = world.encode(w)
local copy = world.new()
local ok, reason = world.decode(copy, data)
check("the island decodes", ok, reason)
local same = true
for i = 1, #w.h do same = same and math.abs(w.h[i] - copy.h[i]) < 1e-9 end
for i = 1, #w.surf do same = same and w.surf[i] == copy.surf[i] and w.road[i] == copy.road[i] and w.obj[i] == copy.obj[i] end
check("the copy is the same island", same)
local code = world.to_code(w)
check("the island code is text", code:match("^DAO1%.[%w%-_]+$") ~= nil)
local visitor = world.new()
ok, reason = world.from_code(visitor, "快来我的岛看看 " .. code .. " 记得带伞")
check("a code inside a message loads", ok, reason)
check("the visitor sees the same island", world.encode(visitor) == data)
check("a damaged code is refused", not world.from_code(world.new(), code:sub(1, -5) .. "AAAA"))
check("the open sea is out of reach, the middle is not", not world.reachable(world.HALF - 1, 0) and world.reachable(0, 0) and world.reachable(20, -20))
-- An island saved on the old map, 44 cells wide, lands in the middle of today's:
-- a hill at the centre with a sand patch, a house and a piece of road.
do
    local old_code = "DAO1.AQELLAABCywAAQssAAELLAABCywAAQssAAELLAABCywAAQssAAELLAABCywAAQssAAELLAABCywAAQssAAELLAABCywAAQssAAELEwACAQIAAv8TAAELEgABAQICAQEB_wL-Af8SAAELEQABAQECAQQCAgL-AfwB_gH_EQABCxEAAQIBAwIEAQIB_gL8Af0B_hEAAQsRAAECAQQBBQEEAQEB_wH8AfsB_AH-EQABCxEAAQIBAwIEAQIB_gL8Af0B_hEAAQsRAAEBAQIBBAICAv4B_AH-Af8RAAELEgABAQICAQEB_wL-Af8SAAELEwACAQIAAv8TAAELLAABCywAAQssAAELLAABCywAAQssAAELLAABCywAAQssAAELLAABCywAAQssAAELLAABCywAAQssAAELLAABCywAAQssAP8B_wH_AeEBAgIqAQIC_wH_Af8BhwH_AP8A_wDhAAEBAYD_AP8A_wCzAJt6"
    local moved = world.new()
    local loaded, why = world.from_code(moved, old_code)
    check("an old island loads", loaded, why)
    local stats = world.stats(moved)
    check("an old island keeps its land", stats.land == 32 and world.height_at(moved, 0, 0) > 0.5, stats.land)
    local cx, cz = world.cell_at(0.5, 0.5)
    check("an old island keeps its house and road in the middle", world.get_obj(moved, cx, cz) == catalog.HOUSE and world.has_road(moved, cx + 1, cz))
    check("an old island keeps its sand", (stats.by_surface[world.SAND] or 0) >= 4, stats.by_surface[world.SAND])
    check("around it there is sea", world.is_wet(moved, 3, 3) and world.is_wet(moved, world.N - 4, world.N - 4))
end
check("text without a code is refused", not world.from_code(world.new(), "没有码"))
print(("island code: %d characters, %d bytes saved"):format(#code, #data))

-- Life: islanders move in, walk, and everything that moves can be drawn.
do
    local life_m = require "island.life"
    local sky_m = require "island.sky"
    local progress = require "island.progress"
    math.randomseed(7)
    local life = life_m.new()
    life_m.set_population(life, w, f, f.connected * 2)
    check("islanders move into houses by the road", #life.people >= 4, #life.people)
    local start_x, start_z = life.people[1].x, life.people[1].z
    for _ = 1, 600 do life_m.update(life, w, f, 1 / 30) end
    local moved = false
    for _, person in ipairs(life.people) do
        moved = moved or math.abs(person.x - start_x) > 0.5 or math.abs(person.z - start_z) > 0.5
        local cx, cz = world.cell_at(person.x, person.z)
        check("an islander stays on walkable ground", cx ~= nil and (world.has_road(w, cx, cz) or not world.is_wet(w, cx, cz)))
    end
    check("islanders walk", moved)
    local actors = life_m.draw_actors(life, f, 1)
    check("gulls are drawn", actors.count >= 30 and actors.count % 3 == 0, actors.count)
    check("a windmill has sails", life_m.blades_geometry().count > 500 and #f.windmills == 1)
    local sx, sy, sz, facing, turned = life_m.blades_pose(life, f.windmills[1], 1)
    check("the sails sit before the mill and turn", type(facing) == "number" and turned > 0 and sy > 0.5 and sx == f.windmills[1][1] and sz == f.windmills[1][3])
    local body = life_m.person_geometry(life.people[1])
    check("an islander has a body", body.count > 900 and body.count % 3 == 0, body.count)
    check("a boat has a hull and sails", life_m.boat_geometry().count > 400)
    local x, y, z, angle, lean = life_m.person_pose(life.people[1])
    check("an islander has a pose", x == life.people[1].x and type(angle) == "number" and type(lean) == "number" and y >= life.people[1].y and z == life.people[1].z)
    local bx, by, bz, heading = life_m.boat_pose(life, 1)
    check("a boat sails outside the map", math.sqrt(bx * bx + bz * bz) > world.HALF and type(heading) == "number" and math.abs(by) < 0.1)
    local cam = { rx = 1, ry = 0, rz = 0, ux = 0, uy = 1, uz = 0, tx = 0, tz = 0 }
    for _, weather in ipairs({ "sunny", "rain", "fog", "snow", "rainbow" }) do
        for _, hour in ipairs({ 12, 23 }) do
            local state = sky_m.at(hour, 2, weather)
            state.weather, state.season = weather, 2
            local g = life_m.draw_fx(life, w, f, state, cam, { x = 0, z = 0, radius = 2 })
            local bad = 0
            for i = 1, g.count * 3 do if g.p[i] ~= g.p[i] then bad = bad + 1 end end
            check(("effects draw in %s at %d h"):format(weather, hour), g.count > 0 and g.count % 3 == 0 and bad == 0, g.count)
            check("a line is said", type(life_m.line(life.people[1], state)) == "string")
        end
    end
    print(("life: %d islanders, %d actor vertices"):format(#life.people, actors.count))

    -- Progress: the demo island finishes the building tasks in order.
    local p = progress.new()
    p.count.painted, p.count.dug = 40, 12
    local state = sky_m.at(12, 2, "sunny")
    state.weather, state.season = "sunny", 2
    local events = progress.evaluate(p, world.stats(w), f, #life.people, state)
    local tasks_done = 0
    for _, event in ipairs(events) do if event.type == "task" then tasks_done = tasks_done + 1 end end
    check("the demo island completes the first ten tasks", tasks_done == 10 and p.task == 11, tasks_done)
    check("rewards are unlocked", p.unlocked.house and p.unlocked.road and p.unlocked.tower and not p.unlocked.lighthouse)
    check("things are found", progress.found_count(p) >= 25, progress.found_count(p))
    local again = progress.load(progress.save(p))
    check("progress survives saving", again.task == p.task and again.unlocked.tower and progress.found_count(again) == progress.found_count(p))
end

-- Tidy removes what ended up under water.
world.sculpt(w, "lower", 0, 0, 30, 20)
local removed = world.tidy(w, catalog.is_building)
check("tidy removes drowned objects", removed > 5 and world.stats(w).objects == 0, removed)

print(("%d checks passed, %d failed"):format(passed, failed))
os.exit(failed == 0 and 0 or 1)
