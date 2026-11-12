--- Builds an island step by step without a finger. The tutorial uses the
-- steps for its "do it for me" button, and the tests use the whole thing.

local world = require "island.world"
local catalog = require "island.catalog"

local M = {}

local function place(w, cx, cz, item)
    if world.place(w, cx, cz, item) then
        if catalog.is_building(item) then world.level_cell(w, cx, cz) end
        return true
    end
    return false
end

--- The first dry, empty, roadless cell at or after (cx, cz), scanning outwards.
local function free_cell(w, cx, cz)
    for r = 0, 6 do
        for dz = -r, r do
            for dx = -r, r do
                local x, z = cx + dx, cz + dz
                if world.buildable(w, x, z) and world.get_obj(w, x, z) == 0 and not world.has_road(w, x, z) then
                    return x, z
                end
            end
        end
    end
    return nil
end

M.steps = {}

-- The steps were laid out on a map 44 cells wide; O moves their cells to the middle of today's map.
local O = (world.N - 44) / 2

function M.steps.land(w)
    for _ = 1, 3 do world.sculpt(w, "raise", 0, 0, 13, 0.6) end
    for _ = 1, 3 do world.sculpt(w, "raise", -7, -6, 6, 0.6) end
    for _ = 1, 2 do world.sculpt(w, "raise", 8, 6, 6.5, 0.5) end
    world.sculpt(w, "raise", 10, -8, 4.5, 1.1)
    world.sculpt(w, "raise", -9, 9, 5, 1.0)
    for _ = 1, 4 do world.sculpt(w, "flatten", 0, 2, 9, 0.5, 0.75) end
    world.quantize(w)
end

function M.steps.paint(w)
    world.paint(w, world.FLOWERS, 5, -4, 2.6)
    world.paint(w, world.WHEAT, -6, 6, 2.6)
    world.paint(w, world.LAVENDER, 8, 5, 2.2)
    return 40
end

function M.steps.river(w)
    local dug = 0
    for step = 0, 44 do
        local z = -11 + step * 0.5
        local x = 1.5 + math.sin(z * 0.35) * 2.2
        if world.sculpt(w, "dig", x, z, 0.9, 0.9) then dug = dug + 1 end
    end
    world.quantize(w)
    return dug
end

function M.steps.house(w)
    local cx, cz = free_cell(w, 15 + O, 22 + O)
    if cx then place(w, cx, cz, catalog.HOUSE) end
end

function M.steps.trees(w)
    local spots = { { 12, 16 }, { 14, 14 }, { 10, 20 }, { 28, 16 }, { 30, 18 }, { 27, 28 }, { 13, 28 }, { 31, 24 } }
    local kinds = { catalog.TREE, catalog.PINE, catalog.TREE, catalog.SAKURA, catalog.TREE, catalog.MAPLE, catalog.PINE, catalog.PALM }
    for index, spot in ipairs(spots) do
        local cx, cz = free_cell(w, spot[1] + O, spot[2] + O)
        if cx then place(w, cx, cz, kinds[index]) end
    end
end

function M.steps.road(w)
    for cx = 12 + O, 32 + O do world.set_road(w, cx, 24 + O, true) end
    for cz = 18 + O, 24 + O do world.set_road(w, 19 + O, cz, true) end
    for cz = 24 + O, 29 + O do world.set_road(w, 27 + O, cz, true) end
end

function M.steps.row(w)
    for cx = 14 + O, 17 + O do
        if world.get_obj(w, cx, 23 + O) ~= catalog.HOUSE then
            world.set_road(w, cx, 23 + O, false)
            place(w, cx, 23 + O, catalog.HOUSE)
        end
    end
    place(w, 21 + O, 25 + O, catalog.SHOP)
    place(w, 29 + O, 23 + O, catalog.HOUSE)
    place(w, 30 + O, 23 + O, catalog.HOUSE)
end

function M.steps.dock(w)
    -- Next to the river: the first dry cell west of a wet one.
    for cz = 14 + O, 20 + O do
        for cx = 16 + O, 26 + O do
            if world.is_wet(w, cx + 1, cz) and world.buildable(w, cx, cz) and world.get_obj(w, cx, cz) == 0
                and not world.has_road(w, cx, cz) then
                place(w, cx, cz, catalog.HOUSE)
                return
            end
        end
    end
end

function M.steps.decor(w)
    local things = {
        { 20, 23, catalog.BENCH }, { 22, 23, catalog.LAMP }, { 25, 26, catalog.WELL }, { 13, 25, catalog.MAILBOX },
        { 31, 26, catalog.PAVILION }, { 11, 12, catalog.ROCK }, { 33, 20, catalog.FLAG }, { 9, 26, catalog.HAYSTACK },
        { 10, 27, catalog.SCARECROW }, { 28, 13, catalog.CAMPFIRE }, { 30, 30, catalog.BUSH }, { 12, 31, catalog.FENCE },
        { 13, 31, catalog.FENCE }, { 14, 31, catalog.FENCE }, { 33, 14, catalog.LIGHTHOUSE }, { 9, 16, catalog.WINDMILL },
        { 24, 21, catalog.TOWER },
    }
    for _, thing in ipairs(things) do
        local cx, cz = free_cell(w, thing[1] + O, thing[2] + O)
        if cx then place(w, cx, cz, thing[3]) end
    end
end

M.order = { "land", "paint", "river", "house", "trees", "road", "row", "dock", "decor" }

--- The whole island at once.
function M.build(w)
    for _, name in ipairs(M.order) do M.steps[name](w) end
    world.tidy(w, catalog.is_building)
    world.touch_all(w)
end

return M
