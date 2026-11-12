--- Runtime meshes: a game object with a mesh component whose vertices are
-- replaced from Lua. Every mesh has position, normal and color0 streams.

local M = {}

local STREAMS = {
    { name = hash("position"), type = buffer.VALUE_TYPE_FLOAT32, count = 3 },
    { name = hash("normal"), type = buffer.VALUE_TYPE_FLOAT32, count = 3 },
    { name = hash("color0"), type = buffer.VALUE_TYPE_FLOAT32, count = 4 },
}

local created = 0

--- Spawns a mesh from one of the factories on the game object.
function M.new(factory_url)
    local id = factory.create(factory_url, vmath.vector3(0, 0, 0))
    created = created + 1
    local resource_path = ("/island/dyn/mesh%d.bufferc"):format(created)
    local res = resource.create_buffer(resource_path, { buffer = buffer.create(3, STREAMS) })
    local url = msg.url(nil, id, "mesh")
    go.set(url, "vertices", res)
    return { id = id, url = url, res = res, vertices = 0 }
end

--- Replaces the vertices. `geometry` is { p = {x,y,z,...}, n = {...}, c = {r,g,b,a,...}, count = vertices }.
function M.upload(mesh, geometry)
    local count = geometry.count
    local buf = buffer.create(math.max(count, 3), STREAMS)
    if count > 0 then
        local position = buffer.get_stream(buf, "position")
        local normal = buffer.get_stream(buf, "normal")
        local color = buffer.get_stream(buf, "color0")
        local p, n, c = geometry.p, geometry.n, geometry.c
        for i = 1, count * 3 do
            position[i] = p[i]
            normal[i] = n[i]
        end
        for i = 1, count * 4 do
            color[i] = c[i]
        end
    end
    resource.set_buffer(mesh.res, buf)
    -- A mesh with nothing in it is not drawn at all.
    if (count == 0) ~= (mesh.hidden == true) then
        mesh.hidden = count == 0
        msg.post(mesh.url, mesh.hidden and "disable" or "enable")
    end
    mesh.vertices = count
end

--- For meshes that change every frame: the same as upload(), but the
-- buffer is kept and only grows, and what is left over from a longer frame
-- is collapsed into nothing instead of being cut off.
function M.upload_dynamic(mesh, geometry)
    local count = geometry.count
    if not mesh.buffer or count > mesh.capacity then
        mesh.capacity = math.max(300, math.floor(count * 1.5 / 3) * 3)
        mesh.buffer = buffer.create(mesh.capacity, STREAMS)
        mesh.position = buffer.get_stream(mesh.buffer, "position")
        mesh.normal = buffer.get_stream(mesh.buffer, "normal")
        mesh.color = buffer.get_stream(mesh.buffer, "color0")
        -- A new buffer holds whatever was in memory: everything past this
        -- frame's vertices is collapsed below, once.
        mesh.vertices = mesh.capacity
    end
    local position, normal, color = mesh.position, mesh.normal, mesh.color
    local p, n, c = geometry.p, geometry.n, geometry.c
    for i = 1, count * 3 do
        position[i] = p[i]
        normal[i] = n[i]
    end
    for i = 1, count * 4 do
        color[i] = c[i]
    end
    for i = count * 3 + 1, mesh.vertices * 3 do
        position[i] = 0
    end
    resource.set_buffer(mesh.res, mesh.buffer)
    mesh.vertices = count
end

return M
