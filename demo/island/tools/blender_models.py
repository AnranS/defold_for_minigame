"""Builds everything that stands or walks on the island in Blender and writes
it out as Lua data (island/models.lua).

Run:      Blender -b --factory-startup -P tools/blender_models.py
Preview:  ISLAND_PREVIEW=/tmp/models.png Blender -b --factory-startup -P tools/blender_models.py

A model lives in a cell: the ground is z = 0, the footprint stays inside
+-0.5, the front faces -Y (that becomes +z in the game, where y is up).
Models are put together from solids with chamfered, round-shaded edges,
lumpy balls for leaves and rocks, and lofted tubes and ribbons for anything
that bends.

Per vertex the game gets: position, normal, colour, a kind (0 plain, 0.25
sways in the wind, 0.6 never snowed on, 1 glows at night) and a material
(0 the colour as written, 1 tinted with a first colour, 2 with a second:
wall and roof, leaves and blossoms, shirt and hair).
"""

import math
import os
import pathlib

import bmesh
import bpy
from mathutils import Matrix, Vector, noise

ROOT = pathlib.Path(__file__).resolve().parent.parent
TARGET = ROOT / "island" / "models.lua"

TINT = (1.0, 1.0, 1.0)
STONE = (0.78, 0.77, 0.76)
STONE_DARK = (0.60, 0.60, 0.63)
DOOR = (0.55, 0.36, 0.25)
WINDOW = (1.0, 0.89, 0.55)
FRAME = (0.99, 0.98, 0.95)
WOOD = (0.76, 0.58, 0.40)
WOOD_DARK = (0.54, 0.40, 0.29)
BARK = (0.56, 0.42, 0.31)
RED = (0.90, 0.34, 0.30)
WHITE = (0.98, 0.97, 0.94)
DARK = (0.28, 0.27, 0.30)
WATER = (0.38, 0.68, 0.88)
GOLD = (0.99, 0.82, 0.36)
STRAW = (0.95, 0.83, 0.46)
SKIN = (1.0, 0.87, 0.76)
FLAME = (1.0, 0.60, 0.18)
ROCK = (0.68, 0.68, 0.71)
SNOW = (0.97, 0.98, 1.0)

NO_SNOW, SWAY, GLOW = 0.6, 0.25, 1.0

current = []


# ── solids ─────────────────────────────────────────────────────

def emit(bm, color, mat=0, kind=0.0, bevel=0.0, segments=1, sharp=42.0, gradient=None):
    """Chamfers, shades and stores one solid. gradient = (bottom, top) brightens it upwards."""
    if bevel > 0:
        bmesh.ops.bevel(bm, geom=list(bm.edges), offset=bevel, offset_type="OFFSET", segments=segments, profile=0.5,
                        affect="EDGES", clamp_overlap=True)
    bmesh.ops.triangulate(bm, faces=bm.faces[:])
    bm.normal_update()
    mesh = bpy.data.meshes.new("part")
    bm.to_mesh(mesh)
    bm.free()
    mesh.shade_smooth()
    mesh.set_sharp_from_angle(angle=math.radians(sharp))
    mesh.calc_loop_triangles()
    normals = mesh.corner_normals
    low = min(v.co.z for v in mesh.vertices)
    high = max(v.co.z for v in mesh.vertices)
    span = max(high - low, 1e-6)
    for tri in mesh.loop_triangles:
        for loop_index in tri.loops:
            co = mesh.vertices[mesh.loops[loop_index].vertex_index].co
            n = normals[loop_index].vector
            shade = 1.0
            if gradient:
                shade = gradient[0] + (gradient[1] - gradient[0]) * (co.z - low) / span
            # Blender is z-up with the front at -y; the game is y-up with the front at +z.
            current.append([co.x, co.z, -co.y, n.x, n.z, -n.y, color[0] * shade, color[1] * shade, color[2] * shade, kind, mat])
    bpy.data.meshes.remove(mesh)


def moved(bm, matrix):
    bmesh.ops.transform(bm, matrix=matrix, verts=bm.verts[:])
    return bm


def box(center, size, color, mat=0, kind=0.0, bevel=0.015, segments=1, rot_x=0.0, rot_y=0.0, rot_z=0.0, gradient=None):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    m = Matrix.Translation(Vector(center)) @ Matrix.Rotation(rot_z, 4, "Z") @ Matrix.Rotation(rot_y, 4, "Y") \
        @ Matrix.Rotation(rot_x, 4, "X") @ Matrix.Diagonal((size[0], size[1], size[2], 1.0))
    emit(moved(bm, m), color, mat, kind, bevel, segments, gradient=gradient)


def tube(base, r0, r1, height, color, sides=14, mat=0, kind=0.0, bevel=0.0, sharp=50.0, cap=True, gradient=None,
         rot_x=0.0, rot_y=0.0):
    """A cylinder, a tapered tower (r1 < r0) or a cone (r1 = 0) standing on `base`; rot_* lay it down."""
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=cap, cap_tris=False, segments=sides, radius1=r0, radius2=max(r1, 0.0001), depth=height)
    m = Matrix.Translation(Vector(base)) @ Matrix.Rotation(rot_y, 4, "Y") @ Matrix.Rotation(rot_x, 4, "X") \
        @ Matrix.Translation(Vector((0, 0, height / 2)))
    emit(moved(bm, m), color, mat, kind, bevel, 1, sharp, gradient)


def ball(center, radius, color, squash=(1, 1, 1), mat=0, kind=0.0, detail=None, gradient=None):
    bm = bmesh.new()
    if detail is None:
        detail = 1 if radius < 0.05 else 2
    bmesh.ops.create_icosphere(bm, subdivisions=detail, radius=radius)
    emit(moved(bm, Matrix.Translation(Vector(center)) @ Matrix.Diagonal((squash[0], squash[1], squash[2], 1.0))),
         color, mat, kind, 0, 1, 80, gradient)


def lump(center, radius, color, squash=(1, 1, 1), seed=0.0, amount=0.16, freq=2.3, detail=2, mat=0, kind=0.0,
         sharp=80.0, gradient=(0.82, 1.08)):
    """A ball pushed in and out by noise: a tree crown, a bush, a rock."""
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=detail, radius=1.0)
    offset = Vector((seed * 7.13, seed * 3.31, seed * 1.77))
    for v in bm.verts:
        v.co *= 1 + noise.noise(v.co * freq + offset) * amount
    emit(moved(bm, Matrix.Translation(Vector(center)) @ Matrix.Diagonal((radius * squash[0], radius * squash[1], radius * squash[2], 1.0))),
         color, mat, kind, 0, 1, sharp, gradient)


def prism(profile, x0, x1, color, mat=0, kind=0.0, bevel=0.02, segments=1, gradient=None, sharp=42.0):
    """A shape drawn in the y-z plane and pulled from x0 to x1."""
    bm = bmesh.new()
    near = [bm.verts.new((x0, y, z)) for y, z in profile]
    far = [bm.verts.new((x1, y, z)) for y, z in profile]
    bm.faces.new(near)
    bm.faces.new(list(reversed(far)))
    count = len(profile)
    for i in range(count):
        j = (i + 1) % count
        bm.faces.new((near[j], near[i], far[i], far[j]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    emit(bm, color, mat, kind, bevel, segments, sharp, gradient)


def plate(profile, y0, y1, color, mat=0, kind=0.0, bevel=0.0, turn=0.0, at=(0, 0, 0), sharp=42.0, flat=False):
    """A shape drawn in the x-z plane, y0 to y1 thick: doors, arched windows, signs. `turn` spins it
    about z. flat: only the face at y0, for what lies on a wall and is never seen from behind."""
    bm = bmesh.new()
    near = [bm.verts.new((x, y0, z)) for x, z in profile]
    front = bm.faces.new(near)
    if flat:
        if front.normal.y > 0:
            front.normal_flip()
    else:
        far = [bm.verts.new((x, y1, z)) for x, z in profile]
        bm.faces.new(list(reversed(far)))
        count = len(profile)
        for i in range(count):
            j = (i + 1) % count
            bm.faces.new((near[j], near[i], far[i], far[j]))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    emit(moved(bm, Matrix.Translation(Vector(at)) @ Matrix.Rotation(turn, 4, "Z")), color, mat, kind, bevel, 1, sharp)


def disc(radius, steps=10):
    """Outline of a round window or a clock face, centred on z = 0."""
    return [(radius * math.cos(i / steps * math.tau), radius * math.sin(i / steps * math.tau)) for i in range(steps)]


def arch(width, height, steps=4):
    """Outline of a door or window with a round top, standing on z = 0."""
    r = width / 2
    points = [(-r, 0.0), (r, 0.0)]
    for i in range(steps + 1):
        a = i / steps * math.pi
        points.append((r * math.cos(a), height - r + r * math.sin(a)))
    return points


def pipe(points, radii, color, sides=8, mat=0, kind=0.0, sharp=70.0, gradient=None, cap=True):
    """A tube that follows a path and changes thickness: trunks, branches, rails, ropes."""
    bm = bmesh.new()
    path = [Vector(p) for p in points]
    rings = []
    a = None
    for i, p in enumerate(path):
        tangent = (path[min(i + 1, len(path) - 1)] - path[max(i - 1, 0)]).normalized()
        if a is None:
            ref = Vector((0, 0, 1)) if abs(tangent.z) < 0.92 else Vector((1, 0, 0))
            a = tangent.cross(ref).normalized()
        else:
            # Carry the ring's orientation along the path, so the tube does not twist.
            a = (a - tangent * a.dot(tangent)).normalized()
        b = tangent.cross(a).normalized()
        rings.append([bm.verts.new(p + (a * math.cos(t / sides * math.tau) + b * math.sin(t / sides * math.tau)) * radii[i])
                      for t in range(sides)])
    for r0, r1 in zip(rings, rings[1:]):
        for t in range(sides):
            u = (t + 1) % sides
            bm.faces.new((r0[t], r0[u], r1[u], r1[t]))
    if cap:
        bm.faces.new(list(reversed(rings[0])))
        bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    emit(bm, color, mat, kind, 0, 1, sharp, gradient)


def ribbon(left, right, color, mat=0, kind=0.0, sharp=80.0, gradient=None):
    """A band between two paths: a leaf, a sail, a flag."""
    bm = bmesh.new()
    a = [bm.verts.new(p) for p in left]
    b = [bm.verts.new(p) for p in right]
    for i in range(len(a) - 1):
        bm.faces.new((a[i], b[i], b[i + 1], a[i + 1]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    emit(bm, color, mat, kind, 0, 1, sharp, gradient)


def spun(profile, color, sides=14, mat=0, kind=0.0, sharp=50.0, at=(0, 0, 0), gradient=None):
    """A shape turned on a lathe: profile is a list of (radius, z) from the bottom up."""
    bm = bmesh.new()
    rings = []
    for radius, z in profile:
        rings.append([bm.verts.new((at[0] + math.cos(t / sides * math.tau) * radius, at[1] + math.sin(t / sides * math.tau) * radius, at[2] + z))
                      for t in range(sides)])
    for r0, r1 in zip(rings, rings[1:]):
        for t in range(sides):
            u = (t + 1) % sides
            bm.faces.new((r0[t], r0[u], r1[u], r1[t]))
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])
    bmesh.ops.remove_doubles(bm, verts=bm.verts[:], dist=1e-5)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    emit(bm, color, mat, kind, 0, 1, sharp, gradient)


# ── parts of buildings ─────────────────────────────────────────

def tiled_roof(x0, x1, half_depth, eave, ridge, thickness=0.055, rows=5):
    """Rows of tiles down both sides, each lying a little flatter than the slope so its
    lower edge stands out; a ridge cap; white boards along the gable ends."""
    run, rise = half_depth, ridge - eave
    length = math.hypot(run, rise)
    angle = math.atan2(rise, run)
    step = length / rows
    for side in (-1, 1):
        for row in range(rows):
            along = (row + 0.5) * step
            cy = side * along * math.cos(angle)
            cz = ridge - along * math.sin(angle) + thickness * 0.5
            shade = 1.0 if row % 2 == 0 else 0.92
            box(((x0 + x1) / 2, cy, cz), (x1 - x0, step + 0.04, thickness), (shade, shade, shade), mat=2,
                bevel=0, rot_x=-side * (angle - 0.1))
    tube(((x0 + x1) / 2 - (x1 - x0 + 0.03) / 2, 0, ridge + thickness * 0.75), 0.042, 0.042, x1 - x0 + 0.03, (0.84, 0.84, 0.84),
         sides=6, mat=2, rot_y=math.pi / 2, sharp=60)


def barge_boards(x, half_depth, eave, ridge):
    """The white boards that close a gable end under the tiles."""
    run, rise = half_depth, ridge - eave
    angle = math.atan2(rise, run)
    length = math.hypot(run, rise)
    for side in (-1, 1):
        box((x, side * run / 2, eave + rise / 2 - 0.012), (0.03, length + 0.02, 0.05), FRAME, bevel=0, rot_x=-side * angle)


def window(x, y, z, facing, width=0.13, height=0.16, shutters=True, arched=True, sill=True):
    """A lit pane in a white frame, with shutters in the roof's colour. z is the sill.
    facing: 'front', 'back', 'left', 'right'."""
    turn = {"front": 0.0, "right": math.pi / 2, "back": math.pi, "left": -math.pi / 2}[facing]
    at = (x, y, z)

    def rect(x0, z0, x1, z1):
        return [(x0, z0), (x1, z0), (x1, z1), (x0, z1)]
    outline = arch(width, height) if arched else rect(-width / 2, 0, width / 2, height)
    outer = arch(width + 0.05, height + 0.03) if arched else rect(-width / 2 - 0.025, -0.01, width / 2 + 0.025, height + 0.025)
    plate(outer, -0.02, 0.0, FRAME, at=at, turn=turn)
    plate(outline, -0.026, 0.0, WINDOW, kind=GLOW, at=at, turn=turn, flat=True)
    plate(rect(-0.007, 0.0, 0.007, height - 0.012), -0.03, 0.0, FRAME, at=at, turn=turn, flat=True)
    if sill:
        plate(rect(-width / 2 - 0.045, -0.025, width / 2 + 0.045, 0.0), -0.055, 0.0, FRAME, at=at, turn=turn)
    if shutters:
        for side in (-1, 1):
            cx = side * (width / 2 + 0.052)
            plate(rect(cx - 0.028, 0.005, cx + 0.028, height - 0.02), -0.016, 0.0, (0.82, 0.82, 0.82), mat=2, at=at, turn=turn)


def door(x, y, z0, width=0.16, height=0.29, turn=0.0, lantern=True):
    at = (x, y, z0)
    plate(arch(width + 0.055, height + 0.03), -0.026, 0.0, FRAME, at=at, turn=turn)
    plate(arch(width, height), -0.034, 0.0, DOOR, at=at, turn=turn, flat=True)
    plate([(-0.004, 0.0), (0.004, 0.0), (0.004, height - 0.05), (-0.004, height - 0.05)], -0.037, 0.0, WOOD_DARK, at=at, turn=turn, flat=True)
    c, s = math.cos(turn), math.sin(turn)

    def world(lx, ly, lz):
        return (x + lx * c - ly * s, y + lx * s + ly * c, z0 + lz)
    box(world(width * 0.26, -0.042, height * 0.42), (0.02, 0.016, 0.02), GOLD, bevel=0, rot_z=turn)
    box(world(0, -0.1, 0.014), (width + 0.14, 0.16, 0.032), STONE, bevel=0, rot_z=turn)
    if lantern:
        box(world(width / 2 + 0.065, -0.03, height - 0.02), (0.035, 0.035, 0.05), WINDOW, kind=GLOW, bevel=0, rot_z=turn)
        tube(world(width / 2 + 0.065, -0.03, height + 0.005), 0.03, 0.0, 0.025, DARK, sides=4, cap=False)


def flower_box(x, y, z, turn=0.0):
    c, s = math.cos(turn), math.sin(turn)

    def world(lx, ly, lz):
        return (x + lx * c - ly * s, y + lx * s + ly * c, z + lz)
    box(world(0, -0.05, 0), (0.2, 0.055, 0.045), WOOD, bevel=0, rot_z=turn)
    for i, color in enumerate(((0.97, 0.47, 0.52), (1.0, 0.87, 0.42), (0.97, 0.47, 0.52), (0.98, 0.98, 0.96))):
        spun([(0.0, 0.0), (0.026, 0.02), (0.0, 0.045)], color, sides=5, kind=SWAY, sharp=80, at=world(-0.072 + i * 0.048, -0.05, 0.02))
    for i in range(3):
        spun([(0.0, 0.0), (0.024, 0.016), (0.0, 0.036)], (0.42, 0.68, 0.36), sides=4, kind=SWAY, sharp=80, at=world(-0.05 + i * 0.05, -0.064, 0.012))


def house(x0, x1, left_open, right_open):
    """A cottage whose ridge runs along x. An open side continues into the neighbour."""
    half, floor, eave, ridge = 0.37, 0.06, 0.52, 0.88
    over_l, over_r = (0.0 if left_open else 0.09), (0.0 if right_open else 0.09)
    width = x1 - x0
    box(((x0 + x1) / 2, 0, floor / 2), (width + (0.0 if left_open and right_open else 0.07), 0.84, floor), STONE, bevel=0.014)
    profile = [(-half, floor), (half, floor), (half, eave), (0.0, ridge), (-half, eave)]
    prism(profile, x0, x1, TINT, mat=1, bevel=0.03, gradient=(0.88, 1.02))
    tiled_roof(x0 - over_l, x1 + over_r, half + 0.1, eave - 0.075, ridge + 0.02)
    if not left_open:
        barge_boards(x0 - over_l - 0.012, half + 0.1, eave - 0.075, ridge + 0.02)
    if not right_open:
        barge_boards(x1 + over_r + 0.012, half + 0.1, eave - 0.075, ridge + 0.02)
    door(0.0, -half, floor)
    window(-0.235, -half, 0.25, "front")
    window(0.235, -half, 0.25, "front")
    flower_box(-0.235, -half, 0.225)
    window(-0.15, half, 0.25, "back", shutters=False, arched=False, sill=False)
    window(0.15, half, 0.25, "back", shutters=False, arched=False, sill=False)
    if not left_open:
        window(x0, 0.0, 0.25, "left", shutters=False)
        plate(disc(0.055, 8), -0.012, 0.0, FRAME, at=(x0, 0, 0.66), turn=-math.pi / 2, flat=True)
        plate(disc(0.04, 8), -0.016, 0.0, WINDOW, kind=GLOW, at=(x0, 0, 0.66), turn=-math.pi / 2, flat=True)
    if not right_open:
        window(x1, 0.0, 0.25, "right", shutters=False)
        plate(disc(0.055, 8), -0.012, 0.0, FRAME, at=(x1, 0, 0.66), turn=math.pi / 2, flat=True)
        plate(disc(0.04, 8), -0.016, 0.0, WINDOW, kind=GLOW, at=(x1, 0, 0.66), turn=math.pi / 2, flat=True)


# ── the models ─────────────────────────────────────────────────

MODELS = {}


def model(name, build, grounded=True):
    """Builds a model. A grounded model gets a little darker towards its feet,
    which is what makes it sit on the ground instead of floating over it."""
    global current
    current = []
    build()
    if grounded:
        for v in current:
            if v[9] < 0.9:      # not the parts that glow
                t = max(0.0, min(1.0, v[1] / 0.26))
                shade = 0.78 + 0.22 * t * t * (3 - 2 * t)
                v[6], v[7], v[8] = v[6] * shade, v[7] * shade, v[8] * shade
    MODELS[name] = current
    print(f"{name}: {len(current)} vertices")


def buildings():
    model("house_single", lambda: house(-0.37, 0.37, False, False))
    model("house_end", lambda: house(-0.37, 0.5, False, True))       # joined on its right (+x)
    model("house_mid", lambda: house(-0.5, 0.5, True, True))

    def chimney():
        box((0.0, 0.0, 0.17), (0.12, 0.12, 0.34), (0.86, 0.60, 0.50), bevel=0.014)
        box((0.0, 0.0, 0.35), (0.155, 0.155, 0.04), STONE_DARK, bevel=0.012)
        tube((0.0, 0.0, 0.37), 0.035, 0.03, 0.05, DARK, sides=8)
    model("chimney", chimney, grounded=False)

    def dock():
        # Starts at the house wall and runs out over the water.
        for i in range(8):
            box((0.0, -0.42 - i * 0.105, 0.105), (0.36, 0.095, 0.03), WOOD if i % 2 == 0 else (0.71, 0.53, 0.36), bevel=0)
        for x in (-0.16, 0.16):
            for y in (-0.78, -1.2):
                tube((x, y, -0.75), 0.034, 0.03, 1.02, WOOD_DARK, sides=6)
        pipe([(-0.16, -1.2, 0.2), (-0.05, -1.22, 0.15), (0.05, -1.22, 0.15), (0.16, -1.2, 0.2)], [0.008] * 4, WHITE, sides=5)
        spun([(0.0, 0.0), (0.045, 0.01), (0.05, 0.05), (0.0, 0.07)], RED, sides=8, at=(0.24, -1.05, -0.02))
    model("dock", dock, grounded=False)

    def shop():
        box((0, 0, 0.03), (0.86, 0.84, 0.06), STONE, bevel=0.014)
        box((0, 0.03, 0.3), (0.76, 0.7, 0.5), TINT, mat=1, bevel=0.03, gradient=(0.88, 1.02))
        box((0, 0.03, 0.57), (0.84, 0.78, 0.06), (0.95, 0.95, 0.95), mat=2, bevel=0.018)
        box((0, 0.03, 0.615), (0.7, 0.64, 0.05), (0.8, 0.8, 0.8), mat=2, bevel=0.014)
        # A striped awning with a scalloped edge over a wide window.
        for i in range(6):
            color = RED if i % 2 == 0 else WHITE
            box((-0.3 + i * 0.12, -0.44, 0.41), (0.118, 0.26, 0.022), color, bevel=0, rot_x=-0.36)
            tube((-0.3 + i * 0.12 - 0.059, -0.555, 0.362), 0.03, 0.03, 0.118, color, sides=6, rot_y=math.pi / 2, sharp=60, cap=False)
        plate([(-0.34, 0.0), (0.08, 0.0), (0.08, 0.2), (-0.34, 0.2)], -0.03, -0.02, WINDOW, kind=GLOW, at=(0, -0.32, 0.12))
        plate([(-0.37, -0.02), (0.11, -0.02), (0.11, 0.225), (-0.37, 0.225)], -0.022, 0.0, FRAME, at=(0, -0.32, 0.12))
        box((-0.13, -0.36, 0.11), (0.5, 0.06, 0.025), WOOD, bevel=0.008)
        door(0.25, -0.32, 0.06, width=0.14, height=0.27, lantern=False)
        box((0.0, -0.375, 0.6), (0.36, 0.035, 0.11), WOOD, bevel=0.014)
        box((0.0, -0.396, 0.6), (0.3, 0.01, 0.065), GOLD, kind=GLOW, bevel=0)
        box((-0.35, -0.5, 0.065), (0.12, 0.12, 0.12), WOOD, bevel=0)
        box((-0.34, -0.5, 0.165), (0.1, 0.1, 0.08), WOOD_DARK, bevel=0)
        spun([(0.045, 0.0), (0.058, 0.05), (0.05, 0.1), (0.0, 0.1)], WOOD_DARK, sides=7, at=(0.38, -0.47, 0.0))
        lump((0.38, -0.47, 0.15), 0.07, (0.42, 0.70, 0.38), seed=3, detail=1, kind=SWAY)
    model("shop", shop)

    def pavilion():
        tube((0, 0, 0), 0.45, 0.43, 0.05, STONE, sides=12, bevel=0.012)
        for i in range(6):
            a = i / 6 * math.tau + math.pi / 6
            x, y = math.cos(a) * 0.34, math.sin(a) * 0.34
            tube((x, y, 0.05), 0.03, 0.024, 0.44, WOOD_DARK, sides=6)
            if i != 4:      # the gap is the way in
                b = (i + 1) / 6 * math.tau + math.pi / 6
                pipe([(x, y, 0.2), (math.cos(b) * 0.34, math.sin(b) * 0.34, 0.2)], [0.012, 0.012], WOOD, sides=4)
        spun([(0.52, 0.0), (0.5, 0.03), (0.3, 0.13), (0.2, 0.2), (0.21, 0.22), (0.1, 0.34), (0.03, 0.4), (0.0, 0.41)],
             TINT, sides=10, mat=2, sharp=35, at=(0, 0, 0.47), gradient=(0.9, 1.05))
        ball((0, 0, 0.9), 0.035, GOLD, kind=GLOW, detail=1)
        tube((0, 0, 0.05), 0.13, 0.13, 0.1, WOOD, sides=10, bevel=0.01)
    model("pavilion", pavilion)

    def tower():
        box((0, 0, 0.04), (0.64, 0.64, 0.08), STONE, bevel=0.014)
        box((0, 0, 0.63), (0.5, 0.5, 1.12), TINT, mat=1, bevel=0.035, gradient=(0.86, 1.02))
        box((0, 0, 1.2), (0.6, 0.6, 0.06), STONE, bevel=0.016)
        spun([(0.4, 0.0), (0.38, 0.03), (0.2, 0.26), (0.08, 0.42), (0.0, 0.5)], TINT, sides=4, mat=2, sharp=30, at=(0, 0, 1.23))
        ball((0, 0, 1.75), 0.03, GOLD, kind=GLOW, detail=1)
        for facing, (x, y, turn) in {"front": (0, -0.25, 0.0), "right": (0.25, 0, math.pi / 2),
                                     "back": (0, 0.25, math.pi), "left": (-0.25, 0, -math.pi / 2)}.items():
            plate(disc(0.13, 12), -0.014, 0.0, FRAME, kind=GLOW, at=(x, y, 0.99), turn=turn, flat=True)
            plate([(-0.006, 0.0), (0.006, 0.0), (0.006, 0.08), (-0.006, 0.08)], -0.018, 0.0, DARK, at=(x, y, 0.99), turn=turn, flat=True)
            plate([(0.0, -0.006), (0.06, -0.006), (0.06, 0.006), (0.0, 0.006)], -0.018, 0.0, DARK, at=(x, y, 0.99), turn=turn, flat=True)
            window(x, y, 0.5, facing, width=0.1, height=0.2, shutters=False)
        door(0.0, -0.25, 0.08, width=0.14, height=0.27, lantern=False)
    model("tower", tower)

    def windmill():
        tube((0, 0, 0), 0.36, 0.34, 0.06, STONE, sides=14, bevel=0.012)
        spun([(0.31, 0.0), (0.3, 0.1), (0.23, 0.7), (0.21, 0.86), (0.0, 0.86)], TINT, sides=12, mat=1, at=(0, 0, 0.06), gradient=(0.86, 1.03))
        tube((0, 0, 0.52), 0.3, 0.3, 0.025, WOOD_DARK, sides=12)
        spun([(0.27, 0.0), (0.25, 0.08), (0.16, 0.2), (0.05, 0.27), (0.0, 0.28)], TINT, sides=12, mat=2, sharp=35, at=(0, 0, 0.9))
        door(0.0, -0.3, 0.06, width=0.13, height=0.25, lantern=False)
        window(0.0, -0.255, 0.6, "front", width=0.08, height=0.12, shutters=False)
        tube((0, -0.2, 0.88), 0.035, 0.035, 0.16, WOOD_DARK, sides=10, rot_x=math.pi / 2, sharp=60)
    model("windmill", windmill)

    def blades():
        # Turns about the game's z axis (Blender's y): four sails on a hub.
        tube((0, 0.03, 0), 0.05, 0.045, 0.06, WOOD_DARK, sides=10, rot_x=math.pi / 2, sharp=60)
        for i in range(4):
            a = i * math.pi / 2
            c, s = math.cos(a), math.sin(a)

            def at(u, w, y=0.0):      # u along the arm, w across it
                return (u * c - w * s, y, u * s + w * c)
            pipe([at(0.03, 0), at(0.6, 0)], [0.016, 0.012], WOOD_DARK, sides=5)
            ribbon([at(0.14, 0.012, -0.012), at(0.58, 0.012, -0.012)], [at(0.14, 0.15, -0.03), at(0.58, 0.15, -0.03)], WHITE)
            for u in (0.14, 0.29, 0.44, 0.58):
                pipe([at(u, 0.0, -0.006), at(u, 0.155, -0.03)], [0.007, 0.007], WOOD, sides=4)
            pipe([at(0.14, 0.155, -0.03), at(0.58, 0.155, -0.03)], [0.007, 0.007], WOOD, sides=4)
    model("blades", blades, grounded=False)

    def lighthouse():
        tube((0, 0, 0), 0.33, 0.31, 0.06, STONE, sides=12, bevel=0.012)
        spun([(0.275, 0.0), (0.25, 0.5), (0.0, 0.5)], WHITE, sides=12, at=(0, 0, 0.06), gradient=(0.88, 1.0))
        spun([(0.25, 0.0), (0.222, 0.5), (0.0, 0.5)], RED, sides=12, at=(0, 0, 0.56))
        spun([(0.222, 0.0), (0.195, 0.44), (0.0, 0.44)], WHITE, sides=12, at=(0, 0, 1.06))
        tube((0, 0, 1.5), 0.3, 0.3, 0.04, STONE, sides=12)
        for i in range(8):
            a = i / 8 * math.tau
            tube((math.cos(a) * 0.28, math.sin(a) * 0.28, 1.54), 0.01, 0.01, 0.1, DARK, sides=4, cap=False)
        ring = [(math.cos(i / 12 * math.tau) * 0.28, math.sin(i / 12 * math.tau) * 0.28, 1.64) for i in range(13)]
        pipe(ring, [0.01] * 13, DARK, sides=4, cap=False)
        tube((0, 0, 1.54), 0.14, 0.14, 0.22, WINDOW, sides=12, kind=GLOW)
        spun([(0.21, 0.0), (0.19, 0.04), (0.08, 0.16), (0.0, 0.2)], RED, sides=12, sharp=35, at=(0, 0, 1.76))
        ball((0, 0, 1.99), 0.03, GOLD, kind=GLOW, detail=1)
        door(0.0, -0.27, 0.06, width=0.13, height=0.25, lantern=False)
        window(0.0, -0.236, 0.78, "front", width=0.08, height=0.13, shutters=False)
        window(0.0, -0.208, 1.22, "front", width=0.07, height=0.11, shutters=False)
    model("lighthouse", lighthouse)


def plants():
    def tree_round():
        pipe([(0, 0, -0.02), (0.01, 0, 0.12), (0.0, 0.01, 0.34), (-0.02, 0.0, 0.52)], [0.1, 0.062, 0.05, 0.04], BARK, sides=8, gradient=(0.85, 1.05))
        pipe([(0.0, 0.0, 0.36), (0.14, 0.02, 0.5)], [0.035, 0.02], BARK, sides=6)
        pipe([(0.0, 0.0, 0.3), (-0.13, -0.04, 0.44)], [0.032, 0.02], BARK, sides=6)
        lump((0.0, 0.0, 0.82), 0.34, TINT, squash=(1.0, 1.0, 0.92), seed=1, mat=1, kind=SWAY)
        lump((0.24, 0.05, 0.62), 0.22, TINT, seed=2, mat=1, kind=SWAY, detail=1, gradient=(0.78, 1.0))
        lump((-0.22, -0.08, 0.6), 0.21, TINT, seed=3, mat=1, kind=SWAY, detail=1, gradient=(0.78, 1.0))
        lump((0.02, 0.22, 0.66), 0.2, TINT, seed=4, mat=1, kind=SWAY, detail=1, gradient=(0.76, 0.98))
    model("tree_round", tree_round)

    def tree_pine():
        pipe([(0, 0, -0.02), (0, 0, 0.3)], [0.075, 0.05], BARK, sides=8, gradient=(0.85, 1.05))
        # Tiers that widen downwards and droop at the rim.
        for z, radius, height in ((0.2, 0.38, 0.36), (0.42, 0.31, 0.34), (0.63, 0.24, 0.32), (0.83, 0.16, 0.3)):
            spun([(radius * 0.86, -0.03), (radius, 0.0), (radius * 0.55, height * 0.42), (radius * 0.18, height * 0.82), (0.0, height)],
                 TINT, sides=10, mat=1, kind=SWAY, sharp=40, at=(0, 0, z), gradient=(0.8, 1.06))
    model("tree_pine", tree_pine)

    def tree_blossom():
        pipe([(0, 0, -0.02), (0.02, 0.0, 0.14), (-0.01, 0.01, 0.34)], [0.085, 0.055, 0.045], BARK, sides=8, gradient=(0.85, 1.05))
        pipe([(-0.01, 0.01, 0.32), (0.17, 0.02, 0.52), (0.26, 0.0, 0.62)], [0.04, 0.028, 0.018], BARK, sides=6)
        pipe([(-0.01, 0.01, 0.3), (-0.15, -0.03, 0.5), (-0.23, -0.02, 0.62)], [0.04, 0.028, 0.018], BARK, sides=6)
        pipe([(-0.01, 0.01, 0.34), (0.0, 0.1, 0.56)], [0.035, 0.018], BARK, sides=6)
        for i, (x, y, z, r) in enumerate(((0.27, 0.0, 0.74, 0.22), (-0.25, -0.03, 0.74, 0.22), (0.0, 0.12, 0.84, 0.25),
                                          (0.04, -0.14, 0.7, 0.19), (-0.06, 0.02, 0.98, 0.17))):
            lump((x, y, z), r, TINT, squash=(1.0, 1.0, 0.86), seed=10 + i, mat=1, kind=SWAY, detail=2 if i == 2 else 1)
    model("tree_blossom", tree_blossom)

    def palm():
        trunk = [(0.0, 0.0, -0.02), (0.02, 0.0, 0.2), (0.06, 0.0, 0.42), (0.12, 0.0, 0.62), (0.2, 0.0, 0.8), (0.27, 0.0, 0.92)]
        pipe(trunk, [0.075, 0.06, 0.052, 0.046, 0.04, 0.036], (0.72, 0.58, 0.42), sides=8, gradient=(0.85, 1.05))
        top = Vector((0.27, 0.0, 0.93))
        for i in range(7):
            a = i / 7 * math.tau + 0.3
            out = Vector((math.cos(a), math.sin(a), 0.0))
            side = Vector((-math.sin(a), math.cos(a), 0.0))
            spine, edge_a, edge_b = [], [], []
            for k in range(6):
                t = k / 5
                p = top + out * (0.08 + 0.5 * t) + Vector((0, 0, 0.14 * math.sin(t * math.pi * 0.75) - 0.3 * t * t))
                w = 0.075 * math.sin(max(0.06, t) * math.pi) ** 0.6 * (1.1 - 0.5 * t)
                spine.append(p)
                edge_a.append(p + side * w - Vector((0, 0, w * 0.7)))
                edge_b.append(p - side * w - Vector((0, 0, w * 0.7)))
            ribbon(spine, edge_a, TINT, mat=1, kind=SWAY, gradient=(0.82, 1.05))
            ribbon(edge_b, spine, TINT, mat=1, kind=SWAY, gradient=(0.82, 1.05))
        for i in range(3):
            a = i / 3 * math.tau
            ball((top.x + math.cos(a) * 0.05, math.sin(a) * 0.05, top.z - 0.05), 0.04, (0.56, 0.40, 0.28), detail=1)
    model("palm", palm)

    def bush():
        lump((0.0, 0.0, 0.14), 0.24, TINT, squash=(1.0, 1.0, 0.72), seed=20, mat=1, kind=SWAY)
        lump((0.19, 0.07, 0.1), 0.15, TINT, squash=(1.0, 1.0, 0.8), seed=21, mat=1, kind=SWAY, detail=1)
        lump((-0.16, -0.1, 0.09), 0.14, TINT, squash=(1.0, 1.0, 0.8), seed=22, mat=1, kind=SWAY, detail=1)
        for x, y, z in ((0.08, -0.16, 0.2), (-0.1, 0.08, 0.27), (0.2, 0.02, 0.2), (-0.04, -0.2, 0.14), (0.02, 0.18, 0.2)):
            spun([(0.0, 0.0), (0.03, 0.022), (0.0, 0.05)], TINT, sides=5, mat=2, kind=SWAY, sharp=80, at=(x, y, z - 0.02))
    model("bush", bush)

    # Small things that grow out of a painted cell: light on vertices, there are many of them.
    def wheat():
        for i, (x, y, lean) in enumerate(((0.0, 0.0, 0.02), (0.07, 0.04, -0.03), (-0.06, 0.05, 0.035), (0.02, -0.07, -0.015))):
            top = (x + lean, y + lean * 0.5, 0.2)
            ribbon([(x - 0.007, y, 0.0), (top[0] - 0.004, top[1], top[2])], [(x + 0.007, y, 0.0), (top[0] + 0.004, top[1], top[2])],
                   (0.86, 0.92, 0.8), mat=1, kind=SWAY)
            tube((top[0], top[1], top[2] - 0.02), 0.02, 0.0, 0.085, TINT, sides=5, mat=1, kind=SWAY, cap=False, sharp=70)
        ribbon([(-0.01, 0.0, 0.0), (-0.06, -0.03, 0.1), (-0.1, -0.05, 0.08)], [(0.01, 0.0, 0.0), (-0.04, -0.045, 0.1), (-0.1, -0.05, 0.08)],
               (0.8, 0.9, 0.7), mat=1, kind=SWAY)
    model("wheat", wheat, grounded=False)

    def lavender():
        lump((0.0, 0.0, 0.035), 0.075, (0.52, 0.68, 0.44), squash=(1.0, 1.0, 0.6), seed=30, detail=1, kind=SWAY)
        for x, y, lean in ((0.0, 0.0, 0.0), (0.05, 0.03, 0.03), (-0.05, 0.02, -0.03), (0.01, -0.05, 0.01), (-0.02, 0.055, -0.01)):
            top = (x + lean, y + lean * 0.5, 0.13)
            ribbon([(x - 0.004, y, 0.03), (top[0] - 0.003, top[1], top[2])], [(x + 0.004, y, 0.03), (top[0] + 0.003, top[1], top[2])],
                   (0.52, 0.68, 0.44), kind=SWAY)
            tube((top[0], top[1], top[2] - 0.015), 0.017, 0.0, 0.09, TINT, sides=5, mat=1, kind=SWAY, cap=False, sharp=70)
    model("lavender", lavender, grounded=False)

    def flower():
        ribbon([(-0.005, 0.0, 0.0), (-0.003, 0.01, 0.1)], [(0.005, 0.0, 0.0), (0.003, 0.01, 0.1)], (0.45, 0.70, 0.40), kind=SWAY)
        ribbon([(0.0, 0.0, 0.02), (0.03, 0.01, 0.05)], [(0.0, 0.012, 0.02), (0.03, 0.02, 0.045)], (0.45, 0.70, 0.40), kind=SWAY)
        spun([(0.0, 0.0), (0.03, 0.006), (0.046, 0.016), (0.03, 0.02), (0.0, 0.012)], TINT, sides=5, mat=1, kind=SWAY, sharp=80, at=(0, 0.01, 0.095))
        spun([(0.0, 0.0), (0.014, 0.008), (0.0, 0.016)], (1.0, 0.86, 0.36), sides=4, kind=SWAY, sharp=80, at=(0, 0.01, 0.108))
    model("flower", flower, grounded=False)

    def grass():
        for i, (x, y, lean, h) in enumerate(((0.0, 0.0, 0.03, 0.1), (0.03, 0.02, -0.02, 0.075), (-0.03, 0.01, -0.035, 0.085),
                                             (0.01, -0.03, 0.02, 0.065), (-0.015, 0.035, 0.0, 0.09))):
            ribbon([(x - 0.009, y, 0.0), (x + lean * 0.5 - 0.005, y, h * 0.6), (x + lean, y, h)],
                   [(x + 0.009, y, 0.0), (x + lean * 0.5 + 0.005, y, h * 0.6), (x + lean, y, h)], TINT, mat=1, kind=SWAY, gradient=(0.85, 1.08))
    model("grass", grass, grounded=False)


def props():
    def bench():
        for i in range(3):
            box((0, -0.05 + i * 0.062, 0.15), (0.54, 0.052, 0.024), WOOD, bevel=0)
        for i in range(2):
            box((0, 0.11, 0.245 + i * 0.072), (0.54, 0.022, 0.058), WOOD, bevel=0, rot_x=0.12)
        for x in (-0.23, 0.23):
            pipe([(x, -0.07, 0.0), (x, -0.07, 0.14), (x, 0.1, 0.14), (x, 0.13, 0.34)], [0.016] * 4, DARK, sides=4)
            pipe([(x, 0.08, 0.0), (x, 0.08, 0.14)], [0.016, 0.016], DARK, sides=4)
    model("bench", bench)

    def lamp():
        spun([(0.06, 0.0), (0.05, 0.03), (0.025, 0.06), (0.018, 0.1), (0.016, 0.66), (0.03, 0.7), (0.0, 0.7)], DARK, sides=7)
        spun([(0.045, 0.0), (0.062, 0.11), (0.0, 0.11)], WINDOW, sides=8, kind=GLOW, at=(0, 0, 0.71))
        spun([(0.09, 0.0), (0.07, 0.02), (0.02, 0.07), (0.0, 0.09)], DARK, sides=8, sharp=35, at=(0, 0, 0.82))
        ball((0, 0, 0.92), 0.014, DARK, detail=1)
    model("lamp", lamp)

    def mailbox():
        pipe([(0, 0, 0), (0, 0, 0.3)], [0.024, 0.02], WOOD_DARK, sides=8)
        box((0, 0, 0.36), (0.17, 0.12, 0.13), RED, bevel=0.03)
        box((0, -0.064, 0.38), (0.1, 0.008, 0.016), DARK, bevel=0)
        box((0.09, 0.02, 0.43), (0.008, 0.012, 0.09), GOLD, bevel=0)
        box((0.09, 0.05, 0.47), (0.008, 0.06, 0.035), RED, bevel=0)
    model("mailbox", mailbox)

    def well():
        spun([(0.25, 0.0), (0.26, 0.04), (0.25, 0.2), (0.18, 0.2), (0.18, 0.14), (0.0, 0.14)], STONE, sides=10, sharp=40, gradient=(0.85, 1.03))
        tube((0, 0, 0.13), 0.175, 0.175, 0.02, WATER, sides=10)
        for x in (-0.21, 0.21):
            box((x, 0, 0.41), (0.045, 0.045, 0.44), WOOD_DARK, bevel=0)
        angle = math.atan2(0.14, 0.17)
        for side in (-1, 1):
            box((0, side * 0.09, 0.685), (0.6, 0.26, 0.035), RED, bevel=0, rot_x=-side * angle)
        tube((-0.22, 0, 0.5), 0.022, 0.022, 0.44, WOOD, sides=8, rot_y=math.pi / 2, sharp=60)
        pipe([(0.0, 0.0, 0.5), (0.0, 0.0, 0.32)], [0.006, 0.006], WHITE, sides=4)
        spun([(0.035, 0.0), (0.045, 0.07), (0.0, 0.07)], WOOD, sides=8, at=(0, 0, 0.25))
    model("well", well)

    def fence_post():
        box((0, 0, 0.15), (0.07, 0.07, 0.3), WOOD, bevel=0.012)
        spun([(0.05, 0.0), (0.0, 0.05)], WOOD, sides=4, sharp=30, at=(0, 0, 0.3))
    model("fence_post", fence_post)

    def fence_rail():
        # From the post to the edge of the cell, towards the front.
        for z in (0.11, 0.22):
            box((0, -0.25, z), (0.028, 0.5, 0.045), (0.80, 0.63, 0.45), bevel=0.008)
        box((0, -0.25, 0.14), (0.045, 0.045, 0.28), WOOD, bevel=0.008)
    model("fence_rail", fence_rail)

    def flag():
        spun([(0.05, 0.0), (0.035, 0.03), (0.02, 0.05), (0.016, 1.0), (0.0, 1.0)], WHITE, sides=8)
        ball((0, 0, 1.02), 0.03, GOLD, kind=GLOW, detail=1)
        top, bottom = [], []
        for k in range(7):
            t = k / 6
            y = math.sin(t * math.pi * 2.2) * 0.03 * t
            top.append((0.018 + t * 0.44, y, 0.97 - t * 0.02))
            bottom.append((0.018 + t * 0.44, y, 0.7 + t * (0.12 if k < 6 else 0.14)))
        ribbon(top, bottom, TINT, mat=2, kind=SWAY, gradient=(0.9, 1.05))
    model("flag", flag)

    def campfire():
        for i in range(7):
            a = i / 7 * math.tau
            lump((math.cos(a) * 0.2, math.sin(a) * 0.2, 0.025), 0.055, ROCK, squash=(1, 1, 0.7), seed=40 + i, detail=1, sharp=40, amount=0.25)
        for i in range(3):
            a = i / 3 * math.tau + 0.4
            pipe([(math.cos(a) * 0.16, math.sin(a) * 0.16, 0.02), (-math.cos(a) * 0.03, -math.sin(a) * 0.03, 0.16)], [0.03, 0.022], WOOD_DARK, sides=6)
        spun([(0.0, 0.0), (0.085, 0.05), (0.07, 0.13), (0.03, 0.24), (0.0, 0.32)], FLAME, sides=8, kind=GLOW, sharp=60, at=(0, 0, 0.04))
        spun([(0.0, 0.0), (0.045, 0.04), (0.035, 0.1), (0.0, 0.2)], (1.0, 0.9, 0.45), sides=6, kind=GLOW, sharp=60, at=(0.01, -0.03, 0.06))
    model("campfire", campfire, grounded=False)

    def scarecrow():
        pipe([(0, 0, 0), (0, 0, 0.62)], [0.022, 0.02], WOOD_DARK, sides=6)
        pipe([(-0.26, 0, 0.42), (0.26, 0, 0.4)], [0.018, 0.018], WOOD_DARK, sides=6)
        box((0, 0, 0.36), (0.2, 0.09, 0.22), (0.44, 0.58, 0.80), bevel=0.03, gradient=(0.9, 1.03))
        box((0.04, -0.047, 0.33), (0.06, 0.006, 0.06), (0.92, 0.5, 0.4), bevel=0)
        for x in (-0.19, 0.19):
            box((x, 0, 0.41), (0.16, 0.07, 0.07), (0.44, 0.58, 0.80), bevel=0)
            spun([(0.035, 0.0), (0.0, 0.07)], STRAW, sides=6, at=(x + (0.09 if x > 0 else -0.09), 0, 0.38), sharp=60)
        lump((0, 0, 0.56), 0.085, (0.93, 0.84, 0.66), seed=50, detail=2, amount=0.08)
        for x in (-0.03, 0.03):
            ball((x, -0.078, 0.57), 0.012, DARK, detail=1)
        spun([(0.17, 0.0), (0.16, 0.012), (0.08, 0.03), (0.06, 0.1), (0.0, 0.13)], STRAW, sides=8, sharp=40, at=(0, 0, 0.61))
    model("scarecrow", scarecrow)

    def haystack():
        spun([(0.27, 0.0), (0.29, 0.08), (0.27, 0.24), (0.18, 0.36), (0.06, 0.44), (0.0, 0.46)], STRAW, sides=10, sharp=60, gradient=(0.85, 1.06))
        pipe([(math.cos(i / 10 * math.tau) * 0.285, math.sin(i / 10 * math.tau) * 0.285, 0.15) for i in range(11)], [0.012] * 11,
             (0.80, 0.62, 0.32), sides=4, cap=False)
    model("haystack", haystack)

    def snowman():
        lump((0, 0, 0.17), 0.2, SNOW, seed=60, amount=0.05, kind=NO_SNOW, gradient=(0.9, 1.0))
        lump((0, 0, 0.44), 0.15, SNOW, seed=61, amount=0.05, kind=NO_SNOW, gradient=(0.93, 1.0))
        lump((0, 0, 0.65), 0.11, SNOW, seed=62, amount=0.04, kind=NO_SNOW, gradient=(0.95, 1.0), detail=1)
        tube((0, -0.1, 0.65), 0.022, 0.0, 0.11, FLAME, sides=6, kind=NO_SNOW, rot_x=math.pi / 2, sharp=60)
        for x in (-0.04, 0.04):
            box((x, -0.1, 0.685), (0.022, 0.012, 0.022), DARK, kind=NO_SNOW, bevel=0)
        for z in (0.36, 0.44, 0.52):
            box((0, -0.15, z), (0.024, 0.012, 0.024), DARK, kind=NO_SNOW, bevel=0)
        pipe([(0.13, 0, 0.47), (0.3, 0, 0.58)], [0.012, 0.008], WOOD_DARK, sides=5, kind=NO_SNOW)
        pipe([(-0.13, 0, 0.47), (-0.3, 0, 0.56)], [0.012, 0.008], WOOD_DARK, sides=5, kind=NO_SNOW)
        pipe([(math.cos(i / 8 * math.tau) * 0.115, math.sin(i / 8 * math.tau) * 0.115, 0.555) for i in range(9)], [0.022] * 9,
             RED, sides=5, kind=NO_SNOW, cap=False)
        spun([(0.12, 0.0), (0.12, 0.015), (0.075, 0.015), (0.07, 0.12), (0.0, 0.12)], DARK, sides=8, kind=NO_SNOW, sharp=40, at=(0, 0, 0.735))
    model("snowman", snowman)

    def rock_a():
        lump((0, 0, 0.1), 0.26, ROCK, squash=(1.0, 0.82, 0.62), seed=70, detail=1, amount=0.3, sharp=28, gradient=(0.84, 1.06))
        lump((0.2, 0.08, 0.05), 0.13, ROCK, squash=(1.0, 0.9, 0.7), seed=71, detail=1, amount=0.3, sharp=28, gradient=(0.8, 1.0))
    model("rock_a", rock_a)

    def rock_b():
        lump((0, 0, 0.16), 0.24, ROCK, squash=(0.85, 0.78, 1.05), seed=72, detail=1, amount=0.32, sharp=28, gradient=(0.82, 1.06))
        lump((-0.17, 0.1, 0.06), 0.14, ROCK, squash=(1.0, 0.9, 0.75), seed=73, detail=1, amount=0.3, sharp=28, gradient=(0.8, 1.0))
        lump((0.13, -0.14, 0.04), 0.09, ROCK, squash=(1.0, 1.0, 0.7), seed=74, detail=1, amount=0.3, sharp=28, gradient=(0.8, 1.0))
    model("rock_b", rock_b)

    def bridge(rails):
        # Runs along the game's z axis (Blender's y) across one cell.
        for i in range(8):
            box((0, -0.4375 + i * 0.125, 0.31), (0.62, 0.115, 0.035), WOOD if i % 2 == 0 else (0.71, 0.53, 0.36), bevel=0)
        for x in (-0.24, 0.24):
            box((x, 0, 0.275), (0.05, 1.0, 0.045), WOOD_DARK, bevel=0)
            tube((x, 0.0, -1.2), 0.04, 0.036, 1.48, WOOD_DARK, sides=6, cap=False)
        if rails:
            for x in (-0.3, 0.3):
                for y in (-0.42, 0.0, 0.42):
                    box((x, y, 0.42), (0.04, 0.04, 0.2), WOOD_DARK, bevel=0)
                pipe([(x, -0.5, 0.52), (x, 0.5, 0.52)], [0.018, 0.018], WOOD, sides=5)
                pipe([(x, -0.5, 0.42), (x, 0.5, 0.42)], [0.012, 0.012], WOOD, sides=4)
    model("bridge", lambda: bridge(True), grounded=False)
    model("bridge_deck", lambda: bridge(False), grounded=False)

    def bridge_ramp():
        # On the shore cell: planks that climb from the ground up to the deck at the cell's front edge.
        for i in range(4):
            t = (i + 0.5) / 4
            box((0, -0.5 + t * 0.42, 0.31 - t * 0.2), (0.62, 0.115, 0.035), WOOD if i % 2 == 0 else (0.71, 0.53, 0.36), bevel=0, rot_x=-0.44)
        for x in (-0.24, 0.24):
            box((x, -0.3, 0.17), (0.05, 0.46, 0.05), WOOD_DARK, bevel=0, rot_x=-0.44)
    model("bridge_ramp", bridge_ramp, grounded=False)


def living():
    def person():
        # A bean of a body, a big head, short arms. Faces -Y. Hair comes separately.
        spun([(0.0, 0.0), (0.052, 0.014), (0.066, 0.055), (0.062, 0.1), (0.04, 0.135), (0.0, 0.142)],
             TINT, sides=8, mat=1, kind=NO_SNOW, sharp=80, at=(0, 0, 0.062), gradient=(0.88, 1.04))
        ball((0, 0, 0.232), 0.06, SKIN, squash=(1.0, 0.95, 0.96), kind=NO_SNOW, detail=2)
        for side in (-1, 1):
            pipe([(side * 0.05, 0, 0.18), (side * 0.076, -0.004, 0.14), (side * 0.084, -0.012, 0.095)], [0.019, 0.017, 0.015],
                 TINT, sides=5, mat=1, kind=NO_SNOW)
            plate(disc(0.0085, 6), -0.0, 0.0, DARK, kind=NO_SNOW, at=(side * 0.023, -0.0575, 0.236), flat=True)
            plate(disc(0.011, 6), -0.0, 0.0, (1.0, 0.70, 0.66), kind=NO_SNOW, at=(side * 0.038, -0.0505, 0.214), flat=True)
    model("person", person, grounded=False)

    def hair_a():       # short, with a fringe
        ball((0, 0.008, 0.248), 0.062, TINT, squash=(1.03, 1.02, 0.86), mat=2, kind=NO_SNOW, detail=2)
        box((0, -0.045, 0.275), (0.09, 0.03, 0.03), TINT, mat=2, kind=NO_SNOW, bevel=0)
    model("hair_a", hair_a, grounded=False)

    def hair_b():       # a bob down to the shoulders
        ball((0, 0.012, 0.24), 0.066, TINT, squash=(1.05, 1.0, 1.0), mat=2, kind=NO_SNOW, detail=2)
        for side in (-1, 1):
            ball((side * 0.05, 0.0, 0.2), 0.03, TINT, squash=(0.8, 1.0, 1.4), mat=2, kind=NO_SNOW, detail=1)
    model("hair_b", hair_b, grounded=False)

    def hair_c():       # tied up in a bun
        ball((0, 0.01, 0.25), 0.061, TINT, squash=(1.03, 1.0, 0.82), mat=2, kind=NO_SNOW, detail=2)
        ball((0, 0.02, 0.305), 0.03, TINT, mat=2, kind=NO_SNOW, detail=1)
    model("hair_c", hair_c, grounded=False)

    def leg():
        pipe([(0, 0, 0.075), (0, 0, 0.022)], [0.024, 0.021], (0.36, 0.40, 0.55), sides=5, kind=NO_SNOW)
        ball((0, -0.01, 0.016), 0.027, (0.38, 0.31, 0.30), squash=(0.9, 1.3, 0.6), kind=NO_SNOW, detail=1)
    model("leg", leg, grounded=False)

    def hat():
        spun([(0.105, 0.0), (0.1, 0.008), (0.062, 0.012), (0.056, 0.04), (0.03, 0.058), (0.0, 0.06)], STRAW, sides=9, kind=NO_SNOW, sharp=40)
        tube((0, 0, 0.012), 0.063, 0.062, 0.012, RED, sides=9, kind=NO_SNOW, cap=False)
    model("hat", hat, grounded=False)

    def boat():
        # The bow points to -Y. A hull lofted over ribs, a rim, benches, a mast and two full sails.
        ribs = []
        bm = bmesh.new()
        shape = ((-0.66, 0.012, 0.2), (-0.5, 0.11, 0.185), (-0.25, 0.185, 0.17), (0.05, 0.215, 0.165), (0.3, 0.2, 0.17), (0.46, 0.15, 0.19))
        for y, width, top in shape:
            ribs.append([bm.verts.new((-width, y, top)), bm.verts.new((-width * 0.82, y, top * 0.45)), bm.verts.new((-width * 0.4, y, 0.0)),
                         bm.verts.new((width * 0.4, y, 0.0)), bm.verts.new((width * 0.82, y, top * 0.45)), bm.verts.new((width, y, top))])
        for a, b in zip(ribs, ribs[1:]):
            for i in range(5):
                bm.faces.new((a[i], a[i + 1], b[i + 1], b[i]))
        bm.faces.new(ribs[0])
        bm.faces.new(list(reversed(ribs[-1])))
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
        emit(bm, (0.84, 0.46, 0.34), 0, NO_SNOW, 0, 1, 70, (0.8, 1.05))
        for side in (-1, 1):
            pipe([(side * w, y, top + 0.006) for y, w, top in shape], [0.014] * len(shape), (0.96, 0.9, 0.78), sides=5, kind=NO_SNOW)
        ribbon([(-w * 0.9, y, top * 0.8) for y, w, top in shape], [(w * 0.9, y, top * 0.8) for y, w, top in shape], (0.90, 0.80, 0.62), kind=NO_SNOW)
        for y in (-0.2, 0.2):
            box((0, y, 0.165), (0.36, 0.07, 0.02), WOOD, kind=NO_SNOW, bevel=0)
        pipe([(0, 0.0, 0.15), (0, 0.0, 1.0)], [0.02, 0.012], WOOD_DARK, sides=6, kind=NO_SNOW)
        # The mainsail behind the mast and the jib before it, both bellied to one side.
        def sail(start_a, start_b, head, color, belly, steps=6):
            edge_a, edge_b = [], []
            for k in range(steps + 1):
                t = k / steps
                bulge = math.sin(t * math.pi * 0.9) * belly
                edge_a.append((start_a[0] + (head[0] - start_a[0]) * t + bulge * 0.4, start_a[1] + (head[1] - start_a[1]) * t,
                               start_a[2] + (head[2] - start_a[2]) * t))
                edge_b.append((start_b[0] + (head[0] - start_b[0]) * t + bulge, start_b[1] + (head[1] - start_b[1]) * t,
                               start_b[2] + (head[2] - start_b[2]) * t))
            ribbon(edge_a, edge_b, color, kind=NO_SNOW, gradient=(0.9, 1.03))
        sail((0, 0.03, 0.27), (0, 0.5, 0.31), (0, 0.03, 0.97), WHITE, 0.09)
        sail((0, -0.62, 0.22), (0, -0.05, 0.28), (0, -0.02, 0.93), (0.98, 0.93, 0.84), 0.07)
        pipe([(0, 0.03, 0.29), (0, 0.5, 0.3)], [0.012, 0.01], WOOD_DARK, sides=5, kind=NO_SNOW)
        ribbon([(0, 0.0, 1.0), (0, 0.12, 0.98)], [(0, 0.0, 0.93), (0, 0.12, 0.95)], RED, kind=NO_SNOW)
    model("boat", boat, grounded=False)


def write():
    lines = ["-- Generated by tools/blender_models.py. Do not edit: change the script and run it again.",
             "-- Per model: n vertices; p positions, q normals, c colours (three each), k kind, m material.",
             "return {"]
    total = 0
    for name, vertices in MODELS.items():
        total += len(vertices)

        def column(a, b, digits):
            return ",".join(f"{round(v[i], digits):g}" for v in vertices for i in range(a, b))
        lines.append(f"  {name} = {{ n = {len(vertices)},")
        lines.append(f"    p = {{{column(0, 3, 3)}}},")
        lines.append(f"    q = {{{column(3, 6, 2)}}},")
        lines.append(f"    c = {{{column(6, 9, 2)}}},")
        lines.append(f"    k = {{{column(9, 10, 2)}}},")
        lines.append(f"    m = {{{column(10, 11, 0)}}} }},")
    lines.append("}")
    TARGET.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {TARGET}: {len(MODELS)} models, {total} vertices, {TARGET.stat().st_size // 1024} KB")


# ── preview: models in rows, rendered roughly the way the game shades them ──

LEAF, PINE, PINK, PALM = (0.36, 0.66, 0.34), (0.22, 0.48, 0.35), (0.99, 0.74, 0.83), (0.40, 0.72, 0.40)
PREVIEW_TINTS = {
    "tree_round": (LEAF, LEAF), "tree_pine": (PINE, PINE), "tree_blossom": (PINK, PINK), "palm": (PALM, PALM),
    "bush": (LEAF, (0.95, 0.4, 0.45)), "wheat": ((0.92, 0.80, 0.36), LEAF), "lavender": ((0.68, 0.52, 0.90), LEAF),
    "flower": ((1.0, 0.7, 0.78), LEAF), "grass": ((0.44, 0.74, 0.36), LEAF), "flag": (WHITE, (0.9, 0.45, 0.3)),
    "person": ((0.36, 0.60, 0.86), DARK), "hair_a": (WHITE, (0.5, 0.34, 0.22)), "hair_b": (WHITE, (0.26, 0.2, 0.18)),
    "hair_c": (WHITE, (0.86, 0.72, 0.42)), "pavilion": (WHITE, (0.86, 0.42, 0.32)),
    "house_end": ((0.84, 0.90, 0.96), (0.36, 0.50, 0.66)), "house_mid": ((0.99, 0.90, 0.66), (0.36, 0.50, 0.66)),
    "shop": ((0.98, 0.84, 0.80), (0.30, 0.58, 0.56)),
}
DEFAULT_TINT = ((0.98, 0.93, 0.82), (0.86, 0.42, 0.32))


def preview(path, names, columns=7, width=2000, zoom=1.0):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scene = bpy.context.scene
    rows = (len(names) + columns - 1) // columns
    for index, name in enumerate(names):
        vertices = MODELS[name]
        mesh = bpy.data.meshes.new(name)
        mesh.from_pydata([(v[0], -v[2], v[1]) for v in vertices], [], [(i, i + 1, i + 2) for i in range(0, len(vertices), 3)])
        colors = mesh.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
        wall, roof = PREVIEW_TINTS.get(name, DEFAULT_TINT)
        for k, v in enumerate(vertices):
            tint = wall if v[10] == 1 else (roof if v[10] == 2 else (1, 1, 1))
            # The image is saved as sRGB: give the renderer linear colours.
            colors.data[k].color = tuple(max(0.0, c * t) ** 2.2 for c, t in zip(v[6:9], tint)) + (1.0,)
        mesh.color_attributes.active_color = colors
        mesh.shade_smooth()
        mesh.normals_split_custom_set_from_vertices([(v[3], -v[5], v[4]) for v in vertices])
        obj = bpy.data.objects.new(name, mesh)
        scene.collection.objects.link(obj)
        obj.location = ((index % columns) * 1.45, -(index // columns) * 1.9, 0)
        obj.scale = (zoom, zoom, zoom)
    ground = bpy.data.meshes.new("ground")
    w, d = columns * 1.45, rows * 1.9
    ground.from_pydata([(-1, 1.2, 0), (w, 1.2, 0), (w, -d + 0.4, 0), (-1, -d + 0.4, 0)], [], [(0, 1, 2, 3)])
    gc = ground.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
    for k in range(4):
        gc.data[k].color = (0.47 ** 2.2, 0.74 ** 2.2, 0.38 ** 2.2, 1.0)
    scene.collection.objects.link(bpy.data.objects.new("ground", ground))

    camera = bpy.data.objects.new("camera", bpy.data.cameras.new("camera"))
    camera.data.type = "ORTHO"
    camera.rotation_euler = (math.radians(60), 0, math.radians(16))
    centre = Vector(((w - 1.45) / 2, -(d - 1.9) / 2, 0.45))
    camera.location = centre + camera.rotation_euler.to_matrix() @ Vector((0, 0, 40))
    scene.collection.objects.link(camera)
    scene.camera = camera
    world = bpy.data.worlds.new("sky")
    world.color = (0.5, 0.74, 0.92)
    scene.world = world

    scene.render.engine = "BLENDER_WORKBENCH"
    scene.view_settings.view_transform = "Standard"
    shading = scene.display.shading
    shading.light = "STUDIO"
    shading.color_type = "VERTEX"
    shading.show_shadows = True
    shading.shadow_intensity = 0.35
    shading.show_cavity = True
    height = int(width * (d * 0.62 + 1.4) / (w + 0.4))
    camera.data.ortho_scale = max(w + 0.4, (d * 0.62 + 1.4) * width / height)
    scene.render.resolution_x, scene.render.resolution_y = width, height
    scene.render.filepath = path
    scene.render.image_settings.file_format = "PNG"
    bpy.ops.render.render(write_still=True)
    print(f"preview {path}")


buildings()
plants()
props()
living()
write()

if os.environ.get("ISLAND_PREVIEW"):
    base = os.environ["ISLAND_PREVIEW"]
    names = list(MODELS.keys())
    only = os.environ.get("ISLAND_PREVIEW_ONLY")
    if only:
        names = [name for name in names if name in only.split(",")]
    preview(base, names, columns=int(os.environ.get("ISLAND_PREVIEW_COLUMNS", "7")), zoom=float(os.environ.get("ISLAND_PREVIEW_ZOOM", "1")))
