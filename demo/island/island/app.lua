--- What the game script and the interface tell each other. Both run in one
-- Lua state, so this module is their shared memory: the interface queues
-- commands and pointer events, the game publishes what the interface shows.

local M = {}

M.commands = {}      -- from the interface: { type = "...", ... }
M.pointer = {}       -- touches that missed the interface: { kind = "down"|"move"|"up"|"gesture", ... }
M.revision = 0       -- bumped whenever something the interface shows has changed
M.photo = false      -- photo mode hides the tools
M.hand = false       -- looking around instead of using the tool: false, "move" (a finger drags the island) or "turn"
M.music = true       -- the background tune
M.film = false       -- the island builds itself for the camera: no interface, no touches

-- Published by the game:
M.tool = "raise"
M.group = "terrain"
M.radius, M.strength, M.count = 3, 2, 1
M.progress = nil     -- island.progress table
M.level, M.level_part = 1, 0
M.hour, M.season, M.weather = 10, 2, "sunny"
M.filter, M.frame = 1, 1
M.slot = 1
M.slots = {}         -- [n] = { land = cells, level = n } or false
M.undo = 0
M.toast = nil        -- { text, until }
M.bubble = nil       -- { text, x, y (screen), until }
M.banner = nil       -- { title, lines, until }: task finished, things unlocked
M.code = nil         -- the island code last made, for the share panel

function M.send(command)
    M.commands[#M.commands + 1] = command
end

function M.changed()
    M.revision = M.revision + 1
end

--- Seconds since the game started; the game script advances it every frame.
M.now = 0

function M.say(text, seconds)
    M.toast = { text = text, until_time = M.now + (seconds or 2.2) }
    M.revision = M.revision + 1
end

return M
