--- What the render script needs each frame: the camera and the light.
-- The game script writes here, the render script reads. Both run in one Lua
-- state (script.shared_state = 1 in game.project).

local M = {}

M.view = vmath.matrix4()
M.fov = math.rad(32)
M.near, M.far = 1, 400
M.window_width, M.window_height = 720, 1280

function M.projection(aspect)
    return vmath.matrix4_perspective(M.fov, aspect, M.near, M.far)
end

M.constants = {
    sun_dir = vmath.vector4(0.4, 0.8, 0.3, 0),
    sun_color = vmath.vector4(1.0, 0.95, 0.85, 1),
    ambient = vmath.vector4(0.45, 0.5, 0.6, 1),
    fog = vmath.vector4(60, 0.01, 0, 1),
    eye = vmath.vector4(0, 30, 30, 1),
    mood = vmath.vector4(0, 0, 0, 0),
    fog_color = vmath.vector4(0.75, 0.87, 0.95, 1),
    fog_params = vmath.vector4(60, 0.01, 0, 0),
    cam_pos = vmath.vector4(0, 30, 30, 1),
    grade = vmath.vector4(1, 1, 1, 1),
}

return M
