--- Light and air for an hour of the day, a season and the weather. Pure Lua.

local M = {}

local sin, cos, max, min, pi = math.sin, math.cos, math.max, math.min, math.pi

local function mix3(a, b, t)
    return { a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t }
end

local NIGHT_SKY, DAY_SKY, DUSK_SKY = { 0.07, 0.10, 0.22 }, { 0.62, 0.83, 0.97 }, { 0.99, 0.68, 0.52 }
local NIGHT_SUN, NOON_SUN, DUSK_SUN = { 0.16, 0.2, 0.36 }, { 1.0, 0.95, 0.84 }, { 1.0, 0.56, 0.30 }
local NIGHT_AMBIENT, DAY_AMBIENT = { 0.20, 0.24, 0.40 }, { 0.47, 0.52, 0.62 }
local GREY = { 0.74, 0.77, 0.80 }

--- @param hour 0..24  @param season 1..4  @param weather "sunny"|"rain"|"fog"|"snow"|"rainbow"
function M.at(hour, season, weather)
    local angle = (hour - 6) / 12 * pi
    local height = sin(angle)                       -- sun above the horizon when positive
    local day = max(0, min(1, height * 4 + 0.6))    -- 0 night .. 1 day; dusk lingers a little
    local noon = max(0, height) ^ 0.6               -- 0 at the horizon .. 1 overhead

    local sun_dir
    if height > -0.08 then
        local x, y, z = cos(angle) * 0.75, max(0.12, height), 0.4
        local len = math.sqrt(x * x + y * y + z * z)
        sun_dir = { x / len, y / len, z / len }
    else
        sun_dir = { -0.35, 0.8, 0.48 }              -- the moon
    end

    local sky = mix3(NIGHT_SKY, mix3(DUSK_SKY, DAY_SKY, noon), day)
    local sun = mix3(NIGHT_SUN, mix3(DUSK_SUN, NOON_SUN, noon), day)
    local ambient = mix3(NIGHT_AMBIENT, DAY_AMBIENT, day)
    local fog_start, fog_end, wind, snow = 60, 210, 1, 0

    if season == 4 then
        snow = 0.8
        ambient = mix3(ambient, { 0.6, 0.66, 0.78 }, 0.3 * day)
    elseif season == 3 then
        sun = mix3(sun, { 1.0, 0.82, 0.6 }, 0.25 * day)
    end
    if weather == "rain" then
        sky = mix3(sky, { GREY[1] * 0.72, GREY[2] * 0.74, GREY[3] * 0.8 }, 0.75)
        sun = { sun[1] * 0.45, sun[2] * 0.47, sun[3] * 0.52 }
        ambient = { ambient[1] * 0.95, ambient[2] * 0.97, ambient[3] }
        fog_start, fog_end, wind = 30, 120, 2
    elseif weather == "fog" then
        sky = mix3(sky, GREY, 0.8)
        sun = { sun[1] * 0.6, sun[2] * 0.6, sun[3] * 0.62 }
        fog_start, fog_end, wind = 6, 62, 0.4
    elseif weather == "snow" then
        sky = mix3(sky, { 0.86, 0.89, 0.93 }, 0.75)
        sun = { sun[1] * 0.7, sun[2] * 0.72, sun[3] * 0.76 }
        fog_start, fog_end, snow = 30, 130, 1
    end

    return {
        sun_dir = sun_dir, sun_color = sun, ambient = ambient, sky = sky,
        fog_start = fog_start, fog_end = fog_end, wind = wind,
        night = 1 - day, snow = snow, day = day,
        sunset = hour >= 17 and hour <= 19.5,
    }
end

return M
