--- What the player has unlocked, found and finished. Pure Lua.

local catalog = require "island.catalog"

local M = {}

function M.new()
    local p = {
        task = 1,                 -- the task being worked on; #tasks + 1 when all are done
        unlocked = {},            -- tool key → true
        found = {},               -- collection key → true
        count = { painted = 0, dug = 0, seasons = 0 },
        flag = {},
        seasons_seen = {},
        tutorial = 1,             -- tutorial step; 0 when finished or skipped
        -- filled in by evaluate():
        stats = { land = 0, roads = 0, bridges = 0, objects = 0, by_item = {}, by_surface = {} },
        population = 0, trees = 0, longest_row = 0, docks = 0,
    }
    for _, tool in ipairs(catalog.tools) do
        if tool.start then p.unlocked[tool.key] = true end
    end
    return p
end

function M.found_count(p)
    local n = 0
    for _ in pairs(p.found) do n = n + 1 end
    return n
end

local function find(p, key, events)
    if not p.found[key] then
        p.found[key] = true
        events[#events + 1] = { type = "found", key = key }
    end
end
M.find = find

--- Looks at the island and reports what is new.
-- Returns a list of events: { type = "found", key }, { type = "task", index, rewards }.
function M.evaluate(p, stats, features, population, sky)
    local events = {}
    p.stats, p.population = stats, population
    p.trees, p.longest_row, p.docks = features.trees, features.longest_row, features.docks

    for _, tool in ipairs(catalog.tools) do
        if tool.item and (stats.by_item[tool.item] or 0) > 0 then find(p, tool.key, events) end
        if tool.surface and (stats.by_surface[tool.surface] or 0) > 0 and (p.count.painted > 0 or tool.surface ~= 1) then
            find(p, tool.key, events)
        end
    end
    if p.count.dug > 0 then find(p, "river", events) end
    if p.count.dug >= 20 then find(p, "lake", events) end
    if stats.roads > 0 then find(p, "road", events) end
    if features.longest_row >= 2 then find(p, "row", events) end
    if #features.chimneys > 0 then find(p, "chimney", events) find(p, "smoke", events) end
    if features.docks > 0 then find(p, "dock", events) end
    if features.junctions > 0 then find(p, "junction", events) end
    if features.street_lamps > 0 then find(p, "streetlamp", events) end
    if stats.bridges > 0 then find(p, "bridge", events) end
    if features.beach then find(p, "beach", events) find(p, "foam", events) end
    if features.reef then find(p, "reef", events) end
    if population > 0 then find(p, "walker", events) end
    if stats.land > 0 then find(p, "boat", events) find(p, "gull", events) end
    if sky then
        if sky.night > 0.6 then
            if features.glow > 0 then find(p, "window", events) end
            if features.trees > 0 then find(p, "firefly", events) end
        end
        if sky.season == 1 and (stats.by_item[catalog.SAKURA] or 0) > 0 then find(p, "bloom", events) end
        if sky.season == 3 and features.trees > 0 then find(p, "redleaf", events) end
        if sky.season == 4 and stats.land > 0 then find(p, "snowcover", events) end
        if sky.weather == "rain" then find(p, "rain", events) end
        if sky.weather == "fog" then find(p, "fog", events) end
        if sky.weather == "snow" then find(p, "snowfall", events) end
        if sky.weather == "rainbow" then find(p, "rainbow", events) end
    end

    -- Tasks are done in order; finishing one may finish the next at once.
    while p.task <= #catalog.tasks do
        local task = catalog.tasks[p.task]
        if task.value(p) < task.goal then break end
        for _, key in ipairs(task.reward) do p.unlocked[key] = true end
        events[#events + 1] = { type = "task", index = p.task, rewards = task.reward }
        p.task = p.task + 1
    end
    return events
end

--- Progress of the current task: value, goal. Nil when all tasks are done.
function M.current(p)
    local task = catalog.tasks[p.task]
    if not task then return nil end
    return task, math.min(task.value(p), task.goal), task.goal
end

--- A plain table for sys.save.
function M.save(p)
    local unlocked, found, seasons = {}, {}, {}
    for key in pairs(p.unlocked) do unlocked[#unlocked + 1] = key end
    for key in pairs(p.found) do found[#found + 1] = key end
    for season in pairs(p.seasons_seen) do seasons[#seasons + 1] = season end
    local flags = {}
    for key, value in pairs(p.flag) do if value then flags[#flags + 1] = key end end
    return { task = p.task, unlocked = unlocked, found = found, seasons = seasons, flags = flags,
             painted = p.count.painted, dug = p.count.dug, tutorial = p.tutorial }
end

function M.load(data)
    local p = M.new()
    if type(data) ~= "table" then return p end
    p.task = math.max(1, math.min(#catalog.tasks + 1, tonumber(data.task) or 1))
    for _, key in ipairs(data.unlocked or {}) do
        if catalog.tool_by_key[key] then p.unlocked[key] = true end
    end
    for _, key in ipairs(data.found or {}) do p.found[key] = true end
    for _, season in ipairs(data.seasons or {}) do p.seasons_seen[season] = true end
    for _, key in ipairs(data.flags or {}) do p.flag[key] = true end
    p.count.painted, p.count.dug = tonumber(data.painted) or 0, tonumber(data.dug) or 0
    for _ in pairs(p.seasons_seen) do p.count.seasons = p.count.seasons + 1 end
    p.tutorial = tonumber(data.tutorial) or 0
    return p
end

return M
